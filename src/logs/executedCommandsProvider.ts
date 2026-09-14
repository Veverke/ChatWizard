import * as vscode from 'vscode';
import { LogService } from './logService';
import { CommandEvent } from './types';

/**
 * src/logs/executedCommandsProvider.ts
 *
 * Phase 2 — "Executed Commands" panel.
 *
 * The first user-facing surface from `docs/work-plan-watch-logs.md` Phase 2:
 * a searchable list of every shell / git / build / test command agents ran,
 * even when the model never mentioned the command in chat text.
 *
 * The panel is intentionally tool-agnostic — it renders whatever `CommandEvent`s
 * the watch-logs store holds (today fed by the Copilot adapter; Cursor/Cline/
 * Windsurf adapters land in Phase 3). Commands are grouped per session, newest
 * first, and each row exposes copy + open-session actions.
 */

/** Hard cap on rows pulled out of the store for one render. */
export const MAX_COMMANDS_PER_QUERY = 2000;

/** Resolve a human-readable session title for an id, when available. */
export type ExecSessionTitleResolver = (sessionId: string) => string | undefined;

// ---------------------------------------------------------------------------
// Display helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/** First non-empty line of a command, trimmed to a reasonable width. */
export function firstLineOf(commandText: string, max = 80): string {
    const line = commandText.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    if (line.length <= max) { return line; }
    return `${line.slice(0, max - 1)}…`;
}

/** Exit-status badge shown in the tree description. */
export function formatExitBadge(exitCode: number | undefined): string {
    if (exitCode === undefined) { return 'exit ?'; }
    return exitCode === 0 ? '✓ exit 0' : `✗ exit ${exitCode}`;
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

/** A session header node. Children are the session's `ExecCommandsLeafItem`s. */
export class ExecCommandsGroupItem extends vscode.TreeItem {
    readonly sessionId: string;
    readonly commands: CommandEvent[];

    constructor(
        sessionId: string,
        title: string,
        commands: CommandEvent[],
        workspacePath?: string
    ) {
        const count = commands.length;
        super(title, commands.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.sessionId = sessionId;
        this.commands = commands;
        this.description = workspacePath && workspacePath.length > 0
            ? `${count} command${count === 1 ? '' : 's'} · ${workspacePath}`
            : `${count} command${count === 1 ? '' : 's'}`;
        this.contextValue = 'execCommandsGroup';
        this.iconPath = new vscode.ThemeIcon('history');
    }
}

/** A single executed command row. */
export class ExecCommandsLeafItem extends vscode.TreeItem {
    readonly event: CommandEvent;

    constructor(event: CommandEvent) {
        super(firstLineOf(event.commandText), vscode.TreeItemCollapsibleState.None);
        this.event = event;
        this.description = formatExitBadge(event.exitCode);
        this.tooltip = event.commandText;
        this.contextValue = 'execCommand';
        const exit = event.exitCode;
        this.iconPath = new vscode.ThemeIcon(
            exit === undefined ? 'run'
            : exit === 0 ? 'terminal'
            : 'error'
        );
    }
}

export type ExecCommandsTreeNode = ExecCommandsGroupItem | ExecCommandsLeafItem;
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ExecutedCommandsProvider implements vscode.TreeDataProvider<ExecCommandsTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExecCommandsTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _groups: ExecCommandsGroupItem[] = [];

    constructor(
        private readonly logService: LogService,
        private readonly resolveSessionTitle?: ExecSessionTitleResolver
    ) { }

    /** Re-query the store and rebuild the tree. */
    refresh(): void {
        this._groups = this._buildGroups();
        this._onDidChangeTreeData.fire();
    }

    getChildren(element?: ExecCommandsTreeNode): ExecCommandsTreeNode[] {
        if (!element) {
            if (this._groups.length === 0) { this.refresh(); }
            return this._groups;
        }
        if (element instanceof ExecCommandsGroupItem) {
            return element.commands.map((c) => new ExecCommandsLeafItem(c));
        }
        return [];
    }

    getTreeItem(element: ExecCommandsTreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: ExecCommandsTreeNode): ExecCommandsGroupItem | undefined {
        if (element instanceof ExecCommandsLeafItem) {
            return this._groups.find((g) => g.sessionId === element.event.sessionId);
        }
        return undefined;
    }

    /** All groups currently rendered (useful for tests + stats). */
    getGroups(): ExecCommandsGroupItem[] {
        return this._groups;
    }

    private _buildGroups(): ExecCommandsGroupItem[] {
        const events = this.logService.getEvents({
            type: 'command',
            order: 'desc',
            limit: MAX_COMMANDS_PER_QUERY,
        });

        const bySession = new Map<string, CommandEvent[]>();
        for (const event of events) {
            // The store narrows the event to its concrete type; cast defensively
            // here since the public LogEvent union keeps `commandText` optional.
            const command = event as CommandEvent;
            const key = command.sessionId ?? '(no session)';
            const bucket = bySession.get(key);
            if (bucket) {
                bucket.push(command);
            } else {
                bySession.set(key, [command]);
            }
        }

        const groups: ExecCommandsGroupItem[] = [];
        for (const [sessionId, commands] of bySession) {
            commands.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
            const workspacePath = commands.find((c) => c.workspacePath)?.workspacePath;
            const customTitle = this.resolveSessionTitle?.(sessionId);
            const title = customTitle && customTitle.trim().length > 0
                ? customTitle.trim()
                : `Session ${sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId}`;
            groups.push(new ExecCommandsGroupItem(sessionId, title, commands, workspacePath));
        }

        // Newest command first across groups.
        groups.sort((a, b) => {
            const aLast = a.commands[0]?.timestamp ?? '';
            const bLast = b.commands[0]?.timestamp ?? '';
            return bLast.localeCompare(aLast);
        });

        return groups;
    }
}