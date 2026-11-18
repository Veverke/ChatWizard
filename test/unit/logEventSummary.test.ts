/**
 * test/unit/logEventSummary.test.ts
 *
 * UX pass — human-readable digests for the Commands view.
 *
 * Verifies the pure helpers behind the tree labels (`toolName [target]`), the
 * detail webview's Description / Input / Output sections and the
 * plain-English command descriptions. No VS Code host is required.
 */

import * as assert from 'assert';
import {
    describeCommand,
    describeLogEvent,
    describeToolCall,
    describeToolName,
    oneLine,
    toolCallInputText,
    toolCallLabel,
    toolCallOutputText,
    toolCallTarget,
    toolLookupKey,
} from '../../src/logs/logEventSummary';
import { CommandEvent, LogEvent, ToolCallEvent } from '../../src/logs/types';

function makeToolCall(overrides: Partial<ToolCallEvent> & { id?: string }): ToolCallEvent {
    return {
        type: 'toolCall',
        id: 't1',
        timestamp: '2026-01-01T10:00:00.000Z',
        tool: 'copilot',
        toolName: 'view',
        ...overrides,
    } as ToolCallEvent;
}

suite('logEventSummary — text helpers', () => {
    test('oneLine keeps the first non-empty line and caps it', () => {
        assert.strictEqual(oneLine('  npm test  '), 'npm test');
        assert.strictEqual(oneLine('\n\n  git status\n--short'), 'git status');
        assert.strictEqual(oneLine(''), '');
        assert.strictEqual(oneLine(undefined), '');
        assert.strictEqual(oneLine('abcdefghij', 5), 'abcd…');
    });

    test('toolLookupKey unwraps MCP namespaces', () => {
        assert.strictEqual(toolLookupKey('Run_In_Terminal'), 'run_in_terminal');
        assert.strictEqual(toolLookupKey('mcp__github__create_issue'), 'create_issue');
        assert.strictEqual(toolLookupKey('  '), '');
        assert.strictEqual(toolLookupKey(undefined), '');
    });
});

suite('logEventSummary — tool catalogue', () => {
    test('describeToolName explains the known tool families', () => {
        assert.strictEqual(describeToolName('view'), 'Reads a file from the workspace');
        assert.strictEqual(describeToolName('powershell'), 'Runs a shell command in the terminal');
        assert.strictEqual(describeToolName('grep'), 'Searches the workspace for text or files');
        assert.strictEqual(describeToolName('apply_patch'), 'Applies a diff / patch to a file');
        assert.strictEqual(describeToolName('mcp__repo__create_file'), 'Creates or edits a workspace file');
        assert.strictEqual(describeToolName('some_unknown_tool'), undefined);
    });

    test('describeCommand recognises common command families', () => {
        assert.match(describeCommand('git status --short'), /^Runs a Git command: git status --short$/);
        assert.match(describeCommand('npm run build'), /^Runs a Node\.js package-manager command/);
        assert.match(describeCommand('dotnet build'), /^Runs the \.NET toolchain/);
        assert.match(describeCommand('pytest -q'), /^Runs Python tests/);
        assert.match(describeCommand('Get-ChildItem -Recurse'), /^Runs a file-system command/);
        assert.match(describeCommand('my-custom-script.sh'), /^Runs the shell command “my-custom-script\.sh”$/);
        assert.strictEqual(describeCommand('   '), 'Executes a shell command');
    });
});

suite('logEventSummary — tool call targets and labels', () => {
    test('the identifying argument follows the tool family', () => {
        assert.strictEqual(toolCallTarget(makeToolCall({ arguments: { path: 'src/extension.ts' } })), 'src/extension.ts');
        assert.strictEqual(
            toolCallTarget(makeToolCall({ toolName: 'powershell', arguments: { command: 'npm test' } })),
            'npm test'
        );
        // A search prefers its query over the folder it searches.
        assert.strictEqual(
            toolCallTarget(makeToolCall({
                toolName: 'grep',
                arguments: { query: 'registerLogCommands', path: 'src/logs' },
            })),
            'registerLogCommands'
        );
        assert.strictEqual(
            toolCallTarget(makeToolCall({ toolName: 'fetch', arguments: { url: 'https://example.com/docs' } })),
            'https://example.com/docs'
        );
    });

    test('unknown tools fall back to the first useful argument', () => {
        assert.strictEqual(
            toolCallTarget(makeToolCall({ toolName: 'weird_tool', arguments: { note: 'n/a', file: 'a.ts' } })),
            'a.ts'
        );
        assert.strictEqual(
            toolCallTarget(makeToolCall({ toolName: 'weird_tool', arguments: { description: 'Look at the build log' } })),
            'Look at the build log'
        );
        assert.strictEqual(toolCallTarget(makeToolCall({ toolName: 'weird_tool' })), undefined);
        assert.strictEqual(toolCallTarget(makeToolCall({ toolName: 'weird_tool', arguments: {} })), undefined);
    });

    test('MCP tools expose their nested input object', () => {
        assert.strictEqual(
            toolCallTarget(makeToolCall({
                toolName: 'mcp__repo__read_file',
                arguments: { input: { path: 'docs/architecture.md' } },
            })),
            'docs/architecture.md'
        );
    });

    test('file lists are joined and long paths keep their tail', () => {
        assert.strictEqual(
            toolCallTarget(makeToolCall({ toolName: 'read_files', arguments: { paths: ['a.ts', 'b.ts'] } })),
            'a.ts, b.ts'
        );
        const longPath = `c:\\${'deep\\'.repeat(20)}extension.ts`;
        const target = toolCallTarget(makeToolCall({ arguments: { path: longPath } }), 30);
        assert.strictEqual(target?.length, 30);
        assert.ok(target?.startsWith('…'), `expected a tail-trimmed path, got ${target}`);
        assert.ok(target?.endsWith('extension.ts'), `expected the file name to survive, got ${target}`);
    });
});


