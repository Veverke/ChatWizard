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
    EventDetailSection,
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

/**
 * Sections after the shared **Description** section — the per-kind payload
 * (Input / Output for commands and tool calls, the kind section otherwise).
 */
function payloadSections(event: LogEvent): EventDetailSection[] {
    return buildEventDetailSections(event).slice(1);
}

/** The section with the given heading (throws when it does not exist). */
function sectionNamed(event: LogEvent, heading: string): EventDetailSection {
    const found = buildEventDetailSections(event).find((section) => section.heading === heading);
    assert.ok(found, `expected a "${heading}" section`);
    return found as EventDetailSection;
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
        const event = makeEvent({
            id: 'c1',
            timestamp: '2026-01-01T10:00:00.000Z',
            commandText: 'npm run build\n-- --config webpack.prod.js',
            cwd: '/repo',
            exitCode: 1,
            shell: 'bash',
            stdoutSummary: 'compiled',
        });
        // Input: where / how it ran + the command text itself.
        const input = sectionNamed(event, 'Input');
        assert.ok(input.code.some((b) => b.language === 'bash' && b.text.includes('npm run build')));
        assert.deepStrictEqual(input.rows, [['Working directory', '/repo'], ['Shell', 'bash']]);

        // Output: exit code + captured stdout.
        const output = sectionNamed(event, 'Output');
        assert.deepStrictEqual(output.rows, [['Exit code', '1']]);
        assert.ok(output.code.some((b) => b.language === 'text' && b.text === 'compiled'));

        // The Description section leads and explains what the command does.
        const description = sectionNamed(event, 'Description');
        assert.strictEqual(buildEventDetailSections(event)[0].heading, 'Description');
        assert.match(description.rows[0][1], /Runs a Node\.js package-manager command/);
    });

    test('diff detail carries stats and the full patch text', () => {
        const sections = payloadSections(makeEvent({
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
        const sections = payloadSections(makeEvent({
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
        const sections = payloadSections(makeEvent({
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
        const sections = payloadSections(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }));
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

suite('logEventWebview — per-kind detail variants', () => {
    type EventInput = Partial<LogEvent> & { id: string; timestamp: string };

    test('shortEventLabel covers every kind and truncates long text', () => {
        assert.match(shortEventLabel(makeEvent({
            id: 'f', timestamp: 'T', type: 'fileOperation', operationType: 'move', filePath: '/a.ts',
        } as EventInput) as LogEvent), /^File Operation: move \/a\.ts/);
        assert.match(shortEventLabel(makeEvent({
            id: 't', timestamp: 'T', type: 'toolCall', toolName: 'read_file',
        } as EventInput) as LogEvent), /^Tool Call: read_file/);
        assert.match(shortEventLabel(makeEvent({
            id: 'e', timestamp: 'T', type: 'error', message: 'boom',
        } as EventInput) as LogEvent), /^Error \/ Failure: boom/);
        assert.match(shortEventLabel(makeEvent({
            id: 'p', timestamp: 'T', type: 'plannerStep', description: 'Plan the work',
        } as EventInput) as LogEvent), /^Planner Step: Plan the work/);
        assert.match(shortEventLabel(makeEvent({
            id: 'd', timestamp: 'T', type: 'diff', filePath: '/d.ts', diffText: '',
        } as EventInput) as LogEvent), /^Diff \/ Patch: \/d\.ts/);

        const longCommand = makeEvent({ id: 'c', timestamp: 'T', commandText: 'x'.repeat(200) } as EventInput) as LogEvent;
        const label = shortEventLabel(longCommand);
        assert.strictEqual(label.length, 70, 'label is capped at the max length');
        assert.ok(label.startsWith('Executed Command: '), `unexpected label: ${label}`);
        assert.ok(!label.includes('x'.repeat(60)), 'long text is truncated');
        assert.strictEqual(shortEventLabel(longCommand, 20).length, 20, 'custom max is honoured');
    });

    test('eventMetaRows only lists facets that exist', () => {
        const bare = eventMetaRows({
            id: 'bare', type: 'command', tool: 'cline', commandText: 'x',
        } as unknown as LogEvent);
        assert.deepStrictEqual(bare.map(([k]) => k), ['Event kind', 'Tool', 'Event id']);

        const rich = eventMetaRows({
            id: 'rich', type: 'command', tool: 'cline', commandText: 'x',
            timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's', workspaceId: 'w',
            workspacePath: '/repo', messageIndex: 3, sourcePath: '/logs/a.jsonl',
        } as unknown as LogEvent);
        assert.deepStrictEqual(rich.map(([k]) => k), [
            'Event kind', 'Tool', 'Timestamp', 'Session', 'Workspace id',
            'Workspace path', 'Message index', 'Source log', 'Event id',
        ]);
    });

    test('command detail adds stdout/stderr blocks only when present', () => {
        const bare = payloadSections(makeEvent({ id: 'c1', timestamp: 'T' } as EventInput) as LogEvent);
        assert.deepStrictEqual(bare[1].rows.find(([k]) => k === 'Exit code'), ['Exit code', 'unknown']);
        assert.strictEqual(bare[0].code.length, 1, 'no summaries → only the command block');
        assert.strictEqual(bare[1].code.length, 0, 'empty output → no blocks');

        const richEvent = makeEvent({
            id: 'c2', timestamp: 'T', exitCode: 0, cwd: '/repo', shell: 'bash',
            stdoutSummary: 'all good', stderrSummary: 'a warning',
        } as EventInput) as LogEvent;
        const rich = payloadSections(richEvent);
        assert.deepStrictEqual(rich[0].rows, [['Working directory', '/repo'], ['Shell', 'bash']]);
        assert.deepStrictEqual(rich[1].rows, [['Exit code', '0']]);
        assert.strictEqual(rich[1].code.length, 2);
    });

    test('fileOperation detail omits optional rows and raw payload', () => {
        const [section] = payloadSections(makeEvent({
            id: 'f1', timestamp: 'T', type: 'fileOperation', operationType: 'create', filePath: '/a.ts',
        } as EventInput) as LogEvent);
        assert.deepStrictEqual(section.rows.map(([k]) => k), ['Operation', 'File path']);
        assert.deepStrictEqual(section.code, []);
    });

    test('diff detail reports unknown stats and skips a blank patch', () => {
        const [section] = payloadSections(makeEvent({
            id: 'd1', timestamp: 'T', type: 'diff', filePath: '/d.ts', diffText: '   ',
        } as EventInput) as LogEvent);
        assert.deepStrictEqual(section.rows.find(([k]) => k === 'Lines'), ['Lines', 'unknown']);
        assert.deepStrictEqual(section.code, []);
    });

    test('toolCall detail exposes input arguments and output metadata', () => {
        const event = makeEvent({
            id: 't1', timestamp: 'T', type: 'toolCall', toolName: 'read_file',
            arguments: { path: 'src/a.ts' },
            success: false, durationMs: 12, resultSummary: 'EACCES', raw: 'raw text',
        } as EventInput) as LogEvent;

        const input = sectionNamed(event, 'Input');
        assert.deepStrictEqual(input.rows, [['Tool', 'read_file']]);
        assert.strictEqual(input.code[0].language, 'json');
        assert.ok(input.code[0].text.includes('"path": "src/a.ts"'));
        assert.ok(input.code.some((block) => block.language === 'text' && block.text === 'raw text'));

        const output = sectionNamed(event, 'Output');
        assert.deepStrictEqual(output.rows, [['Success', 'false'], ['Duration', '12 ms']]);
        assert.deepStrictEqual(output.code, [{ language: 'text', text: 'EACCES' }]);

        assert.match(sectionNamed(event, 'Description').rows[0][1], /Reads a file from the workspace: src\/a\.ts/);
    });

    test('toolCall detail says when no output was captured', () => {
        const output = sectionNamed(makeEvent({
            id: 't1', timestamp: 'T', type: 'toolCall', toolName: 'grep', arguments: { query: 'needle' },
        } as EventInput) as LogEvent, 'Output');
        assert.deepStrictEqual(output.rows, [['Result', 'not captured in the agent log']]);
        assert.deepStrictEqual(output.code, []);
    });

    test('error detail includes the command id and raw text when available', () => {
        const [section] = payloadSections(makeEvent({
            id: 'e1', timestamp: 'T', type: 'error', message: 'boom', commandId: 'cmd-1', raw: 'raw line',
        } as EventInput) as LogEvent);
        assert.deepStrictEqual(section.rows.map(([k]) => k), ['Severity', 'Command']);
        assert.strictEqual(section.code.length, 2);
    });

    test('plannerStep detail tolerates a step with no metadata', () => {
        const [section] = payloadSections(makeEvent({
            id: 'p1', timestamp: 'T', type: 'plannerStep', description: '   ',
        } as EventInput) as LogEvent);
        assert.deepStrictEqual(section.rows, []);
        assert.deepStrictEqual(section.code, []);

        // An empty row list must not emit an empty table in the page.
        const html = renderSections(makeEvent({
            id: 'p2', timestamp: 'T', type: 'plannerStep', description: '',
        } as EventInput) as LogEvent);
        assert.ok(html.includes('<h3>Planner Step</h3>'));
    });
});

suite('logEventWebview — file-op, planner and page edge cases', () => {
    type EventInput = Partial<LogEvent> & { id: string; timestamp: string };

    test('file-operation detail lists the source, detail and raw payload', () => {
        const [fileOp] = payloadSections(makeEvent({
            id: 'f1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'fileOperation',
            operationType: 'rename',
            filePath: '/repo/src/new.ts',
            oldPath: '/repo/src/old.ts',
            detail: 'renamed by the agent',
            raw: '{"tool":"rename_file"}',
        } as EventInput) as LogEvent);

        assert.strictEqual(fileOp.heading, 'File Operation');
        assert.ok(fileOp.rows.some(([k, v]) => k === 'From' && v === '/repo/src/old.ts'));
        assert.ok(fileOp.rows.some(([k, v]) => k === 'Detail' && v === 'renamed by the agent'));
        assert.ok(fileOp.code.some((b) => b.language === 'json' && b.text.includes('rename_file')));
    });

    test('planner-step detail lists status, step type and description', () => {
        const [step] = payloadSections(makeEvent({
            id: 'p1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'plannerStep',
            description: 'Plan the refactor',
            status: 'in_progress',
            stepType: 'plan',
        } as EventInput) as LogEvent);

        assert.ok(step.rows.some(([k, v]) => k === 'Step type' && v === 'plan'));
        assert.ok(step.rows.some(([k, v]) => k === 'Status' && v === 'in_progress'));
        assert.ok(step.code.some((b) => b.language === 'text' && b.text === 'Plan the refactor'));
    });

    test('diff detail shows the trigger command and a single-sided line count', () => {
        const [diffSection] = payloadSections(makeEvent({
            id: 'd1',
            timestamp: '2026-01-01T10:00:00.000Z',
            type: 'diff',
            filePath: '/repo/a.ts',
            diffText: '',
            addedLines: undefined,
            removedLines: 5,
            commandId: 'c9',
        } as EventInput) as LogEvent);

        assert.ok(diffSection.rows.some(([k, v]) => k === 'Lines' && v === '+0 −5'));
        assert.ok(diffSection.rows.some(([k, v]) => k === 'Triggered by command' && v === 'c9'));
    });

    test('the detail page drops the action buttons that cannot work', () => {
        const html = renderEventHtml(makeEvent({
            id: 'c1',
            timestamp: '',
            sessionId: undefined,
            commandText: 'npm test',
        } as EventInput) as LogEvent, 'nonce');

        assert.match(html, /unknown time/);
        assert.ok(!html.includes('id="sessionBtn"'), 'no session button without a session id');
        assert.ok(!html.includes('id="visualDiffBtn"'), 'no visual diff button for a command');
        assert.ok(html.includes('id="copyBtn"'));
    });
});

