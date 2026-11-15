/**
 * test/unit/newLayoutLogAdapters.test.ts
 *
 * Covers the execution-trail adapters for the *new* session layouts:
 *   - Cline 4.x / Roo Code 4.x  → `<dir>/<id>.messages.json` (tool_use/tool_result)
 *   - Copilot agent host        → `<dir>/events.jsonl`      (tool.execution_* )
 *
 * These are the formats that replaced `ui_messages.json` / `chatSessions/*.jsonl`,
 * so this is what makes newer chats contribute command/diff rows at all.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseClineV4LogEvents } from '../../src/logs/adapters/clineV4LogAdapter';
import { parseCopilotAgentLogEvents } from '../../src/logs/adapters/copilotAgentLogAdapter';
import {
    classifyAgentTool,
    extractCommands,
    extractFilePath,
    extractSearchReplace,
    resultToText,
} from '../../src/logs/adapters/agentToolMapping';
import { CommandEvent, DiffEvent, ErrorEvent, FileOperationEvent, ToolCallEvent } from '../../src/logs/types';

const SESSION_ID = '1794437515142_001ri';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-new-adapters-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const CLINE_TRANSCRIPT = {
    version: 1,
    messages: [
        {
            role: 'assistant',
            ts: 1794437518000,
            content: [
                {
                    type: 'tool_use',
                    id: 'call-1',
                    name: 'run_commands',
                    input: { commands: ['git status', 'npm test'] },
                },
                {
                    type: 'tool_use',
                    id: 'call-2',
                    name: 'editor',
                    input: {
                        path: 'src/logs/logFilters.ts',
                        old_text: 'const a = 1;',
                        new_text: 'const a = 2;',
                    },
                },
                {
                    type: 'tool_use',
                    id: 'call-3',
                    name: 'apply_patch',
                    input: { path: 'src/extension.ts', patch: '--- a\n+++ b\n+const added = true;\n' },
                },
                { type: 'tool_use', id: 'call-4', name: 'read_files', input: { files: [{ path: 'a.ts' }] } },
            ],
        },
        {
            role: 'user',
            ts: 1794437520000,
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'call-1',
                    name: 'run_commands',
                    content: [
                        { query: 'git status', result: 'On branch master\nnothing to commit', success: true },
                        { query: 'npm test', result: '2 failing', success: false },
                    ],
                },
                {
                    type: 'tool_result',
                    tool_use_id: 'call-4',
                    name: 'read_files',
                    is_error: true,
                    content: [{ text: 'File not found: a.ts' }],
                },
            ],
        },
    ],
};

const COPILOT_EVENTS = [
    {
        type: 'tool.execution_start',
        data: {
            toolCallId: 'call-a',
            toolName: 'run_in_terminal',
            arguments: { command: 'npm run build' },
        },
        timestamp: '2026-11-12T23:24:00.000Z',
    },
    {
        type: 'tool.execution_complete',
        data: { toolCallId: 'call-a', success: false, result: { content: 'TS2345: type error' } },
        timestamp: '2026-11-12T23:24:10.000Z',
    },
    {
        type: 'tool.execution_start',
        data: {
            toolCallId: 'call-b',
            toolName: 'replace_string_in_file',
            arguments: { path: 'src/a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
        },
        timestamp: '2026-11-12T23:24:20.000Z',
    },
    {
        type: 'tool.execution_complete',
        data: { toolCallId: 'call-b', success: false, result: { content: 'edit failed' } },
        timestamp: '2026-11-12T23:24:30.000Z',
    },
];

/** Writes `<root>/<id>/<id>.messages.json` and returns the session dir. */
function writeClineSession(root: string, id: string, transcript: unknown): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.messages.json`), JSON.stringify(transcript), 'utf8');
    return dir;
}

/** Writes `<root>/<id>/events.jsonl` and returns the session dir. */
function writeAgentSession(root: string, id: string, events: unknown[]): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'events.jsonl'),
        events.map(e => JSON.stringify(e)).join('\n') + '\n',
        'utf8'
    );
    return dir;
}

suite('agentToolMapping — shared vocabulary', () => {
    test('classifies commands, diffs, file operations and tool calls', () => {
        assert.strictEqual(classifyAgentTool('run_commands'), 'command');
        assert.strictEqual(classifyAgentTool('run_in_terminal'), 'command');
        assert.strictEqual(classifyAgentTool('Execute_Command'), 'command');
        assert.strictEqual(classifyAgentTool('apply_patch'), 'diff');
        assert.strictEqual(classifyAgentTool('editor'), 'fileOp');
        assert.strictEqual(classifyAgentTool('create_file'), 'fileOp');
        assert.strictEqual(classifyAgentTool('read_files'), 'tool');
        assert.strictEqual(classifyAgentTool(undefined), 'tool');
    });

    test('extracts commands, file paths, search/replace pairs and results', () => {
        assert.deepStrictEqual(extractCommands({ commands: ['a', 'b'] }), ['a', 'b']);
        assert.deepStrictEqual(extractCommands({ command: 'npm test' }), ['npm test']);
        assert.deepStrictEqual(extractCommands({ commandLine: 'ls' }), ['ls']);
        assert.deepStrictEqual(extractCommands(undefined), []);

        assert.strictEqual(extractFilePath({ path: 'a.ts' }), 'a.ts');
        assert.strictEqual(extractFilePath({ filePath: 'b.ts' }), 'b.ts');
        assert.strictEqual(extractFilePath({}), undefined);

        assert.deepStrictEqual(extractSearchReplace({ old_text: 'x', new_text: 'y' }), { search: 'x', replace: 'y' });
        assert.strictEqual(extractSearchReplace({ path: 'a.ts' }), undefined);

        assert.strictEqual(resultToText('plain'), 'plain');
        assert.strictEqual(resultToText([{ result: 'one' }, { result: 'two' }]), 'one\ntwo');
        assert.strictEqual(resultToText({ content: 'nested' }), 'nested');
        assert.strictEqual(resultToText(undefined), undefined);
    });
});

suite('Cline 4.x log adapter', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('turns tool_use/tool_result parts into commands, file ops, diffs and tool calls', () => {
        const dir = writeClineSession(root, SESSION_ID, CLINE_TRANSCRIPT);

        const { events, errors } = parseClineV4LogEvents(dir, 'cline', 'c:\\repo');

        assert.deepStrictEqual(errors, []);

        const commands = events.filter((e): e is CommandEvent => e.type === 'command');
        assert.deepStrictEqual(commands.map(c => c.commandText), ['git status', 'npm test']);
        assert.strictEqual(commands[0].workspacePath, 'c:\\repo');
        assert.strictEqual(commands[0].sessionId, SESSION_ID);
        assert.strictEqual(commands[0].exitCode, 0, 'successful command gets exit code 0');
        assert.strictEqual(commands[1].exitCode, 1, 'failed command gets a non-zero exit code');
        assert.ok((commands[0].stdoutSummary ?? '').includes('On branch master'));
        assert.ok((commands[1].stderrSummary ?? '').includes('2 failing'));
        assert.strictEqual(commands[0].timestamp, new Date(1794437518000).toISOString());

        const fileOps = events.filter((e): e is FileOperationEvent => e.type === 'fileOperation');
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].operationType, 'patch');
        assert.strictEqual(fileOps[0].filePath, 'src/logs/logFilters.ts');

        const diffs = events.filter((e): e is DiffEvent => e.type === 'diff');
        assert.strictEqual(diffs.length, 2, 'editor edit + apply_patch both produce diffs');
        assert.ok(diffs.some(d => d.filePath === 'src/logs/logFilters.ts' && d.diffText.includes('const a = 2;')));
        assert.ok(diffs.some(d => d.filePath === 'src/extension.ts' && d.diffText.includes('const added = true;')));

        const toolCalls = events.filter((e): e is ToolCallEvent => e.type === 'toolCall');
        assert.deepStrictEqual(toolCalls.map(t => t.toolName), ['read_files']);

        const failures = events.filter((e): e is ErrorEvent => e.type === 'error');
        assert.strictEqual(failures.length, 1, 'is_error tool_result becomes an ErrorEvent');
        assert.ok(failures[0].message.includes('File not found'));
    });

    test('a missing transcript returns an error instead of throwing', () => {
        const dir = path.join(root, SESSION_ID);
        fs.mkdirSync(dir, { recursive: true });
        const { events, errors } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.strictEqual(errors.length, 1);
    });

    test('malformed JSON returns an error instead of throwing', () => {
        const dir = path.join(root, SESSION_ID);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${SESSION_ID}.messages.json`), '{ not json', 'utf8');

        const { events, errors } = parseClineV4LogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('Cannot parse'), errors[0]);
    });

    test('every event id is unique (stable upserts)', () => {
        const dir = writeClineSession(root, SESSION_ID, CLINE_TRANSCRIPT);
        const { events } = parseClineV4LogEvents(dir);
        const ids = events.map(e => e.id);
        assert.strictEqual(new Set(ids).size, ids.length);
    });
});


