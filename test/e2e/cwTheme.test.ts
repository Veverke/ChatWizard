// test/e2e/cwTheme.test.ts
// Tests for src/webview/cwTheme.ts pure string-returning functions.

import * as assert from 'assert';
import { cwThemeCss, syntaxHighlighterCss, syntaxHighlighterJs, cwInteractiveJs } from '../../src/webview/cwTheme';

suite('cwThemeCss', () => {
    test('returns a non-empty string', () => {
        const result = cwThemeCss();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('contains CSS custom property definitions', () => {
        const result = cwThemeCss();
        assert.ok(result.includes('--cw-'), `Expected --cw- CSS vars, got snippet: ${result.slice(0, 200)}`);
    });

    test('contains dark theme selector', () => {
        const result = cwThemeCss();
        assert.ok(result.includes('vscode-dark') || result.includes('.vscode-dark'),
            'Expected dark theme class in CSS');
    });

    test('contains light theme selector', () => {
        const result = cwThemeCss();
        assert.ok(result.includes('vscode-light'), 'Expected light theme class in CSS');
    });

    test('contains --cw-accent variable', () => {
        const result = cwThemeCss();
        assert.ok(result.includes('--cw-accent'), 'Expected --cw-accent variable');
    });

    test('is idempotent (same output on multiple calls)', () => {
        assert.strictEqual(cwThemeCss(), cwThemeCss());
    });
});

suite('syntaxHighlighterCss', () => {
    test('returns a non-empty string', () => {
        const result = syntaxHighlighterCss();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('contains CSS content (has braces)', () => {
        const result = syntaxHighlighterCss();
        assert.ok(result.includes('{') && result.includes('}'),
            'Expected CSS braces in syntax highlighter CSS');
    });

    test('is idempotent', () => {
        assert.strictEqual(syntaxHighlighterCss(), syntaxHighlighterCss());
    });
});

suite('syntaxHighlighterJs', () => {
    test('returns a non-empty string', () => {
        const result = syntaxHighlighterJs();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('contains JavaScript content (function or var or const)', () => {
        const result = syntaxHighlighterJs();
        assert.ok(
            result.includes('function') || result.includes('const') || result.includes('var') || result.includes('=>'),
            `Expected JS content, got snippet: ${result.slice(0, 200)}`
        );
    });

    test('is idempotent', () => {
        assert.strictEqual(syntaxHighlighterJs(), syntaxHighlighterJs());
    });

    test('emits parseable JavaScript', () => {
        // Regression: an escape written with a single backslash inside the
        // template literal (`'\n'`) becomes a *real* newline in the emitted
        // script — a syntax error that silently kills the whole inline
        // <script> block. Escapes must be doubled (`'\\n'`).
        const result = syntaxHighlighterJs();
        // eslint-disable-next-line no-new-func
        assert.doesNotThrow(() => new Function(result), 'syntaxHighlighterJs must parse as JavaScript');
        assert.ok(result.includes("indexOf('\\n', i)"), 'the newline escape must survive into the script');
    });
});

suite('cwInteractiveJs', () => {
    test('returns a non-empty string', () => {
        const result = cwInteractiveJs();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('contains JavaScript content', () => {
        const result = cwInteractiveJs();
        assert.ok(
            result.includes('function') || result.includes('const') || result.includes('addEventListener') || result.includes('=>'),
            `Expected JS content, got snippet: ${result.slice(0, 200)}`
        );
    });

    test('is idempotent', () => {
        assert.strictEqual(cwInteractiveJs(), cwInteractiveJs());
    });

    test('emits parseable JavaScript', () => {
        // Every panel that embeds this script would silently lose its buttons
        // if a stray escape broke the block, so parse it here as well.
        // eslint-disable-next-line no-new-func
        assert.doesNotThrow(() => new Function(cwInteractiveJs()), 'cwInteractiveJs must parse as JavaScript');
    });
});
