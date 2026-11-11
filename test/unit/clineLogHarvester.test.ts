/**
 * test/unit/clineLogHarvester.test.ts
 *
 * Phase 3 — Cline log harvester unit tests.
 * Verifies the bridge between the session-index event bus and the watch-logs
 * store: Cline/Roo Code session upserts re-index their task's ui_messages.json,
 * removals drop rows, and batches keep the store in sync with zero extra
 * filesystem watching.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, Message } from '../../src/types/index';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { ClineLogHarvester } from '../../src/logs/clineLogHarvester';

const TS = 1787652744029;

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-cline-harvester-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/** Build a fake Cline task dir + Session object with a command in ui_messages.json. */
function makeClineTask(parentDir: string, taskId: string): { taskDir: string; session: Session } {
    const taskDir = path.join(parentDir, taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify([
        { ts: TS, type: 'say', say: 'task', text: 'Fix tests' },
        { ts: TS + 1000, type: 'say', say: 'command', text: 'npm test', commandCompleted: true },
        { ts: TS + 2000, type: 'ask', ask: 'command_output', text: 'PASS' },
    ]), 'utf8');

    const userMsg: Message = { id: 'u1', role: 'user', content: 'Fix tests', timestamp: new Date(TS).toISOString(), codeBlocks: [] };
    const session: Session = {
        id: taskId,
        title: 'Fix tests',
        source: 'cline',
        workspaceId: taskId,
        workspacePath: '/repo',
        messages: [userMsg],
        filePath: taskDir,
        createdAt: new Date(TS).toISOString(),
        updatedAt: new Date(TS).toISOString(),
    };
    return { taskDir, session };
}

suite('ClineLogHarvester — session-index bridge', () => {
    let dir: string;
    let service: LogService;
    let harvester: ClineLogHarvester;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        harvester = new ClineLogHarvester(service);
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('upsert event ingests the task ui_messages.json into the log store', () => {
        const { taskDir, session } = makeClineTask(dir, 'task-a');
        const index = new SessionIndex();

        let refreshed = 0;
        harvester.onEventsChanged = () => { refreshed++; };
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(session);

        const stored = service.getEvents({ sessionId: 'task-a' });
        assert.strictEqual(stored.length, 1, 'one CommandEvent stored');
        assert.ok(stored.some((e) => e.type === 'command'), 'the stored event is a command');
        assert.ok(fs.existsSync(path.join(taskDir, 'ui_messages.json'))); // sanity
        assert.strictEqual(refreshed, 1, 'onEventsChanged fires once after upsert');
    });

    test('re-ingest removes stale rows first (live ui_messages rewrite)', () => {
        const { session } = makeClineTask(dir, 'task-rewrite');
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(session);

        // Simulate the file being rewritten with a second command appended.
        const uiPath = path.join(session.filePath!, 'ui_messages.json');
        const messages = JSON.parse(fs.readFileSync(uiPath, 'utf8')) as Record<string, unknown>[];
        messages.push({ ts: TS + 3000, type: 'say', say: 'command', text: 'npm run build', commandCompleted: true });
        fs.writeFileSync(uiPath, JSON.stringify(messages), 'utf8');

        // Re-ingest the same task dir (as the live watcher would).
        harvester.ingestTaskDir(session.filePath!, 'cline');

        const commands = service.getEvents({ sessionId: 'task-rewrite', type: 'command' });
        assert.strictEqual(commands.length, 2, 'should have both commands, no stale duplicates');
    });

    test('batch event ingests every Cline session once', () => {
        const { session: s1 } = makeClineTask(dir, 'task-b1');
        const { session: s2 } = makeClineTask(dir, 'task-b2');
        const index = new SessionIndex();

        let refreshes = 0;
        harvester.onEventsChanged = () => { refreshes++; };
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.batchUpsert([s1, s2]);

        assert.strictEqual(service.getStats().totalEvents, 2, 'one command per task');
        assert.strictEqual(refreshes, 2, 'one refresh per ingested task');
    });

    test('remove event drops only that task’s events', () => {
        const { session: s1 } = makeClineTask(dir, 'task-x');
        const { session: s2 } = makeClineTask(dir, 'task-y');
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));

        index.batchUpsert([s1, s2]);
        assert.strictEqual(service.getStats().totalEvents, 2);

        index.remove(s1.id);
        assert.strictEqual(service.getStats().totalEvents, 1);
        assert.strictEqual(service.getEvents().every((e) => e.sessionId === 'task-y'), true);
    });

    test('roocode sessions are harvested with the roocode source', () => {
        const { session } = makeClineTask(dir, 'roo-a');
        session.source = 'roocode';
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(session);

        const commands = service.getEvents({ sessionId: 'roo-a', type: 'command' });
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].tool, 'roocode');
    });

    test('non-cline sessions are ignored', () => {
        const claudeSession: Session = {
            id: 'claude-1',
            title: 'Claude session',
            source: 'claude',
            workspaceId: 'ws-claude',
            messages: [],
            filePath: '/tmp/x.jsonl',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(claudeSession);
        assert.strictEqual(service.getStats().totalEvents, 0);
    });

    test('ingestTaskDir reports ingested count and parse errors', () => {
        const { taskDir } = makeClineTask(dir, 'task-report');
        const result = harvester.ingestTaskDir(taskDir, 'cline');
        assert.strictEqual(result.ingested, 1);
        assert.strictEqual(result.errors.length, 0);
    });

    test('a session without ui_messages.json never breaks the pipeline', () => {
        const taskDir = path.join(dir, 'task-no-ui');
        fs.mkdirSync(taskDir, { recursive: true });
        const session: Session = {
            id: 'task-no-ui',
            title: 'No UI file',
            source: 'cline',
            workspaceId: 'task-no-ui',
            messages: [],
            filePath: taskDir,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(session);
        assert.strictEqual(service.getStats().totalEvents, 0);
    });
});