import * as vscode from 'vscode';
import * as path from 'path';
import { SessionIndex } from '../index/sessionIndex';
import { SessionSummary, SessionSource } from '../types/index';
import { friendlySourceName, sourceCodiconId } from '../ui/sourceUi';
import { sourceBrandIconUris } from '../ui/sourceBrandIcons';

/**
 * Returns a brand icon `{ light, dark }` URI pair for sources that have bundled SVGs.
 * Falls back to a ThemeIcon for copilot and claude (which use built-in codicons).
 */
function sourceBrandIcon(
    source: SessionSource,
    extensionUri: vscode.Uri
): { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon {
    const brand = sourceBrandIconUris(source, extensionUri);
    return brand ?? new vscode.ThemeIcon(sourceCodiconId(source));
}

export class SessionTreeItem extends vscode.TreeItem {
    readonly summary: SessionSummary;
    readonly pinned: boolean;

    constructor(summary: SessionSummary, pinned = false, extensionUri?: vscode.Uri) {
        super(summary.title || 'Untitled Session', vscode.TreeItemCollapsibleState.None);

        this.summary = summary;
        this.pinned = pinned;

        const workspaceName = path.basename(summary.workspacePath ?? summary.workspaceId);
        const date = summary.updatedAt.slice(0, 10);
        const msgCount = summary.messageCount;
        const sizeKb = summary.fileSizeBytes !== undefined
            ? `${(summary.fileSizeBytes / 1024).toFixed(1)} KB`
            : undefined;

        this.description = sizeKb
            ? `${workspaceName} · ${date} · ${msgCount} msgs · ${sizeKb}`
            : `${workspaceName} · ${date} · ${msgCount} msgs`;

        const sourceName = friendlySourceName(summary.source);
        const modelLine = summary.model ? `\n\n**Model:** ${summary.model}` : '';
        const sizeLine = sizeKb ? `\n\n**Size:** ${msgCount} messages · ${sizeKb}` : `\n\n**Size:** ${msgCount} messages`;
        const pinnedLine = pinned ? `\n\n📌 *Pinned*` : '';
        const interruptedLine = summary.interrupted ? `\n\n⚠ *Response not available — cancelled or incomplete*` : '';
        const parseErrorsLine = summary.hasParseErrors ? `\n\n⚠ *This session has parse errors — some lines could not be read*` : '';

        const config = vscode.workspace.getConfiguration('chatwizard');
        const labelColor = config.get<string>('tooltipLabelColor', '');

        let tooltip: vscode.MarkdownString;
        if (labelColor) {
            const lbl = (t: string) => `<span style="color:${labelColor};">${t}</span>`;
            const sizeText = sizeKb ? `${msgCount} messages · ${sizeKb}` : `${msgCount} messages`;
            tooltip = new vscode.MarkdownString(
                `${lbl('Title:')} ${summary.title || 'Untitled Session'}\n\n` +
                `${lbl('Source:')} ${sourceName}` +
                (summary.model ? `\n\n${lbl('Model:')} ${summary.model}` : '') +
                `\n\n${lbl('Workspace:')} ${workspaceName}` +
                `\n\n${lbl('Updated:')} ${summary.updatedAt.slice(0, 16).replace('T', ' ')}` +
                `\n\n${lbl('Size:')} ${sizeText}` +
                `\n\n${summary.userMessageCount} prompts · ${summary.assistantMessageCount} responses` +
                pinnedLine + interruptedLine + parseErrorsLine
            );
            tooltip.isTrusted = true;
            tooltip.supportHtml = true;
        } else {
            tooltip = new vscode.MarkdownString(
                `**Title:** ${summary.title || 'Untitled Session'}\n\n` +
                `**Source:** ${sourceName}${modelLine}\n\n` +
                `**Workspace:** ${workspaceName}\n\n` +
                `**Updated:** ${summary.updatedAt.slice(0, 16).replace('T', ' ')}` +
                sizeLine + `\n\n` +
                `${summary.userMessageCount} prompts · ${summary.assistantMessageCount} responses` +
                pinnedLine + interruptedLine + parseErrorsLine
            );
        }
        this.tooltip = tooltip;

        if (pinned) {
            this.iconPath = new vscode.ThemeIcon('pinned');
        } else if (extensionUri && sourceBrandIconUris(summary.source, extensionUri)) {
            // Prefer bundled brand SVGs (Cursor, Cline, …) even when interrupted / parse warnings —
            // codicon fallbacks like $(edit) are misleading for product identity.
            this.iconPath = sourceBrandIcon(summary.source, extensionUri);
        } else if (summary.interrupted) {
            const red = new vscode.ThemeColor('list.errorForeground');
            this.iconPath = new vscode.ThemeIcon(sourceCodiconId(summary.source), red);
        } else if (summary.hasParseErrors) {
            const yellow = new vscode.ThemeColor('list.warningForeground');
            this.iconPath = new vscode.ThemeIcon(sourceCodiconId(summary.source), yellow);
        } else if (extensionUri) {
            this.iconPath = sourceBrandIcon(summary.source, extensionUri);
        } else {
            this.iconPath = new vscode.ThemeIcon(sourceCodiconId(summary.source));
        }

        if (summary.hasParseErrors) {
            // Synthetic URI lets the FileDecorationProvider add a ⚠ badge overlay on the icon
            this.resourceUri = vscode.Uri.from({ scheme: 'chatwizard-warn', path: '/' + summary.id });
        }

        this.contextValue = pinned ? 'session.pinned' : 'session';

        this.command = {
            command: 'chatwizard.openSession',
            title: 'Open Session',
            arguments: [summary],
        };
    }
}

export class LoadingTreeItem extends vscode.TreeItem {
    constructor() {
        super('Indexing sessions…', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        this.contextValue = 'loading';
    }
}

export class LoadMoreTreeItem extends vscode.TreeItem {
    readonly remaining: number;
    constructor(remaining: number) {
        super(`⋯ Load more (${remaining} remaining)`, vscode.TreeItemCollapsibleState.None);
        this.remaining = remaining;
        this.contextValue = 'loadMore';
        this.command = {
            command: 'chatwizard.loadMoreSessions',
            title: 'Load More Sessions',
            arguments: [],
        };
    }
}

// ---------------------------------------------------------------------------
// Sort types
// ---------------------------------------------------------------------------

export type SortMode = 'date' | 'workspace' | 'length' | 'title' | 'model';
export type SortKey = SortMode | 'source';
export type SortDirection = 'asc' | 'desc';

export interface SortCriterion {
    key: SortKey;
    direction: SortDirection;
}

export type SortStack = SortCriterion[];

const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
    date: 'desc',
    workspace: 'asc',
    length: 'desc',
    title: 'asc',
    model: 'asc',
    source: 'asc',
};

export const SORT_KEY_LABELS: Record<SortKey, string> = {
    date: 'Date',
    workspace: 'Workspace',
    length: 'Message Count',
    title: 'Title (A–Z)',
    model: 'AI Model',
    source: 'Source',
};

const SHORT_LABEL: Record<SortKey, string> = {
    date: 'Date',
    workspace: 'Workspace',
    length: 'Length',
    title: 'A–Z',
    model: 'Model',
    source: 'Source',
};

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export interface SessionFilter {
    title?: string;        // case-insensitive substring
    dateFrom?: string;     // YYYY-MM-DD lower bound (inclusive)
    dateTo?: string;       // YYYY-MM-DD upper bound (inclusive)
    model?: string;        // case-insensitive substring
    source?: SessionSource; // exact source to show
    minMessages?: number;
    maxMessages?: number;
    hideInterrupted?: boolean;   // when true, hide sessions whose last message has no assistant reply
    onlyWithWarnings?: boolean;  // when true, show only sessions that have parse errors / skipped turns
}

// ---------------------------------------------------------------------------
// Sort comparator
// ---------------------------------------------------------------------------

function compareBy(key: SortKey, a: SessionSummary, b: SessionSummary): number {
    switch (key) {
        case 'date':
            return a.updatedAt.localeCompare(b.updatedAt);
        case 'workspace': {
            const wa = path.basename(a.workspacePath ?? a.workspaceId);
            const wb = path.basename(b.workspacePath ?? b.workspaceId);
            return wa.localeCompare(wb);
        }
        case 'length':
            return a.messageCount - b.messageCount;
        case 'title':
            return a.title.localeCompare(b.title);
        case 'model': {
            const ma = a.model ?? '';
            const mb = b.model ?? '';
            return ma.localeCompare(mb);
        }
        case 'source':
            return a.source.localeCompare(b.source);
    }
}

// ---------------------------------------------------------------------------
// Parse-warning file decoration provider
// ---------------------------------------------------------------------------

/**
 * Adds a ⚠ badge and yellow colour to tree items whose session has parse errors.
 * Register via vscode.window.registerFileDecorationProvider() in extension.ts.
 * Works alongside the yellow icon set on SessionTreeItem when hasParseErrors is true.
 */
export class SessionParseWarningDecorationProvider implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === 'chatwizard-warn') {
            return {
                badge: '⚠',
                color: new vscode.ThemeColor('list.warningForeground'),
                tooltip: 'This session has parse errors',
                propagate: false,
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem | LoadMoreTreeItem | LoadingTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | LoadMoreTreeItem | LoadingTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sortStack: SortStack = [{ key: 'date', direction: 'desc' }];
    private _filter: SessionFilter = {};
    /** Ordered list of pinned session IDs (first = top of list) */
    private _pinnedIds: string[] = [];
    /** Full display order set by drag-and-drop; empty means use sort stack */
    private _manualOrder: string[] = [];
    private _sortedCache: SessionSummary[] | null = null;
    private _visibleCount = 200;
    private _filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /** True until the first change event fires (initial batch index complete) */
    private _loading = true;

    constructor(private readonly index: SessionIndex, private readonly extensionUri?: vscode.Uri) {
        index.addChangeListener(() => {
            this._loading = false;
            this._sortedCache = null;
            this.refresh();
        });
    }

    // ------------------------------------------------------------------
    // Pin management
    // ------------------------------------------------------------------

    pin(id: string): void {
        if (!this._pinnedIds.includes(id)) { this._pinnedIds.push(id); }
    }

    unpin(id: string): void {
        this._pinnedIds = this._pinnedIds.filter(p => p !== id);
    }

    isPinned(id: string): boolean { return this._pinnedIds.includes(id); }

    getPinnedIds(): string[] { return [...this._pinnedIds]; }

    setPinnedIds(ids: string[]): void { this._pinnedIds = ids; }

    getManualOrder(): string[] { return [...this._manualOrder]; }

    setManualOrder(order: string[]): void { this._manualOrder = order; }

    /**
     * Move `draggedIds` to just before `beforeId` in the full display order.
     * Saves the result to `_manualOrder` so unpinned items keep their new positions.
     */
    reorder(draggedIds: string[], beforeId: string | undefined): void {
        const current = this._buildOrderedSummaries().map(s => s.id);
        const order = current.filter(id => !draggedIds.includes(id));

        if (beforeId !== undefined) {
            const idx = order.indexOf(beforeId);
            idx >= 0 ? order.splice(idx, 0, ...draggedIds) : order.push(...draggedIds);
        } else {
            order.push(...draggedIds);
        }

        this._manualOrder = order;
        // Keep pinned IDs sorted to match the new order
        const pinnedSet = new Set(this._pinnedIds);
        this._pinnedIds = order.filter(id => pinnedSet.has(id));
        this._sortedCache = null;
    }

    // ------------------------------------------------------------------
    // Sort stack
    // ------------------------------------------------------------------

    restoreStack(stack: SortStack): void {
        if (stack.length > 0) { this.sortStack = stack; }
    }

    setSortStack(stack: SortStack): void {
        if (stack.length > 0) { this.sortStack = stack; this._manualOrder = []; this.invalidateSortCache(); }
    }

    getSortStack(): SortStack {
        return this.sortStack.map(c => ({ ...c }));
    }

    setSortMode(mode: SortMode): void {
        this.invalidateSortCache();
        this._manualOrder = [];
        if (this.sortStack[0]?.key === mode) {
            const cur = this.sortStack[0].direction;
            this.sortStack = [{ key: mode, direction: cur === 'asc' ? 'desc' : 'asc' }];
        } else {
            this.sortStack = [{ key: mode, direction: DEFAULT_DIRECTION[mode] }];
        }
    }

    getPrimary(): { key: SortKey; direction: SortDirection } {
        const first = this.sortStack[0] ?? { key: 'date' as SortKey, direction: 'desc' as SortDirection };
        return { key: first.key, direction: first.direction };
    }

    // ------------------------------------------------------------------
    // Filters
    // ------------------------------------------------------------------

    setFilter(filter: SessionFilter): void {
        this._filter = filter;
        this.invalidateSortCache();
    }

    clearFilter(): void {
        this._filter = {};
        this.invalidateSortCache();
    }

    getFilter(): SessionFilter { return { ...this._filter }; }

    hasActiveFilter(): boolean {
        const f = this._filter;
        return !!(f.title || f.dateFrom || f.dateTo || f.model || f.source ||
                  f.minMessages !== undefined || f.maxMessages !== undefined ||
                  f.hideInterrupted || f.onlyWithWarnings);
    }

    private _matchesFilter(s: SessionSummary): boolean {
        const f = this._filter;
        if (f.title && !s.title.toLowerCase().includes(f.title.toLowerCase())) { return false; }
        const day = s.updatedAt.slice(0, 10);
        if (f.dateFrom && day < f.dateFrom) { return false; }
        if (f.dateTo && day > f.dateTo) { return false; }
        if (f.model !== undefined && f.model !== '') {
            if (!(s.model ?? '').toLowerCase().includes(f.model.toLowerCase())) { return false; }
        }
        if (f.source && s.source !== f.source) { return false; }
        if (f.minMessages !== undefined && s.messageCount < f.minMessages) { return false; }
        if (f.maxMessages !== undefined && s.messageCount > f.maxMessages) { return false; }
        if (f.hideInterrupted && s.interrupted) { return false; }
        if (f.onlyWithWarnings && !s.hasParseErrors) { return false; }
        return true;
    }

    private _filterDescription(): string {
        const f = this._filter;
        const parts: string[] = [];
        if (f.title) { parts.push(`title:"${f.title}"`); }
        if (f.dateFrom || f.dateTo) { parts.push(`date:${f.dateFrom ?? '*'}→${f.dateTo ?? '*'}`); }
        if (f.model) { parts.push(`model:"${f.model}"`); }
        if (f.source) { parts.push(`source:${friendlySourceName(f.source)}`); }
        if (f.minMessages !== undefined || f.maxMessages !== undefined) {
            parts.push(`msgs:${f.minMessages ?? 0}–${f.maxMessages ?? '∞'}`);
        }
        if (f.hideInterrupted) { parts.push('hide:interrupted'); }
        if (f.onlyWithWarnings) { parts.push('warnings only'); }
        return parts.length > 0 ? `⊘ ${parts.join(' · ')}` : '';
    }

    // ------------------------------------------------------------------
    // Description (shown in TreeView subtitle)
    // ------------------------------------------------------------------

    getDescription(): string {
        const count = this.index.getAllSummaries().length;
        const countPart = `${count.toLocaleString()} session${count === 1 ? '' : 's'}`;
        const sortPart = this.sortStack
            .map(c => `${SHORT_LABEL[c.key]} ${c.direction === 'asc' ? '↑' : '↓'}`)
            .join(' · ');
        const filterPart = this._filterDescription();
        const right = filterPart ? `${sortPart}  ·  ${filterPart}` : sortPart;
        return `${countPart}  ·  ${right}`;
    }

    // ------------------------------------------------------------------
    // Cache management
    // ------------------------------------------------------------------

    private invalidateSortCache(): void {
        this._sortedCache = null;
        this._visibleCount = 200;
    }

    loadMore(): void {
        this._visibleCount += 200;
        this._onDidChangeTreeData.fire();
    }

    setFilterDebounced(filter: SessionFilter): void {
        this._filter = filter;
        this.invalidateSortCache();
        if (this._filterDebounceTimer) { clearTimeout(this._filterDebounceTimer); }
        this._filterDebounceTimer = setTimeout(() => {
            this._filterDebounceTimer = null;
            this._onDidChangeTreeData.fire();
        }, 150);
    }

    // ------------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------------

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: SessionTreeItem | LoadMoreTreeItem | LoadingTreeItem): vscode.TreeItem { return element; }

