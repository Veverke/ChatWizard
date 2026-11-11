/**
 * test/unit/logEventWebview.test.ts
 *
 * Phase 4 — "Show full contents" webview unit tests.
 * Verifies the pure renderers used by the double-click detail panel:
 *   - buildEventDetailSections / eventDetailText per event kind
 *   - escapeHtml hardening (XSS)
 *   - renderEventHtml embedding of command/diff/JSON content
 * The VS Code host is not required for any of these helpers.
 */

import * as assert from 'assert';
import {
    buildEventDetailSections,
    escapeHtml,
    eventDetailText,
    eventMetaRows,
    renderEventHtml,
    renderCodeBlockAction,
    renderSections,
    shortEventLabel,
} from '../../src/logs/logEventWebview';
import { LogEvent } from '../../src/logs/types';

function makeEvent(overrides: Partial<LogEvent> & { id: string; timestamp: string }): LogEvent {
    return {
        type: 'command',
        tool: 'cline',
        sessionId: 'sess-a',
        workspacePath: '/repo',
        commandText: 'npm test',
        ...overrides,
    } as LogEvent;
}

suite('logEventWebview — escapeHtml', () => {
    test('escapes markup-significant characters', () => {
        assert.strictEqual(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
        assert.strictEqual(escapeHtml('say "hi" it\'s'), 'say &quot;hi&quot; it&#39;s');
    });
});

suite('logEventWebview — display helpers', () => {
    test('shortEventLabel adapts to event kind', () => {
        assert.match(shortEventLabel(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' })), /Executed Command: npm test/);
        assert.match(
            shortEventLabel(makeEvent({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/repo/src/a.ts', diffText: 'x' })),
            /Diff \/ Patch: \/repo\/src\/a\.ts/
        );
    });

    test('eventMetaRows carries the common facets', () => {
        const rows = eventMetaRows(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }));
        const map = new Map(rows);
        assert.strictEqual(map.get('Tool'), 'cline');
        assert.strictEqual(map.get('Session'), 'sess-a');
        assert.strictEqual(map.get('Workspace path'), '/repo');
        assert.strictEqual(map.get('Event id'), 'c1');
    });

    test('command detail exposes full text, cwd and exit code', () => {
        const sections = buildEventDetailSections(makeEvent({
            id: 'c1',
            timestamp: '2026-01-01T10:00:00.000Z',
            commandText: 'npm run build\n-- --config webpack.prod.js',
            cwd: '/repo',
            exitCode: 1,
            shell: 'bash',
            stdoutSummary: 'compiled',
        }));
        assert.strictEqual(sections[0].heading, 'Command');
        assert.ok(sections[0].code.some((b) => b.language === 'bash' && b.text.includes('npm run build')));
        assert.ok(sections[0].code.some((b) => b.language === 'text' && b.text === 'compiled'));
        assert.deepStrictEqual(sections[0].rows, [['Working directory', '/repo'], ['Shell', 'bash'], ['Exit code', '1']]);
    });

    test('diff detail carries stats and the full patch text', () => {
        const sections = buildEventDetailSections(makeEvent({
            id: 'd1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'diff',
            filePath: '/repo/a.ts',
            diffText: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
            addedLines: 1,
            removedLines: 1,
        }));
        const diff = sections[0];
        assert.strictEqual(diff.heading, 'Diff / Patch');
        assert.ok(diff.code[0].language === 'diff');
        assert.ok(diff.code[0].text.includes('+new'));
        assert.ok(diff.rows.some(([k, v]) => k === 'Lines' && v === '+1 −1'));
    });

    test('toolCall detail pretty-prints its arguments as JSON', () => {
        const sections = buildEventDetailSections(makeEvent({
            id: 't1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'toolCall',
            toolName: 'applyPatch',
            arguments: { file_path: 'a.ts', diff: '@@ -1 +1 @@' },
        }));
        const code = sections[0].code.find((b) => b.language === 'json');
        assert.ok(code !== undefined);
        assert.ok(code.text.includes('"file_path": "a.ts"'), 'JSON is pretty-printed');
    });

    test('error detail includes message and stack trace', () => {
        const sections = buildEventDetailSections(makeEvent({
            id: 'e1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'error',
            message: 'command failed',
            stackTrace: 'at build(): line 12',
        }));
        const texts = sections[0].code.map((b) => b.text).join('\n');
        assert.ok(texts.includes('command failed'));
        assert.ok(texts.includes('at build(): line 12'));
    });

    test('eventDetailText is a full plain-text document', () => {
        const text = eventDetailText(makeEvent({
            id: 'c1',
            timestamp: '2026-01-01T10:00:00.000Z',
            commandText: 'git commit -m "wip"',
            cwd: '/repo',
        }));
        assert.match(text, /git commit -m "wip"/);
        assert.match(text, /Tool: cline/);
        assert.match(text, /Working directory: \/repo/);
    });
});
suite('logEventWebview — HTML rendering', () => {
    test('renderSections embeds escaped code blocks', () => {
        const html = renderSections(makeEvent({
            id: 'c1',
            timestamp: '2026-01-01T10:00:00.000Z',
            commandText: 'echo "<script>bad()</script>"',
        }));
        assert.ok(!html.includes('<script>'), 'injected script tag must be escaped');
        assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
        assert.ok(html.includes('<pre><code class="language-bash">'));
    });

    test('renderEventHtml assembles a full standalone page', () => {
        const html = renderEventHtml(makeEvent({
            id: 'c1',
            timestamp: '2026-01-01T10:00:00.000Z',
            commandText: 'npm test',
            sessionId: 'sess-a',
        }), 'nonce123');
        assert.ok(html.includes('<!DOCTYPE html>'));
        assert.ok(html.includes('nonce="nonce123"'));
        assert.ok(html.includes('<span class="cw-kind">Executed Command</span>'));
        assert.ok(html.includes('Open Session'));
        assert.ok(html.includes("raw.split('\\n')"), 'embedded JS keeps its newline escape');
    });
});

suite('logEventWebview — run command in terminal', () => {
    test('the command code block carries the run action', () => {
        const sections = buildEventDetailSections(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.strictEqual(sections[0].code[0].action, 'runInTerminal');
        // Only the command itself gets the button — not its stdout/stderr.
        assert.strictEqual(sections[0].code.length, 1);
    });

    test('renderSections places the button directly below the command text', () => {
        const html = renderSections(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }));
        const commandEnd = html.indexOf('</pre>');
        const buttonAt = html.indexOf('id="runCommandBtn"');
        assert.ok(commandEnd > 0, 'expected the command code block');
        assert.ok(buttonAt > commandEnd, 'run button must come after the command text');
        assert.ok(html.includes('Run in Terminal'));
        assert.ok(html.includes('cw-btn'));
    });

    test('non-command events render no run button', () => {
        const diffHtml = renderSections(makeEvent({
            id: 'd1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'diff',
            filePath: '/repo/src/a.ts',
            diffText: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
        }));
        assert.ok(!diffHtml.includes('runCommandBtn'));
    });

    test('renderCodeBlockAction and the page script are wired up', () => {
        assert.ok(renderCodeBlockAction('runInTerminal').includes('id="runCommandBtn"'));

        const html = renderEventHtml(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }), 'n1');
        assert.ok(html.includes("command: 'runInTerminal'"), 'webview posts the run message to the host');
        assert.ok(html.includes("getElementById('runCommandBtn')"));
    });
});
