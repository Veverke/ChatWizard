/**
 * test/unit/toolCallsProvider.test.ts
 *
 * UX pass — "LLM Tool Calls" section of the Commands view.
 *
 * Verifies grouping (per session, newest first), the self-describing row
 * labels (`toolName [target]`), the shared filters / workspace scope and the
 * resilience of the query path. The provider is constructed against an
 * in-memory `LogService`, so no VS Code host is needed.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    MAX_TOOL_CALLS_PER_QUERY,
    ToolCallsProvider,
    ToolCallsGroupItem,
    ToolCallLeafItem,
    TOOL_CALLS_ICON,
    formatToolCallBadge,
    toolCallDescription,
} from '../../src/logs/toolCallsProvider';
import { ToolCallEvent } from '../../src/logs/types';

function makeToolCall(overrides: Partial<ToolCallEvent> & { id: string; timestamp: string }): ToolCallEvent {
    return {
        type: 'toolCall',
        tool: 'copilot',
        toolName: 'view',
        arguments: { path: 'src/extension.ts' },
        sessionId: 's1',
        workspacePath: '/repo',
        ...overrides,
    } as ToolCallEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-tool-calls-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('ToolCallsProvider — display helpers', () => {
    test('formatToolCallBadge maps the captured outcome', () => {
        assert.strictEqual(formatToolCallBadge(makeToolCall({ id: 't1', timestamp: 'T' })), '');
        assert.strictEqual(formatToolCallBadge(makeToolCall({ id: 't1', timestamp: 'T', success: true })), '✓ ok');
        assert.strictEqual(formatToolCallBadge(makeToolCall({ id: 't1', timestamp: 'T', success: false })), '✗ failed');
    });

    test('toolCallDescription joins the badge and the local time', () => {
        const local = new Date(2026, 0, 1, 10, 5, 0).toISOString();
        assert.strictEqual(
            toolCallDescription(makeToolCall({ id: 't1', timestamp: local })),
            '10:05',
            'no outcome → time only'
        );
        assert.strictEqual(
            toolCallDescription(makeToolCall({ id: 't1', timestamp: local, success: false })),
            '✗ failed · 10:05'
        );
        assert.strictEqual(toolCallDescription(makeToolCall({ id: 't1', timestamp: 'not-a-date' })), '');
    });

    test('rows are self-describing', () => {
        const read = new ToolCallLeafItem(makeToolCall({ id: 't1', timestamp: 'T' }));
        assert.strictEqual(read.label, 'view [src/extension.ts]');
        assert.strictEqual(read.contextValue, 'toolCall');
        assert.strictEqual(read.command?.command, 'chatwizard.logs.toolCalls.showDetails');
        assert.ok(String(read.tooltip).includes('Reads a file from the workspace: src/extension.ts'));
        assert.ok(String(read.tooltip).includes('"path": "src/extension.ts"'), 'tooltip carries the arguments');

        const shell = new ToolCallLeafItem(makeToolCall({
            id: 't2',
            timestamp: 'T',
            toolName: 'powershell',
            arguments: { command: 'npm test' },
        }));
        assert.strictEqual(shell.label, 'powershell [npm test]');

        const failed = new ToolCallLeafItem(makeToolCall({ id: 't3', timestamp: 'T', success: false }));
        assert.ok(failed.iconPath instanceof vscode.ThemeIcon);
        assert.strictEqual((failed.iconPath as vscode.ThemeIcon).id, 'tools');
        assert.ok((failed.iconPath as vscode.ThemeIcon).color, 'failed calls use the error colour');
    });

    test('the section owns the tools icon for its session rows and leaves', () => {
        assert.strictEqual(TOOL_CALLS_ICON, 'tools');

        const group = new ToolCallsGroupItem('s1', 'Chat', [
            makeToolCall({ id: 't1', timestamp: '2026-01-01T10:00:00.000Z' }),
        ], '/repo');
        assert.strictEqual((group.iconPath as vscode.ThemeIcon).id, TOOL_CALLS_ICON);

        const leaf = new ToolCallLeafItem(makeToolCall({ id: 't2', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.strictEqual((leaf.iconPath as vscode.ThemeIcon).id, TOOL_CALLS_ICON);
    });
});

suite('ToolCallsProvider — grouping and ordering', () => {
    let dir: string;
    let service: LogService;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('groups tool calls by session, newest call first', () => {
        service.ingestEvents([
            makeToolCall({ id: 't1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeToolCall({
                id: 't2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z',
                toolName: 'powershell', arguments: { command: 'npm test' },
            }),
            makeToolCall({ id: 't3', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z', toolName: 'grep' }),
            // Commands are not tool calls: they must not leak into this section.
            {
                type: 'command', id: 'c1', timestamp: '2026-01-03T10:00:00.000Z',
                tool: 'copilot', commandText: 'npm test', sessionId: 'sess-b',
            },
        ]);

        const provider = new ToolCallsProvider(service, (id) => (id === 'sess-b' ? 'Release session' : undefined));
        const groups = provider.getGroups();

        assert.strictEqual(groups.length, 2);
        assert.strictEqual(groups[0].sessionId, 'sess-b');
        assert.strictEqual(groups[0].label, 'Release session');
        assert.strictEqual(groups[0].events.length, 1, 'only tool calls are listed');
        assert.strictEqual(groups[0].description, '1 tool call · /repo');
        assert.strictEqual(groups[1].label, 'Session sess-a');

        const leaves = provider.getChildren(groups[1]) as ToolCallLeafItem[];
        assert.deepStrictEqual(leaves.map((leaf) => leaf.label), ['powershell [npm test]', 'view [src/extension.ts]']);
    });

    test('harvested chat titles label sessions the live index no longer knows', () => {
        service.ingestEvents([
            makeToolCall({
                id: 't1',
                timestamp: '2026-01-01T10:00:00.000Z',
                sessionId: '1787652725913',
                sessionTitle: 'Investigate the failing release workflow',
            }),
        ]);

        const provider = new ToolCallsProvider(service, () => undefined);
        assert.strictEqual(provider.getGroups()[0].label, 'Investigate the failing release workflow');
    });

    test('children/parents round-trip and groups start collapsed', () => {
        service.ingestEvents([makeToolCall({ id: 't1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' })]);

        const provider = new ToolCallsProvider(service);
        const [group] = provider.getChildren() as ToolCallsGroupItem[];
        assert.strictEqual(group.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.strictEqual(group.contextValue, 'toolCallsGroup');

        const [leaf] = provider.getChildren(group) as ToolCallLeafItem[];
        assert.strictEqual(provider.getTreeItem(leaf), leaf);
        assert.strictEqual(provider.getParent(leaf), group);
        assert.strictEqual(provider.getParent(group), undefined);
        assert.deepStrictEqual(provider.getChildren(leaf), [], 'leaves have no children');
    });
});


suite('ToolCallsProvider — filters, scope and resilience', () => {
    let dir: string;
    let service: LogService;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        service.ingestEvents([
            makeToolCall({
                id: 't1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z',
                toolName: 'powershell', arguments: { command: 'npm test' }, success: true,
            }),
            makeToolCall({
                id: 't2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z',
                toolName: 'grep', arguments: { query: 'registerLogCommands' }, success: false,
            }),
            makeToolCall({
                id: 't3', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z',
                tool: 'cline', workspacePath: '/other', toolName: 'read_file', arguments: { path: '/other/a.ts' },
            }),
        ]);
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('search narrows the rows and the counts', () => {
        const provider = new ToolCallsProvider(service);
        assert.strictEqual(provider.getGroups().length, 2);

        provider.setFilters({ search: 'registerLogCommands' });
        const groups = provider.getGroups();
        assert.strictEqual(groups.length, 1);
        assert.deepStrictEqual(groups[0].events.map((event) => event.id), ['t2']);
        assert.strictEqual(provider.filtersActive(), true);
    });

    test('failures-only keeps failed tool calls', () => {
        const provider = new ToolCallsProvider(service);
        provider.setFilters({ failuresOnly: true });
        assert.deepStrictEqual(
            provider.getGroups().flatMap((group) => group.events.map((event) => event.id)),
            ['t2']
        );
    });

    test('workspace scope and agent filters apply', () => {
        const provider = new ToolCallsProvider(service);
        provider.setWorkspaceScope(['/repo']);
        assert.deepStrictEqual(
            provider.getGroups().flatMap((group) => group.events.map((event) => event.id)).sort(),
            ['t1', 't2']
        );
        assert.deepStrictEqual(provider.getFilters().workspacePaths, ['/repo']);

        provider.setWorkspaceScope([]);
        provider.setFilters({ tool: 'cline' });
        assert.deepStrictEqual(
            provider.getGroups().flatMap((group) => group.events.map((event) => event.id)),
            ['t3']
        );

        // getFilters returns a copy: mutating it must not leak into the provider.
        provider.getFilters().search = 'nope';
        assert.strictEqual(provider.getFilters().search, undefined);
    });

    test('a broken store degrades to an empty section', () => {
        const broken = { getEvents: () => { throw new Error('store down'); } } as unknown as LogService;
        const provider = new ToolCallsProvider(broken);
        assert.deepStrictEqual(provider.getGroups(), []);
        assert.deepStrictEqual(provider.getChildren(), []);
    });

    test('the render cap is a documented constant', () => {
        assert.strictEqual(MAX_TOOL_CALLS_PER_QUERY, 2000);
    });
});

