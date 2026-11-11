/**
 * test/unit/copilotLogAdapter.test.ts
 *
 * Phase 2 — GitHub Copilot log adapter unit tests.
 * Covers normalization of the session JSONL (tool invocations, inline file
 * edits, terminal notifications) into the unified `LogEvent` schema, plus the
 * pure extraction/parsing helpers the adapter is built from.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    parseCopilotLogEvents,
    parseTerminalNotification,
    isTerminalNotification,
    extractCommandText,
    extractCwd,
    extractShell,
    extractCorrelationId,
    extractFilePath,
    extractEditGroupAction,
    buildEditGroupDiffText,
    countEditGroupLines,
    countPatchLines,
} from '../../src/logs/adapters/copilotLogAdapter';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    ToolCallEvent,
} from '../../src/logs/types';

const FIXTURE_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'copilot');
const TOOL_CALLS_FIXTURE = path.join(FIXTURE_DIR, 'session-with-tool-calls.jsonl');
const NOTIFICATIONS_FIXTURE = path.join(FIXTURE_DIR, 'session-with-terminal-notifications.jsonl');

// ---------------------------------------------------------------------------
// JSONL fixture builders (inline, deterministic timestamps)
// ---------------------------------------------------------------------------

function snapshotLine(sessionId: string, creationDate = 1705400000000): string {
    return JSON.stringify({ kind: 0, v: { version: 3, sessionId, creationDate, requests: [], inputState: {} } });
}

/** Append a real conversation turn. */
function turnLine(requestId: string, timestamp: number, userText: string, response: unknown[]): string {
    return JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{ requestId, timestamp, message: { text: userText, parts: [] }, response }],
    });
}

const TERMINAL_UUID = '7b3a4f9e-1234-5678-abcd-ef0123456789';

function writeJsonl(name: string, lines: string[]): string {
    const dir = path.join(os.tmpdir(), `cw-copilot-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
}
// ---------------------------------------------------------------------------
// parseTerminalNotification
// ---------------------------------------------------------------------------

suite('parseTerminalNotification — contract', () => {
    test('parses completed + exit code 0', () => {
        const parsed = parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command completed with exit code 0]`);
        assert.deepStrictEqual(parsed, { terminalId: TERMINAL_UUID, state: 'completed', exitCode: 0 });
    });

    test('parses failed + nonzero exit code', () => {
        const parsed = parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command failed with exit code 1]`);
        assert.deepStrictEqual(parsed, { terminalId: TERMINAL_UUID, state: 'failed', exitCode: 1 });
    });

    test('treats any nonzero exit code as failed even without the word failed', () => {
        const parsed = parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command completed with exit code 2]`);
        assert.strictEqual(parsed?.state, 'failed');
        assert.strictEqual(parsed?.exitCode, 2);
    });

    test('parses running state', () => {
        const parsed = parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command still running]`);
        assert.strictEqual(parsed?.state, 'running');
    });

    test('returns undefined for a plain user message', () => {
        assert.strictEqual(parseTerminalNotification('How do I center a div?'), undefined);
        assert.strictEqual(parseTerminalNotification(undefined), undefined);
    });

    test('isTerminalNotification mirrors the notification shape', () => {
        assert.ok(isTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command completed with exit code 0]`));
        assert.ok(!isTerminalNotification('How do I center a div?'));
        assert.ok(!isTerminalNotification(''));
    });
});

// ---------------------------------------------------------------------------
// Argument-extraction helpers
// ---------------------------------------------------------------------------

