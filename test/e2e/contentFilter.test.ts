// test/e2e/contentFilter.test.ts
// Feature 38 — MCP tools: includeCode flag

import * as assert from 'assert';
import { stripCodeBlocks } from '../../src/utils/contentFilter';

suite('stripCodeBlocks', () => {
    test('removes a single fenced code block', () => {
        const input = 'Before\n```\nconst x = 1;\n```\nAfter';
        const result = stripCodeBlocks(input);
        assert.ok(!result.includes('const x = 1'), 'code content should be removed');
        assert.ok(result.includes('[code block omitted]'), 'placeholder should be present');
        assert.ok(result.includes('Before'), 'prose before block should be preserved');
        assert.ok(result.includes('After'), 'prose after block should be preserved');
    });

    test('removes multiple fenced code blocks', () => {
        const input = 'A\n```js\ncode1();\n```\nB\n```python\ncode2()\n```\nC';
        const result = stripCodeBlocks(input);
        assert.ok(!result.includes('code1()'), 'first block content should be removed');
        assert.ok(!result.includes('code2()'), 'second block content should be removed');
        assert.strictEqual((result.match(/\[code block omitted\]/g) ?? []).length, 2,
            'should have exactly 2 placeholders for 3 fenced blocks');
        assert.ok(result.includes('A'), 'prose A preserved');
        assert.ok(result.includes('B'), 'prose B preserved');
        assert.ok(result.includes('C'), 'prose C preserved');
    });

    test('removes inline code spans longer than 40 characters', () => {
        const longCode = 'a'.repeat(41);
        const input = `Text \`${longCode}\` more text`;
        const result = stripCodeBlocks(input);
        assert.ok(!result.includes(longCode), 'long inline code should be removed');
        assert.ok(result.includes('[code block omitted]'), 'placeholder should be present');
        assert.ok(result.includes('Text'), 'prose should be preserved');
        assert.ok(result.includes('more text'), 'prose should be preserved');
    });

    test('preserves inline code spans of exactly 40 characters', () => {
        const code40 = 'a'.repeat(40);
        const input = `Text \`${code40}\` end`;
        const result = stripCodeBlocks(input);
        assert.ok(result.includes(`\`${code40}\``), 'exactly-40-char inline code should be preserved');
    });

    test('preserves inline code spans shorter than 40 characters', () => {
        const input = 'Call `myFunction()` to start.';
        const result = stripCodeBlocks(input);
        assert.ok(result.includes('`myFunction()`'), 'short inline code should be preserved');
    });

    test('preserves plain prose with no code blocks', () => {
        const input = 'This is just plain text without any code.';
        const result = stripCodeBlocks(input);
        assert.strictEqual(result, input);
    });

    test('returns empty string for empty input', () => {
        assert.strictEqual(stripCodeBlocks(''), '');
    });

    test('handles fenced block with language label', () => {
        const input = '```typescript\ninterface Foo { bar: string; }\n```';
        const result = stripCodeBlocks(input);
        assert.ok(!result.includes('interface Foo'), 'TS code should be removed');
        assert.ok(result.includes('[code block omitted]'), 'placeholder present');
    });

    test('handles multiple inline code spans mixed with prose', () => {
        const short = 'short';
        const long = 'x'.repeat(50);
        const input = `Use \`${short}\` or \`${long}\` as needed.`;
        const result = stripCodeBlocks(input);
        assert.ok(result.includes(`\`${short}\``), 'short code preserved');
        assert.ok(!result.includes(long), 'long code removed');
        assert.ok(result.includes('[code block omitted]'), 'placeholder present');
    });
});