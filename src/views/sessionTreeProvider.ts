import * as vscode from 'vscode';
import * as path from 'path';
import { SessionIndex } from '../index/sessionIndex';
import { Session, SessionSummary, SessionSource, SessionFolder, FolderStats } from '../types/index';
import { FolderStore } from '../index/folderStore';
import { extractWorkItemsFromSession } from '../utils/workItemExtractor';
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

/** Deterministic colored-circle emoji for a tag name — consistent across sessions. */
const _TAG_COLOR_PALETTE = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤'];
function tagColorEmoji(tag: string): string {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) { hash = (hash * 31 + tag.charCodeAt(i)) & 0xffff; }
    return _TAG_COLOR_PALETTE[hash % _TAG_COLOR_PALETTE.length];
}

/** Formats an ISO date string as "DD-Mon-YY" (e.g. "16-Jul-26"). */
function shortDate(iso: string): string {
    const d = new Date(iso);
    const day = d.getDate().toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const year = d.getFullYear().toString().slice(-2);
    return `${day}-${month}-${year}`;
}

/** Builds a date range string from a set of session summaries. */
function dateRangeLabel(summaries: SessionSummary[]): string | undefined {
    let min: string | undefined;
    let max: string | undefined;
    for (const s of summaries) {
        const d = s.updatedAt.slice(0, 10);
        if (!min || d < min) { min = d; }
        if (!max || d > max) { max = d; }
    }
    if (!min || !max) { return undefined; }
    const same = min === max;
    return same ? shortDate(min) : `${shortDate(min)} - ${shortDate(max)}`;
}

export class SessionTreeItem extends vscode.TreeItem {
    readonly summary: SessionSummary;
    readonly pinned: boolean;

