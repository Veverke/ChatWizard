/**
 * src/logs/logsCommands.ts
 *
 * Phase 2/3 — Commands for the watch-logs panels ("Executed Commands",
 * "Unified Timeline", "Diff Explorer"). All commands are registered through the
 * extension `context` so they follow the same disposal pattern as every other
 * ChatWizard command.
 */

import * as vscode from 'vscode';
import { ExecutedCommandsProvider, ExecCommandsLeafItem, ExecCommandsTreeNode } from './executedCommandsProvider';
import { UnifiedTimelineProvider, TimelineEventItem, UnifiedTimelineTreeNode } from './unifiedTimelineProvider';
import { DiffExplorerProvider, DiffEventLeafItem, renderPatchMarkdown, DiffExplorerTreeNode } from './diffExplorerProvider';
import { openVisualDiff } from './diffViewer';
import { showEventWebview } from './logEventWebview';
import { LogEventType, LOG_EVENT_TYPES, LogEvent, CommandEvent, logEventTypeLabel, getEventFilePath } from './types';
import { createLogger } from '../utils/logger';

/** Shared diagnostics for the watch-logs panels (same "Chat Wizard" channel). */
const logWatch = createLogger().withContext('WatchLogs');

export interface LogCommandsContext {
    subscriptions: { push(item: { dispose(): void }): void };
}

/** The three watch-logs tree views (used to resolve "Show Details" from buttons). */
export interface LogTreeViews {
    executedCommands?: vscode.TreeView<ExecCommandsTreeNode>;
    timeline?: vscode.TreeView<UnifiedTimelineTreeNode>;
    diffs?: vscode.TreeView<DiffExplorerTreeNode>;
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
    treeViews?: LogTreeViews
): void {
    const push = (command: string, handler: (...args: any[]) => unknown): void => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    push('chatwizard.showExecutedCommands', () => {
        void vscode.commands.executeCommand('chatwizardExecutedCommands.focus');
    });

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

    push('chatwizard.execCommands.showDetails', (item?: ExecCommandsLeafItem) => {
        const target = item ?? (treeViews?.executedCommands?.selection ?? []).find((s) => s instanceof ExecCommandsLeafItem);
        if (!target) {
            vscode.window.showInformationMessage('Select a command first, then run "Show Full Command".');
            return undefined;
        }
        logWatch.info('execCommands.showDetails → %s (%s)', target.event.type, target.event.id);
        return showEventWebview(target.event, context.subscriptions);
    });
// ── Phase 3: Unified Timeline ──────────────────────────────────────────
    push('chatwizard.showUnifiedTimeline', () => {
        void vscode.commands.executeCommand('chatwizardUnifiedTimeline.focus');
    });

    push('chatwizard.logs.timeline.refresh', () => {
        timelineProvider?.refresh();
    });

    push('chatwizard.logs.timeline.filter', async () => {
        if (!timelineProvider) { return; }
        const current = timelineProvider.getFilter();
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

    push('chatwizard.logs.timeline.openDiff', (item?: TimelineEventItem) => {
        if (!item) { return; }
        void openDiffEditor(item.event);
    });

    push('chatwizard.logs.timeline.showDetails', (item?: TimelineEventItem) => {
        const target = item ?? (treeViews?.timeline?.selection ?? []).find((s) => s instanceof TimelineEventItem);
        if (!target) {
            vscode.window.showInformationMessage('Select an event first, then run "Show Event Details".');
            return undefined;
        }
        logWatch.info('timeline.showDetails → %s (%s)', target.event.type, target.event.id);
        return showEventWebview(target.event, context.subscriptions);
    });

    // ── Phase 3: Diff Explorer ─────────────────────────────────────────────
    push('chatwizard.showDiffExplorer', () => {
        void vscode.commands.executeCommand('chatwizardDiffExplorer.focus');
    });

    push('chatwizard.logs.diffs.refresh', () => {
        diffExplorerProvider?.refresh();
    });

    // Visual diff: hand the reconstructed before/after sides to VS Code's native
    // diff editor (side-by-side / inline) instead of showing patch text.
    push('chatwizard.logs.diff.viewDiff', async (item?: DiffEventLeafItem) => {
        const target = item ?? (treeViews?.diffs?.selection ?? []).find((s) => s instanceof DiffEventLeafItem);
        if (!target) {
            vscode.window.showInformationMessage('Select a change first, then run "Open Visual Diff".');
            return false;
        }
        const opened = await openVisualDiff(target.event);
        if (!opened) {
            logWatch.info('diff.viewDiff → no renderable patch for %s; falling back to details', target.event.id);
            vscode.window.showInformationMessage('This change captured no diff text — showing its details instead.');
            return showEventWebview(target.event, context.subscriptions);
        }
        logWatch.info('diff.viewDiff → %s (%s)', target.event.type, target.event.id);
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

    push('chatwizard.logs.diff.showDetails', (item?: DiffEventLeafItem) => {
        const target = item ?? (treeViews?.diffs?.selection ?? []).find((s) => s instanceof DiffEventLeafItem);
        if (!target) {
            vscode.window.showInformationMessage('Select a change first, then run "Show Change Details".');
            return undefined;
        }
        logWatch.info('diff.showDetails → %s (%s)', target.event.type, target.event.id);
        return showEventWebview(target.event, context.subscriptions);
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