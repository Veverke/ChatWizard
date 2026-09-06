/**
 * test/unit/logEventStore.test.ts
 *
 * Unit tests for Phase 1 — LogEventStore (watch-logs storage/indexing layer).
 * Uses a temporary directory per test for isolation, mirroring
 * test/unit/cacheManager.test.ts conventions.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import {
    LogEventStore,
    LOG_EVENTS_DB_FILENAME,
    LOG_SCHEMA_VERSION,
} from '../../src/logs/logEventStore';
import { LogEvent } from '../../src/logs/types';

/** Minimal CommandEvent fixture factory. */
function makeCommandEvent(overrides: Partial<LogEvent> & { id: string }): LogEvent {
    return {
        type: 'command',
        tool: 'cursor',
        timestamp: '2026-01-01T10:00:00.000Z',
        commandText: 'npm test',
        exitCode: 0,
        cwd: '/repo',
        ...overrides,
    } as LogEvent;
}

/** FileOperationEvent fixture factory. */
function makeFileOperationEvent(overrides: Partial<LogEvent> & { id: string }): LogEvent {
    return {
        type: 'fileOperation',
        tool: 'cline',
        timestamp: '2026-01-01T10:01:00.000Z',
        operationType: 'create',
        filePath: '/repo/src/app.ts',
        ...overrides,
    } as LogEvent;
}

/** Creates a temporary directory for test isolation. */
function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-log-events-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('LogEventStore – watch-logs storage', () => {
    let dir: string;
    let store: LogEventStore;

    setup(() => {
        dir = tmpDir();
        store = new LogEventStore(dir);
        store.open();
    });

    teardown(() => {
        try { store.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('open creates the database file', () => {
        const dbPath = path.join(dir, LOG_EVENTS_DB_FILENAME);
        assert.ok(fs.existsSync(dbPath), 'DB file should exist after open()');
    });

    test('upsertEvent and getEvents round-trip', () => {
        const event = makeCommandEvent({ id: 'e1', commandText: 'npm test' });
        store.upsertEvent(event);

        const rows = store.getEvents();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'e1');
        assert.strictEqual(rows[0].type, 'command');
        assert.strictEqual((rows[0] as Extract<LogEvent, { type: 'command' }>).commandText, 'npm test');
        assert.strictEqual(rows[0].tool, 'cursor');
    });

    test('upsertEvents inserts multiple rows atomically', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeFileOperationEvent({ id: 'e2', timestamp: '2026-01-01T10:01:00.000Z' }),
            makeCommandEvent({ id: 'e3', timestamp: '2026-01-01T10:02:00.000Z' }),
        ]);
        assert.strictEqual(store.getEventCount(), 3);
    });

    test('re-upserting the same id replaces the row', () => {
        store.upsertEvent(makeCommandEvent({ id: 'e1', commandText: 'npm test', exitCode: 0 }));
        store.upsertEvent(makeCommandEvent({ id: 'e1', commandText: 'npm run build', exitCode: 1 }));

        assert.strictEqual(store.getEventCount(), 1);
test('getEvents filters by sessionId', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', sessionId: 's1' }),
            makeCommandEvent({ id: 'e2', sessionId: 's2' }),
        ]);
        const rows = store.getEvents({ sessionId: 's1' });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'e1');
    });

    test('getEvents filters by type', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1' }),
            makeFileOperationEvent({ id: 'e2' }),
        ]);
        const rows = store.getEvents({ type: 'command' });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'e1');
    });

    test('getEvents filters by multiple types', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1' }),
            makeFileOperationEvent({ id: 'e2' }),
            { type: 'error', id: 'e3', tool: 'cursor', timestamp: '2026-01-01T10:03:00.000Z', message: 'boom' } as LogEvent,
        ]);
        const rows = store.getEvents({ types: ['command', 'error'] });
        assert.strictEqual(rows.length, 2);
    });

    test('getEvents filters by tool (single and array)', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', tool: 'cursor' }),
            makeCommandEvent({ id: 'e2', tool: 'cline' }),
            makeCommandEvent({ id: 'e3', tool: 'aider' }),
        ]);

        assert.strictEqual(store.getEvents({ tool: 'cline' }).length, 1);
        assert.strictEqual(store.getEvents({ tool: ['cursor', 'aider'] }).length, 2);
    });

    test('getEvents filters by filePath', () => {
        store.upsertEvents([
            makeFileOperationEvent({ id: 'e1', filePath: '/repo/src/app.ts' }),
            makeFileOperationEvent({ id: 'e2', filePath: '/repo/tests/app.test.ts' }),
        ]);
        const rows = store.getEvents({ filePath: '/repo/src/app.ts' });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'e1');
    });

    test('getEvents applies inclusive time-range filters', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', timestamp: '2026-01-01T09:00:00.000Z' }),
            makeCommandEvent({ id: 'e2', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommandEvent({ id: 'e3', timestamp: '2026-01-01T11:00:00.000Z' }),
        ]);
        const rows = store.getEvents({ from: '2026-01-01T10:00:00.000Z', to: '2026-01-01T10:59:59.999Z' });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'e2');
    });
        const [row] = store.getEvents({ types: ['command'] });
        const cmd = row as Extract<LogEvent, { type: 'command' }>;
        assert.strictEqual(cmd.commandText, 'npm run build');
        assert.strictEqual(cmd.exitCode, 1);
    });
