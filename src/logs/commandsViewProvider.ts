/**
 * src/logs/commandsViewProvider.ts
 *
 * Phase 3 (UX pass) — the single **Commands** sidebar view.
 *
 * The watch-logs subsystem shipped three separate contributed views
 * (`chatwizardExecutedCommands`, `chatwizardUnifiedTimeline`,
 * `chatwizardDiffExplorer`), which made the Chat Wizard sidebar noisy. VS Code
 * does **not** support nesting a contributed view inside another view, so the
 * three panels are exposed as three collapsible *sections* of one tree view
 * (`chatwizardCommands`) instead:
 *
 *   Commands
 *   ├── Executed Commands   (n commands)
 *   ├── Unified Timeline    (n events)
 *   └── Diff Explorer       (n changes · n files)
 *
 * `CommandsViewProvider` is a thin composite: it owns the section rows and
 * forwards every other node to the provider that produced it, re-emitting their
 * change events so the single view stays live.
 */

import * as vscode from 'vscode';
import {
    ExecutedCommandsProvider,
    ExecCommandsGroupItem,
    ExecCommandsLeafItem,
    ExecCommandsTreeNode,
} from './executedCommandsProvider';
import {
    UnifiedTimelineProvider,
    TimelineGroupItem,
    TimelineEventItem,
    UnifiedTimelineTreeNode,
} from './unifiedTimelineProvider';
import {
    DiffExplorerProvider,
    DiffWorkspaceGroupItem,
    DiffFileGroupItem,
    DiffEventLeafItem,
    DiffExplorerTreeNode,
} from './diffExplorerProvider';
import { LogEvent } from './types';

/** Contributed id of the single watch-logs sidebar view. */
export const COMMANDS_VIEW_ID = 'chatwizardCommands';

/** The three former panels, now sections of the Commands view. */
export type CommandsSubViewId = 'executedCommands' | 'timeline' | 'diffs';

/** Static description of one section (label + codicon). */
export interface CommandsSectionDefinition {
    id: CommandsSubViewId;
    label: string;
    icon: string;
}

/** Section order (also the order rendered in the tree). */
export const COMMANDS_SECTIONS: readonly CommandsSectionDefinition[] = [
    { id: 'executedCommands', label: 'Executed Commands', icon: 'terminal' },
    { id: 'timeline', label: 'Unified Timeline', icon: 'history' },
    { id: 'diffs', label: 'Diff Explorer', icon: 'diff' },
];

/** Node counts used for the section descriptions. */
export interface CommandsSectionCounts {
    commands: number;
    events: number;
    changes: number;
    files: number;
}

