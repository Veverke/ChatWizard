// test/suite/tokenCounter.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { countTokens } from '../../src/analytics/tokenCounter';

suite('countTokens — claude source', () => {
    test('empty string returns 0', () => {
        assert.strictEqual(countTokens('', 'claude'), 0);
    });

    test('short text uses char-based formula Math.ceil(length / 4)', () => {
        const text = 'hello'; // length=5 → ceil(5/4) = 2
        assert.strictEqual(countTokens(text, 'claude'), Math.ceil(text.length / 4));
    });

    test('long text uses char-based formula Math.ceil(length / 4)', () => {
        const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
        assert.strictEqual(countTokens(text, 'claude'), Math.ceil(text.length / 4));
    });

    test('whitespace-only text — length still counted by char formula', () => {
        const text = '     '; // length=5 → ceil(5/4) = 2
        assert.strictEqual(countTokens(text, 'claude'), Math.ceil(text.length / 4));
    });

    test('punctuation-only text uses char-based formula', () => {
        const text = '!!!???...'; // length=9 → ceil(9/4) = 3
        assert.strictEqual(countTokens(text, 'claude'), Math.ceil(text.length / 4));
    });
});

suite('countTokens — copilot source', () => {
    test('empty string returns 0', () => {
        assert.strictEqual(countTokens('', 'copilot'), 0);
    });

    test('single word uses word-based formula Math.ceil(words * 1.3)', () => {
        assert.strictEqual(countTokens('hello', 'copilot'), Math.ceil(1 * 1.3));
    });

    test('multi-word text uses word-based formula Math.ceil(words * 1.3)', () => {
        const text = 'the quick brown fox'; // 4 words → ceil(4 * 1.3) = 6
        assert.strictEqual(countTokens(text, 'copilot'), Math.ceil(4 * 1.3));
    });

    test('whitespace-only text has no real words and returns 0', () => {
        assert.strictEqual(countTokens('     ', 'copilot'), 0);
        assert.strictEqual(countTokens('\t\n  \r', 'copilot'), 0);
    });

    test('punctuation/special chars with no whitespace count as one word', () => {
        assert.strictEqual(countTokens('!!!???', 'copilot'), Math.ceil(1 * 1.3));
    });

    test('leading and trailing whitespace does not affect word count', () => {
        const text = '  hello world  '; // 2 words
        assert.strictEqual(countTokens(text, 'copilot'), Math.ceil(2 * 1.3));
    });

    test('multiple internal spaces are treated as one separator', () => {
        const text = 'foo   bar   baz'; // 3 words
        assert.strictEqual(countTokens(text, 'copilot'), Math.ceil(3 * 1.3));
    });
});

suite('countTokens — formula verification', () => {
    test('copilot result matches Math.ceil(wordCount * 1.3) exactly', () => {
        const cases: [string, number][] = [
            ['one', 1],
            ['one two three four five', 5],
            ['a b c d e f g h i j', 10],
        ];
        for (const [text, expectedWords] of cases) {
            const expected = Math.ceil(expectedWords * 1.3);
            assert.strictEqual(
                countTokens(text, 'copilot'),
                expected,
                `"${text}": expected ${expected}`
            );
        }
    });

    test('claude result matches Math.ceil(length / 4) exactly', () => {
        const cases = ['a', 'ab', 'abc', 'abcd', 'abcde', 'hello world'];
        for (const text of cases) {
            const expected = Math.ceil(text.length / 4);
            assert.strictEqual(
                countTokens(text, 'claude'),
                expected,
                `"${text}": expected ${expected}`
            );
        }
    });

    test('copilot and claude produce different results for same prose text', () => {
        const text = 'Please refactor this TypeScript function to improve readability';
        const copilotTokens = countTokens(text, 'copilot');
        const claudeTokens = countTokens(text, 'claude');
        assert.ok(copilotTokens > 0, 'copilot tokens should be > 0');
        assert.ok(claudeTokens > 0, 'claude tokens should be > 0');
    });
});