test('getEvents sorts descending by default and ascending on request', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', timestamp: '2026-01-01T09:00:00.000Z' }),
            makeCommandEvent({ id: 'e2', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommandEvent({ id: 'e3', timestamp: '2026-01-01T11:00:00.000Z' }),
        ]);

        assert.deepStrictEqual(store.getEvents().map((e) => e.id), ['e3', 'e2', 'e1']);
        assert.deepStrictEqual(
            store.getEvents({ order: 'asc' }).map((e) => e.id),
            ['e1', 'e2', 'e3']
        );
    });

    test('getEvents honours limit and offset', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', timestamp: '2026-01-01T09:00:00.000Z' }),
            makeCommandEvent({ id: 'e2', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommandEvent({ id: 'e3', timestamp: '2026-01-01T11:00:00.000Z' }),
        ]);

        assert.deepStrictEqual(store.getEvents({ limit: 2 }).map((e) => e.id), ['e3', 'e2']);
        assert.deepStrictEqual(
            store.getEvents({ limit: 2, offset: 1 }).map((e) => e.id),
            ['e2', 'e1']
        );
    });
test('removeEventsForSession removes only that session', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', sessionId: 's1' }),
            makeCommandEvent({ id: 'e2', sessionId: 's1' }),
            makeCommandEvent({ id: 'e3', sessionId: 's2' }),
        ]);

        const removed = store.removeEventsForSession('s1');
        assert.strictEqual(removed, 2);
        assert.strictEqual(store.getEventCount(), 1);
    });

    test('removeBySourcePath removes events parsed from a file', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', sourcePath: '/logs/1.jsonl' }),
            makeCommandEvent({ id: 'e2', sourcePath: '/logs/1.jsonl' }),
            makeCommandEvent({ id: 'e3', sourcePath: '/logs/2.jsonl' }),
        ]);

        const removed = store.removeBySourcePath('/logs/1.jsonl');
        assert.strictEqual(removed, 2);
        assert.strictEqual(store.getEventCount(), 1);
        assert.strictEqual(store.getEvents()[0].id, 'e3');
    });

    test('clear removes every event but keeps schema', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1' }),
            makeFileOperationEvent({ id: 'e2' }),
        ]);
        store.clear();
        assert.strictEqual(store.getEventCount(), 0);

        // Schema still usable
        store.upsertEvent(makeCommandEvent({ id: 'e3' }));
        assert.strictEqual(store.getEventCount(), 1);
    });

    test('getStats reports totals, per-type counts, and distinct tools', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', tool: 'cursor' }),
            makeCommandEvent({ id: 'e2', tool: 'cline' }),
            makeFileOperationEvent({ id: 'e3' }),
        ]);

        const stats = store.getStats();
        assert.strictEqual(stats.totalEvents, 3);
        assert.strictEqual(stats.schemaVersion, LOG_SCHEMA_VERSION);
        assert.strictEqual(stats.byType.command, 2);
        assert.strictEqual(stats.byType.fileOperation, 1);
        assert.strictEqual(stats.byType.error, 0);
        assert.deepStrictEqual(stats.tools.sort(), ['cline', 'cursor']);
    });

    test('events survive a close + reopen of the store', () => {
        store.upsertEvent(makeCommandEvent({ id: 'e1' }));
        store.close();

        store = new LogEventStore(dir);
        store.open();
        assert.strictEqual(store.getEventCount(), 1);
        assert.strictEqual(store.getEvents()[0].id, 'e1');
    });

    test('opening a store with a newer schema version throws', () => {
        store.close();

        // Bump the version beyond what the extension knows.
        const db = new BetterSqlite3(path.join(dir, LOG_EVENTS_DB_FILENAME));
        db.pragma(`user_version = ${LOG_SCHEMA_VERSION + 1}`);
        db.close();

        const newer = new LogEventStore(dir);
        assert.throws(() => newer.open(), /newer than/i);
    });
});