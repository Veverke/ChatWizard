/**
 * test/unit/executedCommandsProvider.test.ts
 *
 * Phase 2 — Executed Commands panel unit tests.
 * Verifies grouping (per session, newest first), display helpers, and the
 * pure functions the tree renders. Provider is constructed against an in-memory
 * `LogService` so no VS Code host is needed.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    ExecutedCommandsProvider,
    ExecCommandsGroupItem,
    ExecCommandsLeafItem,
    EXEC_COMMANDS_GROUP_ICON,
    execCommandIconId,
    firstLineOf,
    formatExitBadge,
} from '../../src/logs/executedCommandsProvider';
import { CommandEvent } from '../../src/logs/types';

function makeCommand(overrides: Partial<CommandEvent> & { id: string; timestamp: string }): CommandEvent {
    return {
        type: 'command',
        tool: 'copilot',
        commandText: 'npm test',
        sessionId: 's1',
        ...overrides,
    } as CommandEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-exec-commands-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('ExecutedCommandsProvider — display helpers', () => {
    test('firstLineOf trims and truncates', () => {
        assert.strictEqual(firstLineOf('npm test'), 'npm test');
        assert.strictEqual(firstLineOf('  git status  '), 'git status');
        assert.strictEqual(firstLineOf('', 5), '');
        assert.strictEqual(firstLineOf('abcdefghij', 5), 'abcd…');
    });

    test('formatExitBadge maps undefined/0/nonzero', () => {
        assert.strictEqual(formatExitBadge(undefined), 'exit ?');
        assert.strictEqual(formatExitBadge(0), '✓ exit 0');
        assert.strictEqual(formatExitBadge(1), '✗ exit 1');
        assert.strictEqual(formatExitBadge(2), '✗ exit 2');
    });
});
suite('ExecutedCommandsProvider — grouping and ordering', () => {
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

    test('groups commands by session and orders sessions newest-first', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'git add .' }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'npm test' }),
            makeCommand({ id: 'c3', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z', commandText: 'npm run build' }),
        ]);

        const provider = new ExecutedCommandsProvider(service, (id) => (id === 'sess-b' ? 'Build session' : undefined));
        const groups = provider.getGroups();

        assert.strictEqual(groups.length, 2);
        // Session B has the newest command → first.
        assert.strictEqual(groups[0].sessionId, 'sess-b');
        assert.strictEqual(groups[0].label, 'Build session', 'title resolver supplies friendly name');
        assert.strictEqual(groups[1].label, 'Session sess-a', 'fallback label when no title resolved');
    });

    test('harvested event titles label sessions the live index no longer knows', () => {
        service.ingestEvents([
            makeCommand({
                id: 'c1',
                sessionId: '1787652725913',
                timestamp: '2026-01-01T10:00:00.000Z',
                commandText: 'npm run build',
                sessionTitle: 'process-request-tracking.yml workflow is failing',
            }),
        ]);

        const provider = new ExecutedCommandsProvider(service, () => undefined);

        assert.strictEqual(
            provider.getGroups()[0].label,
            'process-request-tracking.yml workflow is failing',
            'the harvested chat title must win over the id fallback'
        );
    });

    test('the live resolver wins over the harvested title', () => {
        service.ingestEvents([
            makeCommand({
                id: 'c1',
                sessionId: 'sess-a',
                timestamp: '2026-01-01T10:00:00.000Z',
                sessionTitle: 'stale harvested title',
            }),
        ]);

        const provider = new ExecutedCommandsProvider(service, () => 'Renamed chat');

        assert.strictEqual(provider.getGroups()[0].label, 'Renamed chat');
    });

    test('setWorkspaceScope keeps only the current workspace (Command view)', () => {
        service.ingestEvents([
            makeCommand({
                id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z',
                commandText: 'npm test', workspacePath: path.join('C:', 'Repos', 'Mine', 'ChatWizard'),
            }),
            makeCommand({
                id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-01T10:01:00.000Z',
                commandText: 'git status', workspacePath: path.join('C:', 'Repos', 'Mine', 'vscode-extension-analytics'),
            }),
        ]);

        const provider = new ExecutedCommandsProvider(service);
        assert.strictEqual(provider.getGroups().length, 2, 'unscoped view shows every workspace');

        provider.setWorkspaceScope([path.join('C:', 'Repos', 'Mine', 'ChatWizard')]);

        const groups = provider.getGroups();
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].sessionId, 'sess-a');

        provider.setWorkspaceScope([]);
        assert.strictEqual(provider.getGroups().length, 2, 'clearing the scope restores everything');
    });

    test('commands inside a session are sorted newest-first', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z' }),
            makeCommand({ id: 'c3', sessionId: 'sess-a', timestamp: '2026-01-01T09:00:00.000Z' }),
        ]);

        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as ExecCommandsLeafItem[];
        assert.deepStrictEqual(leaves.map((l) => l.event.id), ['c2', 'c1', 'c3']);
    });

    test('getParent resolves a leaf back to its group', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-01T11:00:00.000Z' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[1]) as ExecCommandsLeafItem[];
        const parent = provider.getParent(leaves[0]) as ExecCommandsGroupItem;
        assert.strictEqual(parent.sessionId, leaves[0].event.sessionId);
    });

    test('refresh rebuilds from the store (drop + re-add reflected)', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);
        assert.strictEqual(provider.getGroups().length, 1);

        service.ingestEvents([
            makeCommand({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        provider.refresh();
        assert.strictEqual(provider.getGroups().length, 2);
    });

    test('empty store → no groups', () => {
        const provider = new ExecutedCommandsProvider(service);
        assert.deepStrictEqual(provider.getGroups(), []);
        assert.deepStrictEqual(provider.getChildren(), []);
    });

    test('leaf tooltip exposes the full command text', () => {
        const longCommand = 'npm run build -- --config webpack.prod.js --mode production';
        service.ingestEvents([makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: longCommand })]);
        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as ExecCommandsLeafItem[];
        assert.strictEqual(leaves[0].tooltip, longCommand);
    });

    test('leaf item sets a double-click command to show full contents', () => {
        service.ingestEvents([makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' })]);
        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as ExecCommandsLeafItem[];
        assert.strictEqual(leaves[0].command?.command, 'chatwizard.execCommands.showDetails');
        assert.strictEqual(leaves[0].command?.title, 'Show Full Command');
    });
});

suite('ExecutedCommandsProvider — Phase 4 filters', () => {
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

    const visibleCommands = (provider: ExecutedCommandsProvider): string[] =>
        provider.getGroups().flatMap((g) => g.commands.map((c) => c.commandText));

    test('search narrows the rows and clearing restores them', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'npm test' }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'git status' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);

        provider.setFilters({ search: 'NPM' });
        assert.deepStrictEqual(visibleCommands(provider), ['npm test']);
        assert.strictEqual(provider.filtersActive(), true);

        provider.setFilters({});
        assert.strictEqual(visibleCommands(provider).length, 2);
        assert.strictEqual(provider.filtersActive(), false);
    });

    test('the agent filter is delegated to the store query', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', tool: 'copilot' }),
            makeCommand({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-01T10:05:00.000Z', tool: 'cline', commandText: 'git log' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);

        provider.setFilters({ tool: 'cline' });
        assert.deepStrictEqual(visibleCommands(provider), ['git log']);
        assert.strictEqual(provider.getGroups()[0].sessionId, 'sess-b');
    });

    test('failuresOnly keeps only non-zero exit codes', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'npm test', exitCode: 0 }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'npm run build', exitCode: 1 }),
            makeCommand({ id: 'c3', sessionId: 'sess-a', timestamp: '2026-01-01T10:10:00.000Z', commandText: 'npm run lint' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);

        provider.setFilters({ failuresOnly: true });
        assert.deepStrictEqual(visibleCommands(provider), ['npm run build']);
    });

    test('getFilters returns a defensive copy', () => {
        const provider = new ExecutedCommandsProvider(service);
        provider.setFilters({ search: 'npm' });
        const copy = provider.getFilters();
        copy.search = 'mutated';
        assert.strictEqual(provider.getFilters().search, 'npm');
    });
});

suite('ExecutedCommandsProvider — row and resilience edge cases', () => {
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

    test('an empty session group is a leaf row without a workspace suffix', () => {
        const group = new ExecCommandsGroupItem('sess-empty', 'Empty chat', []);

        assert.strictEqual(group.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.strictEqual(group.description, '0 commands');
        assert.strictEqual(group.tooltip, 'Empty chat\nSession: sess-empty');
    });

    test('leaf rows pick one icon per exit-code state', () => {
        assert.strictEqual(execCommandIconId(undefined), 'run');
        assert.strictEqual(execCommandIconId(0), 'terminal');
        assert.strictEqual(execCommandIconId(2), 'error');

        const iconOf = (exitCode: number | undefined): string => {
            const item = new ExecCommandsLeafItem(
                makeCommand({ id: `c-${String(exitCode)}`, timestamp: '2026-01-01T10:00:00.000Z', exitCode })
            );
            return (item.iconPath as vscode.ThemeIcon).id;
        };

        assert.strictEqual(iconOf(undefined), 'run');
        assert.strictEqual(iconOf(0), 'terminal');
        assert.strictEqual(iconOf(2), 'error');
    });

    test('a failed command turns its icon red, a clean one stays plain', () => {
        const failed = new ExecCommandsLeafItem(
            makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 3 })
        );
        assert.strictEqual(
            ((failed.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor).id,
            'problemsErrorIcon.foreground'
        );

        const passed = new ExecCommandsLeafItem(
            makeCommand({ id: 'c2', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 })
        );
        assert.strictEqual((passed.iconPath as vscode.ThemeIcon).color, undefined);

        const unknown = new ExecCommandsLeafItem(
            makeCommand({ id: 'c3', timestamp: '2026-01-01T10:00:00.000Z' })
        );
        assert.strictEqual((unknown.iconPath as vscode.ThemeIcon).color, undefined);
    });

    test('session rows wear the section icon, not the Unified Timeline one', () => {
        const group = new ExecCommandsGroupItem('sess-a', 'Fix the build', [
            makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);
        assert.strictEqual((group.iconPath as vscode.ThemeIcon).id, EXEC_COMMANDS_GROUP_ICON);
        assert.strictEqual(EXEC_COMMANDS_GROUP_ICON, 'terminal');
    });

    test('commands without a session id group under (no session), keeping the workspace', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: undefined, workspacePath: '/repo', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const [group] = new ExecutedCommandsProvider(service).getGroups();
        assert.strictEqual(group.sessionId, '(no session)');
        assert.match(String(group.description), /1 command · \/repo/);
    });

    test('a broken store degrades to an empty tree', () => {
        const broken = { getEvents: () => { throw new Error('boom'); } } as unknown as LogService;
        const provider = new ExecutedCommandsProvider(broken);

        assert.deepStrictEqual(provider.getChildren(), [], 'lazy build over a broken store');
        assert.deepStrictEqual(provider.getGroups(), []);

        const detached = new ExecCommandsLeafItem(makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.deepStrictEqual(provider.getChildren(detached), [], 'leaves have no children');
        assert.strictEqual(provider.getParent(detached), undefined, 'no group owns a detached leaf');
    });
});
