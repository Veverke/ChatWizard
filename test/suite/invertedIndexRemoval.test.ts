// test/suite/invertedIndexRemoval.test.ts
// S5: Inverted index removal is O(session_tokens), not O(total_tokens)

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session, Message } from '../../src/types/index';

// ── Fixture builders ──────────────────────────────────────────────────────────

let _idCounter = 0;

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, words: string[]): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        workspaceId: 'ws-perf',
        messages: [makeMessage('user', words.join(' '))],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
    };
}

/** Generate N distinct words (no collisions between sessions). */
function uniqueWords(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix}word${i}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('S5 — InvertedIndex O(session_tokens) Removal', () => {

    test('removing a session from a 10,000-session index completes in < 5 ms', function() {
        this.timeout(30_000); // generous wall-clock limit for index build

        const engine = new FullTextSearchEngine();
        const SESSION_COUNT = 10_000;
        const WORDS_PER_SESSION = 20;

        // Build a 10K-session index with unique tokens per session
        for (let i = 0; i < SESSION_COUNT; i++) {
            const session = makeSession(`perf-${i}`, uniqueWords(`s${i}_`, WORDS_PER_SESSION));
            engine.index(session);
        }

        assert.strictEqual(engine.size, SESSION_COUNT, 'all sessions indexed');

        // Time the removal of a single session
        const start = performance.now();
        engine.remove('perf-5000');
        const elapsed = performance.now() - start;

        assert.strictEqual(engine.size, SESSION_COUNT - 1, 'session was removed');
        assert.ok(
            elapsed < 5,
            `removal took ${elapsed.toFixed(2)} ms — expected < 5 ms`
        );
    });

    test('removed session is no longer searchable', () => {
        const engine = new FullTextSearchEngine();

        const target = makeSession('s-target', ['findme', 'unique', 'token']);
        const bystander = makeSession('s-bystander', ['findme', 'other', 'content']);
        engine.index(target);
        engine.index(bystander);

        assert.strictEqual(engine.search({ text: 'findme' }).length, 2);

        engine.remove('s-target');

        const results = engine.search({ text: 'findme' });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sessionId, 's-bystander');
    });

    test('re-indexing a session after removal works correctly', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-reindex', ['alpha', 'bravo', 'charlie']);
        engine.index(session);

        engine.remove('s-reindex');
        assert.strictEqual(engine.search({ text: 'alpha' }).length, 0);

        engine.index(session);
        assert.strictEqual(engine.search({ text: 'alpha' }).length, 1);
    });

    test('idempotent re-index clears old tokens via reverse map', () => {
        const engine = new FullTextSearchEngine();

        // Index with one set of tokens
        const v1 = makeSession('s-v1', ['delta', 'echo', 'foxtrot']);
        engine.index(v1);
        assert.strictEqual(engine.search({ text: 'delta' }).length, 1);

        // Re-index same session ID with different tokens
        const v2: Session = {
            ...v1,
            messages: [makeMessage('user', 'golf hotel india')],
        };
        engine.index(v2);

        // Old tokens should be gone
        assert.strictEqual(engine.search({ text: 'delta' }).length, 0);
        // New tokens should be findable
        assert.strictEqual(engine.search({ text: 'golf' }).length, 1);
    });

    test('removing a non-existent session is a no-op', () => {
        const engine = new FullTextSearchEngine();
        engine.index(makeSession('s-exists', ['juliett', 'kilo']));

        assert.doesNotThrow(() => engine.remove('s-ghost'));
        assert.strictEqual(engine.size, 1, 'existing session unaffected');
    });
});