suite('Copilot agent-host log adapter', () => {
    let root: string;

    setup(() => { root = tmpDir(); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('turns tool executions into commands, edits and errors', () => {
        const dir = writeAgentSession(root, SESSION_ID, COPILOT_EVENTS);

        const { events, errors } = parseCopilotAgentLogEvents(dir, 'c:\\repo');

        assert.deepStrictEqual(errors, []);

        const commands = events.filter((e): e is CommandEvent => e.type === 'command');
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm run build');
        assert.strictEqual(commands[0].exitCode, 1, 'failed execution → non-zero exit code');
        assert.ok((commands[0].stderrSummary ?? '').includes('TS2345'));
        assert.strictEqual(commands[0].workspaceId, 'copilot-agent');
        assert.strictEqual(commands[0].workspacePath, 'c:\\repo');

        const fileOps = events.filter((e): e is FileOperationEvent => e.type === 'fileOperation');
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].filePath, 'src/a.ts');

        const diffs = events.filter((e): e is DiffEvent => e.type === 'diff');
        assert.strictEqual(diffs.length, 1, 'search/replace edit yields a diff');
        assert.ok(diffs[0].diffText.includes('const x = 2;'));

        const failures = events.filter((e): e is ErrorEvent => e.type === 'error');
        assert.strictEqual(failures.length, 1, 'failed non-command execution becomes an ErrorEvent');
        assert.ok(failures[0].message.includes('edit failed'));
    });

    test('falls back to assistant.message toolRequests when no execution_start exists', () => {
        const dir = writeAgentSession(root, SESSION_ID, [
            {
                type: 'assistant.message',
                data: {
                    toolRequests: [
                        { toolCallId: 'call-x', name: 'run_in_terminal', arguments: { command: 'git status' } },
                        { toolCallId: 'call-y', name: 'view', arguments: { path: 'a.ts' } },
                    ],
                },
                timestamp: '2026-11-12T23:25:00.000Z',
            },
        ]);

        const { events } = parseCopilotAgentLogEvents(dir);
        assert.deepStrictEqual(events.map(e => e.type), ['command', 'toolCall']);
        assert.strictEqual((events[0] as CommandEvent).commandText, 'git status');
    });

    test('the same tool call id is materialized only once', () => {
        const duplicated = [...COPILOT_EVENTS, COPILOT_EVENTS[0]];
        const dir = writeAgentSession(root, SESSION_ID, duplicated);

        const { events } = parseCopilotAgentLogEvents(dir);
        const commands = events.filter(e => e.type === 'command');
        assert.strictEqual(commands.length, 1);
    });

    test('a missing transcript returns an error instead of throwing', () => {
        const dir = path.join(root, SESSION_ID);
        fs.mkdirSync(dir, { recursive: true });
        const { events, errors } = parseCopilotAgentLogEvents(dir);
        assert.deepStrictEqual(events, []);
        assert.strictEqual(errors.length, 1);
    });
});

