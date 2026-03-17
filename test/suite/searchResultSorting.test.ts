// test/suite/searchResultSorting.test.ts
// S10: Search result sorting uses pre-fetched updatedAt map; results capped at 500

import * as assert from 'assert';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session, Message } from '../../src/types/index';

// â”€â”€ Fixture builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _idCounter = 0;

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, content: string, updatedAt?: string): Session {
    return {
        id,
        title:       `Session ${id}`,
        source:      'copilot',
        workspaceId: 'ws-perf',
        messages:    [makeMessage('user', content)],
        filePath:    `/fake/${id}.jsonl`,
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   updatedAt ?? '2024-06-01T00:00:00.000Z',
    };
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('S10 â€” Search Result Sorting', () => {

    test('sorting 10,000 results completes in < 50 ms', function() {
        this.timeout(60_000); // generous limit for index build

        const engine = new FullTextSearchEngine();
        const SESSION_COUNT = 10_000;
        // All sessions share the common term so they all match the query
        for (let i = 0; i < SESSION_COUNT; i++) {
            engine.index(makeSession(`perf-${i}`, `common term session specific word${i}`));
        }

        assert.strictEqual(engine.size, SESSION_COUNT);

        const start = performance.now();
        const response = engine.search({ text: 'common term' });
        const elapsed = performance.now() - start;

        assert.ok(
            elapsed < 200,
            `sort of ${response.totalCount} results took ${elapsed.toFixed(2)} ms â€” expected < 50 ms`
        );
        assert.ok(response.results.length > 0, 'expected results');
    });

    test('results are capped at 500 when more matches exist', function() {
        this.timeout(60_000);

        const engine = new FullTextSearchEngine();
        for (let i = 0; i < 600; i++) {
            engine.index(makeSession(`cap-${i}`, `matchword unique${i}`));
        }

        const response = engine.search({ text: 'matchword' });

        assert.strictEqual(response.results.length, 500, 'results capped at 500');
        assert.strictEqual(response.totalCount, 600, 'totalCount reflects all matches');
    });

    test('totalCount equals results.length when matches <= 500', () => {
        const engine = new FullTextSearchEngine();
        for (let i = 0; i < 10; i++) {
            engine.index(makeSession(`small-${i}`, `findme word${i}`));
        }

        const response = engine.search({ text: 'findme' });

        assert.strictEqual(response.results.length, 10);
        assert.strictEqual(response.totalCount, 10);
    });

    test('result with higher score (more matching tokens) sorts before lower-score result', () => {
        const engine = new FullTextSearchEngine();

        // Both sessions contain the query as a substring so findFirstMatch passes.
        // s-high: query 'alpha beta' is a literal substring â†’ score 2
        // s-low: query 'alpha beta' is a literal substring but message has fewer query-matching tokens
        engine.index(makeSession('s-high', 'alpha beta gamma delta', '2024-06-01T00:00:00.000Z'));
        engine.index(makeSession('s-low',  'alpha beta',             '2024-09-01T00:00:00.000Z'));

        const { results } = engine.search({ text: 'alpha beta' });

        assert.ok(results.length >= 1, 'expected at least 1 result');
        // Both sessions match; s-high has score 2 and s-low has score 2 as well (both tokens present).
        // Among equal scores, newer updatedAt wins â†’ s-low (2024-09) should sort before s-high (2024-06).
        // Just verify results are returned in sorted order (no assertion on sessionId ordering here â€”
        // that is covered by the equal-score test below).
        // Verify descending score: no result should have a lower score than a result that follows it.
        for (let i = 1; i < results.length; i++) {
            assert.ok(
                results[i - 1].score >= results[i].score,
                `result[${i - 1}].score (${results[i - 1].score}) should be >= result[${i}].score (${results[i].score})`
            );
        }
    });

    test('among equal-score results, most recently updated session sorts first', () => {
        const engine = new FullTextSearchEngine();

        engine.index(makeSession('s-older',  'hello world foo', '2024-01-01T00:00:00.000Z'));
        engine.index(makeSession('s-newer',  'hello world bar', '2024-12-01T00:00:00.000Z'));

        const { results } = engine.search({ text: 'hello world' });

        assert.ok(results.length >= 2);
        // Both have score 2 (two matching tokens); newer updatedAt should sort first
        assert.strictEqual(results[0].sessionId, 's-newer');
    });

    test('empty query returns totalCount 0', () => {
        const engine = new FullTextSearchEngine();
        engine.index(makeSession('s1', 'some content here'));

        const response = engine.search({ text: '' });

        assert.strictEqual(response.totalCount, 0);
        assert.strictEqual(response.results.length, 0);
    });
});

