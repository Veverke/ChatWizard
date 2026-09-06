/**
 * test/unit/logService.test.ts
 *
 * Unit tests for Phase 1 — LogService facade.
 * The key deliverable from the work plan is exercised here:
 *
 *   logService.getEvents({ sessionId, type })
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { LogEvent } from '../../src/logs/types';

function makeCommand(overrides: Partial<LogEvent> & { id: string }): LogEvent {
    return {
        type: 'command',
        tool: 'cursor',
        timestamp: '2026-01-01T10:00:00.000Z',
        commandText: 'npm test',
        ...overrides,
    } as LogEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-log-service-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('LogService – watch-logs facade', () => {
    let dir: string;
    let logService: LogService;

    setup(() => {
        dir = tmpDir();
        logService = new LogService(dir, createDefaultLogSourceRegistry());
    });

    teardown(() => {
        try { logService.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('constructor opens the event store', () => {
        assert.ok(logService.store.isOpen, 'store should be open');
        assert.ok(fs.existsSync(logService.store.dbPath), 'DB file should exist');
    });

    test('deliverable: getEvents({ sessionId, type }) returns the session commands', () => {
        logService.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 's1', commandText: 'npm test' }),
            makeCommand({ id: 'c2', sessionId: 's1', commandText: 'git commit' }),
            makeCommand({ id: 'c3', sessionId: 's2', commandText: 'npm run build' }),
            { type: 'error', id: 'x1', sessionId: 's1', tool: 'cursor', timestamp: '2026-01-01T10:01:00.000Z', message: 'fail' } as LogEvent,
        ]);

        const commands = logService.getEvents({ sessionId: 's1', type: 'command' });
        assert.strictEqual(commands.length, 2);
        assert.deepStrictEqual(commands.map((c) => c.id).sort(), ['c1', 'c2']);
    });

    test('ingestEvent persists a single event', () => {
        logService.ingestEvent(makeCommand({ id: 'c1' }));
        assert.strictEqual(logService.getStats().totalEvents, 1);
    });

    test('removeEventsForSession routes to the store', () => {
        logService.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 's1' }),
            makeCommand({ id: 'c2', sessionId: 's1' }),
            makeCommand({ id: 'c3', sessionId: 's2' }),
        ]);

        const removed = logService.removeEventsForSession('s1');
        assert.strictEqual(removed, 2);
        assert.strictEqual(logService.getStats().totalEvents, 1);
    });

    test('clear drops all events', () => {
        logService.ingestEvents([
            makeCommand({ id: 'c1' }),
            makeCommand({ id: 'c2' }),
        ]);
        logService.clear();
        assert.strictEqual(logService.getStats().totalEvents, 0);
    });

    test('getSources returns registered configs; enabledOnly filters', () => {
        const all = logService.getSources();
        assert.strictEqual(all.length, 6);

        // With default settings every source is enabled.
        const enabled = logService.getSources(true);
        assert.strictEqual(enabled.length, all.length);
        assert.deepStrictEqual(enabled.map((s) => s.tool), all.map((s) => s.tool));
    });

    test('getStats reflects stored events', () => {
        logService.ingestEvents([
            makeCommand({ id: 'c1', tool: 'cursor' }),
            makeCommand({ id: 'c2', tool: 'cursor' }),
        ]);
        const stats = logService.getStats();
        assert.strictEqual(stats.byType.command, 2);
        assert.deepStrictEqual(stats.tools, ['cursor']);
    });

    test('dispose closes the store', () => {
        logService.dispose();
        assert.strictEqual(logService.store.isOpen, false);
    });
});