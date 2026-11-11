/**
 * src/logs/logsCommands.ts
 *
 * Phase 2/3 — Commands for the watch-logs **Commands** view.
 *
 * The three former panels ("Executed Commands", "Unified Timeline", "Diff
 * Explorer") are sections of one contributed tree view
 * (`chatwizardCommands`, see `commandsViewProvider.ts`). All commands are
 * registered through the extension `context` so they follow the same disposal
 * pattern as every other ChatWizard command.
 *
 * The three "Show …" commands now focus that single view and reveal the
 * requested section, so they no longer need a view of their own.
 *
 * Phase 4 adds the view-wide filters (free-text search, agent, failures-only),
 * the single **Filter Agent Logs** menu that fronts them, and the per-agent
 * statistics report (`Chat Wizard: Show Agent Log Stats`).
 */

import * as vscode from 'vscode';
import { ExecutedCommandsProvider, ExecCommandsLeafItem } from './executedCommandsProvider';
import {
    UnifiedTimelineProvider,
    TimelineEventItem,
    MAX_TIMELINE_EVENTS,
} from './unifiedTimelineProvider';
import { DiffExplorerProvider, DiffEventLeafItem, renderPatchMarkdown } from './diffExplorerProvider';
import { openVisualDiff } from './diffViewer';
import { showEventWebview } from './logEventWebview';
import { runCommandInTerminal } from './runInTerminal';
import {
    CommandsSubViewId,
    CommandsTreeNode,
    CommandsViewProvider,
    eventOfCommandsNode,
} from './commandsViewProvider';
import { LogEventType, LOG_EVENT_TYPES, LogEvent, CommandEvent, LogSourceTool, logEventTypeLabel, getEventFilePath } from './types';
import {
    LogViewFilters,
    emptyLogFilters,
    hasActiveFilters,
    normalizeSearchQuery,
} from './logFilters';
import { computeLogStats, renderLogStatsMarkdown } from './logStats';
import { LogService } from './logService';
import { friendlySourceName } from '../ui/sourceUi';
import { createLogger } from '../utils/logger';

/** Shared diagnostics for the watch-logs panels (same "Chat Wizard" channel). */
const logWatch = createLogger().withContext('WatchLogs');

export interface LogCommandsContext {
    subscriptions: { push(item: { dispose(): void }): void };
}

/** The single watch-logs tree view (used to resolve "Show Details" from buttons). */
export interface LogTreeViews {
    commands?: vscode.TreeView<CommandsTreeNode>;
}

/** Quick-pick rows for the timeline kind filter. */
const TIMELINE_FILTER_PICKS = [
    { label: 'All event kinds', description: 'no filter', value: undefined },
    ...LOG_EVENT_TYPES.map((t) => ({
        label: logEventTypeLabel(t),
        description: `only ${t} events`,
        value: t as LogEventType,
    })),
];

