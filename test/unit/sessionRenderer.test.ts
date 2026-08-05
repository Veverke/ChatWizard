/**
 * test/unit/sessionRenderer.test.ts
 *
 * Unit tests for sessionRenderer — pure markdown-to-HTML and message rendering.
 */

import * as assert from 'assert';
import { markdownToHtml, escapeHtml, renderMessage, renderChunk, MessageRenderer } from '../../src/views/sessionRenderer';
import type { Message } from '../../src/types/index';

function msg(role: 'user' | 'assistant', content: string, overrides?: Partial<Message>): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [], ...overrides };
}

suite('sessionRenderer', () => {
    suite('escapeHtml', () => {
        test('escapes ampersands', () => {
            assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
        });

        test('escapes angle brackets', () => {
            assert.strictEqual(escapeHtml('<tag>'), '&lt;tag&gt;');
        });

        test('escapes quotes', () => {
            assert.strictEqual(escapeHtml('"quoted"'), '&quot;quoted&quot;');
            assert.strictEqual(escapeHtml("'text'"), '&#39;text&#39;');
        });

        test('removes control characters', () => {
            assert.strictEqual(escapeHtml('a\x00b\x01c'), 'abc');
        });

        test('encodes non-ASCII characters as HTML entities', () => {
            const result = escapeHtml('café');
            assert.ok(result.includes('&#233;'));
        });
    });

    suite('markdownToHtml', () => {
        test('converts plain text to a paragraph', () => {
            const html = markdownToHtml('Hello world');
            assert.ok(html.includes('<p>Hello world</p>'));
        });

        test('converts headings', () => {
            const html = markdownToHtml('# Title\n## Subtitle');
            assert.ok(html.includes('<h1>Title</h1>'));
            assert.ok(html.includes('<h2>Subtitle</h2>'));
        });

        test('converts bold and italic', () => {
            const html = markdownToHtml('**bold** and *italic*');
            assert.ok(html.includes('<strong>bold</strong>'));
            assert.ok(html.includes('<em>italic</em>'));
        });

        test('converts bold+italic', () => {
            const html = markdownToHtml('***both***');
            assert.ok(html.includes('<strong><em>both</em></strong>'));
        });

        test('converts inline code', () => {
            const html = markdownToHtml('Use `code` here');
            assert.ok(html.includes('<code>code</code>'));
        });

        test('converts fenced code blocks', () => {
            const html = markdownToHtml('```js\nconsole.log(1)\n```');
            assert.ok(html.includes('<pre'));
            assert.ok(html.includes('language-js'));
            assert.ok(html.includes('console.log(1)'));
        });

        test('converts unordered lists', () => {
            const html = markdownToHtml('- Item 1\n- Item 2');
            assert.ok(html.includes('<ul>'));
            assert.ok(html.includes('<li>Item 1</li>'));
            assert.ok(html.includes('<li>Item 2</li>'));
        });

        test('converts ordered lists', () => {
            const html = markdownToHtml('1. First\n2. Second');
            assert.ok(html.includes('<ol>'));
            assert.ok(html.includes('<li>First</li>'));
            assert.ok(html.includes('<li>Second</li>'));
        });

        test('converts links', () => {
            const html = markdownToHtml('[text](http://example.com)');
            assert.ok(html.includes('<a href="http://example.com">text</a>'));
        });

        test('converts horizontal rules', () => {
            const html = markdownToHtml('---');
            assert.ok(html.includes('<hr>'));
        });

        test('converts blockquotes', () => {
            const html = markdownToHtml('> quoted text');
            assert.ok(html.includes('<blockquote>'));
            assert.ok(html.includes('quoted text'));
        });

        test('converts strikethrough', () => {
            const html = markdownToHtml('~~strike~~');
            assert.ok(html.includes('<del>strike</del>'));
        });

        test('handles empty string', () => {
            assert.strictEqual(markdownToHtml(''), '');
        });
    });

    suite('renderMessage', () => {
        test('renders user message with correct role class', () => {
            const m = msg('user', 'Hello');
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', undefined);
            assert.ok(html.includes('class="message user'));
            assert.ok(html.includes('>You<'));
        });

        test('renders assistant message with custom label', () => {
            const m = msg('assistant', 'Response');
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Copilot', undefined);
            assert.ok(html.includes('class="message assistant'));
            assert.ok(html.includes('>Copilot<'));
        });

        test('includes timestamp when present', () => {
            const m = msg('user', 'hi', { timestamp: '2024-01-01T00:00:00Z' });
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', undefined);
            assert.ok(html.includes('class="timestamp"'));
        });

        test('omits timestamp when absent', () => {
            const m = msg('user', 'hi');
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', undefined);
            assert.ok(!html.includes('class="timestamp"'));
        });

        test('adds fade style for first 16 messages', () => {
            const m = msg('user', 'fade');
            for (let fi = 0; fi < 16; fi++) {
                const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', fi);
                assert.ok(html.includes(`--cw-i:${fi}`), `Expected fade ${fi}`);
            }
        });

        test('no fade style for index >= 16', () => {
            const m = msg('user', 'no-fade');
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', 16);
            assert.ok(!html.includes('--cw-i'));
        });

        test('renders skipped message with notice', () => {
            const m = msg('user', 'skipped content', { skipped: true, skippedLineLength: 500_000, skippedLineLimit: 100_000 });
            const html = renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', undefined);
            assert.ok(html.includes('skipped-notice'));
            assert.ok(html.includes('488'));
        });
    });

    suite('renderChunk', () => {
        test('renders empty chunk for empty input', () => {
            const result = renderChunk([], [], 0, 0, 'Assistant', false);
            assert.strictEqual(result, '');
        });

        test('renders and caches messages', () => {
            const msgs = [msg('user', 'Hello'), msg('assistant', 'World')];
            const visible = msgs.map((m, i) => ({ msg: m, origIdx: i }));
            const cache: (string | null)[] = [null, null];
            const result = renderChunk(visible, cache, 0, 2, 'Assistant', false);
            assert.ok(result.includes('Hello'));
            assert.ok(result.includes('World'));
            assert.ok(cache[0] !== null);
            assert.ok(cache[1] !== null);
        });

        test('applies fade only to first 16 of chunk when withFade', () => {
            const msgs = [msg('user', 'first'), msg('user', 'second')];
            const visible = msgs.map((m, i) => ({ msg: m, origIdx: i }));
            const cache: (string | null)[] = [null, null];
            const result = renderChunk(visible, cache, 0, 2, 'Assistant', true);
            assert.ok(result.includes('--cw-i:0'));
            assert.ok(result.includes('--cw-i:1'));
        });
    });

    suite('MessageRenderer (static wrapper)', () => {
        test('markdownToHtml static method works', () => {
            const html = MessageRenderer.markdownToHtml('Hello');
            assert.ok(html.includes('<p>Hello</p>'));
        });

        test('renderMessage static method works', () => {
            const m = msg('user', 'static');
            const html = MessageRenderer.renderMessage(m, 0, 0, [{ msg: m, origIdx: 0 }], 'Assistant', undefined);
            assert.ok(html.includes('static'));
        });

        test('renderChunk static method works', () => {
            const msgs = [msg('user', 'chunk')];
            const visible = msgs.map((m, i) => ({ msg: m, origIdx: i }));
            const cache: (string | null)[] = [null];
            const html = MessageRenderer.renderChunk(visible, cache, 0, 1, 'Assistant', false);
            assert.ok(html.includes('chunk'));
        });
    });
});