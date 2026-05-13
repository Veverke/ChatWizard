import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { TelemetryRecorder, TelemetryEvent } from '../../src/telemetry/telemetryRecorder';

function makeTmpDir(): string {
    return path.join(os.tmpdir(), `chatwizard-telemetry-test-${Math.random().toString(36).slice(2)}`);
}

function removeTmpDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

suite('TelemetryRecorder', () => {

    // ── Disabled state ────────────────────────────────────────────────────────

    test('disabled by default', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            assert.strictEqual(recorder.enabled, false);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('record does nothing when disabled', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.record('test');
            assert.deepStrictEqual(recorder.getEvents(), []);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('file not created when disabled', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.record('test');
            assert.strictEqual(fs.existsSync(recorder.logFilePath), false);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── Enable/disable ────────────────────────────────────────────────────────

    test('setEnabled(true) enables', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            assert.strictEqual(recorder.enabled, true);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('setEnabled(false) disables', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.setEnabled(false);
            assert.strictEqual(recorder.enabled, false);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('toggle: enable → record → disable → record', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('first');
            recorder.setEnabled(false);
            recorder.record('second');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].event, 'first');
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── Recording events ──────────────────────────────────────────────────────

    test('single event written', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('foo');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].event, 'foo');
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('timestamp is ISO string', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('evt');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            assert.match(events[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('properties attached', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('evt', { key: 'val', count: 42, flag: true });
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            const props = events[0].properties;
            assert.ok(props !== undefined);
            assert.strictEqual(props['key'], 'val');
            assert.strictEqual(props['count'], 42);
            assert.strictEqual(props['flag'], true);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('event without properties', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('bare');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].properties, undefined);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('multiple events in order', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('a');
            recorder.record('b');
            recorder.record('c');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 3);
            assert.strictEqual(events[0].event, 'a');
            assert.strictEqual(events[1].event, 'b');
            assert.strictEqual(events[2].event, 'c');
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('file exists after record', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('any');
            assert.strictEqual(fs.existsSync(recorder.logFilePath), true);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── JSONL format ──────────────────────────────────────────────────────────

    test('each line is valid JSON', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('x');
            recorder.record('y');
            recorder.record('z');
            const content = fs.readFileSync(recorder.logFilePath, 'utf8');
            const nonEmptyLines = content.split('\n').filter(l => l.trim().length > 0);
            for (const line of nonEmptyLines) {
                assert.doesNotThrow(() => JSON.parse(line), `Line is not valid JSON: ${line}`);
            }
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('file has correct line count', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('p');
            recorder.record('q');
            recorder.record('r');
            const content = fs.readFileSync(recorder.logFilePath, 'utf8');
            const nonEmptyLines = content.split('\n').filter(l => l.trim().length > 0);
            assert.strictEqual(nonEmptyLines.length, 3);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── getEvents edge cases ──────────────────────────────────────────────────

    test('getEvents on missing file returns empty array', () => {
        const nonExistentDir = path.join(os.tmpdir(), `chatwizard-no-such-${Math.random().toString(36).slice(2)}`);
        // Do not create this directory — it must not exist
        let result: TelemetryEvent[] = [];
        assert.doesNotThrow(() => {
            result = new TelemetryRecorder(nonExistentDir).getEvents();
        });
        assert.deepStrictEqual(result, []);
    });

    test('getEvents skips corrupt lines', () => {
        const tmpDir = makeTmpDir();
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            const filePath = path.join(tmpDir, 'telemetry.jsonl');
            const validEvent: TelemetryEvent = {
                event: 'good',
                timestamp: new Date().toISOString(),
            };
            fs.writeFileSync(filePath, JSON.stringify(validEvent) + '\nnot json\n', 'utf8');
            const recorder = new TelemetryRecorder(tmpDir);
            let events: TelemetryEvent[] = [];
            assert.doesNotThrow(() => {
                events = recorder.getEvents();
            });
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].event, 'good');
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('getEvents parses all fields correctly', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('full-event', { str: 'hello', num: 7, bool: false });
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            const e = events[0];
            assert.strictEqual(e.event, 'full-event');
            assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
            assert.ok(e.properties !== undefined);
            assert.strictEqual(e.properties['str'], 'hello');
            assert.strictEqual(e.properties['num'], 7);
            assert.strictEqual(e.properties['bool'], false);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── clear ─────────────────────────────────────────────────────────────────

    test('clear removes file', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('something');
            assert.strictEqual(fs.existsSync(recorder.logFilePath), true);
            recorder.clear();
            assert.strictEqual(fs.existsSync(recorder.logFilePath), false);
            assert.deepStrictEqual(recorder.getEvents(), []);
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('clear on missing file does not throw', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            // File was never created
            assert.doesNotThrow(() => recorder.clear());
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('clear then record keeps only new events', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            recorder.setEnabled(true);
            recorder.record('old');
            recorder.clear();
            recorder.record('new');
            const events = recorder.getEvents();
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].event, 'new');
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── logFilePath ───────────────────────────────────────────────────────────

    test('logFilePath is inside storagePath', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            assert.ok(
                recorder.logFilePath.startsWith(tmpDir),
                `Expected logFilePath to start with "${tmpDir}", got "${recorder.logFilePath}"`
            );
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    test('logFilePath ends with telemetry.jsonl', () => {
        const tmpDir = makeTmpDir();
        try {
            const recorder = new TelemetryRecorder(tmpDir);
            assert.ok(
                recorder.logFilePath.endsWith('telemetry.jsonl'),
                `Expected logFilePath to end with "telemetry.jsonl", got "${recorder.logFilePath}"`
            );
        } finally {
            removeTmpDir(tmpDir);
        }
    });

    // ── Directory creation ────────────────────────────────────────────────────

    test('creates nested directory automatically', () => {
        const baseDir = makeTmpDir();
        const nestedDir = path.join(baseDir, 'level1', 'level2', 'level3');
        try {
            // nestedDir does not exist yet
            assert.strictEqual(fs.existsSync(nestedDir), false);
            const recorder = new TelemetryRecorder(nestedDir);
            recorder.setEnabled(true);
            assert.doesNotThrow(() => recorder.record('nested-event'));
            assert.strictEqual(fs.existsSync(recorder.logFilePath), true);
        } finally {
            removeTmpDir(baseDir);
        }
    });
});
