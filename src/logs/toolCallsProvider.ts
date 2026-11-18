import * as vscode from 'vscode';
import { LogService } from './logService';
import { ToolCallEvent } from './types';
import { LogViewFilters, emptyLogFilters, hasActiveFilters, matchesLogFilters } from './logFilters';
import {
    ExecSessionTitleResolver,
    resolveGroupTitle,
} from './executedCommandsProvider';
import { formatEventTime } from './unifiedTimelineProvider';
import {
    describeToolCall,
    toolCallInputText,
    toolCallLabel,
} from './logEventSummary';
import { createLogger } from '../utils/logger';

/**
 * src/logs/toolCallsProvider.ts
 *
 * UX pass — "LLM Tool Calls" section of the Commands view.
 *
 * The "Terminal Commands" section only lists `command` events (shell / git /
 * build / test invocations). Everything else an agent *did* through a
 * structured tool — reading a file, searching the codebase, applying a patch,
 * asking a question — is normalized as a `ToolCallEvent` and used to be
 * visible only inside the Unified Timeline, which made the Commands view look
 * empty for tool-heavy agents (GitHub Copilot's agent host emits almost
 * nothing else).
 *
 * This section lists those tool calls, grouped per chat session and newest
 * first, using the same shared filters (search / agent / failures-only) and
 * workspace scope as the other sections.
 *
 * Rows are self-describing: the label is `toolName [identifying argument]`
 * (`view [src/extension.ts]`, `powershell [npm test]`), the tooltip carries
 * the plain-English description and the arguments, and clicking a row opens
 * the shared detail webview with the Description + Input/Output sections.
 */

const logWatch = createLogger().withContext('WatchLogs');

/** Hard cap on rows pulled out of the store for one render. */
export const MAX_TOOL_CALLS_PER_QUERY = 2000;

// ---------------------------------------------------------------------------
// Display helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Outcome badge shown in the tree description (empty when unknown). */
export function formatToolCallBadge(event: ToolCallEvent): string {
    if (event.success === false) { return '✗ failed'; }
    if (event.success === true) { return '✓ ok'; }
    return '';
}

/** Secondary description: outcome badge + timestamp. */
export function toolCallDescription(event: ToolCallEvent): string {
    const time = formatEventTime(event.timestamp);
    return [formatToolCallBadge(event), time].filter((part) => part.length > 0).join(' · ');
}

/**
 * Codicon shared by the "LLM Tool Calls" session rows and its leaf rows.
 *
 * The section owns `tools` exactly like Terminal Commands owns `terminal`, the
 * Unified Timeline owns `history` and the Diff Explorer owns `file-code`, so a
 * row is attributable to its sub view at a glance.
 */
export const TOOL_CALLS_ICON = 'tools';

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

/**
 * A session header. Children are the session's `ToolCallLeafItem`s.
 *
 * Starts **collapsed**, like every group in the Commands view, so expanding
 * the section lists one row per session instead of spilling every tool call
 * of every session into the sidebar.
 */
export class ToolCallsGroupItem extends vscode.TreeItem {
    readonly sessionId: string;
    readonly events: ToolCallEvent[];

    constructor(
        sessionId: string,
        title: string,
        events: ToolCallEvent[],
        workspacePath?: string
    ) {
        const count = events.length;
        super(title, count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.sessionId = sessionId;
        this.events = events;
        this.description = workspacePath && workspacePath.length > 0
            ? `${count} tool call${count === 1 ? '' : 's'} · ${workspacePath}`
            : `${count} tool call${count === 1 ? '' : 's'}`;
        // The label is the chat title; keep the full session id discoverable.
        this.tooltip = [title, `Session: ${sessionId}`, workspacePath ?? '']
            .filter((line) => line && line.length > 0)
            .join('\n');
        this.contextValue = 'toolCallsGroup';
        this.iconPath = new vscode.ThemeIcon(TOOL_CALLS_ICON);
    }
}

/** A single tool-call row: `toolName [file / command / query]`. */
export class ToolCallLeafItem extends vscode.TreeItem {
    readonly event: ToolCallEvent;

