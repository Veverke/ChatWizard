// test/suite/tokenizeQuery.test.ts
//
// Unit tests for the tokenizeQuery() function and STOP_WORDS set.
//
// Bugs these tests would catch:
//   Bug: Stop words not filtered, polluting keyword scoring with non-distinctive tokens.
//   Bug: De-pluralization not applied, so "errors" does not match sessions indexed as "error".
//   Bug: De-pluralization applied to short tokens (<4 chars), mangling words like "bus" → "bu".
//   Bug: De-pluralization applied to words not ending in 's', producing corrupt stems.
//   Bug: Empty query panics or returns unexpected tokens.
//   Bug: Computing generic nouns (file, code, data) not filtered, causing false positives.

import * as assert from 'assert';
import { tokenizeQuery, STOP_WORDS } from '../../src/search/fullTextEngine';

suite('tokenizeQuery', () => {

    // ── Basic filtering ─────────────────────────────────────────────────────

    test('returns empty array for empty string', () => {
        assert.deepStrictEqual(tokenizeQuery(''), []);
    });

    test('filters out common stop words', () => {
        const stopWordsInQuery = 'the and or but for in on at to by as an a';
        const result = tokenizeQuery(stopWordsInQuery);
        assert.strictEqual(result.length, 0, 'all tokens are stop words, result should be empty');
    });

    test('preserves topically meaningful tokens', () => {
        const result = tokenizeQuery('TypeScript generics React hooks');
        assert.ok(result.includes('typescript'), 'typescript should be preserved');
        assert.ok(result.includes('generics'), 'generics should be preserved (or its stem)');
        assert.ok(result.includes('react'), 'react should be preserved');
    });

    test('lowercases all tokens', () => {
        const result = tokenizeQuery('WebSocket Authentication');
        assert.ok(result.includes('websocket'), 'should be lowercased');
        assert.ok(result.includes('authentication'), 'should be lowercased');
        assert.ok(!result.includes('WebSocket'), 'uppercase form should not appear');
    });

    // ── Stop-word coverage for key categories ───────────────────────────────

    test('filters out pronoun stop words', () => {
        const result = tokenizeQuery('i me my we our you your he she his her it its they their them');
        assert.strictEqual(result.length, 0, 'all pronouns are stop words');
    });

    test('filters out auxiliary verb stop words', () => {
        const result = tokenizeQuery('is are was were has have had do does did will would could');
        assert.strictEqual(result.length, 0, 'all auxiliaries are stop words');
    });

    test('filters out generic computing nouns', () => {
        // file, code, data, value, type, item, list are all stop words
        const result = tokenizeQuery('file code data value type item list');
        assert.strictEqual(result.length, 0, 'generic computing nouns should be filtered');
    });

    test('filters out generic infra nouns: server, system, process, service, instance', () => {
        const result = tokenizeQuery('server system process service instance');
        assert.strictEqual(result.length, 0, 'generic infra nouns should be filtered');
    });

    test('mixed: stop words removed while topic words kept', () => {
        const result = tokenizeQuery('how to implement authentication middleware');
        // 'how', 'to' are stop words; 'implement' is a stop word too ('use', 'make' are but 'implement' isn't)
        assert.ok(!result.includes('how'), '"how" is a stop word');
        assert.ok(!result.includes('to'), '"to" is a stop word');
        assert.ok(result.includes('authentication'), 'authentication must be kept');
        assert.ok(result.includes('middleware'), 'middleware must be kept');
    });

    // ── De-pluralization ────────────────────────────────────────────────────

    test('de-pluralizes: "hooks" produces both "hooks" and "hook"', () => {
        const result = tokenizeQuery('react hooks');
        assert.ok(result.includes('hooks'), '"hooks" should be in result');
        assert.ok(result.includes('hook'), 'stem "hook" should also be added');
    });

    test('de-pluralizes: "errors" produces both "errors" and "error"', () => {
        const result = tokenizeQuery('handling errors');
        assert.ok(result.includes('errors'), '"errors" should be in result');
        assert.ok(result.includes('error'), 'stem "error" should also be added');
    });

    test('de-pluralizes: "tests" produces both "tests" and "test"', () => {
        const result = tokenizeQuery('unit tests');
        assert.ok(result.includes('tests'), '"tests" should be present');
        assert.ok(result.includes('test'), '"test" stem should be added');
    });

    test('does NOT de-pluralize short tokens under 4 chars', () => {
        // "bus" = 3 chars, should NOT produce "bu"
        const result = tokenizeQuery('bus');
        assert.ok(!result.includes('bu'), '"bu" should not appear (token < 4 chars)');
    });

    test('does NOT de-pluralize tokens not ending in s', () => {
        const result = tokenizeQuery('format');
        assert.ok(!result.some(t => t === 'forma'), '"forma" should not appear');
    });

    test('de-pluralization produces stem with at least 3 chars', () => {
        // "keys" (4 chars) → stem "key" (3 chars) — valid
        const result = tokenizeQuery('object keys');
        const hasShortStem = result.some(t => t.length < 3);
        assert.ok(!hasShortStem, 'no stem shorter than 3 chars should appear');
    });

    // ── Result is deduplicated (Set semantics) ───────────────────────────────

    test('does not return duplicate tokens', () => {
        const result = tokenizeQuery('authentication authentication');
        const unique = new Set(result);
        assert.strictEqual(result.length, unique.size, 'result must not contain duplicates');
    });

    // ── STOP_WORDS completeness checks ──────────────────────────────────────

    test('STOP_WORDS contains core articles and prepositions', () => {
        for (const word of ['the', 'and', 'or', 'in', 'on', 'at', 'to', 'of', 'a', 'an']) {
            assert.ok(STOP_WORDS.has(word), `"${word}" should be a stop word`);
        }
    });

    test('STOP_WORDS contains generic computing nouns', () => {
        for (const word of ['file', 'code', 'data', 'value', 'type', 'server', 'system']) {
            assert.ok(STOP_WORDS.has(word), `"${word}" should be a stop word`);
        }
    });
});
