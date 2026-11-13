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
        // 6 Phase-1 tools + GitHub Copilot (Phase 2).
        assert.strictEqual(all.length, 7);

        // With default settings every source is enabled.
        const enabled = logService.getSources(true);
        assert.strictEqual(enabled.length, all.length);
        assert.deepStrictEqual(enabled.map((s) => s.tool), all.map((s) => s.tool));

        // The Phase 2 Copilot source is registered with the expected shape.
        const copilot = logService.registry.get('copilot');
        assert.ok(copilot !== undefined, 'copilot log source should be registered');
        assert.strictEqual(copilot!.displayName, 'GitHub Copilot');
        assert.strictEqual(copilot!.format, 'jsonl');
        assert.strictEqual(copilot!.enabledSettingKey, 'chatwizard.indexCopilot');
        assert.ok(copilot!.filePatterns.includes('**/chatSessions/*.jsonl'));
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

    test('stampSessionTitle records the chat title on every event of the session', () => {
        logService.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 's1' }),
            makeCommand({ id: 'c2', sessionId: 's1' }),
            makeCommand({ id: 'c3', sessionId: 's2' }),
        ]);

        const updated = logService.stampSessionTitle('s1', '  Chat title  ');
        assert.strictEqual(updated, 2, 'both events of s1 are stamped');

        const stamped = logService.getEvents({ sessionId: 's1' });
        assert.deepStrictEqual(stamped.map((e) => e.sessionTitle), ['Chat title', 'Chat title']);
        assert.deepStrictEqual(
            logService.getEvents({ sessionId: 's2' }).map((e) => e.sessionTitle),
            [undefined],
            'other sessions are untouched'
        );
    });

    test('stampSessionTitle is a no-op for blank titles and already-current events', () => {
        logService.ingestEvents([makeCommand({ id: 'c1', sessionId: 's1' })]);

        assert.strictEqual(logService.stampSessionTitle('s1', undefined), 0);
        assert.strictEqual(logService.stampSessionTitle('s1', '   '), 0);
        assert.strictEqual(logService.stampSessionTitle('', 'Title'), 0);

        assert.strictEqual(logService.stampSessionTitle('s1', 'Title'), 1);
        assert.strictEqual(logService.stampSessionTitle('s1', 'Title'), 0, 'unchanged title is not rewritten');
        assert.strictEqual(logService.stampSessionTitle('unknown-session', 'Title'), 0);
    });

    test('dispose closes the store', () => {
        logService.dispose();
        assert.strictEqual(logService.store.isOpen, false);
    });
});