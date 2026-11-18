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
 * move/mkdir). Grouped **per changed file**, the changed files listed
 * **alphabetically** (`compareDiffFilePaths`) and each file expanding into its
 * change rows **newest first**, so the section reads like a file index whose
 * entries keep the timeline of the edits made to them:
 *
 *   - open the visual diff — the change in VS Code's native diff editor
 *     (side-by-side / inline, `src/logs/diffViewer.ts`)
 *   - open the patch — renders the raw diff text in a disposable markdown editor
 *   - copy the diff text to the clipboard
 *   - open the affected file (when it still exists on disk)
 *
 * The section is scoped to the active workspace (see `resolveWorkspaceScope`),
 * so the changed files are the section's direct children — a workspace binder
 * level would only repeat the folder that is already in scope on every row.
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
 * VS Code codicon for a change row — one icon per operation, so the Diff
 * Explorer's leaves never wear the generic `file` (or the Unified Timeline's
 * `history`) icon of another section.
 */
export function diffEventIconId(event: LogEvent): string {
    if (event.type === 'diff') { return 'diff'; }
    switch ((event as FileOperationEvent).operationType) {
        case 'create': return 'file-add';
        case 'delete': return 'trash';
        case 'rename': return 'arrow-swap';
        case 'move': return 'move';
        case 'mkdir': return 'new-folder';
        // `patch` operations are filtered out (isDiffCandidate), but a store
        // written by an older adapter may still carry one.
        case 'patch': return 'diff';
        default: return 'file';
    }
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

/**
 * Case-insensitive collation with a case-sensitive tiebreaker.
 *
 * `sensitivity: 'base'` alone reports `a.ts` and `A.ts` as equal, which would
 * make the sort order depend on the input order; the second comparison makes
 * the order total (and therefore stable across refreshes).
 */
function collate(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
        || a.localeCompare(b);
}

/** Alphabetical comparison of two changed-file paths (case-insensitive). */
export function compareDiffFilePaths(a: string, b: string): number {
    return collate(a, b);
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

export type DiffExplorerTreeNode = DiffFileGroupItem | DiffEventLeafItem;

/**
 * A distinct changed file — the section's root rows.
 *
 * Starts **collapsed**, like every group in the Commands view, so opening the
 * "Diff Explorer" section lists the changed files rather than every individual
 * change row.
 */
export class DiffFileGroupItem extends vscode.TreeItem {
    readonly filePath: string;
    readonly events: LogEvent[];

    constructor(filePath: string, events: LogEvent[]) {
        const display = pathToDisplayInfo(filePath);
        super(display.basename || filePath, events.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
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
        this.iconPath = new vscode.ThemeIcon(diffEventIconId(event));
    }
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DiffExplorerProvider implements vscode.TreeDataProvider<DiffExplorerTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiffExplorerTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** Changed files, alphabetically — the section's direct children. */
    private _fileGroups: DiffFileGroupItem[] = [];
    private _filters: LogViewFilters = emptyLogFilters();
    /** Phase 4: cache "filtered to nothing" so empty sections stop re-querying. */
    private _built = false;

    constructor(private readonly logService: LogService) { }

    /**
     * Replace the active filters and rebuild. Only the search + agent facets
     * apply here — the Diff Explorer never lists command/error kinds.
     */
    setFilters(filters: LogViewFilters): void {
        this._filters = {
            search: filters.search,
            tool: filters.tool,
            workspacePaths: filters.workspacePaths,
        };
        this.refresh();
    }

    /**
     * Restrict this section to the given workspace roots (the VS Code open
     * folders). An empty array clears the restriction.
     */
    setWorkspaceScope(workspacePaths: string[]): void {
        this._filters = {
            ...this._filters,
            workspacePaths: workspacePaths.length > 0 ? [...workspacePaths] : undefined,
        };
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
        this._fileGroups = this._buildFileGroups();
        this._built = true;
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: DiffExplorerTreeNode): DiffExplorerTreeNode[] {
        if (!element) {
            if (!this._built) { this.refresh(); }
            return this._fileGroups;
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
            return this._fileGroups.find((g) => g.events.some((e) => e.id === element.event.id));
        }
        // File groups are the roots of this section, so they report the section
        // row as their parent (the composite view falls back to it).
        return undefined;
    }

    /** Changed-file groups currently rendered (useful for tests + stats). */
    getFileGroups(): DiffFileGroupItem[] {
        // Lazily build on first read so callers that inspect the tree before
        // VS Code renders it still see the store contents.
        if (!this._built) {
            this._fileGroups = this._buildFileGroups();
            this._built = true;
        }
        return this._fileGroups;
    }

    /** Total number of change events rendered across all files. */
    getTotalEvents(): number {
        return this._fileGroups.reduce((total, file) => total + file.events.length, 0);
    }

    private _buildFileGroups(): DiffFileGroupItem[] {
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
            .filter((event) => matchesLogFilters(event, {
                search: this._filters.search,
                workspacePaths: this._filters.workspacePaths,
            }));

        // The section is already scoped to the active workspace, so the changed
        // files are grouped directly — no workspace binder level.
        const byFile = new Map<string, LogEvent[]>();
        for (const event of events) {
            const key = getEventFilePath(event) ?? '';
            const bucket = byFile.get(key);
            if (bucket) { bucket.push(event); } else { byFile.set(key, [event]); }
        }

        const fileGroups: DiffFileGroupItem[] = [];
        for (const [filePath, fileEvents] of byFile) {
            // Change rows inside one file keep the edit timeline: newest
            // first, so a file's history reads chronologically.
            fileEvents.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
            fileGroups.push(new DiffFileGroupItem(filePath, fileEvents));
        }

        // The section's direct children are the changed files, listed
        // alphabetically (case-insensitive, with a case-sensitive tiebreaker)
        // so a file is found by name instead of by "when was it last touched".
        fileGroups.sort((a, b) => compareDiffFilePaths(a.filePath, b.filePath));
        return fileGroups;
    }
}