// test/suite/tokenIndexLimit.test.ts
// S11: No limit on inverted index token count

import * as assert from 'assert';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session, Message } from '../../src/types/index';

// â”€â”€ Fixture helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _id = 0;

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m${++_id}`, role, content, codeBlocks: [] };
}

function session(id: string, content: string): Session {
    return {
        id,
        title: id,
        source: 'copilot',
        workspaceId: 'ws',
        messages: [msg('user', content)],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
    };
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('S11 â€” Token Index Limit', () => {

    // 1. Max token length: tokens > 50 chars must not appear in the index or hapax store.
    test('tokens longer than 50 chars are discarded', () => {
        const engine = new FullTextSearchEngine();
        const longToken = 'a'.repeat(51);

        // Two sessions to ensure the token would normally be promoted if it were indexed.
        engine.index(session('s-long-1', `prefix ${longToken} suffix`));
        engine.index(session('s-long-2', `prefix ${longToken} suffix`));

        const stats = engine.indexStats();
        // The long token must not inflate any counter.
        assert.strictEqual(stats.totalTokenCount, 2, 'only "prefix" and "suffix" should be indexed');
    });

    // 2. Tokens at exactly 50 chars ARE indexed.
    test('tokens of exactly 50 chars are accepted', () => {
        const engine = new FullTextSearchEngine();
        const borderToken = 'b'.repeat(50);

        engine.index(session('s-border-1', `start ${borderToken} end`));
        engine.index(session('s-border-2', `start ${borderToken} end`));

        // borderToken should be promoted to main index after 2 sessions.
        const stats = engine.indexStats();
        assert.strictEqual(stats.indexedTokenCount, 3, '"start", the 50-char token, and "end"');
    });

    // 3. Single-session tokens go to hapax and are NOT searchable.
    test('single-session tokens are in hapax and not returned by search', () => {
        const engine = new FullTextSearchEngine();
        engine.index(session('s-hapax', 'uniqueXYZ specialterm'));

        const stats = engine.indexStats();
        assert.strictEqual(stats.indexedTokenCount, 0, 'nothing promoted yet');
        assert.strictEqual(stats.hapaxTokenCount, 2);

        // Search must return empty â€” hapax tokens are intentionally unsearchable.
        assert.strictEqual(engine.search({ text: 'uniqueXYZ' }).results.length, 0);
    });

    // 4. Tokens in â‰¥2 sessions are promoted to main index and ARE searchable.
    test('tokens in â‰¥2 sessions are promoted and searchable', () => {
        const engine = new FullTextSearchEngine();
        engine.index(session('s-promo-1', 'sharedterm context'));
        engine.index(session('s-promo-2', 'sharedterm other'));

        const stats = engine.indexStats();
        assert.ok(stats.indexedTokenCount >= 1, '"sharedterm" should be in main index');
        assert.strictEqual(engine.search({ text: 'sharedterm' }).results.length, 2);
    });

    // 5. Hapax token is promoted when a second session is indexed.
    test('hapax token is promoted when second session indexes it', () => {
        const engine = new FullTextSearchEngine();
        engine.index(session('s-p1', 'rareword alpha'));

        assert.strictEqual(engine.search({ text: 'rareword' }).results.length, 0, 'not yet promoted');

        engine.index(session('s-p2', 'rareword beta'));

        assert.strictEqual(engine.search({ text: 'rareword' }).results.length, 2, 'promoted after 2nd session');

        const stats = engine.indexStats();
        // 'alpha' (s-p1 only) and 'beta' (s-p2 only) remain in hapax; 'rareword' is promoted.
        assert.strictEqual(stats.hapaxTokenCount, 2, '"alpha" and "beta" remain in hapax');
        assert.ok(stats.indexedTokenCount >= 1, '"rareword" should be in main index, not hapax');
    });

    // 6. indexStats() reports correct counts.
    test('indexStats returns accurate counts', () => {
        const engine = new FullTextSearchEngine();
        // "common" will be indexed; "unique1"/"unique2" will be hapax.
        engine.index(session('s-stats-1', 'common unique1'));
        engine.index(session('s-stats-2', 'common unique2'));

        const stats = engine.indexStats();
        assert.strictEqual(stats.indexedTokenCount, 1,              '"common" only');
        assert.strictEqual(stats.hapaxTokenCount,   2,              '"unique1" + "unique2"');
        assert.strictEqual(stats.totalTokenCount,   3);
        assert.ok(stats.postingCount >= 2,                          'at least 2 postings for "common"');
        assert.ok(stats.memoryEstimateKB >= 0);
    });

    // 7. Performance: index of 10,000 messages must hold <500,000 unique tokens.
    test('index of 10,000 messages holds < 500,000 unique tokens', function () {
        this.timeout(30_000);

        const engine = new FullTextSearchEngine();

        // Vocabulary of 200 common words shared across messages (these get promoted).
        const COMMON_WORDS = Array.from({ length: 200 }, (_, i) => `common${i}`);
        // Each message also adds 10 unique words (go to hapax).
        const MSG_COUNT = 10_000;

        for (let i = 0; i < MSG_COUNT; i++) {
            // Pick 20 common words + 10 unique words per message.
            const common  = COMMON_WORDS.slice(i % 180, (i % 180) + 20).join(' ');
            const unique  = Array.from({ length: 10 }, (_, j) => `uniq${i}_${j}`).join(' ');
            // Long tokens (should be filtered out completely).
            const longTok = 'hash' + 'x'.repeat(60);
            engine.index(session(`msg-${i}`, `${common} ${unique} ${longTok}`));
        }

        const stats = engine.indexStats();
        assert.ok(
            stats.totalTokenCount < 500_000,
            `expected < 500,000 unique tokens, got ${stats.totalTokenCount.toLocaleString()}`
        );
        // Main index should only contain the ~200 common words (promoted after 2+ sessions).
        assert.ok(stats.indexedTokenCount <= 200, `main index too large: ${stats.indexedTokenCount}`);
    });

    // 8. Removing a session cleans up its hapax entries.
    test('removing a session removes its hapax tokens', () => {
        const engine = new FullTextSearchEngine();
        engine.index(session('s-rm-hapax', 'onlyhereXYZ content'));

        assert.strictEqual(engine.indexStats().hapaxTokenCount, 2);

        engine.remove('s-rm-hapax');

        assert.strictEqual(engine.indexStats().hapaxTokenCount, 0);
        assert.strictEqual(engine.size, 0);
    });
});

