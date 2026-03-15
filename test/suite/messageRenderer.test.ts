// test/suite/messageRenderer.test.ts
//
// S8 — Markdown Renderer benchmark and correctness tests
// Verifies: pre-compiled regexes, MessageRenderer class, < 5ms for 10KB input.

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { MessageRenderer, markdownToHtml, escapeHtml } from '../../src/views/sessionRenderer';

// ── Fixture: ~10 KB Markdown message ─────────────────────────────────────────

function make10KbMarkdown(): string {
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.\n\n';

    const codeBlock = '```typescript\nfunction greet(name: string): string {\n' +
        '  return `Hello, ${name}!`;\n}\n```\n\n';

    const listSection = '## Features\n\n' +
        '- **Bold item** with inline `code`\n' +
        '- *Italic item* with [a link](https://example.com)\n' +
        '- ~~Strikethrough~~ item\n\n';

    const tableSection = '| Column A | Column B | Column C |\n' +
        '|----------|----------|----------|\n' +
        '| Cell 1   | Cell 2   | Cell 3   |\n' +
        '| Cell 4   | Cell 5   | Cell 6   |\n\n';

    let md = '';
    while (md.length < 10_000) {
        md += paragraph + codeBlock + listSection + tableSection;
    }
    return md.slice(0, 10_000);
}

const MARKDOWN_10KB = make10KbMarkdown();

// ── Benchmark ─────────────────────────────────────────────────────────────────

suite('S8 — MessageRenderer benchmark', () => {
    test('markdownToHtml renders 10 KB in < 5 ms', () => {
        // Warm up (JIT)
        markdownToHtml(MARKDOWN_10KB);

        const start = Date.now();
        markdownToHtml(MARKDOWN_10KB);
        const elapsed = Date.now() - start;

        assert.ok(elapsed < 5, `Expected < 5 ms but took ${elapsed} ms`);
    });

    test('MessageRenderer.markdownToHtml static method delegates correctly', () => {
        const result = MessageRenderer.markdownToHtml('**bold** text');
        assert.ok(result.includes('<strong>bold</strong>'), 'bold rendered');
    });

    test('100 consecutive renders of 10 KB stay under 5 ms each on average', () => {
        const N = 100;
        // Warm up
        for (let i = 0; i < 5; i++) { markdownToHtml(MARKDOWN_10KB); }

        const start = Date.now();
        for (let i = 0; i < N; i++) { markdownToHtml(MARKDOWN_10KB); }
        const avgMs = (Date.now() - start) / N;

        assert.ok(avgMs < 5, `Expected avg < 5 ms but got ${avgMs.toFixed(2)} ms`);
    });
});

// ── Correctness ───────────────────────────────────────────────────────────────

suite('S8 — MessageRenderer correctness', () => {
    test('headings h1–h6', () => {
        for (let lvl = 1; lvl <= 6; lvl++) {
            const result = markdownToHtml(`${'#'.repeat(lvl)} Heading ${lvl}`);
            assert.ok(result.includes(`<h${lvl}>`), `h${lvl} tag present`);
        }
    });

    test('bold, italic, strikethrough inline', () => {
        const result = markdownToHtml('**bold** *italic* ~~strike~~');
        assert.ok(result.includes('<strong>bold</strong>'), 'bold');
        assert.ok(result.includes('<em>italic</em>'), 'italic');
        assert.ok(result.includes('<del>strike</del>'), 'strikethrough');
    });

    test('bold+italic combined', () => {
        const result = markdownToHtml('***bolditalic***');
        assert.ok(result.includes('<strong><em>bolditalic</em></strong>'), 'bold+italic');
    });

    test('fenced code block preserved', () => {
        const result = markdownToHtml('```js\nconsole.log("hi");\n```');
        assert.ok(result.includes('<pre><code'), 'pre+code present');
        assert.ok(result.includes('console.log'), 'code content present');
    });

    test('inline code preserved', () => {
        const result = markdownToHtml('Use `const x = 1` here.');
        assert.ok(result.includes('<code>const x = 1</code>'), 'inline code present');
    });

    test('unordered list', () => {
        const result = markdownToHtml('- item one\n- item two\n- item three');
        assert.ok(result.includes('<ul>'), 'ul tag');
        assert.ok(result.includes('<li>item one</li>'), 'li items');
    });

    test('ordered list', () => {
        const result = markdownToHtml('1. first\n2. second\n3. third');
        assert.ok(result.includes('<ol>'), 'ol tag');
        assert.ok(result.includes('<li>first</li>'), 'li items');
    });

    test('table with alignment', () => {
        const md = '| L | C | R |\n|:--|:-:|--:|\n| a | b | c |';
        const result = markdownToHtml(md);
        assert.ok(result.includes('<table>'), 'table tag');
        assert.ok(result.includes('text-align:center'), 'center align');
        assert.ok(result.includes('text-align:right'), 'right align');
    });

    test('blockquote', () => {
        const result = markdownToHtml('> quoted text');
        assert.ok(result.includes('<blockquote>'), 'blockquote tag');
    });

    test('horizontal rule', () => {
        const result = markdownToHtml('---');
        assert.ok(result.includes('<hr>'), 'hr tag');
    });

    test('link syntax', () => {
        const result = markdownToHtml('[Click here](https://example.com)');
        assert.ok(result.includes('<a href="https://example.com">Click here</a>'), 'link rendered');
    });

    test('escapeHtml sanitises special chars', () => {
        const result = escapeHtml('<script>alert("xss")</script>');
        assert.ok(!result.includes('<script>'), 'no raw script tag');
        assert.ok(result.includes('&lt;script&gt;'), 'escaped correctly');
    });

    test('non-ASCII characters encoded as HTML entities', () => {
        const result = markdownToHtml('Café naïve résumé');
        // Non-ASCII encoded; no raw multi-byte chars
        assert.ok(!result.includes('é'), 'é encoded');
        assert.ok(result.includes('&#'), 'HTML entities present');
    });

    test('empty string returns empty output', () => {
        const result = markdownToHtml('');
        assert.strictEqual(result.trim(), '', 'empty input → empty output');
    });

    test('MessageRenderer class has all expected static methods', () => {
        assert.strictEqual(typeof MessageRenderer.markdownToHtml, 'function');
        assert.strictEqual(typeof MessageRenderer.renderMessage,  'function');
        assert.strictEqual(typeof MessageRenderer.renderChunk,    'function');
    });
});
