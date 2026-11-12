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

// ---------------------------------------------------------------------------
// Remaining notification states + extraction edge shapes
// ---------------------------------------------------------------------------

suite('parseTerminalNotification — remaining states', () => {
    test('"command failed" without an exit code maps to failed', () => {
        const parsed = parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command failed]`);
        assert.deepStrictEqual(parsed, { terminalId: TERMINAL_UUID, state: 'failed', exitCode: undefined });
    });

    test('"command started" / "command running" map to running', () => {
        assert.strictEqual(
            parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command started]`)?.state,
            'running'
        );
        assert.strictEqual(
            parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: command running]`)?.state,
            'running'
        );
    });

    test('an unrecognized body maps to unknown', () => {
        assert.strictEqual(
            parseTerminalNotification(`[Terminal ${TERMINAL_UUID} notification: something else entirely]`)?.state,
            'unknown'
        );
    });

    test('isTerminalNotification tolerates undefined input', () => {
        assert.strictEqual(isTerminalNotification(undefined), false);
    });
});

suite('tool-argument extraction — edge shapes', () => {
    test('extractCommandText uses a bare shell argument', () => {
        assert.strictEqual(extractCommandText({ shell: 'bash' }), 'bash');
    });

    test('extractCommandText returns the program when the args array is empty or non-string', () => {
        assert.strictEqual(extractCommandText({ executable: 'node', args: [] }), 'node');
        assert.strictEqual(extractCommandText({ program: 'python', args: [1, 2] }), 'python');
        assert.strictEqual(extractCommandText({ shell: 'cmd', args: 'not-an-array' }), 'cmd');
    });

    test('extractCommandText handles a null argument object', () => {
        assert.strictEqual(extractCommandText(null as unknown as Record<string, unknown>), undefined);
    });

    test('extractFilePath reads the alternate keys and uri objects', () => {
        assert.strictEqual(extractFilePath({ file: '/src/f.ts' }), '/src/f.ts');
        assert.strictEqual(extractFilePath({ uri: { fsPath: '/src/fs.ts' } }), '/src/fs.ts');
        assert.strictEqual(extractFilePath({ uri: { path: '/src/path.ts' } }), '/src/path.ts');
        assert.strictEqual(extractFilePath({ uri: { fsPath: '   ' } }), undefined);
        assert.strictEqual(extractFilePath({ uri: {} }), undefined);
        assert.strictEqual(extractFilePath({ uri: 'not-an-object' }), 'not-an-object', 'a string uri is used verbatim');
        assert.strictEqual(extractFilePath({}), undefined);
    });

    test('extractFilePath handles a null argument object', () => {
        assert.strictEqual(extractFilePath(null as unknown as Record<string, unknown>), undefined);
    });

    test('extractEditGroupAction maps every documented action verb', () => {
        assert.strictEqual(extractEditGroupAction({ action: 'created' }), 'create');
        assert.strictEqual(extractEditGroupAction({ action: 'new' }), 'create');
        assert.strictEqual(extractEditGroupAction({ action: 'deleted' }), 'delete');
        assert.strictEqual(extractEditGroupAction({ action: 'removed' }), 'delete');
        assert.strictEqual(extractEditGroupAction({ action: 'moved' }), 'move');
        assert.strictEqual(extractEditGroupAction({ action: 'renamed' }), 'rename');
        assert.strictEqual(extractEditGroupAction({ action: 'mkdir' }), 'mkdir');
        assert.strictEqual(extractEditGroupAction({ action: 'Create_Directory' }), 'mkdir');
    });

    test('extractEditGroupAction defaults to patch for unknown or absent actions', () => {
        assert.strictEqual(extractEditGroupAction({ action: 'sideways' }), 'patch');
        assert.strictEqual(extractEditGroupAction('plain-string'), 'patch');
        assert.strictEqual(extractEditGroupAction(undefined), 'patch');
    });
});


// ---------------------------------------------------------------------------
// Edit-group line counting / diff rendering
// ---------------------------------------------------------------------------

suite('edit-group helpers — edge payloads', () => {
    test('countEditGroupLines returns zeros for a non-array payload', () => {
        assert.deepStrictEqual(countEditGroupLines(undefined), { added: 0, removed: 0 });
        assert.deepStrictEqual(countEditGroupLines('nope'), { added: 0, removed: 0 });
    });

    test('countEditGroupLines accepts both flat and nested group arrays', () => {
        const flat = countEditGroupLines([{ range: { startLineNumber: 3, endLineNumber: 4 }, text: 'a\nb\nc' }]);
        assert.deepStrictEqual(flat, { added: 3, removed: 2 });

        const nested = countEditGroupLines([[{ range: { startLineNumber: 1, endLineNumber: 1 }, text: 'x' }]]);
        assert.deepStrictEqual(nested, { added: 1, removed: 1 });
    });

    test('countEditGroupLines skips primitive entries and defaults missing ranges', () => {
        const stats = countEditGroupLines([null, 'string-edit', { text: 'only-text' }]);
        // Primitives are skipped; the range-less edit counts as a single line.
        assert.deepStrictEqual(stats, { added: 1, removed: 1 });
    });

    test('buildEditGroupDiffText reports a missing payload', () => {
        const text = buildEditGroupDiffText('/src/a.ts', undefined);
        assert.match(text, /^--- a\/src\/a\.ts$/m);
        assert.match(text, /^\+<no inline edit payload captured>$/m);
    });

    test('buildEditGroupDiffText renders nested groups, defaults and empty replacements', () => {
        const text = buildEditGroupDiffText('/src/a.ts', [
            [{ range: { startLineNumber: 2, endLineNumber: 3 }, text: 'line1\nline2' }],
            [{ text: undefined }],
            [null, 'primitive'],
        ]);
        assert.match(text, /^@@ -L2,L3 @@$/m);
        assert.match(text, /^\+line1$/m);
        assert.match(text, /^\+line2$/m);
        // A range-less edit falls back to L1.
        assert.match(text, /^@@ -L1,L1 @@$/m);
        assert.match(text, /^\+<empty replacement>$/m);
    });

    test('countPatchLines ignores file headers', () => {
        const stats = countPatchLines('--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n+extra');
        assert.deepStrictEqual(stats, { added: 2, removed: 1 });
        assert.deepStrictEqual(countPatchLines(undefined), { added: 0, removed: 0 });
    });
});

// ---------------------------------------------------------------------------
// JSONL replay edge cases (state patches, malformed lines)
// ---------------------------------------------------------------------------

/** Snapshot with extra top-level state so deep-set patches have a target. */
function richSnapshotLine(): string {
    return JSON.stringify({
        kind: 0,
        v: { version: 3, sessionId: 'sess-replay', creationDate: 1705400000000, requests: [], flags: ['a', 'b'], label: 'plain' },
    });
}

suite('parseCopilotLogEvents — replay edge cases', () => {
    test('applies deep-set patches to objects and arrays', () => {
        const filePath = writeJsonl('deep-set.jsonl', [
            richSnapshotLine(),
            JSON.stringify({ kind: 1, k: ['extra'], v: { marker: true } }),
            JSON.stringify({ kind: 1, k: ['extra', 'nested'], v: 'deep' }),
            JSON.stringify({ kind: 1, k: ['flags', 0], v: 'z' }),
            JSON.stringify({ kind: 1, k: ['flags', 'name'], v: 'named' }),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.deepStrictEqual(result.errors, []);
        // A patch that is not a `requests` append must not add conversation turns.
        assert.strictEqual(result.events.length, 0);
    });

    test('ignores unapplicable deep-set patches without throwing', () => {
        const filePath = writeJsonl('deep-set-ignored.jsonl', [
            richSnapshotLine(),
            JSON.stringify({ kind: 1, k: [], v: 'no-keys' }),
            JSON.stringify({ kind: 1, k: ['label', 'deeper'], v: 'into-a-string' }),
            JSON.stringify({ kind: 1, k: ['missing', 'x'], v: 1 }),
            JSON.stringify({ kind: 1, k: ['flags', 999999], v: 'out-of-range' }),
            JSON.stringify({ kind: 1, k: Array.from({ length: 70 }, (_, i) => `k${i}`), v: 1 }),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.events.length, 0);
    });

    test('reports malformed JSON and oversized lines but keeps parsing', () => {
        const filePath = writeJsonl('malformed.jsonl', [
            snapshotLine('sess-malformed'),
            '*not-json*',
            'x'.repeat(1_000_001),
            turnLine('r1', 1705400001000, 'Hi', [{ kind: undefined, value: 'Hello!' }]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.ok(result.errors.some((e) => /invalid JSON/.test(e)), `errors: ${result.errors.join(', ')}`);
        assert.ok(result.errors.some((e) => /exceeds limit/.test(e)), `errors: ${result.errors.join(', ')}`);
        assert.strictEqual(result.errors.length, 2);
    });

    test('falls back to the file name and epoch when the snapshot lacks metadata', () => {
        const filePath = writeJsonl('no-metadata.jsonl', [
            JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }),
            JSON.stringify({
                kind: 2,
                k: ['requests'],
                v: [{
                    requestId: 'r1',
                    message: { text: 'Hello' },
                    response: [{
                        kind: 'toolInvocationSerialized',
                        value: JSON.stringify({ tool: 'read_file', arguments: { path: '/src/x.ts' } }),
                    }],
                }],
            }),
        ]);

        const expectedSessionId = path.basename(filePath, path.extname(filePath));
        const tools = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'toolCall') as ToolCallEvent[];
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].sessionId, expectedSessionId);
        assert.strictEqual(tools[0].timestamp, new Date(0).toISOString());
    });

    test('returns no events when a patch replaces requests with a non-array', () => {
        const filePath = writeJsonl('requests-not-array.jsonl', [
            snapshotLine('sess-non-array'),
            JSON.stringify({ kind: 2, k: ['requests'], v: 'definitely-not-an-array' }),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
    });

    test('skips blank lines and an oversized line while locating the snapshot', () => {
        const filePath = writeJsonl('scan.jsonl', [
            '',
            'y'.repeat(1_000_001),
            snapshotLine('sess-scan'),
            turnLine('r1', 1705400001000, 'Hi', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({ tool: 'read_file', arguments: { path: '/src/y.ts' } }),
            }]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        // The scan loop skips the oversized line silently; the replay pass reports it.
        assert.strictEqual(result.errors.filter((e) => /invalid JSON/.test(e)).length, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /exceeds limit/);
        assert.ok(result.events.length > 0);
    });
});

// ---------------------------------------------------------------------------
// Turn / response-item edge cases
// ---------------------------------------------------------------------------

suite('parseCopilotLogEvents — turn and item edge cases', () => {
    test('ignores non-conversation turns (kind is set)', () => {
        const filePath = writeJsonl('non-conversation.jsonl', [
            snapshotLine('sess-kind'),
            JSON.stringify({
                kind: 2, k: ['requests'], v: [{
                    kind: 'tool',
                    message: { text: 'internal' },
                    response: [{
                        kind: 'toolInvocationSerialized',
                        value: JSON.stringify({ tool: 'runCommand', arguments: { command: 'rm -rf /' } }),
                    }],
                }],
            }),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
    });

    test('tolerates turns without message text and with non-array responses', () => {
        const filePath = writeJsonl('sparse-turns.jsonl', [
            snapshotLine('sess-sparse'),
            JSON.stringify({
                kind: 2, k: ['requests'], v: [
                    { requestId: 'r1', response: [] },
                    { requestId: 'r2', message: {}, response: 'not-an-array' },
                ],
            }),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.deepStrictEqual(result.errors, []);
    });

    test('skips primitive response items and truncates an oversized raw snippet', () => {
        const filePath = writeJsonl('primitive-items.jsonl', [
            snapshotLine('sess-items'),
            turnLine('r1', 1705400001000, 'Run it', [
                null,
                'primitive',
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'runCommand', arguments: { command: 'echo ' + 'z'.repeat(3000) } }),
                },
            ]),
        ]);

        const commands = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].raw?.length, 2000, 'raw snippet is capped at 2000 chars');
    });

    test('resolves the tool name from tool, then name, then a placeholder', () => {
        const filePath = writeJsonl('tool-names.jsonl', [
            snapshotLine('sess-names'),
            turnLine('r1', 1705400001000, 'Names', [
                { kind: 'toolInvocationSerialized', value: JSON.stringify({ name: 'list_dir', arguments: { path: '/repo' } }) },
                { kind: 'toolInvocationSerialized', value: JSON.stringify({ arguments: {} }) },
                { kind: 'toolInvocationSerialized', value: JSON.stringify({ tool: 'read_file', arguments: ['not-an-object'] }) },
            ]),
        ]);

        const tools = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'toolCall') as ToolCallEvent[];
        assert.deepStrictEqual(tools.map((t) => t.toolName), ['list_dir', '(unknown tool)', 'read_file']);
        assert.deepStrictEqual(tools[2].arguments, {}, 'non-object arguments normalize to {}');
    });

    test('records invalid serialized tool payloads as errors', () => {
        const filePath = writeJsonl('bad-tool-json.jsonl', [
            snapshotLine('sess-bad'),
            turnLine('r1', 1705400001000, 'Bad', [
                { kind: 'toolInvocationSerialized', value: '{oops' },
                { kind: 'toolInvocationSerialized', value: 42 },
            ]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /invalid toolInvocationSerialized JSON/);
        assert.strictEqual(result.events.filter((e) => e.type === 'toolCall').length, 0);
    });

    test('a command tool with no command text still yields a CommandEvent', () => {
        const filePath = writeJsonl('cmd-empty.jsonl', [
            snapshotLine('sess-cmd-empty'),
            turnLine('r1', 1705400001000, 'Run', [
                { kind: 'toolInvocationSerialized', value: JSON.stringify({ tool: 'runCommand', arguments: {} }) },
            ]),
        ]);

        const commands = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, '(command text unavailable)');
    });

    test('a diff tool using the `diff` argument yields a DiffEvent', () => {
        const filePath = writeJsonl('diff-arg.jsonl', [
            snapshotLine('sess-diff-arg'),
            turnLine('r1', 1705400001000, 'Diff', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({
                    tool: 'write_to_file',
                    arguments: { path: '/src/d.ts', diff: '--- a/d\n+++ b/d\n-x\n+y\n' },
                }),
            }]),
        ]);

        const diffs = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'diff') as DiffEvent[];
        assert.strictEqual(diffs.length, 1);
        assert.deepStrictEqual([diffs[0].addedLines, diffs[0].removedLines], [1, 1]);
    });
});

suite('parseCopilotLogEvents — read failures', () => {
    test('reports a read failure for a missing file', () => {
        const result = parseCopilotLogEvents(path.join(os.tmpdir(), 'cw-does-not-exist-1234.jsonl'), 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /Failed to read file/);
    });
});


// ---------------------------------------------------------------------------
// File-operation / textEditGroup path variants and notifications
// ---------------------------------------------------------------------------

suite('parseCopilotLogEvents — path and notification variants', () => {
    test('move tools fall back to the source path when no destination is logged', () => {
        const filePath = writeJsonl('move-fallback.jsonl', [
            snapshotLine('sess-move'),
            turnLine('r1', 1705400001000, 'Move', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({ tool: 'move_file', arguments: { path: '/src/only.ts' } }),
            }]),
        ]);

        const files = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].filePath, '/src/only.ts');
        assert.strictEqual(files[0].oldPath, '/src/only.ts');
    });

    test('file tools accept newPath, destinationPath, oldPath and sourcePath', () => {
        const filePath = writeJsonl('create-variants.jsonl', [
            snapshotLine('sess-create'),
            turnLine('r1', 1705400001000, 'Create', [
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({ tool: 'create_file', arguments: { newPath: '/src/only-new.ts' } }),
                },
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({
                        tool: 'rename_file',
                        arguments: { oldPath: '/src/old.ts', destinationPath: '/src/dest.ts' },
                    }),
                },
                {
                    kind: 'toolInvocationSerialized',
                    value: JSON.stringify({
                        tool: 'rename_file',
                        arguments: { sourcePath: '/src/src.ts', path: '/src/dst.ts' },
                    }),
                },
            ]),
        ]);

        const files = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(files.length, 3);
        assert.strictEqual(files[0].filePath, '/src/only-new.ts');
        assert.strictEqual(files[1].filePath, '/src/dest.ts');
        assert.strictEqual(files[1].oldPath, '/src/old.ts');
        assert.strictEqual(files[2].filePath, '/src/dst.ts');
        assert.strictEqual(files[2].oldPath, '/src/src.ts');
    });
});


suite('parseCopilotLogEvents — edit groups and notifications', () => {
    test('textEditGroup items use uri.path, action verbs and old-path variants', () => {
        const filePath = writeJsonl('edit-groups.jsonl', [
            snapshotLine('sess-groups'),
            turnLine('r1', 1705400001000, 'Edits', [
                {
                    kind: 'textEditGroup',
                    uri: { path: '/src/via-path.ts' },
                    value: { action: 'renamed', oldPath: '/src/prev.ts' },
                    edits: [[{ range: { startLineNumber: 1, endLineNumber: 2 }, text: 'a\nb' }]],
                },
                {
                    kind: 'textEditGroup',
                    uri: { fsPath: '/src/prev-path.ts' },
                    value: { action: 'moved', previousPath: '/src/older.ts' },
                    edits: [{ range: { startLineNumber: 5 }, text: 'x' }],
                },
                { kind: 'textEditGroup', uri: { fsPath: '/src/plain.ts' }, value: 'not-an-object' },
                { kind: 'textEditGroup', value: { action: 'delete' } },
            ]),
        ]);

        const result = parseCopilotLogEvents(filePath, 'ws-hash');
        const files = result.events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(files.length, 3, 'the uri-less group is skipped');
        assert.strictEqual(files[0].operationType, 'rename');
        assert.strictEqual(files[0].filePath, '/src/via-path.ts');
        assert.strictEqual(files[0].oldPath, '/src/prev.ts');
        assert.strictEqual(files[0].detail, 'inline text edit group (rename)');
        assert.strictEqual(files[1].operationType, 'move');
        assert.strictEqual(files[1].oldPath, '/src/older.ts');
        assert.strictEqual(files[2].operationType, 'patch');
        assert.strictEqual(files[2].oldPath, undefined);
        assert.strictEqual(files[2].detail, 'inline text edit group');

        const diffs = result.events.filter((e) => e.type === 'diff') as DiffEvent[];
        assert.strictEqual(diffs.length, 2, 'only groups carrying an edits array yield a DiffEvent');
        assert.strictEqual(diffs[0].addedLines, 2);
        assert.strictEqual(diffs[0].removedLines, 2);
        assert.match(diffs[0].diffText, /^@@ -L1,L2 @@$/m);
    });

    test('a failed notification without a matching command records an ErrorEvent', () => {
        const orphanUuid = '11111111-2222-3333-4444-555555555555';
        const filePath = writeJsonl('orphan-notification.jsonl', [
            snapshotLine('sess-orphan'),
            turnLine('r1', 1705400001000, `[Terminal ${orphanUuid} notification: command failed]`, []),
        ]);

        const errors = parseCopilotLogEvents(filePath, 'ws-hash')
            .events.filter((e) => e.type === 'error') as ErrorEvent[];
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].message, 'command failed');
        assert.strictEqual(errors[0].commandId, undefined);
    });

    test('a nonzero notification exit code is linked back to the pending command', () => {
        const filePath = writeJsonl('pending-notification.jsonl', [
            snapshotLine('sess-pending'),
            turnLine('r1', 1705400001000, 'Run tests', [{
                kind: 'toolInvocationSerialized',
                value: JSON.stringify({ tool: 'runCommand', arguments: { command: 'npm test', terminalId: TERMINAL_UUID } }),
            }]),
            turnLine('r2', 1705400002000, `[Terminal ${TERMINAL_UUID} notification: command failed with exit code 3]`, []),
        ]);

        const events = parseCopilotLogEvents(filePath, 'ws-hash').events;
        const commands = events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].exitCode, 3);

        const errors = events.filter((e) => e.type === 'error') as ErrorEvent[];
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].message, 'command failed with exit code 3');
        assert.strictEqual(errors[0].commandId, commands[0].id);
    });
});