    constructor(event: ToolCallEvent) {
        super(toolCallLabel(event), vscode.TreeItemCollapsibleState.None);
        this.event = event;
        this.description = toolCallDescription(event);
        // Full description + arguments + raw payload — everything the row is
        // about, without opening the detail webview.
        this.tooltip = [
            describeToolCall(event),
            toolCallInputText(event) ?? '',
            event.raw ?? '',
        ].filter((part) => part.length > 0).join('\n\n');
        this.contextValue = 'toolCall';
        // Double-click / Enter opens a webview with the full call contents.
        this.command = {
            command: 'chatwizard.logs.toolCalls.showDetails',
            title: 'Show Tool Call Details',
        };
        this.iconPath = new vscode.ThemeIcon(
            TOOL_CALLS_ICON,
            event.success === false ? new vscode.ThemeColor('problemsErrorIcon.foreground') : undefined
        );
    }
}

export type ToolCallsTreeNode = ToolCallsGroupItem | ToolCallLeafItem;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ToolCallsProvider implements vscode.TreeDataProvider<ToolCallsTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ToolCallsTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _groups: ToolCallsGroupItem[] = [];
    private _filters: LogViewFilters = emptyLogFilters();
    /**
     * An empty result set is a valid, cacheable state: without this flag every
     * `getChildren()` on a filtered-to-nothing section would re-run the query.
     */
    private _built = false;

    constructor(
        private readonly logService: LogService,
        private readonly resolveSessionTitle?: ExecSessionTitleResolver
    ) { }

    /**
     * Replace the active filters and rebuild. `types` is ignored here — this
     * section only ever renders `toolCall` events.
     */
    setFilters(filters: LogViewFilters): void {
        this._filters = {
            search: filters.search,
            tool: filters.tool,
            failuresOnly: filters.failuresOnly,
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

    /** True when a search / agent / failures filter is narrowing this section. */
    filtersActive(): boolean {
        return hasActiveFilters(this._filters);
    }

    /** Re-query the store and rebuild the tree. */
    refresh(): void {
        this._groups = this._buildGroups();
        this._built = true;
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: ToolCallsTreeNode): ToolCallsTreeNode[] {
        if (!element) {
            if (!this._built) { this.refresh(); }
            return this._groups;
        }
        if (element instanceof ToolCallsGroupItem) {
            return element.events.map((event) => new ToolCallLeafItem(event));
        }
        return [];
    }

    getTreeItem(element: ToolCallsTreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: ToolCallsTreeNode): ToolCallsGroupItem | undefined {
        if (element instanceof ToolCallLeafItem) {
            return this._groups.find((g) => g.sessionId === element.event.sessionId);
        }
        return undefined;
    }

    /** All groups currently rendered (useful for tests + stats). */
    getGroups(): ToolCallsGroupItem[] {
        // Lazily build on first read: VS Code normally calls getChildren(),
        // but tests (and any caller inspecting the tree before it rendered)
        // must see the store contents rather than a permanently empty list.
        if (!this._built) {
            this._groups = this._buildGroups();
            this._built = true;
        }
        return this._groups;
    }

    private _buildGroups(): ToolCallsGroupItem[] {
        let events: ToolCallEvent[];
        try {
            events = this.logService.getEvents({
                type: 'toolCall',
                tool: this._filters.tool,
                order: 'desc',
                limit: MAX_TOOL_CALLS_PER_QUERY,
            }) as ToolCallEvent[];
        } catch (err) {
            // A broken/degraded store must never break tree rendering.
            logWatch.warn('tool calls query failed: %s', err);
            return [];
        }

        const bySession = new Map<string, ToolCallEvent[]>();
        for (const event of events) {
            // Search + failures-only are applied here (the store handles the
            // type/tool facets); both share the predicates with the timeline.
            if (!matchesLogFilters(event, {
                search: this._filters.search,
                failuresOnly: this._filters.failuresOnly,
                workspacePaths: this._filters.workspacePaths,
            })) {
                continue;
            }
            const key = event.sessionId ?? '(no session)';
            const bucket = bySession.get(key);
            if (bucket) {
                bucket.push(event);
            } else {
                bySession.set(key, [event]);
            }
        }

        const groups: ToolCallsGroupItem[] = [];
        for (const [sessionId, calls] of bySession) {
            calls.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
            const workspacePath = calls.find((c) => c.workspacePath)?.workspacePath;
            const title = resolveGroupTitle(sessionId, this.resolveSessionTitle, calls);
            groups.push(new ToolCallsGroupItem(sessionId, title, calls, workspacePath));
        }

        // Newest call first across groups.
        groups.sort((a, b) => {
            const aLast = a.events[0]?.timestamp ?? '';
            const bLast = b.events[0]?.timestamp ?? '';
            return bLast.localeCompare(aLast);
        });

        return groups;
    }
}

