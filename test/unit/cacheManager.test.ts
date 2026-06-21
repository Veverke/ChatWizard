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
        cache.addTag('s1', 'typescript');
        cache.addTag('s1', 'bug');
        cache.addTag('s2', 'feature');

        const s1Tags = cache.getTagsForSession('s1');
        const s2Tags = cache.getTagsForSession('s2');

        assert.deepStrictEqual(s1Tags.sort(), ['bug', 'typescript']);
        assert.deepStrictEqual(s2Tags, ['feature']);
    });

    test('removeTag works correctly', () => {
        cache.addTag('s1', 'typescript');
        cache.addTag('s1', 'bug');
        cache.removeTag('s1', 'bug');

        const tags = cache.getTagsForSession('s1');
        assert.deepStrictEqual(tags, ['typescript']);
    });

    test('addNote and getNotes round-trip', () => {
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
        assert.strictEqual(cache.getSessionCount(), 0);
        assert.strictEqual(cache.isOpen, false);
    });
});