// test/suite/messageRenderer.test.ts
//
// S8 â€” Markdown Renderer benchmark and correctness tests
// Verifies: pre-compiled regexes, MessageRenderer class, < 5ms for 10KB input.

import * as assert from 'assert';
import { MessageRenderer, markdownToHtml, escapeHtml, renderMessage, renderChunk } from '../../src/views/sessionRenderer';
import { Message } from '../../src/types/index';

// â”€â”€ Fixture: ~10 KB Markdown message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Benchmark â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('S8 â€” MessageRenderer benchmark', () => {
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

// â”€â”€ Correctness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('S8 â€” MessageRenderer correctness', () => {
    test('headings h1â€“h6', () => {
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
        assert.ok(result.includes('<pre') && result.includes('<code'), 'pre+code present');
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
        const result = markdownToHtml('CafÃ© naÃ¯ve rÃ©sumÃ©');
        // Non-ASCII encoded; no raw multi-byte chars
        assert.ok(!result.includes('Ã©'), 'Ã© encoded');
        assert.ok(result.includes('&#'), 'HTML entities present');
    });

    test('empty string returns empty output', () => {
        const result = markdownToHtml('');
        assert.strictEqual(result.trim(), '', 'empty input â†’ empty output');
    });

    test('MessageRenderer class has all expected static methods', () => {
        assert.strictEqual(typeof MessageRenderer.markdownToHtml, 'function');
        assert.strictEqual(typeof MessageRenderer.renderMessage,  'function');
        assert.strictEqual(typeof MessageRenderer.renderChunk,    'function');
    });
});

// ---------------------------------------------------------------------------
// renderMessage — branch coverage for skipped/unanswered/timestamp cases
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<Message> & { id: string; role: 'user' | 'assistant'; content: string }): Message {
    return {
        codeBlocks: [],
        ...overrides,
    };
}

function makeVisible(msgs: Message[]): import('../../src/views/sessionRenderer').VisibleMessage[] {
    return msgs.map((msg, i) => ({ msg, origIdx: i }));
}

suite('renderMessage — branch coverage', () => {
    test('skipped message renders skipped-notice without skippedLineLength', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: '', skipped: true });
        const visible = makeVisible([msg]);
        const html = renderMessage(msg, 0, 0, visible, 'Assistant', undefined);
        assert.ok(html.includes('skipped-notice'));
        assert.ok(html.includes('?&nbsp;KB'));
    });

    test('skipped message renders with skippedLineLength when set', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: '', skipped: true, skippedLineLength: 51200, skippedLineLimit: 5120 });
        const visible = makeVisible([msg]);
        const html = renderMessage(msg, 0, 0, visible, 'Assistant', undefined);
        assert.ok(html.includes('skipped-notice'));
        // skippedLineLength = 51200 → 50 KB
        assert.ok(html.includes('50'));
    });

    test('message with timestamp renders timestamp span', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: 'Hello', timestamp: '2024-01-15T10:00:00Z' });
        const visible = makeVisible([msg, makeMsg({ id: 'm2', role: 'assistant', content: 'Hi' })]);
        const html = renderMessage(msg, 0, 0, visible, 'Assistant', undefined);
        assert.ok(html.includes('class="timestamp"'));
    });

    test('unanswered user message (followed by another user) with hasAssistant=true shows aborted notice', () => {
        const userMsg1 = makeMsg({ id: 'm1', role: 'user', content: 'Question 1' });
        const userMsg2 = makeMsg({ id: 'm2', role: 'user', content: 'Question 2' });
        const assistantMsg = makeMsg({ id: 'm3', role: 'assistant', content: 'Answer' });
        const visible = makeVisible([userMsg1, userMsg2, assistantMsg]);
        const html = renderMessage(userMsg1, 0, 0, visible, 'Assistant', undefined);
        assert.ok(html.includes('aborted-notice'));
        assert.ok(html.includes('cancelled or incomplete'));
    });

    test('user message with no assistant in session shows not-stored notice', () => {
        const userMsg1 = makeMsg({ id: 'm1', role: 'user', content: 'Question 1' });
        const userMsg2 = makeMsg({ id: 'm2', role: 'user', content: 'Question 2' });
        const visible = makeVisible([userMsg1, userMsg2]);
        const html = renderMessage(userMsg1, 0, 0, visible, 'Assistant', undefined);
        assert.ok(html.includes('not stored locally'));
    });

    test('assistant message is rendered normally without placeholder', () => {
        const msg = makeMsg({ id: 'm1', role: 'assistant', content: 'Hello there!' });
        const visible = makeVisible([msg]);
        const html = renderMessage(msg, 0, 0, visible, 'Claude', undefined);
        assert.ok(html.includes('Hello there!'));
        assert.ok(!html.includes('aborted-notice'));
    });

    test('fadeIdx < 16 applies fade style', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: 'Hello' });
        const visible = makeVisible([msg, makeMsg({ id: 'm2', role: 'assistant', content: 'Hi' })]);
        const html = renderMessage(msg, 0, 0, visible, 'Assistant', 5);
        assert.ok(html.includes('--cw-i:5'));
    });

    test('fadeIdx >= 16 does not apply fade style', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: 'Hello' });
        const visible = makeVisible([msg, makeMsg({ id: 'm2', role: 'assistant', content: 'Hi' })]);
        const html = renderMessage(msg, 0, 0, visible, 'Assistant', 20);
        assert.ok(!html.includes('--cw-i:20'));
    });
});

// ---------------------------------------------------------------------------
// MessageRenderer static methods — function coverage
// ---------------------------------------------------------------------------
suite('MessageRenderer static methods', () => {
    test('MessageRenderer.renderMessage delegates to standalone renderMessage', () => {
        const msg = makeMsg({ id: 'm1', role: 'user', content: 'Static test' });
        const visible = makeVisible([msg, makeMsg({ id: 'm2', role: 'assistant', content: 'Hi' })]);
        const html = MessageRenderer.renderMessage(msg, 0, 0, visible, 'Copilot', 3);
        assert.ok(html.includes('Static test'));
    });

    test('MessageRenderer.renderChunk delegates to standalone renderChunk', () => {
        const m1 = makeMsg({ id: 'm1', role: 'user', content: 'Question' });
        const m2 = makeMsg({ id: 'm2', role: 'assistant', content: 'Answer' });
        const visible = makeVisible([m1, m2]);
        const cache: (string | null)[] = [null, null];
        const html = MessageRenderer.renderChunk(visible, cache, 0, 2, 'Copilot', false);
        assert.ok(html.includes('Question'));
        assert.ok(html.includes('Answer'));
    });
});

