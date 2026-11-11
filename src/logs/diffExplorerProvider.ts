import * as vscode from 'vscode';
import { LogService } from './logService';
import { LogViewFilters, emptyLogFilters, hasActiveFilters, matchesLogFilters } from './logFilters';
import { createLogger } from '../utils/logger';
import {
    DiffEvent,
    FileOperationEvent,
    LogEvent,
    getEventFilePath,
    logEventTypeLabel,
} from './types';

/**
 * src/logs/diffExplorerProvider.ts
 *
 * Phase 3 — "Diff Explorer" panel.
 *
 * A file-centric, cross-agent view of every code change the watch-logs store
 * captured: `diff` events (inline edit groups, apply_patch payloads) plus the
 * file operations that never produce a paired diff (create/delete/rename/
 * move/mkdir). Grouped per workspace → per file, newest first, with actions:
 *
 *   - open the visual diff — the change in VS Code's native diff editor
 *     (side-by-side / inline, `src/logs/diffViewer.ts`)
 *   - open the patch — renders the raw diff text in a disposable markdown editor
 *   - copy the diff text to the clipboard
 *   - open the affected file (when it still exists on disk)
 *
 * Feeds today from the GitHub Copilot, Cline / Roo Code, Aider and Windsurf
 * adapters — all of them stream into the same normalized store.
 *
 * Phase 4 honours the shared view filters: the free-text search and the agent
 * filter narrow this section exactly like the other two.
 */

const logWatch = createLogger().withContext('WatchLogs');

/** Hard cap on rows pulled out of the store for one render. */
export const MAX_DIFFS_PER_QUERY = 2000;

// ---------------------------------------------------------------------------
// Selection helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Whether an event belongs in the Diff Explorer. Patch-type file operations
 * are excluded because every inline edit group already emits a paired DiffEvent
 * (showing both would duplicate the same row).
 */
export function isDiffCandidate(event: LogEvent): boolean {
    if (event.type === 'diff') { return true; }
    if (event.type === 'fileOperation') {
        const op = (event as FileOperationEvent).operationType;
        return op !== 'patch';
    }
    return false;
}

/** 'create', 'delete', 'move', … for a file-op event. */
export function fileOperationLabel(event: FileOperationEvent): string {
    return event.operationType;
}

/** '+A −R' or '±?' badge text for a diff event. */
export function diffStatsLabel(event: DiffEvent): string {
    if (event.addedLines !== undefined || event.removedLines !== undefined) {
        return `+${event.addedLines ?? 0} −${event.removedLines ?? 0}`;
    }
    return '±?';
}

/** Short row description for a diff-candidate event. */
export function diffEventDescription(event: LogEvent): string {
    if (event.type === 'diff') {
        const d = event as DiffEvent;
        return `${logEventTypeLabel('diff')} · ${diffStatsLabel(d)} · ${event.tool}`;
    }
    const op = event as FileOperationEvent;
    return `${logEventTypeLabel('fileOperation')} · ${fileOperationLabel(op)} · ${event.tool}`;
}

/** Row label for a diff-candidate event (kept tight for narrow trees). */
export function diffEventLabel(event: LogEvent): string {
    return event.type === 'diff'
        ? 'diff'
        : (event as FileOperationEvent).operationType;
}

/**
 * A human-friendly markdown document representing the event's change, used by
 * the "Open Patch" action (opened in a disposable untitled editor).
 */
