/**
 * test/unit/clineLogAdapter.test.ts
 *
 * Phase 3 — Cline / Roo Code log adapter unit tests.
 * Covers normalization of `ui_messages.json` (modern `say:'command'`/`say:'tool'`
 * messages and legacy `ask:'command'`/`ask:'tool_use'` shapes) into the unified
 * `LogEvent` schema, plus the pure extraction/parsing helpers the adapter is
 * built from.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    parseClineLogEvents,
    cleanTerminalText,
    parseCommandStringXml,
    parseToolText,
    parseToolParam,
    extractSearchReplace,
    buildSearchReplaceDiff,
    countSearchReplaceLines,
    extractApiFailureMessage,
    deriveClineWorkspace,
} from '../../src/logs/adapters/clineLogAdapter';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    PlannerStepEvent,
    ToolCallEvent,
} from '../../src/logs/types';

function tmpTaskDir(messages: Record<string, unknown>[]): string {
    const dir = path.join(os.tmpdir(), `cw-cline-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui_messages.json'), JSON.stringify(messages), 'utf8');
    return dir;
}

const TS = 1787652744029; // deterministic epoch-millis

// ---------------------------------------------------------------------------
// cleanTerminalText
// ---------------------------------------------------------------------------

suite('cleanTerminalText — ANSI stripping', () => {
    test('removes CSI and OSC escapes', () => {
        assert.strictEqual(cleanTerminalText('\u001b[31mred\u001b[0m'), 'red');
        assert.strictEqual(cleanTerminalText('a\u001b]633;SetUserDir\u0007b'), 'ab');
        assert.strictEqual(cleanTerminalText('plain text'), 'plain text');
    });
});

// ---------------------------------------------------------------------------
// parseCommandStringXml
// ---------------------------------------------------------------------------

suite('parseCommandStringXml — Cline XML command payloads', () => {
    test('extracts command inside <execute_command>', () => {
        const parsed = parseCommandStringXml([
            '<execute_command>',
            '<command>npm test --watch</command>',
            '<requires_approval>false</requires_approval>',
            '</execute_command>',
        ].join('\n'));
        assert.strictEqual(parsed.firstTag, 'execute_command');
        assert.strictEqual(parsed.command, 'npm test --watch');
    });

    test('extracts path and content for <write_to_file>', () => {
        const parsed = parseCommandStringXml([
            '<write_to_file>',
            '<path>src/foo.ts</path>',
            '<content>export const x = 1;</content>',
            '</write_to_file>',
        ].join('\n'));
        assert.strictEqual(parsed.firstTag, 'write_to_file');
        assert.strictEqual(parsed.path, 'src/foo.ts');
        assert.strictEqual(parsed.content, 'export const x = 1;');
    });

    test('passes a plain command string through unchanged', () => {
        assert.strictEqual(parseCommandStringXml('git status').command, 'git status');
    });
});
// ---------------------------------------------------------------------------
// parseToolText / parseToolParam
// ---------------------------------------------------------------------------

suite('tool payload parsing', () => {
    test('parseToolText parses modern say:tool JSON and rejects non-JSON', () => {
        assert.deepStrictEqual(
            parseToolText('{"tool":"readFile","path":"src/a.ts"}'),
            { tool: 'readFile', path: 'src/a.ts' }
        );
        assert.strictEqual(parseToolText('not json'), undefined);
    });

    test('parseToolParam accepts object, stringified JSON and raw strings', () => {
        assert.deepStrictEqual(parseToolParam({ a: 1 }), { a: 1 });
        assert.deepStrictEqual(parseToolParam('{"a":1}'), { a: 1 });
        assert.deepStrictEqual(parseToolParam('raw value'), { toolParam: 'raw value' });
        assert.strictEqual(parseToolParam(undefined), undefined);
        assert.strictEqual(parseToolParam(''), undefined);
    });
});

// ---------------------------------------------------------------------------
// Search/replace diff helpers
// ---------------------------------------------------------------------------

suite('editedExistingFile SEARCH/REPLACE helpers', () => {
    const BLOCK = [
        '------- SEARCH',
        'const x = 1;',
        '=======',
        'const x = 2;',
        '+++++++ REPLACE',
    ].join('\n');

    test('extractSearchReplace splits both halves', () => {
        const split = extractSearchReplace(BLOCK);
        assert.ok(split, 'expected a SEARCH/REPLACE split');
        assert.strictEqual(split!.search, 'const x = 1;');
        assert.strictEqual(split!.replace, 'const x = 2;');
    });

    test('extractSearchReplace rejects unmatched shapes', () => {
        assert.strictEqual(extractSearchReplace('plain content'), undefined);
    });

    test('buildSearchReplaceDiff renders a small unified diff', () => {
        const diff = buildSearchReplaceDiff('src/a.ts', 'const x = 1;', 'const x = 2;');
        assert.ok(diff.includes('--- a/src/a.ts'));
        assert.ok(diff.includes('+++ b/src/a.ts'));
        assert.ok(diff.includes('-const x = 1;'));
        assert.ok(diff.includes('+const x = 2;'));
        const stats = countSearchReplaceLines('const x = 1;', 'const x = 2;');
        assert.strictEqual(stats.added, 1);
        assert.strictEqual(stats.removed, 1);
    });
});

// ---------------------------------------------------------------------------
// extractApiFailureMessage
// ---------------------------------------------------------------------------

suite('extractApiFailureMessage — api_req_failed payloads', () => {
    test('extracts .message from JSON bodies and falls back to raw text', () => {
        assert.strictEqual(
            extractApiFailureMessage('{"message":"429 daily limit reached","code":"INFERENCE_CAP_ERROR"}'),
            '429 daily limit reached'
        );
        assert.strictEqual(extractApiFailureMessage('bare failure text'), 'bare failure text');
    });
});
// ---------------------------------------------------------------------------
// deriveClineWorkspace
// ---------------------------------------------------------------------------

suite('deriveClineWorkspace — cwd vs prompt fallback', () => {
    test('prefers the cwd field, then the Current Working Directory marker', () => {
        assert.strictEqual(
            deriveClineWorkspace([{ ts: 1, say: 'task', cwd: '/repo' }]),
            '/repo'
        );
        assert.strictEqual(
            deriveClineWorkspace([
                { ts: 1, say: 'api_req_started', text: '# Current Working Directory (c:/repos/demo) Files\n.gitignore' },
            ]),
            'c:/repos/demo'
        );
        assert.strictEqual(deriveClineWorkspace([{ ts: 1, say: 'text' }]), undefined);
    });
});

// ---------------------------------------------------------------------------
// parseClineLogEvents — end-to-end normalization
// ---------------------------------------------------------------------------

suite('parseClineLogEvents — modern ui_messages.json', () => {
    test('normalizes commands with output correlation in a realistic flow', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'say', say: 'task', text: 'Fix failing tests' },
            { ts: TS + 1000, type: 'say', say: 'command', text: 'npm test --watch', commandCompleted: true },
            { ts: TS + 2000, type: 'ask', ask: 'command_output', text: 'PASS 1/1' },
            { ts: TS + 3000, type: 'ask', ask: 'command_output', text: 'Tests finished' },
            { ts: TS + 4000, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'readFile', path: 'src/a.test.ts' }) },
            { ts: TS + 5000, type: 'say', say: 'text', text: 'I fixed it.', partial: false },
        ]);

        const result = parseClineLogEvents(dir);
        assert.strictEqual(result.errors.length, 0);

        const commands = result.events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm test --watch');
        assert.ok(commands[0].stdoutSummary?.includes('PASS 1/1'));
        assert.ok(commands[0].stdoutSummary?.includes('Tests finished'));
        // The command was emitted at ts = TS + 1000.
        assert.strictEqual(commands[0].timestamp, new Date(TS + 1000).toISOString());
        assert.strictEqual(commands[0].tool, 'cline');

        const tools = result.events.filter((e) => e.type === 'toolCall') as ToolCallEvent[];
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].toolName, 'readFile');

        // text / task messages never produce events.
        assert.strictEqual(result.events.filter((e) => e.type === 'plannerStep').length, 0);
    });

    test('emits file op + diff for editedExistingFile and skips noise', () => {
        const content = [
            '------- SEARCH',
            'const x = 1;',
            '=======',
            'const x = 2;',
            '+++++++ REPLACE',
        ].join('\n');
        const dir = tmpTaskDir([
            { ts: TS, type: 'say', say: 'tool', text: JSON.stringify({
                tool: 'editedExistingFile',
                path: 'src/config.ts',
                content,
                operationIsLocatedInWorkspace: true,
                startLineNumbers: [2],
            }) },
            { ts: TS + 1, type: 'say', say: 'reasoning', text: 'let me think...' },
            { ts: TS + 2, type: 'say', say: 'command_output' },
        ]);

        const result = parseClineLogEvents(dir);
        assert.strictEqual(result.errors.length, 0);

        const fileOps = result.events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].operationType, 'patch');
        assert.strictEqual(fileOps[0].filePath, 'src/config.ts');

        const diffs = result.events.filter((e) => e.type === 'diff') as DiffEvent[];
        assert.strictEqual(diffs.length, 1);
        assert.ok(diffs[0].diffText.includes('-const x = 1;'));
        assert.ok(diffs[0].diffText.includes('+const x = 2;'));

        // reasoning + command_output carry no events of their own.
        assert.strictEqual(result.events.filter((e) => e.type === 'command').length, 0);
    });

    test('mapper tools → file ops, errors and planner steps', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'deleteFile', path: 'old.ts' }) },
            { ts: TS + 1, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'mkdir', path: 'src/generated' }) },
            { ts: TS + 2, type: 'say', say: 'error', text: 'Cline tried to use execute_command without required parameter. Retrying...' },
            { ts: TS + 3, type: 'ask', ask: 'api_req_failed', text: JSON.stringify({ message: '429 rate limited', status: 429 }) },
            { ts: TS + 4, type: 'say', say: 'task_progress', text: '- [ ] Do one\n- [ ] Do two' },
        ]);

        const result = parseClineLogEvents(dir);
        const events = result.events;

        const ops = events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.deepStrictEqual(ops.map((o) => [o.operationType, o.filePath] as [string, string]).sort(),
            [['delete', 'old.ts'], ['mkdir', 'src/generated']] as [string, string][]);

        const errs = events.filter((e) => e.type === 'error') as ErrorEvent[];
        assert.strictEqual(errs.length, 2);
        assert.ok((errs[0].message as string).includes('execute_command'));
        assert.strictEqual(errs[1].message, '429 rate limited');

        const plans = events.filter((e) => e.type === 'plannerStep') as PlannerStepEvent[];
        assert.strictEqual(plans.length, 1);
        assert.strictEqual(plans[0].description, '- [ ] Do one');
        assert.strictEqual(plans[0].stepType, 'plan');
    });

    test('non-JSON say:tool text is reported as an error, not a crash', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'say', say: 'tool', text: 'tool payload without JSON' },
        ]);
        const result = parseClineLogEvents(dir);
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 1);
    });
});

suite('parseClineLogEvents — legacy ui_messages.json', () => {
    test('ask:command terminal + commandString XML → CommandEvent', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'ask', ask: 'command', commandType: 'terminal', commandString: [
                '<execute_command>',
                '<command>git commit -m "wip"</command>',
                '<requires_approval>false</requires_approval>',
                '</execute_command>',
            ].join('\n'), cwd: '/repo' },
        ]);
        const result = parseClineLogEvents(dir);
        assert.strictEqual(result.errors.length, 0);
        const cmd = result.events.find((e) => e.type === 'command') as CommandEvent | undefined;
        assert.ok(cmd, 'expected a CommandEvent');
        assert.strictEqual(cmd!.commandText, 'git commit -m "wip"');
        assert.strictEqual(cmd!.cwd, '/repo');
    });

    test('ask:command writeToFile + ask:use_mcp_tool → file op + tool call', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'ask', ask: 'command', commandType: 'writeToFile', commandString: [
                '<write_to_file>',
                '<path>src/new.ts</path>',
                '<content>export const y = 3;</content>',
                '</write_to_file>',
            ].join('\n') },
            { ts: TS + 1, type: 'ask', ask: 'use_mcp_tool', toolName: 'mcp__server__sql', toolParam: '{"query":"select 1"}' },
        ]);
        const result = parseClineLogEvents(dir);

        const ops = result.events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(ops.length, 1);
        assert.strictEqual(ops[0].operationType, 'patch');
        assert.strictEqual(ops[0].filePath, 'src/new.ts');

        const tools = result.events.filter((e) => e.type === 'toolCall') as ToolCallEvent[];
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].toolName, 'mcp__server__sql');
        assert.deepStrictEqual(tools[0].arguments, { query: 'select 1' });
    });
});

suite('parseClineLogEvents — source & robustness', () => {
    test('roocode source is reflected on events', () => {
        const dir = tmpTaskDir([
            { ts: TS, type: 'say', say: 'command', text: 'npm ci' },
        ]);
        const result = parseClineLogEvents(dir, 'roocode');
        const cmd = result.events[0] as CommandEvent;
        assert.strictEqual(cmd.tool, 'roocode');
        assert.strictEqual(cmd.sessionId, path.basename(dir));
    });

    test('missing ui_messages.json yields an error and no events', () => {
        const dir = path.join(os.tmpdir(), `cw-cline-adapter-empty-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
            const result = parseClineLogEvents(dir);
            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a non-array root yields an error', () => {
        const dir = path.join(os.tmpdir(), `cw-cline-adapter-obj-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ui_messages.json'), '{"say":"task"}', 'utf8');
        try {
            const result = parseClineLogEvents(dir);
            assert.strictEqual(result.events.length, 0);
            assert.strictEqual(result.errors.length, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});