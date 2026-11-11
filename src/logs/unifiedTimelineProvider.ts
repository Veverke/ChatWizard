import * as vscode from 'vscode';
import { LogService } from './logService';
import { firstLineOf } from './executedCommandsProvider';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    LogEventType,
    PlannerStepEvent,
    ToolCallEvent,
    logEventTypeLabel,
} from './types';

/**
 * src/logs/unifiedTimelineProvider.ts
 *
 * Phase 3 — "Unified Timeline" panel.
 *
 * The cross-agent, cross-kind view of every normalized agent-execution event
 * the watch-logs store holds: executed commands, file operations, diffs, tool
 * calls, errors and planner steps — regardless of which AI coding tool produced
 * them (feeds today entirely from the GitHub Copilot adapter). Events are
 * grouped per session and sorted newest-first; an optional type filter narrows
 * the view to the kinds the user cares about.
 *
 * Rows expose useful actions via `contextValue`:
 *   - `logsEvent.command` → copy command / open session
 *   - `logsEvent.diff`     → open the patch in the Diff Explorer viewer
 *   - `logsEvent.fileOperation` → reveal the affected file when it exists
 */

/** Hard cap on rows pulled out of the store for one render. */
export const MAX_TIMELINE_EVENTS = 5000;

// ---------------------------------------------------------------------------
// Display helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

export function formatEventTime(timestamp: string | undefined): string {
    if (!timestamp) { return ''; }
    const ms = Date.parse(timestamp);
    if (isNaN(ms)) { return ''; }
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/** Primary (bold) label for a single timeline row. */
export function eventPrimaryLabel(event: LogEvent): string {
    switch (event.type) {
        case 'command': return firstLineOf((event as CommandEvent).commandText, 100);
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            return `${op.operationType} ${op.filePath}`;
        }
        case 'diff': return (event as DiffEvent).filePath;
        case 'toolCall': return (event as ToolCallEvent).toolName;
        case 'error': return firstLineOf((event as ErrorEvent).message, 100);
        case 'plannerStep': return firstLineOf((event as PlannerStepEvent).description, 100);
    }
}

/** Short secondary description shown right of the label. */
export function eventDescription(event: LogEvent): string {
    const time = formatEventTime(event.timestamp);
    const timePart = time ? ` · ${time}` : '';
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            const exit = c.exitCode === undefined ? 'exit ?' : c.exitCode === 0 ? 'exit 0' : `exit ${c.exitCode}`;
            return `${logEventTypeLabel('command')} · ${exit}${timePart}`;
        }
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            const extra = op.detail ? ` · ${op.detail}` : '';
            return `${logEventTypeLabel('fileOperation')} · ${op.operationType}${extra}${timePart}`;
        }
        case 'diff': {
            const d = event as DiffEvent;
            const stats = (d.addedLines !== undefined || d.removedLines !== undefined)
                ? ` · +${d.addedLines ?? 0} −${d.removedLines ?? 0}` : '';
            return `${logEventTypeLabel('diff')}${stats}${timePart}`;
        }
        case 'toolCall': return `${logEventTypeLabel('toolCall')}${timePart}`;
        case 'error': {
            const e = event as ErrorEvent;
            const sev = e.severity ? ` · ${e.severity}` : '';
            return `${logEventTypeLabel('error')}${sev}${timePart}`;
        }
        case 'plannerStep': return `${logEventTypeLabel('plannerStep')}${timePart}`;
    }
}
/** VS Code codicon for a timeline row (drives the visual hierarchy). */
export function eventIconId(event: LogEvent): string {
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            return c.exitCode === undefined ? 'run'
                : c.exitCode === 0 ? 'terminal'
                : 'error';
        }
        case 'fileOperation': return 'file';
        case 'diff': return 'diff';
        case 'toolCall': return 'tools';
        case 'error': return ((event as ErrorEvent).severity === 'warning') ? 'warning' : 'error';
        case 'plannerStep': return 'list-unordered';
    }
}

/** Full tooltip text (everything we know about the event). */
export function eventTooltip(event: LogEvent): string {
    const base = event.raw && event.raw.length > 0 ? event.raw : '';
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            return [c.commandText, c.cwd ? `cwd: ${c.cwd}` : '', base].filter(Boolean).join('\n');
        }
        case 'diff': return (event as DiffEvent).diffText;
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            return [op.filePath, op.oldPath ? `from: ${op.oldPath}` : '', op.detail ?? '', base].filter(Boolean).join('\n');
        }
        case 'toolCall': {
            const t = event as ToolCallEvent;
            return [t.toolName, t.arguments ? JSON.stringify(t.arguments, null, 2) : '', base].filter(Boolean).join('\n');
        }
        case 'error': {
            const e = event as ErrorEvent;
            return [e.message, e.stackTrace ?? '', base].filter(Boolean).join('\n');
        }
        case 'plannerStep': {
            const p = event as PlannerStepEvent;
            return [p.description, p.status ?? '', base].filter(Boolean).join('\n');
        }
    }
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

export type UnifiedTimelineTreeNode = TimelineGroupItem | TimelineEventItem;

