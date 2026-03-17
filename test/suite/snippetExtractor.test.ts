import * as assert from 'assert';
import { extractSnippet, findFirstMatch } from '../../src/search/snippetExtractor';

suite('extractSnippet', () => {
    test('match in the middle â€” snippet has context on both sides, offsets point to match', () => {
        const content = 'The quick brown fox jumps over the lazy dog';
        // match: "fox" at offset 16, length 3
        const offset = content.indexOf('fox');
        const result = extractSnippet(content, offset, 3, 10);

        const extracted = result.snippet.slice(result.matchStart, result.matchEnd);
        assert.strictEqual(extracted, 'fox');
        assert.ok(result.snippet.includes('brown'));
        assert.ok(result.snippet.includes('jumps'));
    });

    test('match at the start â€” no leading ellipsis, matchStart = 0', () => {
        const content = 'Hello world, this is a test';
        // match: "Hello" at offset 0, length 5
        const result = extractSnippet(content, 0, 5, 10);

        assert.strictEqual(result.matchStart, 0);
        assert.strictEqual(result.matchEnd, 5);
        assert.ok(!result.snippet.startsWith('â€¦'));
        assert.strictEqual(result.snippet.slice(result.matchStart, result.matchEnd), 'Hello');
    });

    test('match at the end â€” no trailing ellipsis', () => {
        const content = 'Hello world, this is a test ending';
        const matchWord = 'ending';
        const offset = content.indexOf(matchWord);
        const result = extractSnippet(content, offset, matchWord.length, 10);

        assert.ok(!result.snippet.endsWith('â€¦'));
        assert.strictEqual(result.snippet.slice(result.matchStart, result.matchEnd), matchWord);
    });

    test('content shorter than 2*contextChars â€” returns full content, offsets equal match position in content', () => {
        const content = 'Short text';
        const offset = content.indexOf('text');
        const result = extractSnippet(content, offset, 4, 100);

        assert.strictEqual(result.snippet, content);
        assert.strictEqual(result.matchStart, offset);
        assert.strictEqual(result.matchEnd, offset + 4);
    });

    test('ellipsis prepended when window starts mid-content', () => {
        const content = 'AAAAAAAAAA BBBBBBBBBB match CCCCCCCCCC DDDDDDDDDD';
        const offset = content.indexOf('match');
        const result = extractSnippet(content, offset, 5, 3);

        assert.ok(result.snippet.startsWith('…'));
        assert.strictEqual(result.snippet.slice(result.matchStart, result.matchEnd), 'match');
    });

    test('ellipsis appended when window ends before content end', () => {
        const content = 'AAAAAAAAAA BBBBBBBBBB match CCCCCCCCCC DDDDDDDDDD';
        const offset = content.indexOf('match');
        const result = extractSnippet(content, offset, 5, 3);

        assert.ok(result.snippet.endsWith('…'));
        assert.strictEqual(result.snippet.slice(result.matchStart, result.matchEnd), 'match');
    });
});

suite('findFirstMatch', () => {
    test('string query found case-insensitively', () => {
        const content = 'The Quick Brown Fox';
        const result = findFirstMatch(content, 'quick');

        assert.ok(result !== undefined);
        assert.strictEqual(result.offset, 4);
        assert.strictEqual(result.length, 5);
    });

    test('string query not found returns undefined', () => {
        const content = 'Hello world';
        const result = findFirstMatch(content, 'xyz');

        assert.strictEqual(result, undefined);
    });

    test('RegExp match returns correct offset and length', () => {
        const content = 'foo 123 bar 456';
        const result = findFirstMatch(content, /\d+/);

        assert.ok(result !== undefined);
        assert.strictEqual(result.offset, 4);
        assert.strictEqual(result.length, 3);
    });

    test('RegExp no match returns undefined', () => {
        const content = 'no digits here';
        const result = findFirstMatch(content, /\d+/);

        assert.strictEqual(result, undefined);
    });
});