    // Required by VS Code for treeView.reveal() to work — all items are root-level, so no parent.
    getParent(_element: SessionTreeItem | LoadMoreTreeItem | LoadingTreeItem): undefined { return undefined; }

    private _buildOrderedSummaries(): SessionSummary[] {
        if (this._sortedCache !== null) {
            return this._sortedCache;
        }

        let summaries = this.index.getAllSummaries();
        if (this.hasActiveFilter()) {
            summaries = summaries.filter(s => this._matchesFilter(s));
        }

        // If the user has manually reordered via drag-and-drop, honour that order.
        if (this._manualOrder.length > 0) {
            const byId = new Map(summaries.map(s => [s.id, s]));
            const ordered = this._manualOrder
                .map(id => byId.get(id))
                .filter((s): s is SessionSummary => s !== undefined);
            // Append sessions that arrived after the last drag (not yet in manual order)
            const inManual = new Set(this._manualOrder);
            const extras = summaries.filter(s => !inManual.has(s.id));
            this._sortedCache = [...ordered, ...extras];
            return this._sortedCache;
        }

        const pinnedSet = new Set(this._pinnedIds);
        const pinned = this._pinnedIds
            .map(id => summaries.find(s => s.id === id))
            .filter(Boolean) as SessionSummary[];
        const unpinned = summaries.filter(s => !pinnedSet.has(s.id));

        unpinned.sort((a, b) => {
            for (const criterion of this.sortStack) {
                const raw = compareBy(criterion.key, a, b);
                if (raw !== 0) { return criterion.direction === 'asc' ? raw : -raw; }
            }
            return 0;
        });

        this._sortedCache = [...pinned, ...unpinned];
        return this._sortedCache;
    }

    getChildren(): (SessionTreeItem | LoadMoreTreeItem | LoadingTreeItem)[] {
        if (this._loading) {
            return [new LoadingTreeItem()];
        }
        const pinnedSet = new Set(this._pinnedIds);
        const all = this._buildOrderedSummaries();
        const visible = all.slice(0, this._visibleCount);
        const items: (SessionTreeItem | LoadMoreTreeItem)[] = visible.map(s => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri));
        const remaining = all.length - visible.length;
        if (remaining > 0) {
            items.push(new LoadMoreTreeItem(remaining));
        }
        return items;
    }

    /** Returns sessions in the same order as the tree view (sort, pins, filters applied). */
    getSortedSummaries(): SessionSummary[] {
        return this._buildOrderedSummaries();
    }
}