suite('logEventSummary — labels and descriptions', () => {
    test('labels render the target in square brackets', () => {
        assert.strictEqual(
            toolCallLabel(makeToolCall({ arguments: { path: 'src/extension.ts' } })),
            'view [src/extension.ts]'
        );
        assert.strictEqual(
            toolCallLabel(makeToolCall({ toolName: 'powershell', arguments: { command: 'npm test' } })),
            'powershell [npm test]'
        );
        assert.strictEqual(toolCallLabel(makeToolCall({ toolName: 'view', arguments: undefined })), 'view');
        assert.strictEqual(toolCallLabel(makeToolCall({ toolName: '' })), 'tool');

        const long = toolCallLabel(
            makeToolCall({
                toolName: 'powershell',
                arguments: { command: 'npm test -- --watch --coverage --reporter=dot' },
            }),
            30
        );
        assert.strictEqual(long.length, 30);
        assert.ok(long.startsWith('powershell ['), long);
        assert.ok(long.endsWith('…]'), long);
        assert.ok(!long.includes('npm test -- --watch --coverage'), 'the command is trimmed');
    });

    test('describeToolCall combines the catalogue entry, description and target', () => {
        assert.strictEqual(
            describeToolCall(makeToolCall({ arguments: { path: 'src/a.ts' } })),
            'Reads a file from the workspace: src/a.ts'
        );
        assert.strictEqual(
            describeToolCall(makeToolCall({
                toolName: 'powershell',
                arguments: { command: 'npm test', description: 'Verify the build passes' },
            })),
            'Runs a shell command in the terminal: Verify the build passes'
        );
        assert.strictEqual(
            describeToolCall(makeToolCall({ toolName: 'weird_tool' })),
            'Invokes the “weird_tool” tool'
        );
    });

    test('input/output helpers only return real payloads', () => {
        assert.strictEqual(toolCallInputText(makeToolCall({ arguments: undefined })), undefined);
        assert.strictEqual(toolCallInputText(makeToolCall({ arguments: {} })), undefined);
        assert.strictEqual(
            toolCallInputText(makeToolCall({ arguments: { path: 'a.ts' } })),
            '{\n  "path": "a.ts"\n}'
        );
        assert.strictEqual(toolCallOutputText(makeToolCall({ resultSummary: '   ' })), undefined);
        assert.strictEqual(toolCallOutputText(makeToolCall({ resultSummary: '  exit 0  ' })), 'exit 0');
    });
});

suite('logEventSummary — whole-event descriptions', () => {
    const base = { id: 'x', timestamp: '2026-01-01T10:00:00.000Z', tool: 'copilot' as const };

    test('describes every event kind', () => {
        assert.match(
            describeLogEvent({ ...base, type: 'command', commandText: 'git status' } as CommandEvent),
            /^Runs a Git command: git status$/
        );
        assert.strictEqual(
            describeLogEvent({ ...base, type: 'fileOperation', operationType: 'create', filePath: 'a.ts' } as LogEvent),
            'Creates the file a.ts'
        );
        assert.strictEqual(
            describeLogEvent({
                ...base, type: 'diff', filePath: 'a.ts', diffText: '', addedLines: 2, removedLines: 1,
            } as LogEvent),
            'Captures a change to a.ts (+2 −1 lines)'
        );
        assert.strictEqual(
            describeLogEvent({ ...base, type: 'toolCall', toolName: 'view', arguments: { path: 'a.ts' } } as LogEvent),
            'Reads a file from the workspace: a.ts'
        );
        assert.strictEqual(
            describeLogEvent({ ...base, type: 'error', message: 'boom', severity: 'fatal' } as LogEvent),
            'Records a fatal: boom'
        );
        assert.strictEqual(
            describeLogEvent({
                ...base, type: 'plannerStep', description: 'Plan the refactor', stepType: 'plan',
            } as LogEvent),
            'Planner step (plan): Plan the refactor'
        );
    });
});

