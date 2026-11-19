/**
 * test/unit/cacheManager.removedTurns.test.ts
 *
 * Unit tests for Feature 51 — removing a turn from a conversation and keeping
 * the original conversation in the chat DB (`removed_turns`).
 *
 * Uses a temporary directory per test so every test starts from an empty DB.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CacheManager } from '../../src/cache/cacheManager';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, SessionSource, Message } from '../../src/types/index';

function makeMessage(overrides: Partial<Message> & { id: string; content: string }): Message {
    return {
        role: overrides.role ?? 'user',
        codeBlocks: overrides.codeBlocks ?? [],
        timestamp: overrides.timestamp,
        ...overrides,
    } as Message;
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: overrides.source ?? 'copilot' as SessionSource,
        title: overrides.title ?? 'Removed turns session',
        messages: overrides.messages ?? [
            makeMessage({ id: `${overrides.id}-m1`, role: 'user', content: 'first prompt needle-one' }),
            makeMessage({ id: `${overrides.id}-m2`, role: 'assistant', content: 'first answer haystack' }),
            makeMessage({ id: `${overrides.id}-m3`, role: 'user', content: 'second prompt' }),
            makeMessage({ id: `${overrides.id}-m4`, role: 'assistant', content: 'second answer' }),
        ],
        workspaceId: overrides.workspaceId ?? 'ws1',
        workspacePath: overrides.workspacePath ?? '/ws1',
        filePath: overrides.filePath ?? `/ws1/${overrides.id}.jsonl`,
        createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        model: overrides.model ?? 'gpt-4',
    };
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-removed-turns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('CacheManager – removed turns (Feature 51)', () => {
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


    test('removeTurn archives the full payload of the removed turn', () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);

        const removed = cache.removeTurn('s1', 1, session.messages[1]);

        assert.strictEqual(removed.messageId, 's1-m2');
        assert.strictEqual(removed.messageIndex, 1);
        assert.strictEqual(removed.role, 'assistant');
        assert.strictEqual(removed.content, 'first answer haystack');
        assert.ok(removed.removedAt.length > 0);

        assert.strictEqual(cache.getRemovedTurnCount('s1'), 1);
        const turns = cache.getRemovedTurns('s1');
        assert.strictEqual(turns.length, 1);
        assert.strictEqual(turns[0].content, 'first answer haystack');
    });

    test('removeTurn drops the turn from the FTS index', () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);
        assert.strictEqual(cache.searchFts('haystack').length, 1, 'indexed before removal');

        cache.removeTurn('s1', 1, session.messages[1]);

        assert.strictEqual(cache.searchFts('haystack').length, 0, 'not searchable after removal');
    });

    test('loadAll flags removed messages but keeps their content in the session', async () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);
        cache.removeTurn('s1', 1, session.messages[1]);

        const index = new SessionIndex();
        await cache.loadAll(index);

        const loaded = index.get('s1');
        assert.ok(loaded);
        assert.strictEqual(loaded!.messages.length, 4, 'indices must stay stable');
        assert.strictEqual(loaded!.messages[1].removed, true);
        assert.strictEqual(loaded!.messages[1].content, 'first answer haystack');
        assert.ok(!loaded!.messages[0].removed);
        assert.ok(!loaded!.messages[2].removed);
    });

    test('the removal survives a re-parse (fresh session object without flags)', async () => {
        const first = makeSession({ id: 's1' });
        cache.upsertSession(first);
        cache.removeTurn('s1', 1, first.messages[1]);

        // A re-parse produces brand-new Message objects without `removed`.
        const reparsed = makeSession({ id: 's1', updatedAt: '2024-01-02T00:00:00Z' });
        cache.upsertSession(reparsed);

        assert.strictEqual(reparsed.messages[1].removed, true, 'upsert must re-apply the removal');

        const index = new SessionIndex();
        await cache.loadAll(index);
        assert.strictEqual(index.get('s1')!.messages[1].removed, true);

        // And the removed content is still not searchable.
        assert.strictEqual(cache.searchFts('haystack').length, 0);
    });

    test('code blocks of a removed turn do not survive the round-trip', async () => {
        const session = makeSession({
            id: 's1',
            messages: [
                makeMessage({
                    id: 's1-m1', role: 'assistant', content: 'has code',
                    codeBlocks: [{
                        language: 'ts', content: 'const a = 1;', sessionId: 's1',
                        messageIndex: 0, blockIndexInMessage: 0,
                    }],
                }),
            ],
        });
        cache.upsertSession(session);
        cache.removeTurn('s1', 0, session.messages[0]);

        const index = new SessionIndex();
        await cache.loadAll(index);
        const loaded = index.get('s1')!;
        assert.strictEqual(loaded.messages.length, 1);
        assert.strictEqual(loaded.messages[0].codeBlocks.length, 0);
        assert.strictEqual(index.getAllCodeBlocks().length, 0);
    });

    test('getOriginalSession returns the conversation as it was before the removal', () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);
        cache.removeTurn('s1', 1, session.messages[1]);
        cache.removeTurn('s1', 3, session.messages[3]);

        const original = cache.getOriginalSession('s1');
        assert.ok(original);
        assert.strictEqual(original!.messages.length, 4);
        assert.deepStrictEqual(
            original!.messages.map(m => m.content),
            ['first prompt needle-one', 'first answer haystack', 'second prompt', 'second answer']
        );
        assert.ok(original!.messages.every(m => !m.removed), 'original view has no removal flags');
    });

    test('getOriginalSession merges archived payloads that are no longer stored as messages', () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);
        cache.removeTurn('s1', 1, session.messages[1]);

        // Simulate the source file losing the turn: only messages 0, 2 and 3 remain.
        const shrunk = makeSession({
            id: 's1',
            messages: [session.messages[0], session.messages[2], session.messages[3]],
        });
        cache.upsertSession(shrunk);

        const original = cache.getOriginalSession('s1');
        assert.ok(original);
        assert.strictEqual(original!.messages.length, 4);
        assert.ok(
            original!.messages.some(m => m.content === 'first answer haystack'),
            'the archived turn must be merged back in'
        );
    });

    test('getRemovedTurnCount is 0 for a session without removals', () => {
        cache.upsertSession(makeSession({ id: 'clean' }));
        assert.strictEqual(cache.getRemovedTurnCount('clean'), 0);
        assert.deepStrictEqual(cache.getRemovedTurns('clean'), []);
    });

    test('removeSession also drops the removal records', () => {
        const session = makeSession({ id: 's1' });
        cache.upsertSession(session);
        cache.removeTurn('s1', 0, session.messages[0]);
        assert.strictEqual(cache.getRemovedTurnCount('s1'), 1);

        cache.removeSession('s1');
        assert.strictEqual(cache.getRemovedTurnCount('s1'), 0);
    });
});