export function renderPatchMarkdown(event: LogEvent): string {
    const when = event.timestamp ? new Date(event.timestamp).toLocaleString() : 'unknown';
    const filePath = getEventFilePath(event) ?? 'unknown path';
    const lines: string[] = [];
    lines.push(`## ${event.type === 'diff' ? 'Diff' : 'File operation'} — \`${filePath}\``);
    lines.push('');
    lines.push(`- **Tool:** ${event.tool}`);
    lines.push(`- **When:** ${when}`);
    if (event.sessionId) {
        lines.push(`- **Session:** ${event.sessionId}`);
    }
    if (event.type === 'diff') {
        const d = event as DiffEvent;
        if (d.addedLines !== undefined || d.removedLines !== undefined) {
            lines.push(`- **Lines:** +${d.addedLines ?? 0} −${d.removedLines ?? 0}`);
        }
        lines.push('');
        lines.push('```diff');
        lines.push(d.diffText);
        lines.push('```');
    } else {
        const op = event as FileOperationEvent;
        lines.push(`- **Operation:** ${op.operationType}`);
        if (op.oldPath) {
            lines.push(`- **From:** ${op.oldPath}`);
        }
        if (op.detail) {
            lines.push(`- **Detail:** ${op.detail}`);
        }
        if (event.raw && event.raw.length > 0) {
            lines.push('');
            lines.push('```json');
            lines.push(event.raw);
            lines.push('```');
        }
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Hover tooltip for a change row: a *short* patch preview rather than the whole
 * patch (a hovered 500-line diff is unreadable — the visual diff editor shows
 * the full change).
 */
export function diffEventTooltip(event: LogEvent, maxLines = 40): string {
    if (event.type !== 'diff') { return renderPatchMarkdown(event); }
    const d = event as DiffEvent;
    const text = d.diffText ?? '';
    const lines = text.split('\n');
    if (lines.length <= maxLines) { return text; }
    const remaining = lines.length - maxLines;
    return [
        ...lines.slice(0, maxLines),
        `… ${remaining} more line${remaining === 1 ? '' : 's'} — open the visual diff for the full change`,
    ].join('\n');
}

/** Split a file path into { basename, dirname } for compact tree labels. */
export function pathToDisplayInfo(filePath: string): { basename: string; dirname: string } {
    const normalized = filePath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx < 0) {
        return { basename: normalized, dirname: '' };
    }
    return { basename: normalized.slice(idx + 1), dirname: normalized.slice(0, idx) };
}
// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

export type DiffExplorerTreeNode = DiffWorkspaceGroupItem | DiffFileGroupItem | DiffEventLeafItem;

/** Workspace binder — root level. */
export class DiffWorkspaceGroupItem extends vscode.TreeItem {
    readonly workspaceKey: string;
    readonly groups: DiffFileGroupItem[];

    constructor(workspaceKey: string, workspacePath: string | undefined, groups: DiffFileGroupItem[]) {
        super(workspacePath && workspacePath.length > 0
            ? pathToDisplayInfo(workspacePath).basename || workspacePath
            : 'Unknown workspace',
        vscode.TreeItemCollapsibleState.Collapsed);
        this.workspaceKey = workspaceKey;
        this.groups = groups;
        this.description = workspacePath && workspacePath.length > 0 ? workspacePath : `${groups.length} file(s)`;
        this.contextValue = 'logsDiffWorkspace';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

/** A distinct changed file — lists its change events. */
export class DiffFileGroupItem extends vscode.TreeItem {
    readonly filePath: string;
    readonly events: LogEvent[];

    constructor(filePath: string, events: LogEvent[]) {
        const display = pathToDisplayInfo(filePath);
        super(display.basename || filePath, events.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None);
        this.filePath = filePath;
        this.events = events;
        this.description = display.dirname
            ? `${events.length} change${events.length === 1 ? '' : 's'} · ${display.dirname}`
            : `${events.length} change${events.length === 1 ? '' : 's'}`;
        this.contextValue = 'logsDiffFile';
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.tooltip = filePath;
    }

    /** Sorting key: the newest event timestamp of this file's changes. */
    get newestTimestamp(): string {
        return this.events[0]?.timestamp ?? '';
    }
}

/** A single change row. */
export class DiffEventLeafItem extends vscode.TreeItem {
    readonly event: LogEvent;

    constructor(event: LogEvent) {
        super(diffEventLabel(event), vscode.TreeItemCollapsibleState.None);
        this.event = event;
        this.description = diffEventDescription(event);
        this.tooltip = diffEventTooltip(event);
        this.contextValue = event.type === 'diff' ? 'logsDiffEvent' : 'logsDiffFileOp';
        // Double-click / Enter: a diff opens in VS Code's native diff editor
        // (side-by-side visual diff); a file operation — which carries no
        // patch text — falls back to the detail webview.
        this.command = event.type === 'diff'
            ? { command: 'chatwizard.logs.diff.viewDiff', title: 'Open Visual Diff' }
            : { command: 'chatwizard.logs.diff.showDetails', title: 'Show Change Details' };
        this.iconPath = new vscode.ThemeIcon(event.type === 'diff' ? 'diff' : 'file');
    }
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DiffExplorerProvider implements vscode.TreeDataProvider<DiffExplorerTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiffExplorerTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _workspaceGroups: DiffWorkspaceGroupItem[] = [];
    private _filters: LogViewFilters = emptyLogFilters();
    /** Phase 4: cache "filtered to nothing" so empty sections stop re-querying. */
    private _built = false;

    constructor(private readonly logService: LogService) { }

    /**
     * Replace the active filters and rebuild. Only the search + agent facets
     * apply here — the Diff Explorer never lists command/error kinds.
     */
    setFilters(filters: LogViewFilters): void {
        this._filters = { search: filters.search, tool: filters.tool };
        this.refresh();
    }

    /** Current filters (a copy — callers may mutate the result safely). */
    getFilters(): LogViewFilters {
        return { ...this._filters };
    }

    /** True when a search / agent filter is narrowing this section. */
    filtersActive(): boolean {
        return hasActiveFilters(this._filters);
    }

    /** Re-query the store and rebuild the tree. */
    refresh(): void {
        this._workspaceGroups = this._buildWorkspaceGroups();
        this._built = true;
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: DiffExplorerTreeNode): DiffExplorerTreeNode[] {
        if (!element) {
            if (!this._built) { this.refresh(); }
            return this._workspaceGroups;
        }
        if (element instanceof DiffWorkspaceGroupItem) {
            return element.groups;
        }
        if (element instanceof DiffFileGroupItem) {
            return element.events.map((e) => new DiffEventLeafItem(e));
        }
        return [];
    }

    getTreeItem(element: DiffExplorerTreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: DiffExplorerTreeNode): DiffExplorerTreeNode | undefined {
        if (element instanceof DiffEventLeafItem) {
            for (const ws of this._workspaceGroups) {
                const fileGroup = ws.groups.find((g) => g.events.some((e) => e.id === element.event.id));
                if (fileGroup) { return fileGroup; }
            }
        }
        if (element instanceof DiffFileGroupItem) {
            return this._workspaceGroups.find((ws) => ws.groups.includes(element));
        }
        return undefined;
    }

    /** Root groups currently rendered (useful for tests + stats). */
    getWorkspaceGroups(): DiffWorkspaceGroupItem[] {
        // Lazily build on first read so callers that inspect the tree before
        // VS Code renders it still see the store contents.
        if (!this._built) {
            this._workspaceGroups = this._buildWorkspaceGroups();
            this._built = true;
        }
        return this._workspaceGroups;
    }

    /** Total number of change events rendered across all groups. */
    getTotalEvents(): number {
        let total = 0;
        for (const ws of this._workspaceGroups) {
            for (const file of ws.groups) {
                total += file.events.length;
            }
        }
        return total;
    }

    private _buildWorkspaceGroups(): DiffWorkspaceGroupItem[] {
        let events: LogEvent[];
        try {
            events = this.logService.getEvents({
                types: ['diff', 'fileOperation'],
                tool: this._filters.tool,
                order: 'desc',
                limit: MAX_DIFFS_PER_QUERY,
            });
        } catch (err) {
            // A broken/degraded store must never break tree rendering.
            logWatch.warn('diff explorer query failed: %s', err);
            return [];
        }

        events = events
            .filter(isDiffCandidate)
            .filter((event) => matchesLogFilters(event, { search: this._filters.search }));

        const byWorkspace = new Map<string, LogEvent[]>();
        for (const event of events) {
            const key = event.workspacePath && event.workspacePath.length > 0
                ? event.workspacePath
                : `id:${event.workspaceId ?? event.sessionId ?? 'unknown'}`;
            const bucket = byWorkspace.get(key);
            if (bucket) { bucket.push(event); } else { byWorkspace.set(key, [event]); }
        }

        const groups: DiffWorkspaceGroupItem[] = [];
        for (const [workspaceKey, wsEvents] of byWorkspace) {
            const byFile = new Map<string, LogEvent[]>();
            for (const event of wsEvents) {
                const key = getEventFilePath(event) ?? '';
                const bucket = byFile.get(key);
                if (bucket) { bucket.push(event); } else { byFile.set(key, [event]); }
            }

            const fileGroups: DiffFileGroupItem[] = [];
            for (const [filePath, fileEvents] of byFile) {
                fileEvents.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
                fileGroups.push(new DiffFileGroupItem(filePath, fileEvents));
            }
            fileGroups.sort((a, b) => b.newestTimestamp.localeCompare(a.newestTimestamp));

            const workspacePath = workspaceKey.startsWith('id:') ? undefined : workspaceKey;
            groups.push(new DiffWorkspaceGroupItem(workspaceKey, workspacePath, fileGroups));
        }

        // Newest change first across workspaces.
        groups.sort((a, b) => {
            const aNewest = a.groups[0]?.newestTimestamp ?? '';
            const bNewest = b.groups[0]?.newestTimestamp ?? '';
            return bNewest.localeCompare(aNewest);
        });

        return groups;
    }
}