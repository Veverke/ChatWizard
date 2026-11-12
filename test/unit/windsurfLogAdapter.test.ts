/**
 * test/unit/windsurfLogAdapter.test.ts
 *
 * Phase 3 — Windsurf log adapter unit tests.
 * The adapter normalizes the `cascade.sessionData` payload the Windsurf parser
 * already reads. Tests cover both layers: structured tool calls (when a payload
 * carries them) and the fenced-shell-block fallback that is the only signal in
 * today's payloads. No SQLite is required — the parser is pure.
 */

import * as assert from 'assert';
import {
    extractShellFences,
    messageToolCalls,
    parseWindsurfCascadeJson,
    parseWindsurfLogEvents,
    toolCallInfo,
} from '../../src/logs/adapters/windsurfLogAdapter';
import { CommandEvent, DiffEvent, FileOperationEvent, ToolCallEvent } from '../../src/logs/types';

const CTX = { workspaceId: 'ws-hash', workspacePath: '/repo', sourcePath: '/ws-hash/state.vscdb' };

function cascade(messages: unknown[], overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        sessions: [{ sessionId: 'cascade-1', createdAt: 1714500000000, messages, ...overrides }],
    });
}

suite('windsurfLogAdapter — fenced shell blocks', () => {
    test('extracts shell fences and ignores other languages', () => {
        const content = [
            'Run this:',
            '```bash',
            'npm ci',
            'npm test',
            '```',
            '```yaml',
            'name: CI',
            '```',
            '```',
            'plain',
            '```',
        ].join('\n');
        const fences = extractShellFences(content);
        assert.strictEqual(fences.length, 1);
        assert.strictEqual(fences[0].language, 'bash');
        assert.strictEqual(fences[0].commandText, 'npm ci\nnpm test');
    });

    test('ignores unterminated fences', () => {
        assert.deepStrictEqual(extractShellFences('```powershell\nGet-ChildItem\n'), []);
    });

    test('assistant fences become commands, user fences do not', () => {
        const raw = cascade([
            { role: 'user', content: 'try:\n```bash\nrm -rf build\n```', timestamp: 1714500010000 },
            { role: 'assistant', content: 'Use:\n```sh\nnpm run build\n```', timestamp: 1714500020000 },
        ]);

        const { events, errors } = parseWindsurfCascadeJson(raw, CTX);
        assert.deepStrictEqual(errors, []);

        const commands = events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1, 'only the assistant block is an agent action');
        assert.strictEqual(commands[0].commandText, 'npm run build');
        assert.strictEqual(commands[0].shell, 'sh');
        assert.strictEqual(commands[0].sessionId, 'cascade-1');
        assert.strictEqual(commands[0].workspaceId, 'ws-hash');
        assert.strictEqual(commands[0].messageIndex, 1);
        assert.strictEqual(commands[0].timestamp, new Date(1714500020000).toISOString());
        assert.match(commands[0].raw ?? '', /derived from a fenced sh block/);
        assert.strictEqual(commands[0].exitCode, undefined, 'no exit code is available');
    });
});

suite('windsurfLogAdapter — structured tool calls', () => {
    test('toolCallInfo parses object and JSON-string arguments', () => {
        assert.deepStrictEqual(
            toolCallInfo({ name: 'run_command', arguments: { command: 'ls' } }),
            { name: 'run_command', args: { command: 'ls' } }
        );
        assert.deepStrictEqual(
            toolCallInfo({ toolName: 'edit_file', args: '{"path":"a.ts"}' }),
            { name: 'edit_file', args: { path: 'a.ts' } }
        );
        assert.strictEqual(toolCallInfo({ arguments: {} }), undefined);
        assert.strictEqual(toolCallInfo('nope'), undefined);
    });

    test('messageToolCalls accepts all known field names', () => {
        assert.strictEqual(messageToolCalls({ toolCalls: [{}] }).length, 1);
        assert.strictEqual(messageToolCalls({ tool_calls: [{}, {}] }).length, 2);
        assert.strictEqual(messageToolCalls({ toolInvocations: [{}] }).length, 1);
        assert.strictEqual(messageToolCalls({}).length, 0);
    });

    test('command tool calls emit a ToolCallEvent + CommandEvent', () => {
        const raw = cascade([{
            role: 'assistant',
            timestamp: 1714500020000,
            toolCalls: [{ name: 'run_terminal_cmd', args: { command: 'npm run lint', cwd: '/repo/app', shell: 'bash' } }],
        }]);

        const { events } = parseWindsurfCascadeJson(raw, CTX);
        const tools = events.filter((e) => e.type === 'toolCall') as ToolCallEvent[];
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].toolName, 'run_terminal_cmd');

        const commands = events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0].commandText, 'npm run lint');
        assert.strictEqual(commands[0].cwd, '/repo/app');
        assert.strictEqual(commands[0].shell, 'bash');
    });

    test('file-write tool calls emit a FileOperationEvent + DiffEvent', () => {
        const searchReplace = [
            '------- SEARCH',
            'const a = 1;',
            '=======',
            'const a = 2;',
            '+++++++ REPLACE',
        ].join('\n');
        const raw = cascade([{
            role: 'assistant',
            timestamp: 1714500020000,
            toolCalls: [{ name: 'edit_file', arguments: { path: 'src/a.ts', patch: searchReplace } }],
        }]);

        const { events } = parseWindsurfCascadeJson(raw, CTX);
        const fileOps = events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].filePath, 'src/a.ts');
        assert.strictEqual(fileOps[0].operationType, 'patch');

        const diffs = events.filter((e) => e.type === 'diff') as DiffEvent[];
        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].filePath, 'src/a.ts');
        assert.match(diffs[0].diffText, /^--- a\/src\/a\.ts/m);
        assert.strictEqual(diffs[0].addedLines, 1);
        assert.strictEqual(diffs[0].removedLines, 1);
    });

    test('delete tool calls map to the delete operation', () => {
        const raw = cascade([{
            role: 'assistant',
            toolCalls: [{ name: 'delete_file', args: { file_path: 'src/old.ts' } }],
        }]);
        const { events } = parseWindsurfCascadeJson(raw, CTX);
        const fileOps = events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(fileOps[0].operationType, 'delete');
        assert.strictEqual(fileOps[0].filePath, 'src/old.ts');
    });
});

suite('windsurfLogAdapter — payload edges', () => {
    test('handles multiple sessions and a missing sessionId', () => {
        const raw = JSON.stringify({
            sessions: [
                { sessionId: 'a', messages: [{ role: 'assistant', content: '```bash\nls\n```' }] },
                { messages: [{ role: 'assistant', content: '```bash\npwd\n```' }] },
            ],
        });
        const { events } = parseWindsurfCascadeJson(raw, CTX);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].sessionId, 'a');
        assert.strictEqual(events[1].sessionId, 'ws-hash-windsurf-unknown');
        assert.strictEqual(events[0].timestamp, new Date(0).toISOString(), 'no timestamps → epoch');
    });

    test('reports malformed payloads instead of throwing', () => {
        assert.strictEqual(parseWindsurfCascadeJson('not json', CTX).errors.length, 1);
        const noSessions = parseWindsurfCascadeJson('{"foo":1}', CTX);
        assert.strictEqual(noSessions.events.length, 0);
        assert.match(noSessions.errors[0], /sessions is not an array/);
    });

    test('parseWindsurfLogEvents surfaces an unreadable database as an error', async () => {
        const result = await parseWindsurfLogEvents('/nonexistent/state.vscdb', 'ws-hash');
        assert.strictEqual(result.events.length, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /Cannot read cascade.sessionData/);
    });
});

