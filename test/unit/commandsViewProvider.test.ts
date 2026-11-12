/**
 * test/unit/commandsViewProvider.test.ts
 *
 * UX pass — the single "Commands" sidebar view.
 *
 * The three watch-logs panels (Executed Commands / Unified Timeline / Diff
 * Explorer) are now sections of one tree view. These tests cover the section
 * rows, the delegated children/parents, the live counts and the node helpers
 * used by the commands. Providers are constructed against an in-memory
 * `LogService`, so no VS Code host is required.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { ExecutedCommandsProvider, ExecCommandsGroupItem, ExecCommandsLeafItem } from '../../src/logs/executedCommandsProvider';
import { UnifiedTimelineProvider, TimelineGroupItem, TimelineEventItem } from '../../src/logs/unifiedTimelineProvider';
import { DiffExplorerProvider, DiffEventLeafItem } from '../../src/logs/diffExplorerProvider';
import {
    COMMANDS_SECTIONS,
    CommandsSectionItem,
    CommandsViewProvider,
    describeCommandsSection,
    eventOfCommandsNode,
    subViewOfCommandsNode,
} from '../../src/logs/commandsViewProvider';
import { CommandEvent, LogEvent } from '../../src/logs/types';

function makeCommand(overrides: Partial<CommandEvent> & { id: string; timestamp: string }): CommandEvent {
    return {
        type: 'command',
        tool: 'copilot',
        commandText: 'npm test',
        sessionId: 'sess-a',
        workspacePath: '/repo',
        ...overrides,
    } as CommandEvent;
}

function makeDiff(overrides: Partial<LogEvent> & { id: string; timestamp: string }): LogEvent {
    return {
        type: 'diff',
        tool: 'copilot',
        sessionId: 'sess-a',
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        filePath: '/repo/src/a.ts',
        diffText: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        addedLines: 1,
        removedLines: 1,
        ...overrides,
    } as LogEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-commands-view-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('CommandsViewProvider — section helpers', () => {
    test('describes every section with singular/plural counts', () => {
        const counts = { commands: 1, events: 2, changes: 3, files: 1 };
        assert.strictEqual(describeCommandsSection('executedCommands', counts), '1 command');
        assert.strictEqual(describeCommandsSection('timeline', counts), '2 events');
        assert.strictEqual(describeCommandsSection('diffs', counts), '3 changes · 1 file');
        assert.strictEqual(
            describeCommandsSection('executedCommands', { commands: 0, events: 0, changes: 0, files: 0 }),
            '0 commands'
        );
    });

    test('section definitions keep the documented order', () => {
        assert.deepStrictEqual(COMMANDS_SECTIONS.map((s) => s.label), [
            'Executed Commands',
            'Unified Timeline',
            'Diff Explorer',
        ]);
    });
});

suite('CommandsViewProvider — composite tree', () => {
    let dir: string;
    let service: LogService;
    let provider: CommandsViewProvider;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        provider = new CommandsViewProvider(
            new ExecutedCommandsProvider(service),
            new UnifiedTimelineProvider(service),
            new DiffExplorerProvider(service)
        );
    });

    teardown(() => {
        try { provider.dispose(); } catch { /* ignore */ }
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('roots are the three sections, in order', () => {
        const roots = provider.getChildren() as CommandsSectionItem[];
        assert.strictEqual(roots.length, 3);
        assert.deepStrictEqual(roots.map((r) => r.label), [
            'Executed Commands',
            'Unified Timeline',
            'Diff Explorer',
        ]);
        assert.strictEqual(roots[0].subView, 'executedCommands');
        assert.strictEqual(roots[1].subView, 'timeline');
        assert.strictEqual(roots[2].subView, 'diffs');
    });

    test('all three sections start collapsed', () => {
        const roots = provider.getChildren() as CommandsSectionItem[];
        for (const section of roots) {
            assert.strictEqual(
                section.collapsibleState,
                vscode.TreeItemCollapsibleState.Collapsed,
                `${section.label} must start collapsed`
            );
        }
        // A re-render (refresh → getTreeItem) must never auto-expand them again.
        provider.refresh();
        for (const section of roots) {
            assert.strictEqual(provider.getTreeItem(section).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        }
    });

    test('sections delegate to their provider and count their rows', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'git status' }),
            makeDiff({ id: 'd1', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);

        const [commandsSection, timelineSection, diffsSection] = provider.getChildren() as CommandsSectionItem[];

        const commandGroups = provider.getChildren(commandsSection) as ExecCommandsGroupItem[];
        assert.ok(commandGroups.length > 0, 'Executed Commands section lists session groups');
        const leaves = provider.getChildren(commandGroups[0]) as ExecCommandsLeafItem[];
        assert.strictEqual(leaves.length, 2);

        const timelineGroups = provider.getChildren(timelineSection) as TimelineGroupItem[];
        assert.ok(timelineGroups.length > 0, 'Unified Timeline section lists session groups');
        const timelineLeaves = provider.getChildren(timelineGroups[0]) as TimelineEventItem[];
        // Two commands + one diff are all timeline events.
        assert.strictEqual(timelineLeaves.length, 3);

        const workspaceGroups = provider.getChildren(diffsSection);
        assert.strictEqual(workspaceGroups.length, 1, 'Diff Explorer section lists workspace groups');

        assert.deepStrictEqual(provider.counts(), {
            commands: 2,
            events: 3,
            changes: 1,
            files: 1,
            failedCommands: 0,
            filtered: false,
        });
        assert.strictEqual(commandsSection.description, '2 commands');
        assert.strictEqual(timelineSection.description, '3 events');
        assert.strictEqual(diffsSection.description, '1 change · 1 file');
    });

    test('getParent walks leaf → group → section', () => {
        service.ingestEvents([makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' })]);
        const [commandsSection] = provider.getChildren() as CommandsSectionItem[];
        const [group] = provider.getChildren(commandsSection) as ExecCommandsGroupItem[];
        const [leaf] = provider.getChildren(group) as ExecCommandsLeafItem[];

        assert.strictEqual(provider.getParent(leaf), group);
        assert.strictEqual(provider.getParent(group), commandsSection);
        assert.strictEqual(provider.getParent(commandsSection), undefined);
    });

    test('refresh reloads new events and re-describes the sections', () => {
        service.ingestEvents([makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' })]);
        assert.strictEqual(provider.counts().commands, 1);

        service.ingestEvents([makeCommand({ id: 'c2', timestamp: '2026-01-01T10:05:00.000Z' })]);
        provider.refresh();

        assert.strictEqual(provider.counts().commands, 2);
        const [section] = provider.getChildren() as CommandsSectionItem[];
        assert.strictEqual(section.description, '2 commands');
    });

    test('section lookup supports reveal()', () => {
        const roots = provider.getChildren() as CommandsSectionItem[];
        assert.strictEqual(provider.section('timeline'), roots[1]);
        assert.strictEqual(provider.section('diffs'), roots[2]);
    });
});


suite('CommandsViewProvider — node helpers', () => {
    test('eventOfCommandsNode resolves leaves of every section', () => {
        const command = makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' });
        const diff = makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' });

        assert.strictEqual(eventOfCommandsNode(new ExecCommandsLeafItem(command)), command);
        assert.strictEqual(eventOfCommandsNode(new TimelineEventItem(diff)), diff);
        assert.strictEqual(eventOfCommandsNode(new DiffEventLeafItem(diff)), diff);
        assert.strictEqual(
            eventOfCommandsNode(new CommandsSectionItem('timeline', 'Unified Timeline', 'history', '')),
            undefined
        );
        assert.strictEqual(eventOfCommandsNode(undefined), undefined);
    });

    test('subViewOfCommandsNode maps groups and leaves to their section', () => {
        const command = makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' });
        const section = new CommandsSectionItem('diffs', 'Diff Explorer', 'diff', '0 changes');

        assert.strictEqual(subViewOfCommandsNode(new ExecCommandsLeafItem(command)), 'executedCommands');
        assert.strictEqual(subViewOfCommandsNode(new TimelineEventItem(command)), 'timeline');
        assert.strictEqual(subViewOfCommandsNode(new DiffEventLeafItem(command)), 'diffs');
        assert.strictEqual(subViewOfCommandsNode(section), 'diffs');
        assert.strictEqual(subViewOfCommandsNode({}), undefined);
    });
});

suite('CommandsViewProvider — Phase 4 filters', () => {
    let dir: string;
    let service: LogService;
    let provider: CommandsViewProvider;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        provider = new CommandsViewProvider(
            new ExecutedCommandsProvider(service),
            new UnifiedTimelineProvider(service),
            new DiffExplorerProvider(service)
        );
        service.ingestEvents([
            makeCommand({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'npm test', exitCode: 0 }),
            makeCommand({ id: 'c2', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'npm run build', exitCode: 2 }),
            makeDiff({ id: 'd1', timestamp: '2026-01-02T10:00:00.000Z', filePath: '/repo/src/app.ts' }),
        ]);
    });

    teardown(() => {
        try { provider.dispose(); } catch { /* ignore */ }
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('describeCommandsSection adds failed / filtered suffixes', () => {
        const base = { commands: 2, events: 3, changes: 1, files: 1 };
        assert.strictEqual(
            describeCommandsSection('executedCommands', { ...base, failedCommands: 1 }),
            '2 commands · 1 failed'
        );
        assert.strictEqual(
            describeCommandsSection('executedCommands', { ...base, failedCommands: 0, filtered: true }),
            '2 commands · filtered'
        );
        assert.strictEqual(describeCommandsSection('timeline', { ...base, filtered: true }), '3 events · filtered');
        assert.strictEqual(describeCommandsSection('diffs', { ...base, filtered: true }), '1 change · 1 file · filtered');
    });

    test('counts report failed commands', () => {
        assert.strictEqual(provider.counts().failedCommands, 1);
        assert.strictEqual(provider.counts().filtered, false);
    });

    test('setFilters narrows every section and flags them as filtered', () => {
        provider.setFilters({ search: 'npm run', failuresOnly: true });
        const [commandsSection, timelineSection, diffsSection] = provider.getChildren() as CommandsSectionItem[];

        const counts = provider.counts();
        assert.strictEqual(counts.commands, 1, 'only the failed "npm run build" command matches');
        assert.strictEqual(counts.filtered, true);
        assert.strictEqual(provider.filtersActive(), true);
        assert.strictEqual(commandsSection.description, '1 command · 1 failed · filtered');
        assert.strictEqual(timelineSection.description, '1 event · filtered');
        assert.strictEqual(diffsSection.description, '0 changes · 0 files · filtered');
        // The diff file does not match the text query.
        assert.deepStrictEqual(provider.getChildren(diffsSection), []);
    });

    test('getFilters merges the section filters; clearFilters resets everything', () => {
        provider.setFilters({ search: 'npm', tool: 'copilot', failuresOnly: true, types: ['command'] });
        assert.deepStrictEqual(provider.getFilters(), {
            search: 'npm',
            tool: 'copilot',
            failuresOnly: true,
            types: ['command'],
        });

        provider.clearFilters();
        assert.deepStrictEqual(provider.getFilters(), {
            search: undefined,
            tool: undefined,
            failuresOnly: undefined,
            types: undefined,
        });
        assert.strictEqual(provider.filtersActive(), false);
        assert.strictEqual(provider.counts().commands, 2);
    });
});

