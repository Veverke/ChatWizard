/**
 * test/unit/logEventStoreFallback.test.ts
 *
 * Regression tests for the watch-logs in-memory fallback.
 *
 * Background: `LogService` used to throw when the SQLite backend could not be
 * opened (missing/incompatible better-sqlite3 native binding in the extension
 * dev host, unwritable shared cache dir, newer shared schema, …). That
 * exception aborted the whole watch-logs UI registration in `activate()`, so
 * the three contributed views stayed empty and `chatwizard.execCommands.refresh`
 * reported "command not found" when its title-bar button was clicked.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryLogEventStore } from '../../src/logs/logEventStore';
import { LogService } from '../../src/logs/logService';
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

function makeFileOperation(overrides: Partial<LogEvent> & { id: string }): LogEvent {
    return {
        type: 'fileOperation',
        tool: 'cline',
        timestamp: '2026-01-01T10:00:00.000Z',
        operationType: 'edit',
        filePath: '/repo/src/app.ts',
        ...overrides,
    } as LogEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-log-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('LogEventStore – in-memory fallback', () => {
    test('stores events and returns them newest first by default', () => {
        const store = new InMemoryLogEventStore(tmpDir());
        store.open();

        store.upsertEvents([
            makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', timestamp: '2026-01-01T10:02:00.000Z' }),
            makeCommand({ id: 'c3', timestamp: '2026-01-01T10:01:00.000Z' }),
        ]);

        try {
            assert.strictEqual(store.isPersistent, false);
            assert.strictEqual(store.getEventCount(), 3);
            assert.deepStrictEqual(store.getEvents().map((e) => e.id), ['c2', 'c3', 'c1']);
            assert.deepStrictEqual(
                store.getEvents({ order: 'asc' }).map((e) => e.id),
                ['c1', 'c3', 'c2']
            );
        } finally {
            store.close();
        }
    });

    test('applies the same AND-combined filters as the SQL store', () => {
        const store = new InMemoryLogEventStore(tmpDir());
        store.open();

        store.upsertEvents([
            makeCommand({ id: 'c1', sessionId: 's1', tool: 'copilot', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', sessionId: 's1', tool: 'cline', timestamp: '2026-01-02T10:00:00.000Z' }),
            makeCommand({ id: 'c3', sessionId: 's2', tool: 'copilot', timestamp: '2026-01-03T10:00:00.000Z' }),
            makeFileOperation({ id: 'f1', sessionId: 's1', workspaceId: 'ws-1', filePath: '/repo/a.ts' }),
        ]);

        try {
            assert.deepStrictEqual(store.getEvents({ sessionId: 's1' }).map((e) => e.id).sort(), ['c1', 'c2', 'f1']);
            assert.deepStrictEqual(store.getEvents({ type: 'command', sessionId: 's1' }).map((e) => e.id).sort(), ['c1', 'c2']);
            assert.deepStrictEqual(store.getEvents({ types: ['fileOperation'] }).map((e) => e.id), ['f1']);
            assert.deepStrictEqual(store.getEvents({ tool: ['copilot'] }).map((e) => e.id).sort(), ['c1', 'c3']);
            assert.deepStrictEqual(store.getEvents({ filePath: '/repo/a.ts' }).map((e) => e.id), ['f1']);
            assert.deepStrictEqual(store.getEvents({ workspaceId: 'ws-1' }).map((e) => e.id), ['f1']);
            assert.deepStrictEqual(
                store.getEvents({ from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z', type: 'command' })
                    .map((e) => e.id),
                ['c2']
            );
            assert.deepStrictEqual(store.getEvents({ limit: 1, offset: 1 }).map((e) => e.id), ['c2']);
        } finally {
            store.close();
        }
    });

    test('removes by session / source path, reports stats and clears', () => {
        const store = new InMemoryLogEventStore(tmpDir());
        store.open();

        store.upsertEvents([
            makeCommand({ id: 'c1', sessionId: 's1', sourcePath: '/logs/a.jsonl' }),
            makeCommand({ id: 'c2', sessionId: 's2', sourcePath: '/logs/a.jsonl' }),
            makeFileOperation({ id: 'f1', sessionId: 's1', sourcePath: '/logs/b.jsonl' }),
        ]);

        try {
            assert.strictEqual(store.countBySourcePath('/logs/a.jsonl'), 2);
            assert.strictEqual(store.removeBySourcePath('/logs/a.jsonl'), 2);
            assert.strictEqual(store.getEventCount(), 1);
            assert.strictEqual(store.removeEventsForSession('s1'), 1);
            assert.strictEqual(store.getEventCount(), 0);

            store.upsertEvent(makeCommand({ id: 'c9' }));
            const stats = store.getStats();
            assert.strictEqual(stats.totalEvents, 1);
            assert.strictEqual(stats.byType.command, 1);
            assert.strictEqual(stats.byType.diff, 0);
            assert.deepStrictEqual(stats.tools, ['cursor']);

            store.clear();
            assert.strictEqual(store.getEventCount(), 0);
        } finally {
            store.close();
        }
    });

    test('LogService degrades to memory instead of throwing when SQLite cannot open', () => {
        // A regular file cannot act as a directory for the DB file, so opening
        // the SQLite store fails deterministically — independently of whether
        // the native binding happens to be built in the current environment.
        const filePath = path.join(tmpDir(), 'not-a-directory');
        fs.writeFileSync(filePath, 'not a directory');

        const service = new LogService(filePath);
        try {
            assert.strictEqual(service.isPersistent, false);
            assert.ok(service.storeError, 'storeError should explain the fallback');
            assert.ok(service.store.isOpen, 'fallback store should be open');

            service.ingestEvent(makeCommand({ id: 'c1', sessionId: 's1', commandText: 'npm run build' }));
            assert.strictEqual(service.getEvents().length, 1);
            assert.strictEqual(service.getEvents({ sessionId: 's1' })[0].id, 'c1');
            assert.strictEqual(service.getEventCountForSource('/logs/none.jsonl'), 0);
            assert.strictEqual(service.removeEventsForSession('s1'), 1);
            assert.strictEqual(service.getEvents().length, 0);
        } finally {
            service.dispose();
        }
    });
});