    constructor(summary: SessionSummary, pinned = false, extensionUri?: vscode.Uri, tags?: string[], summaryText?: string, public readonly status?: 'open' | 'resolved' | 'revisit') {
        const statusBadge = status === 'resolved' ? '✓ ' : status === 'revisit' ? '⟲ ' : '';
        super(`${statusBadge}${summary.title || 'Untitled Session'}`, vscode.TreeItemCollapsibleState.None);

        this.id      = summary.id;   // stable identity → enables treeView.reveal()
        this.summary = summary;
        this.pinned  = pinned;

        const workspaceName = path.basename(summary.workspacePath ?? summary.workspaceId);
        const date = summary.updatedAt.slice(0, 10);
        const msgCount = summary.messageCount;
        const sizeKb = summary.fileSizeBytes !== undefined
            ? `${(summary.fileSizeBytes / 1024).toFixed(1)} KB`
            : undefined;

        const archivedPrefix = summary.userArchived
            ? '🧊 archived (by you)  ·  '
            : summary.archived
                ? '📦 archived (auto)  ·  '
                : '';
        const tagsSuffix = tags && tags.length > 0 ? `  ·  ${tags.map(t => `${tagColorEmoji(t)} #${t}`).join(' ')}` : '';
        this.description = sizeKb
            ? `${archivedPrefix}${workspaceName} · ${date} · ${msgCount} msgs · ${sizeKb}${tagsSuffix}`
            : `${archivedPrefix}${workspaceName} · ${date} · ${msgCount} msgs${tagsSuffix}`;

        const sourceName = friendlySourceName(summary.source);
        const modelLine = summary.model ? `\n\n**Model:** ${summary.model}` : '';
        const sizeLine = sizeKb ? `\n\n**Size:** ${msgCount} messages · ${sizeKb}` : `\n\n**Size:** ${msgCount} messages`;
        const pinnedLine = pinned ? `\n\n📌 *Pinned*` : '';
        const archivedLine = summary.userArchived
            ? `\n\n🧊 *Archived by you — original source file deleted, ChatWizard copy retained*`
            : summary.archived
                ? `\n\n📦 *Auto-archived — source file was pruned by the AI tool, ChatWizard copy retained*`
                : '';
        const tagsLine = tags && tags.length > 0 ? `\n\n**Tags:** ${tags.map(t => `\`#${t}\``).join(' ')}` : '';
        const summaryLine = summaryText ? `\n\n**Summary:** ${summaryText}` : '';
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
                pinnedLine + archivedLine + tagsLine + summaryLine + interruptedLine + parseErrorsLine
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
                pinnedLine + archivedLine + tagsLine + summaryLine + interruptedLine + parseErrorsLine
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

        const statusSuffix = status ? `.${status}` : '';
        this.contextValue = pinned
            ? `session.pinned${statusSuffix}`
            : summary.userArchived
                ? `session.userArchived${statusSuffix}`
                : summary.archived
                    ? `session.archived${statusSuffix}`
                    : `session${statusSuffix}`;

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

// ---------------------------------------------------------------------------
// Date grouping
// ---------------------------------------------------------------------------

export type GroupMode = 'none' | 'date' | 'branch' | 'workItem' | 'tag' | 'folder';

/**
 * Returns a bucket label for a given ISO date string.
 * Buckets (in descending recency): "This Week", "Last Week",
 * "This Month", "Last Month", then full month names like "March 2025".
 */
export function getDateBucket(isoDate: string): string {
    const now = new Date();
    const d = new Date(isoDate);

    // Start of the current ISO week (Monday)
    const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mon…6=Sun
    const thisWeekStart = new Date(now);
    thisWeekStart.setHours(0, 0, 0, 0);
    thisWeekStart.setDate(thisWeekStart.getDate() - dayOfWeek);

    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    if (d >= thisWeekStart) { return 'This Week'; }
    if (d >= lastWeekStart) { return 'Last Week'; }

    // Calendar months
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth(); // 0-based
    const dYear = d.getFullYear();
    const dMonth = d.getMonth();

    if (dYear === nowYear && dMonth === nowMonth) { return 'This Month'; }

    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    if (dYear === lastMonthDate.getFullYear() && dMonth === lastMonthDate.getMonth()) { return 'Last Month'; }

    // Older: full month label
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    return `${MONTHS[dMonth]} ${dYear}`;
}

/** Sort order for date bucket labels (most recent first). */
function dateBucketOrder(label: string): number {
    if (label === 'This Week') { return 0; }
    if (label === 'Last Week') { return 1; }
    if (label === 'This Month') { return 2; }
    if (label === 'Last Month') { return 3; }
    // For older buckets "Month YYYY", parse and sort by year/month descending
    const match = /^(\w+) (\d{4})$/.exec(label);
    if (match) {
        const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const monthIdx = MONTHS.indexOf(match[1]);
        const year = parseInt(match[2], 10);
        return 4 + (3000 - year) * 12 + (11 - monthIdx);
    }
    return 9999;
}

export class DateGroupTreeItem extends vscode.TreeItem {
    readonly bucketLabel: string;

    constructor(label: string, count: number) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.bucketLabel = label;
        this.description = `${count} session${count === 1 ? '' : 's'}`;
        this.iconPath = new vscode.ThemeIcon('calendar');
        this.contextValue = 'dateGroup';
    }
}

export class ContextGroupTreeItem extends vscode.TreeItem {
    readonly groupKey: string;
    readonly groupMode: 'branch' | 'workItem' | 'tag';

    constructor(label: string, count: number, mode: 'branch' | 'workItem' | 'tag') {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.groupKey = label;
        this.groupMode = mode;
        this.description = `${count} session${count === 1 ? '' : 's'}`;
        this.iconPath = new vscode.ThemeIcon(
            mode === 'branch' ? 'git-branch' : mode === 'tag' ? 'bookmark' : 'tag'
        );
        this.contextValue = 'contextGroup';
    }
}

// ---------------------------------------------------------------------------
// Folder group tree item
// ---------------------------------------------------------------------------

export class FolderGroupTreeItem extends vscode.TreeItem {
    readonly folder: SessionFolder;
    readonly stats: FolderStats;
    readonly index: SessionIndex;

    constructor(folder: SessionFolder, stats: FolderStats, index: SessionIndex, allSummaries: SessionSummary[]) {
        const childSessionCount = folder.sessionIds.length;
        const subfolderCount = folder.childFolderIds.length;
        const parts: string[] = [];
        if (subfolderCount > 0) { parts.push(`${subfolderCount} folder${subfolderCount === 1 ? '' : 's'}`); }
        if (childSessionCount > 0) { parts.push(`${childSessionCount} session${childSessionCount === 1 ? '' : 's'}`); }

        super(folder.name, subfolderCount > 0 || childSessionCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);

        this.folder = folder;
        this.stats = stats;
        this.index = index;
        this.id = `folder:${folder.id}`;

        // Date range
        if (stats.minDate && stats.maxDate) {
            const dateLabel = stats.minDate === stats.maxDate
                ? shortDate(stats.minDate)
                : `${shortDate(stats.minDate)} - ${shortDate(stats.maxDate)}`;
            parts.push(dateLabel);
        }
        this.description = parts.length > 0 ? parts.join(' · ') : 'empty';
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'sessionFolder';

        // Build tooltip with hover stats overlay
        this.tooltip = this._buildTooltip(stats);
    }

    private _buildTooltip(stats: FolderStats): vscode.MarkdownString {
        const lines: string[] = [];
        lines.push(`**📁 ${this.folder.name}**`);
        lines.push('');
        lines.push(`**Total Chats:** ${stats.totalChats}`);
        lines.push(`**Total Size:** ${stats.totalSizeFormatted}`);
        lines.push(`**Sources:** ${stats.sources.length > 0 ? stats.sources.join(', ') : '—'}`);
        lines.push(`**Models:** ${stats.models.length > 0 ? stats.models.join(', ') : '—'}`);
        const md = new vscode.MarkdownString(lines.join('\n'));
        md.isTrusted = true;
        return md;
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
    status?: 'open' | 'resolved' | 'revisit'; // filter by feature-28 status
    minMessages?: number;
    maxMessages?: number;
    hideInterrupted?: boolean;   // when true, hide sessions whose last message has no assistant reply
    onlyWithWarnings?: boolean;  // when true, show only sessions that have parse errors / skipped turns
    tags?: string[];             // when set, show only sessions tagged with any of these tags (OR)
    archivedOnly?: boolean;      // when true, show only sessions served from the ChatWizard archive
    liveOnly?: boolean;          // when true, hide sessions served from the ChatWizard archive
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

export type SessionTreeNode = SessionTreeItem | DateGroupTreeItem | ContextGroupTreeItem | FolderGroupTreeItem | LoadMoreTreeItem | LoadingTreeItem | vscode.TreeItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sortStack: SortStack = [{ key: 'date', direction: 'desc' }];
    private _filter: SessionFilter = {};
    /** Ordered list of pinned session IDs (first = top of list) */
    private _pinnedIds: string[] = [];
    /** Full display order set by drag-and-drop; empty means use sort stack */
    private _manualOrder: string[] = [];
    private _sortedCache: SessionSummary[] | null = null;
    /**
     * Filtered (but not yet sorted) result of applying `_filter` to all summaries.
     * Invalidated only when filter settings or underlying data change — not on sort-only changes.
     * This avoids O(n) re-filter work for sort-only interactions (Item 9).
     */
    private _filteredCache: SessionSummary[] | null = null;
    private _visibleCount = 200;
    private _filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /** Debounce handle for change-listener — coalesces rapid live-watch upserts (Item 9). */
    private _changeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /** True until the first change event fires (initial batch index complete) */
    private _loading = true;
    /** Safety timeout handle — clears _loading if no change arrives within 30 s */
    private _loadingTimeout: ReturnType<typeof setTimeout> | null = null;
    /** Group mode — on by default */
    private _groupMode: GroupMode = 'date';
    /** Folder store — set externally after construction */
    private _folderStore: FolderStore | null = null;

    constructor(private readonly index: SessionIndex, private readonly extensionUri?: vscode.Uri) {
        // If the index already has data (e.g. in tests where sessions are upserted
        // before the provider is constructed), skip the loading state immediately.
        if (index.getAllSummaries().length > 0) {
            this._loading = false;
        } else {
            // Safety timeout: if no change event fires within 30 s, clear the loading
            // spinner so the tree shows empty-state UI instead of spinning forever.
            this._loadingTimeout = setTimeout(() => {
                if (this._loading) {
                    this._loading = false;
                    this.refresh();
                }
                this._loadingTimeout = null;
            }, 30_000);
        }
        index.addChangeListener(() => {
            this._loading = false;
            if (this._loadingTimeout !== null) {
                clearTimeout(this._loadingTimeout);
                this._loadingTimeout = null;
            }
            // Coalesce rapid sequential upserts (live-watch) into one tree refresh (Item 9).
            this._filteredCache = null;
            this._sortedCache = null;
            if (this._changeDebounceTimer !== null) { return; }
            this._changeDebounceTimer = setTimeout(() => {
                this._changeDebounceTimer = null;
                this.refresh();
            }, 100);
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

    // ------------------------------------------------------------------
    // Folder store
    // ------------------------------------------------------------------

    /** Attach a FolderStore to this provider. Must be called before groupMode='folder'. */
    setFolderStore(store: FolderStore): void {
        this._folderStore = store;
    }

    getFolderStore(): FolderStore | null { return this._folderStore; }

    // ------------------------------------------------------------------
    // Group mode
    // ------------------------------------------------------------------

    getGroupMode(): GroupMode { return this._groupMode; }

    setGroupMode(mode: GroupMode): void {
        this._groupMode = mode;
        this._onDidChangeTreeData.fire();
    }

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
        if (stack.length > 0) { this.sortStack = stack; this._manualOrder = []; this._invalidateSortOnly(); }
    }

    getSortStack(): SortStack {
        return this.sortStack.map(c => ({ ...c }));
    }

    setSortMode(mode: SortMode): void {
        this._invalidateSortOnly();
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
        this._invalidateFilterAndSort();
    }

    clearFilter(): void {
        this._filter = {};
        this._invalidateFilterAndSort();
    }

    getFilter(): SessionFilter { return { ...this._filter }; }

    hasActiveFilter(): boolean {
        const f = this._filter;
        return !!(f.title || f.dateFrom || f.dateTo || f.model || f.source || f.status ||
                  f.minMessages !== undefined || f.maxMessages !== undefined ||
                  f.hideInterrupted || f.onlyWithWarnings || (f.tags && f.tags.length > 0) ||
                  f.archivedOnly || f.liveOnly);
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
        if (f.status && this.index.getSidecarMeta(s.id)?.status !== f.status) { return false; }
        if (f.minMessages !== undefined && s.messageCount < f.minMessages) { return false; }
        if (f.maxMessages !== undefined && s.messageCount > f.maxMessages) { return false; }
        if (f.hideInterrupted && s.interrupted) { return false; }
        if (f.onlyWithWarnings && !s.hasParseErrors) { return false; }
        if (f.tags && f.tags.length > 0) {
            const sessionTags = this.index.getSidecarMeta(s.id)?.tags ?? [];
            if (!f.tags.some(t => sessionTags.includes(t))) { return false; }
        }
        if (f.archivedOnly && !s.archived) { return false; }
        if (f.liveOnly && s.archived) { return false; }
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
        if (f.tags && f.tags.length > 0) { parts.push(`tags:${f.tags.map(t => `#${t}`).join(',')}`); }
        if (f.archivedOnly) { parts.push('archived only'); }
        if (f.liveOnly) { parts.push('live only'); }
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

    /** Invalidate only the sort cache — filtered list stays valid (sort-only change). */
    private _invalidateSortOnly(): void {
        this._sortedCache = null;
        this._visibleCount = 200;
    }

    /** Invalidate both filter and sort caches (data or filter change). */
    private _invalidateFilterAndSort(): void {
        this._filteredCache = null;
        this._sortedCache = null;
        this._visibleCount = 200;
    }

    /** @deprecated Use _invalidateSortOnly or _invalidateFilterAndSort */
    private invalidateSortCache(): void {
        this._invalidateFilterAndSort();
    }

    loadMore(): void {
        this._visibleCount += 200;
        this._onDidChangeTreeData.fire();
    }

    setFilterDebounced(filter: SessionFilter): void {
        this._filter = filter;
        this._invalidateFilterAndSort();
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

    getTreeItem(element: SessionTreeNode): vscode.TreeItem { return element; }

    // Required by VS Code for treeView.reveal() to work.
    getParent(element: SessionTreeNode): DateGroupTreeItem | ContextGroupTreeItem | FolderGroupTreeItem | vscode.TreeItem | undefined {
        // When grouping is active, SessionTreeItems are nested under a group header.
        if (element instanceof SessionTreeItem) {
            if (this._groupMode === 'date') {
                const bucket = getDateBucket(element.summary.updatedAt);
                const all = this._buildOrderedSummaries();
                const bucketed = this._buildBuckets(all);
                const grp = bucketed.find(b => b.label === bucket);
                if (grp) { return new DateGroupTreeItem(grp.label, grp.items.length); }
            } else if (this._groupMode === 'branch') {
                const session = this.index.get(element.summary.id);
                const key = session?.gitContext?.branch ?? session?.chronicleData?.branch ?? '[no branch recorded]';
                return new ContextGroupTreeItem(key, 0, 'branch');
            } else if (this._groupMode === 'workItem') {
                const session = this.index.get(element.summary.id);
                if (!session) { return undefined; }
                const pattern = vscode.workspace.getConfiguration('chatwizard').get<string>('workItemPattern', '');
                const keys = extractWorkItemsFromSession(session.title, session.messages, pattern || undefined);
                const key = keys.length > 0 ? keys[0] : '(no work item)';
                return new ContextGroupTreeItem(key, 0, 'workItem');
            } else if (this._groupMode === 'tag') {
                const tags = this.index.getSidecarMeta(element.summary.id)?.tags ?? [];
                const key = tags.length > 0 ? tags[0] : '(untagged)';
                return new ContextGroupTreeItem(key, 0, 'tag');
            } else if (this._groupMode === 'folder') {
                // Find the parent folder for this session
                const parent = this._getParentFolderForSession(element.summary.id);
                if (parent) { return parent; }
                // Session not in any folder → parent is the (uncategorized) group
                return this._makeUncategorizedItem(this._buildOrderedSummaries());
            }
        }
        if (element instanceof FolderGroupTreeItem && element.folder.parentId) {
            // Return the parent FolderGroupTreeItem for a subfolder
            return this._getParentFolderGroup(element.folder.parentId);
        }
        return undefined;
    }

    /** Finds the FolderGroupTreeItem that contains a given session. */
    private _getParentFolderForSession(sessionId: string): FolderGroupTreeItem | undefined {
        const folders = this._folderStore?.getCached();
        if (!folders) { return undefined; }
        const all = this._buildOrderedSummaries();
        for (const folder of folders.values()) {
            if (folder.sessionIds.includes(sessionId)) {
                const descendantIds = this._collectDescendantFolderSessionIds(folder.id, folders, new Set());
                const idSet = new Set(descendantIds);
                const relevant = all.filter(s => idSet.has(s.id));
                const stats = this._computeFolderStats(relevant);
                return new FolderGroupTreeItem(folder, stats, this.index, all);
            }
        }
        return undefined;
    }

    /** Builds a FolderGroupTreeItem for a given folder ID. */
    private _getParentFolderGroup(folderId: string): FolderGroupTreeItem | undefined {
        const folders = this._folderStore?.getCached();
        if (!folders) { return undefined; }
        const folder = folders.get(folderId);
        if (!folder) { return undefined; }
        const all = this._buildOrderedSummaries();
        const descendantIds = this._collectDescendantFolderSessionIds(folder.id, folders, new Set());
        const idSet = new Set(descendantIds);
        const relevant = all.filter(s => idSet.has(s.id));
        const stats = this._computeFolderStats(relevant);
        return new FolderGroupTreeItem(folder, stats, this.index, all);
    }

    private _buildOrderedSummaries(): SessionSummary[] {
        if (this._sortedCache !== null) {
            return this._sortedCache;
        }

        // Use cached filtered list when only sort changed (Item 9).
        if (this._filteredCache === null) {
            const all = this.index.getAllSummaries();
            this._filteredCache = this.hasActiveFilter()
                ? all.filter(s => this._matchesFilter(s))
                : all;
        }
        let summaries = this._filteredCache;

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

    /** Groups a sorted list of summaries into date buckets. */
    private _buildBuckets(summaries: SessionSummary[]): { label: string; items: SessionSummary[] }[] {
        const bucketMap = new Map<string, SessionSummary[]>();
        for (const s of summaries) {
            const label = getDateBucket(s.updatedAt);
            let arr = bucketMap.get(label);
            if (!arr) { arr = []; bucketMap.set(label, arr); }
            arr.push(s);
        }
        return Array.from(bucketMap.entries())
            .map(([label, items]) => ({ label, items }))
            .sort((a, b) => dateBucketOrder(a.label) - dateBucketOrder(b.label));
    }

    /** Groups summaries by branch (from gitContext or chronicleData). */
    private _buildBranchGroups(summaries: SessionSummary[]): ContextGroupTreeItem[] {
        const groupMap = new Map<string, number>();
        for (const s of summaries) {
            const session = this.index.get(s.id);
            const key = session?.gitContext?.branch ?? session?.chronicleData?.branch ?? '[no branch recorded]';
            groupMap.set(key, (groupMap.get(key) ?? 0) + 1);
        }
        return Array.from(groupMap.entries())
            .sort((a, b) => {
                // '[no branch recorded]' sorts last
                if (a[0] === '[no branch recorded]') { return 1; }
                if (b[0] === '[no branch recorded]') { return -1; }
                return b[1] - a[1]; // descending by count
            })
            .map(([key, count]) => new ContextGroupTreeItem(key, count, 'branch'));
    }

    /** Groups summaries by extracted work-item IDs. */
    private _buildWorkItemGroups(summaries: SessionSummary[]): ContextGroupTreeItem[] {
        const pattern = vscode.workspace.getConfiguration('chatwizard').get<string>('workItemPattern', '');
        const groupMap = new Map<string, number>();
        for (const s of summaries) {
            const session = this.index.get(s.id);
            if (!session) { continue; }
            const keys = extractWorkItemsFromSession(session.title, session.messages, pattern || undefined);
            if (keys.length === 0) {
                groupMap.set('(no work item)', (groupMap.get('(no work item)') ?? 0) + 1);
            } else {
                for (const key of keys) {
                    groupMap.set(key, (groupMap.get(key) ?? 0) + 1);
                }
            }
        }
        return Array.from(groupMap.entries())
            .sort((a, b) => {
                if (a[0] === '(no work item)') { return 1; }
                if (b[0] === '(no work item)') { return -1; }
                return b[1] - a[1];
            })
            .map(([key, count]) => new ContextGroupTreeItem(key, count, 'workItem'));
    }

    /** Groups summaries by tag. Sessions with multiple tags appear in each tag's group.
     *  Sessions with no tags are grouped under '(untagged)'. */
    private _buildTagGroups(summaries: SessionSummary[]): ContextGroupTreeItem[] {
        const groupMap = new Map<string, number>();
        for (const s of summaries) {
            const tags = this.index.getSidecarMeta(s.id)?.tags;
            if (!tags || tags.length === 0) {
                groupMap.set('(untagged)', (groupMap.get('(untagged)') ?? 0) + 1);
            } else {
                for (const tag of tags) {
                    groupMap.set(tag, (groupMap.get(tag) ?? 0) + 1);
                }
            }
        }
        return Array.from(groupMap.entries())
            .sort((a, b) => {
                if (a[0] === '(untagged)') { return 1; }
                if (b[0] === '(untagged)') { return -1; }
                return a[0].localeCompare(b[0]); // alphabetical
            })
            .map(([key, count]) => new ContextGroupTreeItem(key, count, 'tag'));
    }

    /** Builds folder group tree items. Root-level folders with stats. */
    private _buildFolderGroups(summaries: SessionSummary[]): FolderGroupTreeItem[] {
        if (!this._folderStore) { return []; }
        const folders = this._folderStore.getCached();
        if (!folders) { return []; }

        const rootFolders = Array.from(folders.values())
            .filter(f => f.parentId === null)
            .sort((a, b) => a.name.localeCompare(b.name));

        // Collect session IDs that are already assigned to any folder
        const assignedIds = new Set<string>();
        for (const f of folders.values()) {
            for (const sid of f.sessionIds) {
                assignedIds.add(sid);
            }
        }

        const items = rootFolders.map(f => {
            // Compute stats asynchronously — but for sync rendering use synchronous best-effort
            const descendantIds = this._collectDescendantFolderSessionIds(f.id, folders, new Set());
            const idSet = new Set(descendantIds);
            const relevant = summaries.filter(s => idSet.has(s.id));
            const stats = this._computeFolderStats(relevant);
            return new FolderGroupTreeItem(f, stats, this.index, summaries);
        });

        // Add uncategorized group at the end
        const uncategorized = summaries.filter(s => !assignedIds.has(s.id));
        if (uncategorized.length > 0) {
            items.push(this._makeUncategorizedItem(summaries) as unknown as FolderGroupTreeItem);
        }

        return items;
    }

    /** Creates a TreeItem representing the (uncategorized) group. */
    private _makeUncategorizedItem(summaries: SessionSummary[]): vscode.TreeItem {
        const uncategorized = summaries.filter(s => {
            if (!this._folderStore) { return true; }
            const folders = this._folderStore.getCached();
            if (!folders) { return true; }
            const assignedIds = new Set<string>();
            for (const f of folders.values()) {
                for (const sid of f.sessionIds) {
                    assignedIds.add(sid);
                }
            }
            return !assignedIds.has(s.id);
        });
        const tooltip = new vscode.MarkdownString(
            `**📁 Uncategorized**\n\n${uncategorized.length} session${uncategorized.length === 1 ? '' : 's'} not assigned to any folder.`
        );
        tooltip.isTrusted = true;
        const item = new vscode.TreeItem(
            '(uncategorized)',
            vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = 'folder:__uncategorized__';
        const dateLabel = dateRangeLabel(uncategorized);
        const desc = dateLabel
            ? `${uncategorized.length} session${uncategorized.length === 1 ? '' : 's'} · ${dateLabel}`
            : `${uncategorized.length} session${uncategorized.length === 1 ? '' : 's'}`;
        item.description = desc;
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.contextValue = 'folderUncategorized';
        item.tooltip = tooltip;
        return item;
    }

    /** Recursively collects all descendant session IDs for a folder. Synchronous version. */
    private _collectDescendantFolderSessionIds(
        folderId: string,
        map: Map<string, SessionFolder>,
        visited: Set<string>
    ): string[] {
        if (visited.has(folderId)) { return []; }
        visited.add(folderId);
        const folder = map.get(folderId);
        if (!folder) { return []; }
        const result = [...folder.sessionIds];
        for (const childId of folder.childFolderIds) {
            result.push(...this._collectDescendantFolderSessionIds(childId, map, visited));
        }
        return result;
    }

    /** Formats bytes to a human-readable string. */
    private _formatBytes(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const val = bytes / Math.pow(1024, i);
        return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }

    /** Computes FolderStats (size, sources, models, date range) from a list of summaries. */
    private _computeFolderStats(summaries: SessionSummary[]): FolderStats {
        let totalSizeBytes = 0;
        const sources = new Set<string>();
        const models = new Set<string>();
        let minDate: string | undefined;
        let maxDate: string | undefined;
        for (const s of summaries) {
            if (s.fileSizeBytes !== undefined) { totalSizeBytes += s.fileSizeBytes; }
            sources.add(s.source);
            if (s.model) { models.add(s.model); }
            const d = s.updatedAt.slice(0, 10);
            if (!minDate || d < minDate) { minDate = d; }
            if (!maxDate || d > maxDate) { maxDate = d; }
        }
        return {
            totalChats: summaries.length,
            totalSizeBytes,
            totalSizeFormatted: this._formatBytes(totalSizeBytes),
            sources: Array.from(sources).sort(),
            models: Array.from(models).sort(),
            minDate,
            maxDate,
        };
    }

    /** True if at least one session has branch data (from gitContext or chronicleData). */
    hasBranchData(): boolean {
        for (const s of this.index.getAllSummaries()) {
            const session = this.index.get(s.id);
            if (session?.gitContext?.branch ?? session?.chronicleData?.branch) { return true; }
        }
        return false;
    }

    /** True if at least one session has extractable work-item IDs. */
    hasWorkItems(): boolean {
        const pattern = vscode.workspace.getConfiguration('chatwizard').get<string>('workItemPattern', '');
        for (const s of this.index.getAllSummaries()) {
            const session = this.index.get(s.id);
            if (!session) { continue; }
            if (extractWorkItemsFromSession(session.title, session.messages, pattern || undefined).length > 0) { return true; }
        }
        return false;
    }

    /** True if at least one session has at least one tag. */
    hasTags(): boolean {
        for (const s of this.index.getAllSummaries()) {
            const tags = this.index.getSidecarMeta(s.id)?.tags;
            if (tags && tags.length > 0) { return true; }
        }
        return false;
    }

    /** Returns child items for a folder: subfolder groups + session items. */
    private _getFolderChildren(element: FolderGroupTreeItem): SessionTreeNode[] {
        const all = this._buildOrderedSummaries();
        const pinnedSet = new Set(this._pinnedIds);
        const result: SessionTreeNode[] = [];

        const folders = this._folderStore?.getCached();
        if (!folders) { return []; }

        // Add subfolder items first
        const subfolders = element.folder.childFolderIds
            .map(id => folders.get(id))
            .filter((f): f is SessionFolder => f !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const sub of subfolders) {
            const descendantIds = this._collectDescendantFolderSessionIds(sub.id, folders, new Set());
            const idSet = new Set(descendantIds);
            const relevant = all.filter(s => idSet.has(s.id));
            const stats = this._computeFolderStats(relevant);
            result.push(new FolderGroupTreeItem(sub, stats, this.index, all));
        }

        // Add session items directly in this folder, sorted by date descending
        const sessionIdsInFolder = new Set(element.folder.sessionIds);
        const sessions = all
            .filter(s => sessionIdsInFolder.has(s.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        for (const s of sessions) {
            result.push(new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri,
                this.index.getSidecarMeta(s.id)?.tags,
                this.index.getSidecarMeta(s.id)?.summary,
                this.index.getSidecarMeta(s.id)?.status));
        }

        return result;
    }

    getChildren(element?: SessionTreeNode): SessionTreeNode[] {
        if (this._loading) {
            return [new LoadingTreeItem()];
        }

        // When a DateGroupTreeItem is expanded, return its session children
        // sorted by updatedAt descending (most recent first)
        if (element instanceof DateGroupTreeItem) {
            const all = this._buildOrderedSummaries();
            const pinnedSet = new Set(this._pinnedIds);
            const bucketItems = all
                .filter(s => getDateBucket(s.updatedAt) === element.bucketLabel)
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const pinnedInBucket   = bucketItems.filter(s =>  pinnedSet.has(s.id));
            const unpinnedInBucket = bucketItems.filter(s => !pinnedSet.has(s.id));
            return [...pinnedInBucket, ...unpinnedInBucket]
                .map(s => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri, this.index.getSidecarMeta(s.id)?.tags, this.index.getSidecarMeta(s.id)?.summary, this.index.getSidecarMeta(s.id)?.status));
        }

        // When a ContextGroupTreeItem is expanded, return matching session children
        if (element instanceof ContextGroupTreeItem) {
            const all = this._buildOrderedSummaries();
            const pinnedSet = new Set(this._pinnedIds);
            const pattern = vscode.workspace.getConfiguration('chatwizard').get<string>('workItemPattern', '');
            const matched = all.filter(s => {
                if (element.groupMode === 'branch') {
                    const session = this.index.get(s.id);
                    if (!session) { return false; }
                    const branch = session.chronicleData?.branch ?? '[no branch recorded]';
                    return branch === element.groupKey;
                } else if (element.groupMode === 'tag') {
                    const tags = this.index.getSidecarMeta(s.id)?.tags ?? [];
                    return tags.length === 0
                        ? element.groupKey === '(untagged)'
                        : tags.includes(element.groupKey);
                } else {
                    const session = this.index.get(s.id);
                    if (!session) { return false; }
                    const keys = extractWorkItemsFromSession(session.title, session.messages, pattern || undefined);
                    return keys.length === 0
                        ? element.groupKey === '(no work item)'
                        : keys.includes(element.groupKey);
                }
            });
            return matched.map(s => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri, this.index.getSidecarMeta(s.id)?.tags, this.index.getSidecarMeta(s.id)?.summary, this.index.getSidecarMeta(s.id)?.status));
        }

        // When a FolderGroupTreeItem is expanded, return subfolder items + session children
        if (element instanceof FolderGroupTreeItem) {
            return this._getFolderChildren(element);
        }

        // When the (uncategorized) group is expanded, return unassigned sessions
        if (element instanceof vscode.TreeItem && element.id === 'folder:__uncategorized__') {
            const all = this._buildOrderedSummaries();
            const pinnedSet = new Set(this._pinnedIds);
            const folders = this._folderStore?.getCached();
            if (!folders) { return []; }
            const assignedIds = new Set<string>();
            for (const f of folders.values()) {
                for (const sid of f.sessionIds) {
                    assignedIds.add(sid);
                }
            }
            const uncategorized = all
                .filter(s => !assignedIds.has(s.id))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return uncategorized.map(s => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri,
                this.index.getSidecarMeta(s.id)?.tags,
                this.index.getSidecarMeta(s.id)?.summary,
                this.index.getSidecarMeta(s.id)?.status));
        }

        if (element) { return []; }

        const pinnedSet = new Set(this._pinnedIds);
        const all = this._buildOrderedSummaries();

        // Grouped view
        if (this._groupMode === 'date') {
            const buckets = this._buildBuckets(all);
            return buckets.map(b => new DateGroupTreeItem(b.label, b.items.length));
        }
        if (this._groupMode === 'branch') {
            return this._buildBranchGroups(all);
        }
        if (this._groupMode === 'workItem') {
            return this._buildWorkItemGroups(all);
        }
        if (this._groupMode === 'tag') {
            return this._buildTagGroups(all);
        }
        if (this._groupMode === 'folder') {
            return this._buildFolderGroups(all);
        }

        // Flat view (original behaviour with pagination)
        const visible = all.slice(0, this._visibleCount);
        const items: SessionTreeNode[] = visible.map(s => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri, this.index.getSidecarMeta(s.id)?.tags, this.index.getSidecarMeta(s.id)?.summary, this.index.getSidecarMeta(s.id)?.status));
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

    /** Returns true when any non-flat grouping is active. */
    isGrouped(): boolean {
        return this._groupMode !== 'none';
    }
}
