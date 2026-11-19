/**
 * test/unit/logAdapters.edgeCases.test.ts
 *
 * Branch-level coverage for the *new* execution-trail adapters:
 *   - Cline 4.x / Roo Code → `<dir>/<id>.messages.json`
 *   - Copilot agent host   → `<dir>/events.jsonl`
 *
 * The happy paths live in `newLayoutLogAdapters.test.ts`; this suite feeds the
 * defensive edges each adapter must survive — missing/typed-away fields, empty
 * payloads, unclassifiable tools and result correlation that has no matching
 * invocation.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from '../helpers/fsCleanup';
import { parseClineV4LogEvents } from '../../src/logs/adapters/clineV4LogAdapter';
import { parseCopilotAgentLogEvents } from '../../src/logs/adapters/copilotAgentLogAdapter';
import {
    classifyAgentTool,
    extractCommands,
    extractContent,
    extractSearchReplace,
    fileOperationOf,
    resultToText,
} from '../../src/logs/adapters/agentToolMapping';
import { CommandEvent, DiffEvent, ErrorEvent, FileOperationEvent, ToolCallEvent } from '../../src/logs/types';

const SESSION_ID = '1794437515142_edge';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-adapter-edges-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeClineSession(root: string, transcript: unknown): string {
    const dir = path.join(root, SESSION_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.messages.json`), JSON.stringify(transcript), 'utf8');
    return dir;
}

function writeAgentSession(root: string, lines: unknown[]): string {
    const dir = path.join(root, SESSION_ID);
    fs.mkdirSync(dir, { recursive: true });
    const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), body, 'utf8');
    return dir;
}

suite('Cline 4.x adapter — defensive branches', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => removeTempDir(root));

    test('a transcript without a messages array yields no events', () => {
        const dir = writeClineSession(root, { version: 1 });
        const { events, errors } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(errors, []);
    });

    test('messages without timestamps or parts are skipped', () => {
        const dir = writeClineSession(root, {
            messages: [
                { role: 'user', content: 'not-a-part-list' },
                { role: 'assistant', ts: 0, content: [{ type: 'thinking', text: 'ignored' }] },
                null,
            ],
        });

        const { events, errors } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, [], 'no tool_use/tool_result parts → no events');
        assert.deepStrictEqual(errors, []);
    });

    test('tool calls without a name are dropped', () => {
        const dir = writeClineSession(root, {
            messages: [{ role: 'assistant', ts: 1794437518000, content: [{ type: 'tool_use', id: 'call-x', input: {} }] }],
        });

        const { events } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, []);
    });

    test('non-object inputs leave arguments undefined and a blank raw snippet', () => {
        const dir = writeClineSession(root, {
            messages: [{
                role: 'assistant',
                ts: 1794437518000,
                content: [
                    { type: 'tool_use', id: 'c1', name: 'read_files', input: 'just-a-string' },
                    { type: 'tool_use', id: 'c2', name: 'read_files', input: null },
                    { type: 'tool_use', id: 'c3', name: 'read_files', input: '   ' },
                ],
            }],
        });

        const calls = parseClineV4LogEvents(dir).events.filter((e): e is ToolCallEvent => e.type === 'toolCall');
        assert.strictEqual(calls.length, 3);
        assert.deepStrictEqual(calls.map((c) => c.arguments), [undefined, undefined, undefined]);
        assert.strictEqual(calls[0].raw, 'just-a-string', 'string input is kept as the raw snippet');
        assert.strictEqual(calls[1].raw, '{}', 'null input is serialized');
        assert.strictEqual(calls[2].raw, undefined, 'whitespace-only raw snippets are dropped');
    });

    test('a diff tool without path or patch still produces a diff event', () => {
        const dir = writeClineSession(root, {
            messages: [{
                role: 'assistant',
                ts: 1794437518000,
                content: [{ type: 'tool_use', id: 'd1', name: 'apply_patch', input: {} }],
            }],
        });

        const diffs = parseClineV4LogEvents(dir).events.filter((e): e is DiffEvent => e.type === 'diff');
        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].filePath, '(unknown)');
        assert.strictEqual(diffs[0].diffText, '');
    });

    test('a file operation without a path is recorded as (unknown) and skips the diff', () => {
        const dir = writeClineSession(root, {
            messages: [{
                role: 'assistant',
                ts: 1794437518000,
                content: [{ type: 'tool_use', id: 'f1', name: 'editor', input: { old_text: '', new_text: '' } }],
            }],
        });

        const events = parseClineV4LogEvents(dir).events;
        const fileOps = events.filter((e): e is FileOperationEvent => e.type === 'fileOperation');
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].filePath, '(unknown)');
        assert.strictEqual(events.filter((e) => e.type === 'diff').length, 0, 'empty edit → no diff');
    });

    test('tool results without a tool_use_id or with unknown ids are ignored', () => {
        const dir = writeClineSession(root, {
            messages: [
                { role: 'user', ts: 1794437520000, content: [
                    { type: 'tool_result', content: [{ text: 'orphan' }] },
                    { type: 'tool_result', tool_use_id: 'never-seen', content: [{ text: 'orphan-2' }] },
                ] },
            ],
        });

        const { events } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, []);
    });

    test('per-command results fall back to the last entry and tolerate missing fields', () => {
        const dir = writeClineSession(root, {
            messages: [
                { role: 'assistant', ts: 1794437518000, content: [
                    { type: 'tool_use', id: 'cmd-1', name: 'run_commands', input: { commands: ['npm test', 'npm run lint'] } },
                ] },
                { role: 'user', ts: 1794437520000, content: [
                    { type: 'tool_result', tool_use_id: 'cmd-1', content: [{ query: 'npm test', result: 'ok' }] },
                ] },
            ],
        });

        const commands = parseClineV4LogEvents(dir).events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 2);
        assert.strictEqual(commands[0].exitCode, undefined, 'no boolean success → no exit code');
        assert.ok((commands[0].stdoutSummary ?? '').includes('ok'));
        assert.ok((commands[1].stdoutSummary ?? '').includes('ok'), 'second command reuses the last entry');
    });

    test('a failed tool result with no text still becomes an error event', () => {
        const dir = writeClineSession(root, {
            messages: [
                { role: 'assistant', ts: 1794437518000, content: [
                    { type: 'tool_use', id: 'tool-1', name: 'read_files', input: { path: 'a.ts' } },
                ] },
                { role: 'user', ts: 1794437520000, content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', success: false, content: [] },
                ] },
            ],
        });

        const errors = parseClineV4LogEvents(dir).events.filter((e): e is ErrorEvent => e.type === 'error');
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].message, 'Tool call failed', 'falls back to a generic message');
        assert.strictEqual(errors[0].severity, 'error');
    });
});


suite('Copilot agent-host adapter — defensive branches', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => removeTempDir(root));

    test('malformed JSON is reported and non-object events are skipped', () => {
        const dir = writeAgentSession(root, ['{ not json', 'null', '42', '']);

        const { events, errors } = parseCopilotAgentLogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.strictEqual(errors.length, 1, 'only the unparseable line is reported');
        assert.match(errors[0], /invalid JSON/);
    });

    test('events without a timestamp fall back to the epoch', () => {
        const dir = writeAgentSession(root, [{
            type: 'tool.execution_start',
            data: { toolName: 'run_in_terminal', arguments: { command: 'ls' } },
        }]);

        const commands = parseCopilotAgentLogEvents(dir).events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].timestamp, new Date(0).toISOString());
        assert.strictEqual(commands[0].commandText, 'ls');
    });

    test('unknown event types and nameless invocations are ignored', () => {
        const dir = writeAgentSession(root, [
            { type: 'session.start', data: { cwd: '/repo' } },
            { type: 'tool.execution_start', data: { toolCallId: 'no-name' } },
        ]);

        const { events, errors } = parseCopilotAgentLogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(errors, []);
    });

    test('a repeated toolCallId materializes only once', () => {
        const invocation = {
            type: 'tool.execution_start',
            data: { toolCallId: 'call-dup', toolName: 'run_in_terminal', arguments: { command: 'npm test' } },
        };
        const dir = writeAgentSession(root, [invocation, invocation]);

        const commands = parseCopilotAgentLogEvents(dir).events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 1);
    });

    test('string and primitive arguments survive as raw snippets without an arguments object', () => {
        const dir = writeAgentSession(root, [
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'c-str', toolName: 'read_files', arguments: '{"path":"a.ts"}' },
            },
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'c-num', toolName: 'read_files', arguments: 42 },
            },
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'c-blank', toolName: 'read_files', arguments: '   ' },
            },
        ]);

        const calls = parseCopilotAgentLogEvents(dir).events.filter((e): e is ToolCallEvent => e.type === 'toolCall');
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(calls[0].raw, '{"path":"a.ts"}', 'string arguments are the raw snippet');
        assert.strictEqual(calls[0].arguments, undefined, 'string arguments are not parsed into an object');
        assert.strictEqual(calls[1].raw, '42');
        assert.strictEqual(calls[2].raw, undefined, 'whitespace-only snippets are dropped');
    });

    test('assistant toolRequests are a fallback and tolerate missing fields', () => {
        const dir = writeAgentSession(root, [
            { type: 'assistant.message', data: { toolRequests: 'not-an-array' } },
            {
                type: 'assistant.message',
                data: {
                    toolRequests: [
                        { name: undefined, arguments: {} },
                        { name: 'run_in_terminal', arguments: { command: 'npm ci' } },
                    ],
                },
            },
        ]);

        const commands = parseCopilotAgentLogEvents(dir).events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm ci');
    });

    test('diff tools and path-less file operations are normalized', () => {
        const dir = writeAgentSession(root, [
            {
                type: 'tool.execution_start',
                data: {
                    toolCallId: 'd1',
                    toolName: 'apply_patch',
                    arguments: '--- a/x.ts\n+++ b/x.ts\n+1\n',
                },
            },
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'f1', toolName: 'editor', arguments: { old_text: '', new_text: '' } },
            },
        ]);

        const events = parseCopilotAgentLogEvents(dir).events;
        const diffs = events.filter((e): e is DiffEvent => e.type === 'diff');
        assert.strictEqual(diffs.length, 1, 'a string patch argument still yields a diff');
        assert.strictEqual(diffs[0].filePath, '(unknown)');
        assert.strictEqual(diffs[0].addedLines, 1);

        const fileOps = events.filter((e): e is FileOperationEvent => e.type === 'fileOperation');
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].filePath, '(unknown)');
        assert.strictEqual(events.filter((e) => e.type === 'diff').length, 1, 'empty edit adds no second diff');
    });


    test('completions attach exit codes and output to the matching command', () => {
        const dir = writeAgentSession(root, [
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'ok', toolName: 'run_in_terminal', arguments: { command: 'npm test' } },
            },
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'no-flag', toolName: 'run_in_terminal', arguments: { command: 'npm run lint' } },
            },
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'bad', toolName: 'run_in_terminal', arguments: { command: 'npm run build' } },
            },
            {
                type: 'tool.execution_complete',
                data: { toolCallId: 'ok', success: true, result: { content: 'green' } },
            },
            {
                type: 'tool.execution_complete',
                data: { toolCallId: 'no-flag', result: { content: 'no success flag' } },
            },
            {
                type: 'tool.execution_complete',
                data: { toolCallId: 'bad', success: false, result: { content: 'boom' } },
            },
        ]);

        const commands = parseCopilotAgentLogEvents(dir).events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 3);

        const ok = commands.find((c) => c.commandText === 'npm test');
        assert.strictEqual(ok?.exitCode, 0);
        assert.strictEqual(ok?.stdoutSummary, 'green');

        const unflagged = commands.find((c) => c.commandText === 'npm run lint');
        assert.strictEqual(unflagged?.exitCode, undefined, 'no boolean success → no exit code');
        assert.strictEqual(unflagged?.stdoutSummary, 'no success flag');

        const failed = commands.find((c) => c.commandText === 'npm run build');
        assert.strictEqual(failed?.exitCode, 1);
        assert.strictEqual(failed?.stderrSummary, 'boom');
    });

    test('failed completions without a matching call become error events', () => {
        const dir = writeAgentSession(root, [
            { type: 'tool.execution_complete', data: { toolCallId: 'ghost', success: true } },
            { type: 'tool.execution_complete', data: { success: false, result: { output: 'nothing worked' } } },
        ]);

        const events = parseCopilotAgentLogEvents(dir).events;
        const errors = events.filter((e): e is ErrorEvent => e.type === 'error');
        assert.strictEqual(errors.length, 1, 'a successful unknown completion stays silent');
        assert.strictEqual(errors[0].message, 'nothing worked');
    });

    test('a failed completion for a known tool falls back to "<tool> failed"', () => {
        const dir = writeAgentSession(root, [
            {
                type: 'tool.execution_start',
                data: { toolCallId: 'call-1', toolName: 'read_files', arguments: { path: 'a.ts' } },
            },
            { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: false } },
        ]);

        const errors = parseCopilotAgentLogEvents(dir).events.filter((e): e is ErrorEvent => e.type === 'error');
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].message, 'read_files failed');
    });
});


suite('agentToolMapping — classification and extraction edges', () => {
    test('classifies command, diff and file-operation tools case-insensitively', () => {
        assert.strictEqual(classifyAgentTool('Run_Commands'), 'command');
        assert.strictEqual(classifyAgentTool('  RUN_IN_TERMINAL '), 'command');
        assert.strictEqual(classifyAgentTool('Apply_Patch'), 'diff');
        assert.strictEqual(classifyAgentTool('CREATE_NEW_FILE'), 'fileOp');
        assert.strictEqual(classifyAgentTool('read_files'), 'tool');
        assert.strictEqual(classifyAgentTool(undefined), 'tool');
    });

    test('unknown file-operation tools default to "patch"', () => {
        assert.strictEqual(fileOperationOf('create_new_file'), 'create');
        assert.strictEqual(fileOperationOf('delete_file'), 'delete');
        assert.strictEqual(fileOperationOf('mystery_tool'), 'patch');
        assert.strictEqual(fileOperationOf(undefined), 'patch');
    });

    test('extractCommands handles every argument spelling and filters blanks', () => {
        assert.deepStrictEqual(extractCommands(undefined), []);
        assert.deepStrictEqual(extractCommands('npm test'), []);
        assert.deepStrictEqual(extractCommands({ command: 'npm test' }), ['npm test']);
        assert.deepStrictEqual(extractCommands({ commandLine: 'git status' }), ['git status']);
        assert.deepStrictEqual(extractCommands({ commandString: 'make' }), ['make']);
        assert.deepStrictEqual(extractCommands({ cmd: 'ls' }), ['ls']);
        assert.deepStrictEqual(extractCommands({ commands: ['a', '  ', '', 'b'] }), ['a', 'b']);
        assert.deepStrictEqual(extractCommands({ commands: 'not-an-array' }), []);
        assert.deepStrictEqual(extractCommands({ command: '   ' }), []);
    });

    test('extractSearchReplace recognises search/replace spellings', () => {
        assert.strictEqual(extractSearchReplace(undefined), undefined);
        assert.strictEqual(extractSearchReplace({ path: 'a.ts' }), undefined, 'no search or replace text');
        assert.deepStrictEqual(extractSearchReplace({ old_text: 'a' }), { search: 'a', replace: '' });
        assert.deepStrictEqual(extractSearchReplace({ new_str: 'b' }), { search: '', replace: 'b' });
        assert.deepStrictEqual(extractSearchReplace({ find: 'x', replacement: 'y' }), { search: 'x', replace: 'y' });
    });

    test('extractContent accepts the content spellings used by write tools', () => {
        assert.strictEqual(extractContent(null), undefined);
        assert.strictEqual(extractContent({ path: 'a.ts' }), undefined);
        assert.strictEqual(extractContent({ contents: 'body' }), 'body');
        assert.strictEqual(extractContent({ text: 'body' }), 'body');
        assert.strictEqual(extractContent({ new_text: 'body' }), 'body');
    });

    test('resultToText flattens strings, arrays and records', () => {
        assert.strictEqual(resultToText(undefined), undefined);
        assert.strictEqual(resultToText(null), undefined);
        assert.strictEqual(resultToText('plain'), 'plain');
        assert.strictEqual(resultToText(['a', { result: 'b' }, 42, {}]), 'a\nb');
        assert.strictEqual(resultToText(['  ', 42]), undefined, 'nothing printable in the array');
        assert.strictEqual(resultToText({ output: 'out' }), 'out');
        assert.strictEqual(resultToText({ nested: { deep: true } }), '{"nested":{"deep":true}}');
        assert.strictEqual(resultToText(42), undefined, 'primitives that are not strings are not printable');
    });
});

