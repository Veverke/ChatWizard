import * as vscode from 'vscode';
import * as path from 'path';
import { SessionIndex } from '../index/sessionIndex';
import { SessionSummary } from '../types/index';

export class SessionTreeItem extends vscode.TreeItem {
    readonly summary: SessionSummary;
    readonly pinned: boolean;

    constructor(summary: SessionSummary, pinned = false) {
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

        const sourceName = summary.source === 'copilot' ? 'GitHub Copilot' : 'Claude Code';
        const modelLine = summary.model ? `\n\n**Model:** ${summary.model}` : '';
        const sizeLine = sizeKb ? `\n\n**Size:** ${msgCount} messages · ${sizeKb}` : `\n\n**Size:** ${msgCount} messages`;
        const pinnedLine = pinned ? `\n\n📌 *Pinned*` : '';

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
                pinnedLine
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
                pinnedLine
            );
        }
        this.tooltip = tooltip;

        this.iconPath = pinned
            ? new vscode.ThemeIcon('pinned')
            : (summary.source === 'copilot'
                ? new vscode.ThemeIcon('github')
                : new vscode.ThemeIcon('hubot'));

        this.contextValue = pinned ? 'session.pinned' : 'session';

        this.command = {
            command: 'chatwizard.openSession',
            title: 'Open Session',
            arguments: [summary],
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
    source: 'Source (Copilot / Claude)',
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
    minMessages?: number;
    maxMessages?: number;
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
// Provider
// ---------------------------------------------------------------------------

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sortStack: SortStack = [{ key: 'date', direction: 'desc' }];
    private _filter: SessionFilter = {};
    /** Ordered list of pinned session IDs (first = top of list) */
    private _pinnedIds: string[] = [];
    /** Full display order set by drag-and-drop; empty means use sort stack */
    private _manualOrder: string[] = [];

    constructor(private readonly index: SessionIndex) {
        index.addChangeListener(() => this.refresh());
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
    }

    // ------------------------------------------------------------------
    // Sort stack
    // ------------------------------------------------------------------

    restoreStack(stack: SortStack): void {
        if (stack.length > 0) { this.sortStack = stack; }
    }

    setSortStack(stack: SortStack): void {
        if (stack.length > 0) { this.sortStack = stack; this._manualOrder = []; }
    }

    getSortStack(): SortStack {
        return this.sortStack.map(c => ({ ...c }));
    }

    setSortMode(mode: SortMode): void {
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

    setFilter(filter: SessionFilter): void { this._filter = filter; }
    clearFilter(): void { this._filter = {}; }
    getFilter(): SessionFilter { return { ...this._filter }; }

    hasActiveFilter(): boolean {
        const f = this._filter;
        return !!(f.title || f.dateFrom || f.dateTo || f.model ||
                  f.minMessages !== undefined || f.maxMessages !== undefined);
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
        if (f.minMessages !== undefined && s.messageCount < f.minMessages) { return false; }
        if (f.maxMessages !== undefined && s.messageCount > f.maxMessages) { return false; }
        return true;
    }

    private _filterDescription(): string {
        const f = this._filter;
        const parts: string[] = [];
        if (f.title) { parts.push(`title:"${f.title}"`); }
        if (f.dateFrom || f.dateTo) { parts.push(`date:${f.dateFrom ?? '*'}→${f.dateTo ?? '*'}`); }
        if (f.model) { parts.push(`model:"${f.model}"`); }
        if (f.minMessages !== undefined || f.maxMessages !== undefined) {
            parts.push(`msgs:${f.minMessages ?? 0}–${f.maxMessages ?? '∞'}`);
        }
        return parts.length > 0 ? `⊘ ${parts.join(' · ')}` : '';
    }

    // ------------------------------------------------------------------
    // Description (shown in TreeView subtitle)
    // ------------------------------------------------------------------

    getDescription(): string {
        const sortPart = this.sortStack
            .map(c => `${SHORT_LABEL[c.key]} ${c.direction === 'asc' ? '↑' : '↓'}`)
            .join(' · ');
        const filterPart = this._filterDescription();
        return filterPart ? `${sortPart}  ·  ${filterPart}` : sortPart;
    }

    // ------------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------------

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem { return element; }

    private _buildOrderedSummaries(): SessionSummary[] {
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
            return [...ordered, ...extras];
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

        return [...pinned, ...unpinned];
    }

    getChildren(): SessionTreeItem[] {
        const pinnedSet = new Set(this._pinnedIds);
        return this._buildOrderedSummaries().map(s => new SessionTreeItem(s, pinnedSet.has(s.id)));
    }
}