/** A session header. */
export class TimelineGroupItem extends vscode.TreeItem {
    readonly sessionKey: string;
    readonly events: LogEvent[];

    constructor(
        sessionKey: string,
        title: string,
        events: LogEvent[],
        workspacePath?: string
    ) {
        const count = events.length;
        super(title, count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.sessionKey = sessionKey;
        this.events = events;
        this.description = workspacePath && workspacePath.length > 0
            ? `${count} event${count === 1 ? '' : 's'} · ${workspacePath}`
            : `${count} event${count === 1 ? '' : 's'}`;
        this.contextValue = 'logsTimelineGroup';
        this.iconPath = new vscode.ThemeIcon('history');
    }
}

/** A single normalized agent log event row. */
export class TimelineEventItem extends vscode.TreeItem {
    readonly event: LogEvent;

    constructor(event: LogEvent) {
        const exitCode = event.type === 'command' ? (event as CommandEvent).exitCode : undefined;
        super(eventPrimaryLabel(event), vscode.TreeItemCollapsibleState.None);
        this.event = event;
        this.description = eventDescription(event);
        this.tooltip = eventTooltip(event);
        this.contextValue = `logsEvent.${event.type}`;
        // Double-click / Enter opens a webview with the full event contents.
        this.command = {
            command: 'chatwizard.logs.timeline.showDetails',
            title: 'Show Event Details',
        };
        this.iconPath = new vscode.ThemeIcon(eventIconId(event), exitCode !== undefined && exitCode !== 0
            ? new vscode.ThemeColor('problemsErrorIcon.foreground')
            : undefined);
    }
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class UnifiedTimelineProvider implements vscode.TreeDataProvider<UnifiedTimelineTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<UnifiedTimelineTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _groups: TimelineGroupItem[] = [];
    private _filter: LogEventType[] | undefined;

    constructor(
        private readonly logService: LogService,
        private readonly resolveSessionTitle?: (sessionId: string) => string | undefined
    ) { }

    /** Restrict the view to the given event kinds (undefined = all). */
    setFilter(types: LogEventType[] | undefined): void {
        this._filter = types;
        this.refresh();
    }

    getFilter(): LogEventType[] | undefined {
        return this._filter;
    }

    /** Re-query the store and rebuild the tree. */
    refresh(): void {
        this._groups = this._buildGroups();
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: UnifiedTimelineTreeNode): UnifiedTimelineTreeNode[] {
        if (!element) {
            if (this._groups.length === 0) { this.refresh(); }
            return this._groups;
        }
        if (element instanceof TimelineGroupItem) {
            return element.events.map((e) => new TimelineEventItem(e));
        }
        return [];
    }

    getTreeItem(element: UnifiedTimelineTreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: UnifiedTimelineTreeNode): TimelineGroupItem | undefined {
        if (element instanceof TimelineEventItem) {
            return this._groups.find((g) => g.sessionKey === groupKeyOf(element.event));
        }
        return undefined;
    }

    /** All groups currently rendered (useful for tests + stats). */
    getGroups(): TimelineGroupItem[] {
        // Lazily build on first read so callers that inspect the tree before
        // VS Code renders it still see the store contents.
        if (this._groups.length === 0) {
            this._groups = this._buildGroups();
        }
        return this._groups;
    }

    private _buildGroups(): TimelineGroupItem[] {
        const events = this.logService.getEvents({
            types: this._filter,
            order: 'desc',
            limit: MAX_TIMELINE_EVENTS,
        });

        const bySession = new Map<string, LogEvent[]>();
        for (const event of events) {
            const key = groupKeyOf(event);
            const bucket = bySession.get(key);
            if (bucket) {
                bucket.push(event);
            } else {
                bySession.set(key, [event]);
            }
        }

        const groups: TimelineGroupItem[] = [];
        for (const [key, sessionEvents] of bySession) {
            sessionEvents.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
            const workspacePath = sessionEvents.find((e) => e.workspacePath && e.workspacePath.length > 0)?.workspacePath;
            const sessionId = sessionEvents.find((e) => e.sessionId)?.sessionId;
            const customTitle = sessionId !== undefined ? this.resolveSessionTitle?.(sessionId) : undefined;
            const title = sessionKeyTitle(key, customTitle);
            groups.push(new TimelineGroupItem(key, title, sessionEvents, workspacePath));
        }

        // Newest event first across groups.
        groups.sort((a, b) => {
            const aLast = a.events[0]?.timestamp ?? '';
            const bLast = b.events[0]?.timestamp ?? '';
            return bLast.localeCompare(aLast);
        });

        return groups;
    }
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

function groupKeyOf(event: LogEvent): string {
    return event.sessionId ?? `tool:${event.tool}`;
}

function sessionKeyTitle(key: string, customTitle: string | undefined): string {
    if (customTitle && customTitle.trim().length > 0) { return customTitle.trim(); }
    if (key.startsWith('tool:')) {
        return `${key.slice(5)} (unsessioned)`;
    }
    return `Session ${key.length > 12 ? key.slice(0, 12) : key}`;
}