suite('tool-argument extraction helpers', () => {
    test('extractCommandText prefers command + args array', () => {
        assert.strictEqual(
            extractCommandText({ command: 'npm', args: ['test', '--watch'] }),
            'npm test --watch'
        );
        assert.strictEqual(extractCommandText({ commandText: 'git status' }), 'git status');
        assert.strictEqual(extractCommandText({ script: 'echo hi' }), 'echo hi');
    });

    test('extractCommandText falls back to executable + args', () => {
        assert.strictEqual(extractCommandText({ executable: 'node', args: ['x.js'] }), 'node x.js');
        assert.strictEqual(extractCommandText({ program: 'python' }), 'python');
    });

    test('extractCommandText handles missing/empty arguments', () => {
        assert.strictEqual(extractCommandText({}), undefined);
        assert.strictEqual(extractCommandText(undefined as unknown as Record<string, unknown>), undefined);
        assert.strictEqual(extractCommandText({ command: '   ' }), undefined);
    });

    test('extractCwd / extractShell read known keys', () => {
        assert.strictEqual(extractCwd({ cwd: '/repo' }), '/repo');
        assert.strictEqual(extractCwd({ workingDirectory: '/w' }), '/w');
        assert.strictEqual(extractCwd({}), undefined);
        assert.strictEqual(extractShell({ shell: 'pwsh' }), 'pwsh');
        assert.strictEqual(extractShell({}), undefined);
    });

    test('extractCorrelationId matches a UUID-shaped terminal id only', () => {
        assert.strictEqual(extractCorrelationId({ terminalId: TERMINAL_UUID }), TERMINAL_UUID);
        assert.strictEqual(extractCorrelationId({ id: TERMINAL_UUID }), TERMINAL_UUID);
        assert.strictEqual(extractCorrelationId({ terminalId: 'not-a-uuid' }), undefined);
        assert.strictEqual(extractCorrelationId({ path: '/x' }), undefined);
    });
});
// ---------------------------------------------------------------------------
// parseCopilotLogEvents — fixture round-trips
// ---------------------------------------------------------------------------