/** Section subtitle, e.g. "12 commands" or "8 changes · 3 files". */
export function describeCommandsSection(subView: CommandsSubViewId, counts: CommandsSectionCounts): string {
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    switch (subView) {
        case 'executedCommands':
            return plural(counts.commands, 'command');
        case 'timeline':
            return plural(counts.events, 'event');
        case 'diffs':
            return `${plural(counts.changes, 'change')} · ${plural(counts.files, 'file')}`;
    }
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

/** A collapsible section header — one per former panel. */
export class CommandsSectionItem extends vscode.TreeItem {
    constructor(
        readonly subView: CommandsSubViewId,
        label: string,
        icon: string,
        description: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = description;
        this.contextValue = `commandsSection.${subView}`;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.tooltip = description ? `${label} — ${description}` : label;
    }

    /** Keep the row subtitle in sync with the live counts. */
    setDescription(description: string): void {
        this.description = description;
        const label = typeof this.label === 'string' ? this.label : this.label?.label ?? '';
        this.tooltip = description ? `${label} — ${description}` : label;
    }
}

/** Every node the composite tree can render. */
export type CommandsTreeNode =
    | CommandsSectionItem
    | ExecCommandsTreeNode
    | UnifiedTimelineTreeNode
    | DiffExplorerTreeNode;

/**
 * Whether `value` looks like a normalized log event.
 *
 * Used by the node helpers so they also work across module boundaries: when the
 * extension host hands a command a tree item created by a *different* copy of
 * this module (the bundled `dist/extension.js` vs the compiled `out/` sources
 * during tests), `instanceof` fails even though the shape is identical.
 */
function isLogEventLike(value: unknown): value is LogEvent {
    if (!value || typeof value !== 'object') { return false; }
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string';
}

/** The `LogEvent` behind a leaf row, whichever section it came from. */
export function eventOfCommandsNode(node: unknown): LogEvent | undefined {
    if (node instanceof ExecCommandsLeafItem) { return node.event; }
    if (node instanceof TimelineEventItem) { return node.event; }
    if (node instanceof DiffEventLeafItem) { return node.event; }
    if (!node || typeof node !== 'object') { return undefined; }
    const candidate = (node as { event?: unknown }).event;
    return isLogEventLike(candidate) ? candidate : undefined;
}

/** The section a node belongs to (undefined for the section rows themselves). */
export function subViewOfCommandsNode(node: unknown): CommandsSubViewId | undefined {
    if (node instanceof CommandsSectionItem) { return node.subView; }
    if (node instanceof ExecCommandsGroupItem || node instanceof ExecCommandsLeafItem) { return 'executedCommands'; }
    if (node instanceof TimelineGroupItem || node instanceof TimelineEventItem) { return 'timeline'; }
    if (
        node instanceof DiffWorkspaceGroupItem
        || node instanceof DiffFileGroupItem
        || node instanceof DiffEventLeafItem
    ) {
        return 'diffs';
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * One tree view for the whole watch-logs subsystem. Section rows are owned
 * here; everything below a section is delegated to the provider that built it.
 */
export class CommandsViewProvider implements vscode.TreeDataProvider<CommandsTreeNode>, vscode.Disposable {
    static readonly viewType = COMMANDS_VIEW_ID;

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CommandsTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _sections = new Map<CommandsSubViewId, CommandsSectionItem>();
    private readonly _delegateSubscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly executedCommands: ExecutedCommandsProvider,
        private readonly timeline: UnifiedTimelineProvider,
        private readonly diffs: DiffExplorerProvider
    ) {
        for (const definition of COMMANDS_SECTIONS) {
            this._sections.set(
                definition.id,
                new CommandsSectionItem(definition.id, definition.label, definition.icon, '')
            );
        }
        // The delegates already know how to rebuild themselves; the composite
        // only has to refresh the counts and re-emit so the single view updates.
        for (const delegate of [executedCommands, timeline, diffs]) {
            this._delegateSubscriptions.push(delegate.onDidChangeTreeData(() => {
                this._syncSectionDescriptions();
                this._onDidChangeTreeData.fire();
            }));
        }
        // Counts are computed lazily on first render (`getChildren()`) so the
        // constructor stays cheap during extension activation.
    }

    /** Reload every section from the event store. */
    refresh(): void {
        this.executedCommands.refresh();
        this.timeline.refresh();
        this.diffs.refresh();
    }

    getChildren(element?: CommandsTreeNode): CommandsTreeNode[] {
        if (!element) {
            this._syncSectionDescriptions();
            return COMMANDS_SECTIONS.map((s) => this._sections.get(s.id) as CommandsSectionItem);
        }
        if (element instanceof CommandsSectionItem) {
            return this._childrenOfSection(element.subView);
        }
        if (element instanceof ExecCommandsGroupItem || element instanceof ExecCommandsLeafItem) {
            return this.executedCommands.getChildren(element);
        }
        if (element instanceof TimelineGroupItem || element instanceof TimelineEventItem) {
            return this.timeline.getChildren(element);
        }
        if (
            element instanceof DiffWorkspaceGroupItem
            || element instanceof DiffFileGroupItem
            || element instanceof DiffEventLeafItem
        ) {
            return this.diffs.getChildren(element);
        }
        return [];
    }

    getTreeItem(element: CommandsTreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: CommandsTreeNode): CommandsTreeNode | undefined {
        // Section rows are the roots of the tree.
        if (element instanceof CommandsSectionItem) { return undefined; }
        switch (subViewOfCommandsNode(element)) {
            case undefined:
                return undefined;
            case 'executedCommands':
                return element instanceof ExecCommandsLeafItem
                    ? (this.executedCommands.getParent(element) ?? this.section('executedCommands'))
                    : this.section('executedCommands');
            case 'timeline':
                return element instanceof TimelineEventItem
                    ? (this.timeline.getParent(element) ?? this.section('timeline'))
                    : this.section('timeline');
            case 'diffs':
                return this.diffs.getParent(element as DiffExplorerTreeNode) ?? this.section('diffs');
        }
    }

    /** A single section row, for `TreeView.reveal`. */
    section(subView: CommandsSubViewId): CommandsSectionItem | undefined {
        return this._sections.get(subView);
    }

    /** Node counts across every section (exposed for tests + diagnostics). */
    counts(): CommandsSectionCounts {
        const groups = this.executedCommands.getGroups();
        const timelineGroups = this.timeline.getGroups();
        const workspaceGroups = this.diffs.getWorkspaceGroups();
        return {
            commands: groups.reduce((total, g) => total + g.commands.length, 0),
            events: timelineGroups.reduce((total, g) => total + g.events.length, 0),
            changes: workspaceGroups.reduce(
                (total, ws) => total + ws.groups.reduce((n, file) => n + file.events.length, 0),
                0
            ),
            files: workspaceGroups.reduce((total, ws) => total + ws.groups.length, 0),
        };
    }

    dispose(): void {
        for (const subscription of this._delegateSubscriptions) { subscription.dispose(); }
        this._onDidChangeTreeData.dispose();
    }

    private _childrenOfSection(subView: CommandsSubViewId): CommandsTreeNode[] {
        switch (subView) {
            case 'executedCommands': return this.executedCommands.getChildren();
            case 'timeline': return this.timeline.getChildren();
            case 'diffs': return this.diffs.getChildren();
        }
    }

    private _syncSectionDescriptions(): void {
        const counts = this.counts();
        for (const [id, item] of this._sections) {
            item.setDescription(describeCommandsSection(id, counts));
        }
    }
}

