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
    InMemoryLogEventStore,
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

suite('LogEventStore – diagnostics, degraded paths and corrupt rows', () => {
    let dir: string;
    let store: LogEventStore;

    setup(() => {
        dir = tmpDir();
        store = new LogEventStore(dir);
        store.open();
    });

    teardown(() => {
        try { store.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('SQLite store reports itself as persistent and exposes its path', () => {
        assert.strictEqual(store.isPersistent, true);
        assert.strictEqual(store.dbPath, path.join(dir, LOG_EVENTS_DB_FILENAME));
        assert.strictEqual(store.degradedReason, undefined);
    });

    test('open() creates a missing storage directory', () => {
        const nested = path.join(dir, 'deep', 'nested');
        const fresh = new LogEventStore(nested);
        fresh.open();
        try {
            assert.ok(fs.existsSync(path.join(nested, LOG_EVENTS_DB_FILENAME)));
        } finally {
            fresh.close();
        }
    });

    test('rows whose payload cannot be parsed are reconstructed from their columns', () => {
        store.upsertEvent(makeCommandEvent({ id: 'bad-payload', sessionId: 'sess-1' }));

        // Corrupt the stored payload via a separate connection (WAL allows it).
        const raw = new BetterSqlite3(path.join(dir, LOG_EVENTS_DB_FILENAME));
        try {
            raw.prepare('UPDATE agent_events SET payload = ? WHERE id = ?').run('not-json-at-all', 'bad-payload');
        } finally {
            raw.close();
        }

        const [row] = store.getEvents();
        assert.strictEqual(row.id, 'bad-payload');
        assert.strictEqual(row.type, 'command');
        assert.strictEqual(row.tool, 'cursor');
        assert.strictEqual(row.sessionId, 'sess-1');
        assert.strictEqual((row as { commandText?: string }).commandText, undefined);
    });

    test('the in-memory fallback store reports degraded metadata', () => {
        const fallback = new InMemoryLogEventStore(dir, 'better-sqlite3 unavailable');
        fallback.open();
        try {
            assert.strictEqual(fallback.isPersistent, false);
            assert.strictEqual(fallback.degradedReason, 'better-sqlite3 unavailable');
            assert.strictEqual(fallback.dbPath, path.join(dir, LOG_EVENTS_DB_FILENAME));
        } finally {
            fallback.close();
        }
    });

    test('the in-memory fallback store honours filters and removals', () => {
        const fallback = new InMemoryLogEventStore(dir);
        fallback.open();
        try {
            fallback.upsertEvents([
                makeCommandEvent({ id: 'f1', sessionId: 's1', tool: 'cursor', sourcePath: '/logs/a.jsonl' }),
                makeCommandEvent({ id: 'f2', sessionId: 's2', tool: 'cline', sourcePath: '/logs/b.jsonl' }),
            ]);

            assert.deepStrictEqual(fallback.getEvents({ tool: ['cursor'] }).map((e) => e.id), ['f1']);
            assert.deepStrictEqual(fallback.getEvents({ tool: 'cline' }).map((e) => e.id), ['f2']);
            assert.deepStrictEqual(fallback.getEvents({ sessionId: 's2' }).map((e) => e.id), ['f2']);
            assert.strictEqual(fallback.countBySourcePath('/logs/a.jsonl'), 1);
            assert.strictEqual(fallback.getStats().totalEvents, 2);

            assert.strictEqual(fallback.removeBySourcePath('/logs/b.jsonl'), 1);
            assert.strictEqual(fallback.removeEventsForSession('s1'), 1);
            assert.strictEqual(fallback.getEventCount(), 0);
        } finally {
            fallback.close();
        }
    });

    test('upsertEvents with an empty array is a no-op', () => {
        store.upsertEvents([]);
        assert.strictEqual(store.getEvents().length, 0);
    });

    test('getEvents intersects the workspace, tool-array and range filters', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', sessionId: 's1', workspaceId: 'ws-a', tool: 'cursor', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommandEvent({ id: 'e2', sessionId: 's2', workspaceId: 'ws-b', tool: 'cline', timestamp: '2026-01-02T10:00:00.000Z' }),
            makeFileOperationEvent({ id: 'e3', sessionId: 's1', workspaceId: 'ws-a', tool: 'windsurf', filePath: '/repo/src/a.ts', timestamp: '2026-01-03T10:00:00.000Z' }),
        ]);

        assert.deepStrictEqual(store.getEvents({ workspaceId: 'ws-a' }).map((e) => e.id).sort(), ['e1', 'e3']);
        assert.deepStrictEqual(store.getEvents({ tool: ['cursor', 'cline'] }).map((e) => e.id).sort(), ['e1', 'e2']);
        assert.deepStrictEqual(store.getEvents({ filePath: '/repo/src/a.ts' }).map((e) => e.id), ['e3']);
        assert.deepStrictEqual(store.getEvents({ from: '2026-01-02T00:00:00.000Z' }).map((e) => e.id).sort(), ['e2', 'e3']);
        assert.deepStrictEqual(store.getEvents({ to: '2026-01-02T23:59:59.999Z' }).map((e) => e.id).sort(), ['e1', 'e2']);
        assert.deepStrictEqual(store.getEvents({ sessionId: 's1', types: ['command'] }).map((e) => e.id), ['e1']);
    });

    test('countBySourcePath and getEventCount report stored rows', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1', sourcePath: '/logs/a.jsonl' }),
            makeCommandEvent({ id: 'e2', sourcePath: '/logs/a.jsonl' }),
            makeCommandEvent({ id: 'e3', sourcePath: '/logs/b.jsonl' }),
        ]);

        assert.strictEqual(store.countBySourcePath('/logs/a.jsonl'), 2);
        assert.strictEqual(store.countBySourcePath('/logs/missing.jsonl'), 0);
        assert.strictEqual(store.getEventCount(), 3);
    });

    test('pagination arguments are clamped to sane values', () => {
        store.upsertEvents([
            makeCommandEvent({ id: 'e1' }),
            makeCommandEvent({ id: 'e2' }),
            makeCommandEvent({ id: 'e3' }),
        ]);

        assert.strictEqual(store.getEvents({ limit: 0 }).length, 1, 'limit is clamped up to 1');
        assert.strictEqual(store.getEvents({ limit: 99_999 }).length, 3, 'limit above the max still returns matches');
        assert.strictEqual(store.getEvents({ offset: 2 }).length, 1, 'offset skips the first two rows');
        assert.deepStrictEqual(store.getEvents({ offset: -5 }).length, 3, 'negative offsets clamp to 0');
    });
});