export function registerLogCommands(
    context: LogCommandsContext,
    provider: ExecutedCommandsProvider,
    timelineProvider?: UnifiedTimelineProvider,
    diffExplorerProvider?: DiffExplorerProvider,
    commandsViewProvider?: CommandsViewProvider,
    treeViews?: LogTreeViews,
    logService?: LogService
): void {
    const push = (command: string, handler: (...args: any[]) => unknown): void => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    /** The node currently selected in the Commands view, if any. */
    const selectedNode = (): unknown => (treeViews?.commands?.selection ?? [])[0];

    // ── Shared view filters (Phase 4: search / agent / failures) ───────────
    // One filter set drives the three sections, so a search in Commands also
    // narrows the timeline and the diff explorer.

    /** Read the filters currently applied to the whole view. */
    const readFilters = (): LogViewFilters => {
        if (commandsViewProvider) { return commandsViewProvider.getFilters(); }
        const timeline = timelineProvider?.getFilters();
        const commands = provider.getFilters();
        return {
            search: timeline?.search ?? commands.search,
            tool: timeline?.tool ?? commands.tool,
            failuresOnly: timeline?.failuresOnly ?? commands.failuresOnly,
            types: timeline?.types,
        };
    };

    /** Apply filters everywhere, keeping the description counts in sync. */
    const writeFilters = (filters: LogViewFilters): void => {
        if (commandsViewProvider) {
            commandsViewProvider.setFilters(filters);
            return;
        }
        provider.setFilters(filters);
        timelineProvider?.setFilters(filters);
        diffExplorerProvider?.setFilters(filters);
    };

    /** Short confirmation message describing the resulting filter state. */
    const announceFilters = (filters: LogViewFilters): void => {
        if (!hasActiveFilters(filters)) {
            vscode.window.showInformationMessage('Agent log filters cleared — showing everything.');
            return;
        }
        const parts: string[] = [];
        const search = normalizeSearchQuery(filters.search);
        if (search) { parts.push(`text “${search}”`); }
        if (filters.tool) { parts.push(`agent ${friendlySourceName(filters.tool)}`); }
        if (filters.failuresOnly) { parts.push('failures only'); }
        if (filters.types && filters.types.length > 0) {
            parts.push(`kind ${filters.types.map((t) => logEventTypeLabel(t)).join(', ')}`);
        }
        vscode.window.showInformationMessage(`Agent logs filtered by ${parts.join(' · ')}.`);
    };

    /**
     * Focus the single Commands view and reveal one of its sections — this is
     * what the three "Show …" commands (and their palette entries) do now.
     */
    const showSection = (subView: CommandsSubViewId): void => {
        void (async () => {
            try {
                await vscode.commands.executeCommand(`${CommandsViewProvider.viewType}.focus`);
                const view = treeViews?.commands;
                const section = commandsViewProvider?.section(subView);
                if (view && section) {
                    await view.reveal(section, { select: false, focus: false, expand: true });
                }
            } catch (err) {
                // The view is contributed but may be hidden by the user; the
                // command itself must never fail because of that.
                logWatch.info('could not reveal Commands section %s: %s', subView, err);
            }
        })();
    };

    // ── Phase 4: view-wide filters (search / agent / failures) + stats ─────
    // These commands narrow all three sections at once. The title-bar filter
    // button opens `filterMenu`, which dispatches to the individual commands so
    // every action stays reachable from the Command Palette too.

    push('chatwizard.logs.search', async () => {
        const current = readFilters().search ?? '';
        const query = await vscode.window.showInputBox({
            title: 'Search Agent Logs',
            prompt: 'Match commands, file paths, diffs, errors and planner steps. '
                + 'Separate words to require all of them.',
            value: current,
            placeHolder: 'e.g. npm test',
            ignoreFocusOut: true,
        });
        if (query === undefined) { return; }
        const next: LogViewFilters = { ...readFilters(), search: normalizeSearchQuery(query) };
        writeFilters(next);
        announceFilters(next);
    });

    push('chatwizard.logs.filterByAgent', async () => {
        if (!logService) {
            vscode.window.showInformationMessage('The agent log store is not available.');
            return;
        }
        let tools: LogSourceTool[] = [];
        try {
            tools = logService.getStats().tools;
        } catch (err) {
            logWatch.warn('filterByAgent could not read store stats: %s', err);
        }
        if (tools.length === 0) {
            vscode.window.showInformationMessage('No agent log events indexed yet — run an agent session first.');
            return;
        }

        const currentTool = readFilters().tool;
        const picks: (vscode.QuickPickItem & { value?: LogSourceTool })[] = [
            { label: 'All agents', description: 'no agent filter', value: undefined },
            ...tools.map((tool) => ({
                label: friendlySourceName(tool),
                description: tool,
                value: tool,
            })),
        ];
        const picked = await vscode.window.showQuickPick(picks, {
            title: 'Filter Agent Logs by Agent',
            placeHolder: currentTool
                ? `Now: ${friendlySourceName(currentTool)}`
                : 'All agents',
        });
        if (!picked) { return; }
        const next: LogViewFilters = {
            ...readFilters(),
            tool: picked.value,
        };
        writeFilters(next);
        announceFilters(next);
    });

    push('chatwizard.logs.toggleFailures', () => {
        const current = readFilters();
        const next: LogViewFilters = {
            ...current,
            failuresOnly: current.failuresOnly ? undefined : true,
        };
        writeFilters(next);
        vscode.window.showInformationMessage(
            next.failuresOnly
                ? 'Showing failures only: failed commands (non-zero exit) and error events.'
                : 'Showing all agent log events.'
        );
    });

    push('chatwizard.logs.clearFilters', () => {
        writeFilters(emptyLogFilters());
        vscode.window.showInformationMessage('Agent log filters cleared — showing everything.');
    });

    push('chatwizard.logs.filterMenu', async () => {
        const filters = readFilters();
        const search = normalizeSearchQuery(filters.search);
        const kindCount = filters.types?.length ?? 0;
        const kindDetail = kindCount === 0
            ? 'all kinds'
            : filters.types?.map((t) => logEventTypeLabel(t)).join(', ');

        type FilterAction = 'search' | 'agent' | 'failures' | 'kinds' | 'clear' | 'stats';
        const items: (vscode.QuickPickItem & { action: FilterAction })[] = [
            {
                label: '$(search) Search Agent Logs…',
                description: search ? `current: “${search}”` : 'no text filter',
                action: 'search',
            },
            {
                label: '$(person) Filter by Agent…',
                description: filters.tool ? friendlySourceName(filters.tool) : 'all agents',
                action: 'agent',
            },
            {
                label: filters.failuresOnly
                    ? '$(pass) Show All Events'
                    : '$(error) Show Failures Only',
                description: filters.failuresOnly ? 'failures-only filter is ON' : 'no failure filter',
                action: 'failures',
            },
            {
                label: '$(symbol-event) Filter by Event Kind…',
                description: kindDetail,
                action: 'kinds',
            },
            {
                label: '$(clear-all) Clear All Filters',
                description: hasActiveFilters(filters) ? 'reset every filter' : 'nothing is filtered',
                action: 'clear',
            },
            {
                label: '$(graph) Show Agent Log Stats',
                description: 'per-agent and per-session totals',
                action: 'stats',
            },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Filter Agent Logs',
            placeHolder: hasActiveFilters(filters)
                ? 'Filters are active — pick what to change'
                : 'No filters active',
        });
        if (!picked) { return; }
        switch (picked.action) {
            case 'search': return vscode.commands.executeCommand('chatwizard.logs.search');
            case 'agent': return vscode.commands.executeCommand('chatwizard.logs.filterByAgent');
            case 'failures': return vscode.commands.executeCommand('chatwizard.logs.toggleFailures');
            case 'kinds': return vscode.commands.executeCommand('chatwizard.logs.timeline.filter');
            case 'clear': return vscode.commands.executeCommand('chatwizard.logs.clearFilters');
            case 'stats': return vscode.commands.executeCommand('chatwizard.logs.showStats');
        }
    });

    push('chatwizard.logs.showStats', async () => {
        if (!logService) {
            vscode.window.showInformationMessage('The agent log store is not available.');
            return undefined;
        }
        try {
            // Same cap as the timeline: the stats describe what the panels show.
            const events = logService.getEvents({ order: 'desc', limit: MAX_TIMELINE_EVENTS });
            const report = computeLogStats(events);
            if (report.totalEvents === 0) {
                vscode.window.showInformationMessage(
                    'No agent log events indexed yet — run an agent session first.'
                );
                return undefined;
            }
            const markdown = renderLogStatsMarkdown(report, friendlySourceName);
            const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false });
            logWatch.info(
                'stats report: %d events across %d agents / %d sessions',
                report.totalEvents,
                report.toolCount,
                report.sessionCount
            );
            return doc;
        } catch (err) {
            logWatch.error('showStats failed: %s', err);
            vscode.window.showErrorMessage(
                `Could not build the agent log stats report: ${err instanceof Error ? err.message : String(err)}`
            );
            return undefined;
        }
    });

    // ── Section 1: Executed Commands ───────────────────────────────────────
    push('chatwizard.showExecutedCommands', () => showSection('executedCommands'));

    push('chatwizard.execCommands.copy', (item?: ExecCommandsLeafItem) => {
        if (!item) { return; }
        void vscode.env.clipboard.writeText(item.event.commandText);
        vscode.window.showInformationMessage('Copied executed command to clipboard');
    });

    push('chatwizard.execCommands.openSession', (item?: ExecCommandsLeafItem) => {
        if (!item) { return; }
        openSessionById(item.event.sessionId);
    });

    push('chatwizard.execCommands.refresh', () => {
        provider.refresh();
    });

    // Re-run what the agent ran: opens a VS Code terminal and sends the command
    // text to it. Wired to the "▶ Run in Terminal" button rendered under the
    // command text in the detail webview, and to the row context menu.
    push('chatwizard.execCommands.runInTerminal', async (item?: unknown) => {
        const target = item ?? selectedNode();
        // Tree items, raw CommandEvents and items created by another bundle
        // copy are all accepted (see `eventOfCommandsNode`).
        const event = eventOfCommandsNode(target) ?? (target as CommandEvent | undefined);
        if (!event || event.type !== 'command') {
            vscode.window.showInformationMessage('Select an executed command first, then run "Run in Terminal".');
            return undefined;
        }
        const commandEvent = event as CommandEvent;
        logWatch.info('execCommands.runInTerminal → %s', commandEvent.id);
        return runCommandInTerminal(commandEvent.commandText, commandEvent.cwd);
    });

    push('chatwizard.execCommands.showDetails', (item?: unknown) => {
        const target = item ?? selectedNode();
        const event = eventOfCommandsNode(target);
        if (!event || event.type !== 'command') {
            vscode.window.showInformationMessage('Select a command first, then run "Show Full Command".');
            return undefined;
        }
        logWatch.info('execCommands.showDetails → %s (%s)', event.type, event.id);
        return showEventWebview(event, context.subscriptions);
    });

    // ── Section 2: Unified Timeline ────────────────────────────────────────
    push('chatwizard.showUnifiedTimeline', () => showSection('timeline'));

    push('chatwizard.logs.timeline.refresh', () => {
        timelineProvider?.refresh();
    });

    push('chatwizard.logs.timeline.filter', async () => {
        if (!timelineProvider) { return; }
        const pick = await vscode.window.showQuickPick(TIMELINE_FILTER_PICKS, {
            placeHolder: 'Filter the Unified Timeline by event kind',
        });
        if (!pick) { return; }
        const next = pick.value !== undefined ? [pick.value] : undefined;
        timelineProvider.setFilter(next);
        vscode.window.showInformationMessage(
            next
                ? `Unified Timeline: showing ${logEventTypeLabel(next[0]).toLowerCase()} events only`
                : 'Unified Timeline: showing all event kinds'
        );
    });

    push('chatwizard.logs.timeline.copyCommand', (item?: TimelineEventItem) => {
        if (!item || item.event.type !== 'command') { return; }
        void vscode.env.clipboard.writeText((item.event as CommandEvent).commandText);
        vscode.window.showInformationMessage('Copied executed command to clipboard');
    });

    push('chatwizard.logs.timeline.openSession', (item?: TimelineEventItem) => {
        if (!item) { return; }
        openSessionById(item.event.sessionId);
    });

    push('chatwizard.logs.timeline.openDiff', async (item?: TimelineEventItem) => {
        if (!item) { return; }
        // Same visual diff the Diff Explorer opens; events without a
        // reconstructable patch fall back to the raw patch / operation card.
        const opened = await openVisualDiff(item.event);
        if (opened) {
            logWatch.info('timeline.openDiff → visual diff %s', item.event.id);
            return;
        }
        void openDiffEditor(item.event);
    });

    push('chatwizard.logs.timeline.showDetails', (item?: unknown) => {
        const target = item ?? selectedNode();
        const event = eventOfCommandsNode(target);
        if (!event) {
            vscode.window.showInformationMessage('Select an event first, then run "Show Event Details".');
            return undefined;
        }
        logWatch.info('timeline.showDetails → %s (%s)', event.type, event.id);
        return showEventWebview(event, context.subscriptions);
    });

    // ── Section 3: Diff Explorer ───────────────────────────────────────────
    push('chatwizard.showDiffExplorer', () => showSection('diffs'));

    push('chatwizard.logs.diffs.refresh', () => {
        diffExplorerProvider?.refresh();
    });

    // Visual diff: hand the reconstructed before/after sides to VS Code's native
    // diff editor (side-by-side / inline) instead of showing patch text.
    push('chatwizard.logs.diff.viewDiff', async (item?: unknown) => {
        const target = item ?? selectedNode();
        const event = eventOfCommandsNode(target);
        if (!event || (event.type !== 'diff' && event.type !== 'fileOperation')) {
            vscode.window.showInformationMessage('Select a change first, then run "Open Visual Diff".');
            return false;
        }
        const opened = await openVisualDiff(event);
        if (!opened) {
            logWatch.info('diff.viewDiff → no renderable patch for %s; falling back to details', event.id);
            vscode.window.showInformationMessage('This change captured no diff text — showing its details instead.');
            return showEventWebview(event, context.subscriptions);
        }
        logWatch.info('diff.viewDiff → %s (%s)', event.type, event.id);
        return true;
    });

    push('chatwizard.logs.diff.openPatch', (item?: DiffEventLeafItem) => {
        if (!item) { return; }
        void openDiffEditor(item.event);
    });

    push('chatwizard.logs.diff.copy', (item?: DiffEventLeafItem) => {
        if (!item) { return; }
        const text = item.event.type === 'diff'
            ? (item.event as { diffText: string }).diffText
            : renderPatchMarkdown(item.event);
        void vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Copied change to clipboard');
    });

    push('chatwizard.logs.diff.openFile', (item?: DiffEventLeafItem) => {
        if (!item) { return; }
        void openFileAt(getEventFilePath(item.event));
    });

    push('chatwizard.logs.diff.showDetails', (item?: unknown) => {
        const target = item ?? selectedNode();
        const event = eventOfCommandsNode(target);
        if (!event || (event.type !== 'diff' && event.type !== 'fileOperation')) {
            vscode.window.showInformationMessage('Select a change first, then run "Show Change Details".');
            return undefined;
        }
        logWatch.info('diff.showDetails → %s (%s)', event.type, event.id);
        return showEventWebview(event, context.subscriptions);
    });

    // ── Commands view: shared title-bar actions ────────────────────────────
    // One refresh button for the whole view (it used to be three, one per
    // panel) and one selection-aware "Show Details" button.
    push('chatwizard.logs.refreshAll', () => {
        if (commandsViewProvider) {
            commandsViewProvider.refresh();
            return;
        }
        provider.refresh();
        timelineProvider?.refresh();
        diffExplorerProvider?.refresh();
    });

    push('chatwizard.logs.showSelectedDetails', async (node?: unknown) => {
        const target = node ?? selectedNode();
        const event = eventOfCommandsNode(target);
        if (!event) {
            vscode.window.showInformationMessage('Select a row in the Commands view first.');
            return undefined;
        }
        logWatch.info('showSelectedDetails → %s (%s)', event.type, event.id);
        if (event.type === 'diff' && await openVisualDiff(event)) {
            return true;
        }
        return showEventWebview(event, context.subscriptions);
    });
}

function openSessionById(sessionId: string | undefined): void {
    if (!sessionId) {
        vscode.window.showErrorMessage('This log event is not attached to a session');
        return;
    }
    // Reuse the sessions panel's opener — it only needs the summary shape.
    void vscode.commands.executeCommand('chatwizard.openSession', { id: sessionId });
}

/** Open the change's diff text in a disposable markdown editor. */
async function openDiffEditor(event: LogEvent): Promise<void> {
    const content = renderPatchMarkdown(event);
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
    void vscode.languages.setTextDocumentLanguage(doc, 'markdown');
}

/** Reveal the affected file when it still exists on disk. */
async function openFileAt(filePath: string | undefined): Promise<void> {
    if (!filePath) {
        vscode.window.showErrorMessage('This event does not carry a file path');
        return;
    }
    try {
        const uri = vscode.Uri.file(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) { return; }
        await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
        vscode.window.showErrorMessage(`File no longer exists: ${filePath}`);
    }
}

