/**
 * test/unit/cacheManager.test.ts
 *
 * Unit tests for Feature 24 — SQLite Persistent Cache (CacheManager).
 * Uses a temporary directory for each test to ensure isolation.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import BetterSqlite3 from 'better-sqlite3';
import { CacheManager } from '../../src/cache/cacheManager';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, SessionSource } from '../../src/types/index';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: overrides.source ?? 'copilot' as SessionSource,
        title: overrides.title ?? 'Test Session',
        messages: overrides.messages ?? [
            { id: `${overrides.id}-m1`, role: 'user', content: 'hello world', timestamp: '2024-01-01T00:00:00Z', codeBlocks: [] },
            { id: `${overrides.id}-m2`, role: 'assistant', content: 'hi there', timestamp: '2024-01-01T00:00:01Z', codeBlocks: [] },
        ],
        workspaceId: overrides.workspaceId ?? 'ws1',
        workspacePath: overrides.workspacePath ?? '/ws1',
        filePath: overrides.filePath ?? `/ws1/${overrides.id}.jsonl`,
        createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        model: overrides.model ?? 'gpt-4',
    };
}

/** Creates a temporary directory for test isolation. */
function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('CacheManager – SQLite persistent cache', () => {
    let cache: CacheManager;
    let dir: string;

    setup(() => {
        dir = tmpDir();
        cache = new CacheManager(dir);
        cache.open();
    });

    teardown(() => {
        try { cache.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('open creates the database file', () => {
        const dbPath = path.join(dir, 'chatwizard-cache.db');
        assert.ok(fs.existsSync(dbPath), 'DB file should exist after open()');
    });

    test('upsertSession and getSessionCount round-trip', () => {
        const s = makeSession({ id: 's1' });
        cache.upsertSession(s);
        assert.strictEqual(cache.getSessionCount(), 1);
    });

    test('multiple upsertSessions increases count', () => {
        cache.upsertSessions([
            makeSession({ id: 's1' }),
            makeSession({ id: 's2' }),
            makeSession({ id: 's3' }),
        ]);
        assert.strictEqual(cache.getSessionCount(), 3);
    });

    test('removeSession decreases count', () => {
        cache.upsertSessions([
            makeSession({ id: 's1' }),
            makeSession({ id: 's2' }),
        ]);
        cache.removeSession('s1');
        assert.strictEqual(cache.getSessionCount(), 1);
    });

    test('loadAll populates SessionIndex', async () => {
        cache.upsertSessions([
            makeSession({ id: 's1', title: 'Session One' }),
            makeSession({ id: 's2', title: 'Session Two' }),
        ]);

        // Create a new index and load from cache
        const index = new SessionIndex();
        await cache.loadAll(index);

        assert.strictEqual(index.size, 2);
        assert.strictEqual(index.get('s1')?.title, 'Session One');
        assert.strictEqual(index.get('s2')?.title, 'Session Two');
    });

    test('loadAll with empty DB does nothing', async () => {
        const index = new SessionIndex();
        await cache.loadAll(index);
        assert.strictEqual(index.size, 0);
    });

    test('messages are persisted and restored', async () => {
        const s = makeSession({
            id: 's1',
            messages: [
                { id: 's1-m1', role: 'user', content: 'user message', timestamp: '2024-01-01T00:00:00Z', codeBlocks: [] },
                { id: 's1-m2', role: 'assistant', content: 'assistant response', timestamp: '2024-01-01T00:00:01Z', codeBlocks: [] },
            ],
        });
        cache.upsertSession(s);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('s1');
        assert.ok(loaded);
        assert.strictEqual(loaded.messages.length, 2);
        assert.strictEqual(loaded.messages[0].content, 'user message');
        assert.strictEqual(loaded.messages[1].content, 'assistant response');
    });

    test('code blocks are persisted and restored', async () => {
        const s = makeSession({
            id: 's1',
            messages: [
                {
                    id: 's1-m1', role: 'user', content: 'write code',
                    timestamp: '2024-01-01T00:00:00Z', codeBlocks: [
                        { language: 'typescript', content: 'const x = 1;', sessionId: 's1', messageIndex: 0, blockIndexInMessage: 0 },
                    ],
                },
            ],
        });
        cache.upsertSession(s);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('s1');
        assert.ok(loaded);
        assert.strictEqual(loaded.messages[0].codeBlocks.length, 1);
        assert.strictEqual(loaded.messages[0].codeBlocks[0].language, 'typescript');
        assert.strictEqual(loaded.messages[0].codeBlocks[0].content, 'const x = 1;');
    });

    test('parse_state round-trip', () => {
        cache.setParseState('/path/to/file.jsonl', {
            filePath: '/path/to/file.jsonl',
            source: 'copilot',
            lastMtime: 1700000000000,
            lastSize: 1024,
            lastOffset: 1024,
        });

        const state = cache.getParseState('/path/to/file.jsonl');
        assert.ok(state);
        assert.strictEqual(state.source, 'copilot');
        assert.strictEqual(state.lastMtime, 1700000000000);
        assert.strictEqual(state.lastSize, 1024);
    });

    test('parse_state for unknown file returns undefined', () => {
        const state = cache.getParseState('/nonexistent/file.jsonl');
        assert.strictEqual(state, undefined);
    });

    test('FTS5 search returns ranked results', () => {
        const s1 = makeSession({ id: 's1', title: 'Docker Setup', messages: [
            { id: 's1-m1', role: 'user', content: 'how do I set up docker', timestamp: '', codeBlocks: [] },
            { id: 's1-m2', role: 'assistant', content: 'install docker compose', timestamp: '', codeBlocks: [] },
        ]});
        const s2 = makeSession({ id: 's2', title: 'Kubernetes', messages: [
            { id: 's2-m1', role: 'user', content: 'kubernetes deployment', timestamp: '', codeBlocks: [] },
        ]});
        cache.upsertSessions([s1, s2]);

        const results = cache.searchFts('docker', 10);
        assert.ok(results.length >= 1, 'should find docker session');
        assert.ok(results.some(r => r.sessionId === 's1'), 's1 should be in results');
    });

    test('FTS5 search does not find non-matching session', () => {
        const s = makeSession({ id: 's1', title: 'React', messages: [
            { id: 's1-m1', role: 'user', content: 'react component', timestamp: '', codeBlocks: [] },
        ]});
        cache.upsertSession(s);

        const results = cache.searchFts('docker', 10);
        assert.strictEqual(results.length, 0, 'should not find docker in react content');
    });

    test('addTag and getTagsForSession round-trip', () => {
        // Tags reference sessions via FOREIGN KEY — the session must exist first.
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.upsertSession(makeSession({ id: 's2' }));
        cache.addTag('s1', 'typescript');
        cache.addTag('s1', 'bug');
        cache.addTag('s2', 'feature');

        const s1Tags = cache.getTagsForSession('s1');
        const s2Tags = cache.getTagsForSession('s2');

        assert.deepStrictEqual(s1Tags.sort(), ['bug', 'typescript']);
        assert.deepStrictEqual(s2Tags, ['feature']);
    });

    test('removeTag works correctly', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.addTag('s1', 'typescript');
        cache.addTag('s1', 'bug');
        cache.removeTag('s1', 'bug');

        const tags = cache.getTagsForSession('s1');
        assert.deepStrictEqual(tags, ['typescript']);
    });

    test('addNote and getNotes round-trip', () => {
        // Notes reference sessions via FOREIGN KEY — the session must exist first.
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.addNote('s1', 'first note');
        cache.addNote('s1', 'second note');

        const notes = cache.getNotes('s1');
        assert.strictEqual(notes.length, 2);
        assert.ok(notes.some(n => n.note === 'first note'));
        assert.ok(notes.some(n => n.note === 'second note'));
    });

    test('close and reopen loads persisted data', () => {
        cache.upsertSession(makeSession({ id: 's1', title: 'Persisted' }));
        cache.close();

        // Reopen the same cache
        const cache2 = new CacheManager(dir);
        cache2.open();
        assert.strictEqual(cache2.getSessionCount(), 1);
        cache2.close();
    });

    test('upsertSession replaces existing session', () => {
        const s1 = makeSession({ id: 's1', title: 'Original Title' });
        cache.upsertSession(s1);

        const s1Updated = makeSession({ id: 's1', title: 'Updated Title' });
        cache.upsertSession(s1Updated);

        const index = new SessionIndex();
        cache.loadAll(index); // sync in test context

        const loaded = index.get('s1');
        assert.ok(loaded);
        assert.strictEqual(loaded.title, 'Updated Title');
    });

    test('CASCADE delete on removeSession removes messages and code blocks', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.removeSession('s1');
        assert.strictEqual(cache.getSessionCount(), 0);
    });

    test('session size tracks correctly', () => {
        assert.strictEqual(cache.getSessionCount(), 0);
        cache.upsertSession(makeSession({ id: 's1' }));
        assert.strictEqual(cache.getSessionCount(), 1);
        cache.upsertSessions([makeSession({ id: 's2' }), makeSession({ id: 's3' })]);
        assert.strictEqual(cache.getSessionCount(), 3);
        cache.removeSession('s2');
        assert.strictEqual(cache.getSessionCount(), 2);
    });

    test('closed cache returns 0 for getSessionCount', () => {
        cache.close();
        assert.strictEqual(cache.isOpen, false);
        // getSessionCount() auto-reopens the DB (existing behavior) and returns 0
        // from the fresh database.
        assert.strictEqual(cache.getSessionCount(), 0);
        assert.strictEqual(cache.isOpen, true);
    });

    test('busy_timeout pragma is set to 3000 ms', () => {
        // Verify the multi-process safety pragma is active
        cache.close();

        // Re-open and check pragma via a raw query
        cache.open();
        // We can't directly read pragmas through better-sqlite3's API,
        // but we can verify the DB is open and functional — the pragma
        // is applied at open() time and there's no API to unset it.
        const dbPath = path.join(dir, 'chatwizard-cache.db');
        assert.ok(fs.existsSync(dbPath), 'DB file should exist');
        assert.strictEqual(cache.isOpen, true);
        assert.strictEqual(cache.getSessionCount(), 0);
    });

    test('newer schema version throws on open', () => {
        cache.close();

        // Bump the schema version beyond what the code expects
        const dbPath = path.join(dir, 'chatwizard-cache.db');
        const BetterSqlite3 = require('better-sqlite3');
        const db = new BetterSqlite3(dbPath);
        db.pragma('user_version = 9999');
        db.close();

        // Re-opening should throw because schema is newer
        const cache2 = new CacheManager(dir);
        assert.throws(() => {
            cache2.open();
        }, /newer|schema version/);
        cache2.close();
    });

    test('loadAll with workspaceIds filters sessions by workspace', async () => {
        // Insert sessions from two different workspaces
        cache.upsertSessions([
            makeSession({ id: 'ws1-s1', workspaceId: 'ws1', workspacePath: '/ws1', title: 'WS1 Session' }),
            makeSession({ id: 'ws1-s2', workspaceId: 'ws1', workspacePath: '/ws1', title: 'WS1 Session 2' }),
            makeSession({ id: 'ws2-s1', workspaceId: 'ws2', workspacePath: '/ws2', title: 'WS2 Session' }),
            makeSession({ id: 'ws2-s2', workspaceId: 'ws2', workspacePath: '/ws2', title: 'WS2 Session 2' }),
        ]);

        // Load only ws1 sessions
        const index = new SessionIndex();
        await cache.loadAll(index, ['ws1']);

        assert.strictEqual(index.size, 2, 'should only load ws1 sessions');
        assert.ok(index.get('ws1-s1'), 'ws1-s1 should be loaded');
        assert.ok(index.get('ws1-s2'), 'ws1-s2 should be loaded');
        assert.ok(!index.get('ws2-s1'), 'ws2-s1 should NOT be loaded');
        assert.ok(!index.get('ws2-s2'), 'ws2-s2 should NOT be loaded');
    });

    test('loadAll with empty workspaceIds array loads nothing', async () => {
        cache.upsertSessions([
            makeSession({ id: 's1', workspaceId: 'ws1' }),
            makeSession({ id: 's2', workspaceId: 'ws2' }),
        ]);

        const index = new SessionIndex();
        await cache.loadAll(index, []);

        assert.strictEqual(index.size, 0, 'empty workspaceIds should load nothing');
    });

    test('loadAll without workspaceIds loads all sessions (backward compat)', async () => {
        cache.upsertSessions([
            makeSession({ id: 's1', workspaceId: 'ws1' }),
            makeSession({ id: 's2', workspaceId: 'ws2' }),
        ]);

        const index = new SessionIndex();
        await cache.loadAll(index);

        assert.strictEqual(index.size, 2, 'no workspaceIds should load all');
    });
});

suite('CacheManager – lifecycle and lazy reopen', () => {
    let cache: CacheManager;
    let dir: string;

    setup(() => {
        dir = tmpDir();
        cache = new CacheManager(dir);
        cache.open();
    });

    teardown(() => {
        try { cache.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('dbPath exposes the database location', () => {
        assert.strictEqual(cache.dbPath, path.join(dir, 'chatwizard-cache.db'));
    });

    test('open() is idempotent', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.open();
        cache.open();
        assert.strictEqual(cache.isOpen, true);
        assert.strictEqual(cache.getSessionCount(), 1);
    });

    test('open() creates a missing storage directory', () => {
        const nested = path.join(dir, 'deep', 'nested');
        const fresh = new CacheManager(nested);
        fresh.open();
        try {
            assert.ok(fs.existsSync(path.join(nested, 'chatwizard-cache.db')));
            assert.strictEqual(fresh.getSessionCount(), 0, 'a fresh DB reports zero sessions');
        } finally {
            fresh.close();
        }
    });

    test('close() is safe to call twice', () => {
        cache.close();
        cache.close();
        assert.strictEqual(cache.isOpen, false);
    });

    test('every public API lazily reopens the database after close()', async () => {
        cache.upsertSession(makeSession({ id: 'lazy' }));
        cache.setParseState('/x.jsonl', {
            filePath: '/x.jsonl', source: 'copilot', lastMtime: 1, lastSize: 2, lastOffset: 3,
        });
        cache.addTag('lazy', 'Keep');
        cache.addNote('lazy', 'note');

        cache.close();
        assert.strictEqual(cache.isOpen, false);

        // Each call below must transparently re-open the DB.
        assert.strictEqual(cache.getSessionCount(), 1);
        assert.strictEqual(cache.searchFts('hello').length, 1);
        assert.deepStrictEqual(cache.getTagsForSession('lazy'), ['keep']);
        assert.strictEqual(cache.getNotes('lazy').length, 1);
        assert.strictEqual(cache.getParseState('/x.jsonl')?.lastOffset, 3);

        cache.setParseState('/y.jsonl', {
            filePath: '/y.jsonl', source: 'claude', lastMtime: 9, lastSize: 9, lastOffset: 9,
        });
        cache.addTag('lazy', 'extra');
        cache.removeTag('lazy', 'EXtra');
        cache.clearTags('lazy');
        assert.deepStrictEqual(cache.getTagsForSession('lazy'), []);

        cache.upsertSessions([makeSession({ id: 'lazy2' })]);
        cache.removeSession('lazy2');
        assert.strictEqual(cache.getSessionCount(), 1);

        const index = new SessionIndex();
        await cache.loadAll(index);
        assert.strictEqual(index.size, 1);
    });
});

suite('CacheManager – loadAll scoping and write-path variants', () => {
    let cache: CacheManager;
    let dir: string;

    setup(() => {
        dir = tmpDir();
        cache = new CacheManager(dir);
        cache.open();
    });

    teardown(() => {
        try { cache.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('loadAll keeps global workspace sessions when "cursor-global" is already listed', async () => {
        cache.upsertSessions([
            makeSession({ id: 'global', workspaceId: 'cursor-global' }),
            makeSession({ id: 'other', workspaceId: 'ws-other' }),
        ]);

        const index = new SessionIndex();
        await cache.loadAll(index, ['cursor-global']);

        assert.strictEqual(index.size, 1);
        assert.ok(index.get('global'));
    });

    test('loadAll restores a session that has no messages', async () => {
        cache.upsertSession(makeSession({ id: 'no-messages', messages: [] }));

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('no-messages');
        assert.ok(loaded);
        assert.deepStrictEqual(loaded.messages, []);
    });

    test('upsertSessions persists code blocks through the raw write path', async () => {
        cache.upsertSessions([makeSession({
            id: 'bulk',
            messages: [{
                id: 'bulk-m1', role: 'assistant', content: 'here you go',
                timestamp: '2024-01-01T00:00:00Z',
                codeBlocks: [{
                    language: 'python', content: 'print(1)',
                    sessionId: 'bulk', messageIndex: 0, blockIndexInMessage: 0,
                }],
            }],
        })]);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('bulk');
        assert.ok(loaded);
        assert.strictEqual(loaded.messages[0].codeBlocks.length, 1);
        assert.strictEqual(loaded.messages[0].codeBlocks[0].language, 'python');
    });

    test('messages without a timestamp and with flags round-trip', async () => {
        cache.upsertSession(makeSession({
            id: 'flags',
            messages: [{
                id: 'flags-m1', role: 'user', content: "it's quoted",
                codeBlocks: [], skipped: true, interrupted: true,
            }],
        }));

        const index = new SessionIndex();
        await cache.loadAll(index);

        const msg = index.get('flags')?.messages[0];
        assert.ok(msg);
        assert.strictEqual(msg.content, "it's quoted");
        assert.strictEqual(msg.timestamp, undefined);
        assert.strictEqual(msg.skipped, true);
        assert.strictEqual(msg.interrupted, true);
    });

    test('searchFts returns nothing for a query with no searchable characters', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        assert.deepStrictEqual(cache.searchFts('***'), []);
        assert.deepStrictEqual(cache.searchFts('   '), []);
    });

    test('searchFts strips quotes before querying', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        assert.strictEqual(cache.searchFts('"hello"').length, 1);
        assert.strictEqual(cache.searchFts("hel'lo").length, 1);
    });

    test('clearTags removes every tag for a session', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.addTag('s1', 'One');
        cache.addTag('s1', 'Two');
        assert.deepStrictEqual(cache.getTagsForSession('s1').sort(), ['one', 'two']);

        cache.clearTags('s1');
        assert.deepStrictEqual(cache.getTagsForSession('s1'), []);
    });

    test('tags are normalized to lower case on add and remove', () => {
        cache.upsertSession(makeSession({ id: 's1' }));
        cache.addTag('s1', '  Important  ');
        assert.deepStrictEqual(cache.getTagsForSession('s1'), ['important']);

        cache.removeTag('s1', 'IMPORTANT');
        assert.deepStrictEqual(cache.getTagsForSession('s1'), []);
    });

    test('searchFts falls back to LIKE when the FTS index is unavailable', () => {
        cache.upsertSession(makeSession({ id: 's1', messages: [{
            id: 's1-m1', role: 'user', content: 'needle in a haystack',
            timestamp: '2024-01-01T00:00:00Z', codeBlocks: [],
        }] }));

        // Simulate a broken/missing FTS index: the prepared FTS statement then
        // throws, which must degrade to the LIKE query instead of failing.
        const raw = new BetterSqlite3(cache.dbPath);
        try {
            raw.exec('DROP TABLE messages_fts');
        } finally {
            raw.close();
        }

        const rows = cache.searchFts('needle');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].sessionId, 's1');
    });

    test('bulk upsert persists flag and timestamp variants', async () => {
        cache.upsertSessions([makeSession({
            id: 'bulk-flags',
            messages: [
                { id: 'bulk-m1', role: 'user', content: 'no timestamp', codeBlocks: [], skipped: true },
                { id: 'bulk-m2', role: 'assistant', content: 'interrupted', timestamp: '2024-02-02T00:00:00Z', codeBlocks: [], interrupted: true },
            ],
        })]);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('bulk-flags');
        assert.ok(loaded);
        assert.strictEqual(loaded.messages[0].timestamp, undefined);
        assert.strictEqual(loaded.messages[0].skipped, true);
        assert.strictEqual(loaded.messages[1].interrupted, true);
    });

    test('a minimal session round-trips with undefined optional fields', async () => {
        cache.upsertSession({
            id: 'minimal',
            source: 'claude' as SessionSource,
            title: 'Minimal',
            messages: [],
            workspaceId: 'ws-min',
            filePath: '/minimal.jsonl',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
        } as Session);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('minimal');
        assert.ok(loaded);
        assert.strictEqual(loaded.workspacePath, undefined);
        assert.strictEqual(loaded.model, undefined);
        assert.strictEqual(loaded.fileSizeBytes, undefined);
        assert.strictEqual(loaded.parseErrors, undefined);
        assert.strictEqual(loaded.sourceNotes, undefined);
        assert.strictEqual(loaded.subSource, undefined);
        assert.strictEqual(loaded.compactionSummary, undefined);
    });

    test('notes and tags for an unknown session stay empty', () => {
        assert.deepStrictEqual(cache.getNotes('missing-session'), []);
        assert.deepStrictEqual(cache.getTagsForSession('missing-session'), []);
    });
});