suite('parseCopilotLogEvents — tool-calls fixture', () => {
    test('extracts tool invocation + inline file edit with correlation fields', () => {
        const result = parseCopilotLogEvents(TOOL_CALLS_FIXTURE, 'ws-hash', '/repo');

        assert.strictEqual(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`);

        const tools = result.events.filter((e) => e.type === 'toolCall').map((e) => e as ToolCallEvent);
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].toolName, 'read_file');
        assert.deepStrictEqual(tools[0].arguments, { path: '/src/utils/formatDate.ts' });
        assert.strictEqual(tools[0].tool, 'copilot');
        assert.strictEqual(tools[0].sessionId, 'copilot-tool-test-001');
        assert.strictEqual(tools[0].workspaceId, 'ws-hash');
        assert.strictEqual(tools[0].workspacePath, '/repo');
        assert.strictEqual(tools[0].sourcePath, TOOL_CALLS_FIXTURE);
        assert.ok(tools[0].messageIndex !== undefined, 'messageIndex should be attached');

        // read_file is a read tool — it must NOT produce a CommandEvent.
        assert.strictEqual(result.events.filter((e) => e.type === 'command').length, 0);

        const files = result.events.filter((e) => e.type === 'fileOperation').map((e) => e as FileOperationEvent);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].operationType, 'patch');
        assert.strictEqual(files[0].filePath, '/src/utils/formatDate.ts');
    });

    test('event ids are deterministic across parses', () => {
        const a = parseCopilotLogEvents(TOOL_CALLS_FIXTURE, 'ws-hash');
        const b = parseCopilotLogEvents(TOOL_CALLS_FIXTURE, 'ws-hash');
        assert.deepStrictEqual(
            a.events.map((e) => e.id).sort(),
            b.events.map((e) => e.id).sort()
        );
    });
});
suite('parseCopilotLogEvents — command execution + correlation', () => {
    test('run_in_terminal produces CommandEvent + ToolCallEvent + attach exit code', () => {
        const filePath = writeJsonl('commands.jsonl', [
            snapshotLine('sess-cmds'),
            turnLine('r1', 1705400005000, 'Run the test suite', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({ tool: 'run_in_terminal', arguments: { command: 'npm test', cwd: '/repo', shell: 'bash', terminalId: TERMINAL_UUID } }),
            }]),
            turnLine('r2', 1705400009000, `[Terminal ${TERMINAL_UUID} notification: command completed with exit code 0]`, []),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash', '/repo');
        assert.strictEqual(result.errors.length, 0);

        const commands = result.events.filter((e) => e.type === 'command').map((e) => e as CommandEvent);
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm test');
        assert.strictEqual(commands[0].cwd, '/repo');
        assert.strictEqual(commands[0].shell, 'bash');
        assert.strictEqual(commands[0].exitCode, 0, 'success notification must attach exit code 0');

        const tools = result.events.filter((e) => e.type === 'toolCall').map((e) => e as ToolCallEvent);
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].toolName, 'run_in_terminal');
    });

    test('failed terminal notification creates ErrorEvent linked to its command', () => {
        const filePath = writeJsonl('fail.jsonl', [
            snapshotLine('sess-fail'),
            turnLine('r1', 1705400005000, 'Deploy', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({ tool: 'shell_command', arguments: { command: 'npm run deploy', terminalId: TERMINAL_UUID } }),
            }]),
            turnLine('r2', 1705400009000, `[Terminal ${TERMINAL_UUID} notification: command failed with exit code 1]`, []),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        const commands = result.events.filter((e) => e.type === 'command').map((e) => e as CommandEvent);
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].exitCode, 1);

        const errors = result.events.filter((e) => e.type === 'error').map((e) => e as ErrorEvent);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].commandId, commands[0].id, 'error must reference the command id');
        assert.match(errors[0].message, /exit code 1/);
    });
test('failed notification without a matching command → standalone ErrorEvent', () => {
        const filePath = writeJsonl('orphan-fail.jsonl', [
            snapshotLine('sess-orphan'),
            turnLine('r1', 1705400009000, `[Terminal ${TERMINAL_UUID} notification: command failed with exit code 1]`, []),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.filter((e) => e.type === 'command').length, 0);
        const errors = result.events.filter((e) => e.type === 'error').map((e) => e as ErrorEvent);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].commandId, undefined);
        assert.match(errors[0].message, /exit code 1/);
    });

    test('success notification with no pending command emits nothing (no fabricated text)', () => {
        const result = parseCopilotLogEvents(NOTIFICATIONS_FIXTURE, 'ws-notify');
        // Fixture contains only the success notification for an unknown command.
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 0);
    });
});
suite('parseCopilotLogEvents — resilience', () => {
    test('missing file → error + no events', () => {
        const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.jsonl`);
        const result = parseCopilotLogEvents(missing, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /Failed to read file/i);
    });

    test('no snapshot line → empty result', () => {
        const filePath = writeJsonl('no-snapshot.jsonl', ['not json at all']);
        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
    });

    test('malformed toolInvocationSerialized JSON is reported and skipped', () => {
        const filePath = writeJsonl('bad-serialized.jsonl', [
            snapshotLine('sess-bad'),
            turnLine('r1', 1705400005000, 'Do it', [{
                kind: 'toolInvocationSerialized',
                value: '{"tool": "runCommand", "arguments": {',
            }]),
        ]);
        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /toolInvocationSerialized/);
    });

    test('non-copilot / empty conversation file round-trips cleanly', () => {
        const filePath = writeJsonl('plain.jsonl', [
            snapshotLine('sess-plain'),
            turnLine('r1', 1705400005000, 'Explain X', [{ value: 'Sure thing.' }]),
        ]);
        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Phase 3 — richer Copilot events: file-operation classification + diffs
// ---------------------------------------------------------------------------

suite('Phase 3 — file-path & file-action extraction helpers', () => {
    test('extractFilePath resolves string and uri shapes', () => {
        assert.strictEqual(extractFilePath({ path: '/a/b.ts' }), '/a/b.ts');
        assert.strictEqual(extractFilePath({ filePath: 'c:/x.ts' }), 'c:/x.ts');
        assert.strictEqual(extractFilePath({ uri: { fsPath: '/u.ts', path: '/u.ts' } }), '/u.ts');
        assert.strictEqual(extractFilePath({ uri: { path: '/v.ts' } }), '/v.ts');
        assert.strictEqual(extractFilePath({ file: 'plain.txt' }), 'plain.txt');
        assert.strictEqual(extractFilePath({}), undefined);
        assert.strictEqual(extractFilePath({ path: '   ' }), undefined);
    });

    test('extractEditGroupAction normalizes host action strings', () => {
        assert.strictEqual(extractEditGroupAction(undefined), 'patch');
        assert.strictEqual(extractEditGroupAction({ action: 'created' }), 'create');
        assert.strictEqual(extractEditGroupAction({ action: 'deleted' }), 'delete');
        assert.strictEqual(extractEditGroupAction({ action: 'renamed' }), 'rename');
        assert.strictEqual(extractEditGroupAction({ action: 'moved' }), 'move');
        assert.strictEqual(extractEditGroupAction({ action: 'mkdir' }), 'mkdir');
        assert.strictEqual(extractEditGroupAction({ action: 'something-else' }), 'patch');
        assert.strictEqual(extractEditGroupAction('plain'), 'patch');
    });

    test('countEditGroupLines sums replacement text + spanned source lines', () => {
        const edits = [
            [
                { range: { startLineNumber: 1, endLineNumber: 3 }, text: 'a\nb' },
                { range: { startLineNumber: 10, endLineNumber: 10 }, text: '' },
            ],
        ];
        // removed = (3-1+1) + (10-10+1) = 3 + 1 = 4
        // added   = 2 lines + 1 (empty string splits to ['']) = 2 + 1 = 3
        assert.deepStrictEqual(countEditGroupLines(edits), { added: 3, removed: 4 });
        assert.deepStrictEqual(countEditGroupLines(undefined), { added: 0, removed: 0 });
    });

    test('buildEditGroupDiffText renders a summarized unified patch', () => {
        const text = buildEditGroupDiffText('/src/util.ts', [[
            { range: { startLineNumber: 2, endLineNumber: 2 }, text: 'const x = 1;\nconst y = 2;' },
        ]]);
        assert.match(text, /^--- a\/src\/util\.ts/m);
        assert.match(text, /^\+\+\+ b\/src\/util\.ts/m);
        assert.match(text, /@@ -L2,L2 @@/);
        assert.match(text, /\+const x = 1;/);
        assert.match(text, /\+const y = 2;/);
    });

    test('countPatchLines tallies +/- content lines only', () => {
        assert.deepStrictEqual(countPatchLines('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n'), { added: 1, removed: 1 });
        assert.deepStrictEqual(countPatchLines(undefined), { added: 0, removed: 0 });
    });
});

suite('parseCopilotLogEvents — Phase 3 diff + file-operation tool handling', () => {
    test('textEditGroup emits FileOperationEvent + DiffEvent with line stats', () => {
        const result = parseCopilotLogEvents(TOOL_CALLS_FIXTURE, 'ws-hash', '/repo');
        const diffs = result.events.filter((e) => e.type === 'diff').map((e) => e as DiffEvent);
        assert.strictEqual(diffs.length, 1, 'inline edit group must produce a DiffEvent');
        assert.strictEqual(diffs[0].filePath, '/src/utils/formatDate.ts');
        assert.strictEqual(diffs[0].addedLines, 4, 'replacement text has 4 lines');
        assert.strictEqual(diffs[0].removedLines, 3, 'range spans lines 1..3');
        assert.match(diffs[0].diffText, /export function formatDate/);

        // The file operation itself remains a `patch` (no host action annotation).
        const files = result.events.filter((e) => e.type === 'fileOperation').map((e) => e as FileOperationEvent);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].operationType, 'patch');
    });

    test('create/delete/move tools produce typed FileOperationEvents', () => {
        const filePath = writeJsonl('file-ops.jsonl', [
            snapshotLine('sess-fops'),
            turnLine('r1', 1705400005000, 'Create, delete, move', [
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'create_file', arguments: { path: '/src/new.ts', content: 'export {}' } }),
                },
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'delete_file', arguments: { path: '/src/old.ts' } }),
                },
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'move_file', arguments: { sourcePath: '/src/a.ts', newPath: '/src/b.ts' } }),
                },
            ]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        const files = result.events.filter((e) => e.type === 'fileOperation').map((e) => e as FileOperationEvent);
        assert.strictEqual(files.length, 3);

        const [created, deleted, moved] = files;
        assert.strictEqual(created.operationType, 'create');
        assert.strictEqual(created.filePath, '/src/new.ts');

        assert.strictEqual(deleted.operationType, 'delete');
        assert.strictEqual(deleted.filePath, '/src/old.ts');

        assert.strictEqual(moved.operationType, 'move');
        assert.strictEqual(moved.filePath, '/src/b.ts', 'move points at destination');
        assert.strictEqual(moved.oldPath, '/src/a.ts', 'move records the source as oldPath');
    });

    test('apply_patch tool with a patch payload yields a DiffEvent + stats', () => {
        const filePath = writeJsonl('patch.jsonl', [
            snapshotLine('sess-patch'),
            turnLine('r1', 1705400005000, 'Apply patch', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({
                    tool: 'apply_patch',
                    arguments: { path: '/src/p.ts', patch: '--- a/src/p.ts\n+++ b/src/p.ts\n@@ -1 +1 @@\n-old\n+new\n' },
                }),
            }]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        const diffs = result.events.filter((e) => e.type === 'diff').map((e) => e as DiffEvent);
        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].filePath, '/src/p.ts');
        assert.strictEqual(diffs[0].addedLines, 1);
        assert.strictEqual(diffs[0].removedLines, 1);
        assert.match(diffs[0].diffText, /^--- a\/src\/p\.ts/m);
    });

    test('command tool aliases recognized across Copilot versions', () => {
        const filePath = writeJsonl('cmd-aliases.jsonl', [
            snapshotLine('sess-cmds2'),
            turnLine('r1', 1705400005000, 'Run', [
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'executeTerminalCommand', arguments: { command: 'npm install' } }),
                },
            ]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        const commands = result.events.filter((e) => e.type === 'command').map((e) => e as CommandEvent);
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm install');
    });
});