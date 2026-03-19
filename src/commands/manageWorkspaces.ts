// src/commands/manageWorkspaces.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { ScopedWorkspace } from '../types/index';
import { WorkspaceScopeManager, calcWorkspaceSizeBytes, countWorkspaceSessions } from '../watcher/workspaceScope';
import { ChatWizardWatcher } from '../watcher/fileWatcher';
import { SessionIndex } from '../index/sessionIndex';
import { discoverCopilotWorkspacesAsync } from '../readers/copilotWorkspace';
import { discoverClaudeWorkspacesAsync } from '../readers/claudeWorkspace';

/** One row in the QuickPick — represents a workspace folder regardless of how many sources it has. */
type WorkspaceItem = vscode.QuickPickItem & {
    wsIds: string[];
    /** Combined size in bytes across all sources in this folder. */
    totalBytes: number;
    /**
     * Session count for this folder.
     * Priority: (1) live index, (2) globalState cache of last known exact count,
     * (3) disk file count (approximate, prefixed with ~).
     */
    sessionCount: number;
    /** True when sessionCount is from disk only (no index or cache data available). */
    sessionCountApprox: boolean;
};

/**
 * Registers the `chatwizard.manageWatchedWorkspaces` command.
 *
 * @param context     Extension context (for subscription management).
 * @param scopeManager  The active WorkspaceScopeManager instance.
 * @param getWatcher  Getter returning the current ChatWizardWatcher (may be undefined if not yet started).
 * @param channel     Output channel for log messages.
 */
export function registerManageWorkspacesCommand(
    context: vscode.ExtensionContext,
    scopeManager: WorkspaceScopeManager,
    getWatcher: () => ChatWizardWatcher | undefined,
    channel: vscode.OutputChannel,
    index: SessionIndex
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.manageWatchedWorkspaces', async () => {
            // 1. Discover all available workspaces (Copilot + Claude) in parallel.
            const [copilotWs, claudeWs] = await Promise.all([
                discoverCopilotWorkspacesAsync().then(list =>
                    list.map(ws => ({
                        id: ws.workspaceId,
                        source: 'copilot' as const,
                        workspacePath: ws.workspacePath,
                        storageDir: ws.storageDir,
                    }) satisfies ScopedWorkspace)
                ).catch(() => [] as ScopedWorkspace[]),
                discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
            ]);
            const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs];

            if (allAvailable.length === 0) {
                void vscode.window.showInformationMessage(
                    'ChatWizard: No Copilot or Claude workspaces found to manage.'
                );
                return;
            }

            // 2. Build size (bytes) and disk-session-count maps in parallel.
            const [byteCounts, diskCounts] = await Promise.all([
                Promise.all(allAvailable.map(ws => calcWorkspaceSizeBytes(ws.storageDir, ws.source))),
                Promise.all(allAvailable.map(ws => countWorkspaceSessions(ws.storageDir, ws.source))),
            ]);
            const byteMap = new Map<string, number>();
            const diskCountMap = new Map<string, number>();
            allAvailable.forEach((ws, i) => {
                byteMap.set(ws.id, byteCounts[i]);
                diskCountMap.set(ws.id, diskCounts[i]);
            });

            /** Format bytes to KB or MB depending on magnitude. */
            function formatSize(bytes: number): string {
                if (bytes === 0) { return '0 KB'; }
                if (bytes < 1024 * 1024) {
                    return `${(bytes / 1024).toFixed(2)} KB`;
                }
                return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
            }

            // Index-based session count (Claude stores workspaceId = session UUID → match by filePath prefix).
            const allSummaries = index.getAllSummaries();
            function indexCountForIds(ids: string[]): number {
                const dirs = ids.map(id => {
                    const ws = allAvailable.find(w => w.id === id)!;
                    return path.normalize(ws.storageDir);
                });
                return allSummaries.filter(s =>
                    dirs.some(dir => path.normalize(s.filePath).startsWith(dir + path.sep))
                ).length;
            }

            // Load last-known exact counts from persistent cache (keyed by normalised workspacePath).
            // This lets previously-indexed workspaces show their exact count even after being deselected.
            const countCache = context.globalState.get<Record<string, number>>('cwSessionCountCache', {});
            const updatedCache: Record<string, number> = { ...countCache };

            // Group by normalised workspace path so each folder appears as a single row.
            const pathGroups = new Map<string, ScopedWorkspace[]>();
            for (const ws of allAvailable) {
                const key = path.normalize(ws.workspacePath).toLowerCase();
                const group = pathGroups.get(key) ?? [];
                group.push(ws);
                pathGroups.set(key, group);
            }

            // 3. Determine currently selected IDs.
            const currentSelectedIds = scopeManager.getSelectedIds();

            // 4. Build QuickPick items — one per unique workspace folder.
            const workspaceItems: WorkspaceItem[] = [];
            for (const group of pathGroups.values()) {
                const representative = group[0];
                const allIds = group.map(ws => ws.id);
                const groupBytes = allIds.reduce((sum, id) => sum + (byteMap.get(id) ?? 0), 0);
                const cacheKey = path.normalize(representative.workspacePath).toLowerCase();
                const isSelected = allIds.some(id => currentSelectedIds.includes(id));

                // Count priority: 1) live index  2) globalState cache  3) disk (~)
                const indexCount = indexCountForIds(allIds);
                let sessionCount: number;
                let approx: boolean;
                if (indexCount > 0) {
                    sessionCount = indexCount;
                    approx = false;
                    updatedCache[cacheKey] = indexCount; // refresh the persistent cache
                } else {
                    const cached = countCache[cacheKey];
                    if (cached !== undefined && cached > 0) {
                        sessionCount = cached;
                        approx = false;
                    } else {
                        sessionCount = allIds.reduce((sum, id) => sum + (diskCountMap.get(id) ?? 0), 0);
                        approx = true;
                    }
                }

                const countLabel = approx
                    ? `~${sessionCount.toLocaleString()} session${sessionCount !== 1 ? 's' : ''}`
                    : `${sessionCount.toLocaleString()} session${sessionCount !== 1 ? 's' : ''}`;
                workspaceItems.push({
                    wsIds: allIds,
                    totalBytes: groupBytes,
                    sessionCount,
                    sessionCountApprox: approx,
                    label: path.basename(representative.workspacePath),
                    description: representative.workspacePath,
                    detail: `${formatSize(groupBytes)}  —  ${countLabel}`,
                    picked: isSelected,
                });
            }

            // Persist updated cache (fire-and-forget).
            void context.globalState.update('cwSessionCountCache', updatedCache);

            const TITLE_BASE = 'ChatWizard: Manage Watched Workspaces';

            function makeTitle(selectedItems: readonly WorkspaceItem[]): string {
                const bytes = selectedItems.reduce((sum, item) => sum + item.totalBytes, 0);
                const sessions = selectedItems.reduce((sum, item) => sum + item.sessionCount, 0);
                return `${TITLE_BASE}  —  ${formatSize(bytes)}  /  ${sessions.toLocaleString()} session${sessions !== 1 ? 's' : ''} selected`;
            }

            // 5. Show multi-select QuickPick.
            //    The native top-left "select-all" checkbox is used for toggle-all.
            //    When the user deselects all (native or manually), we snap back to the
            //    last non-empty selection via setImmediate so the write runs outside
            //    the synchronous event-handler tick — preventing re-render cascades.
            //    qp.keepScrollPosition = true ensures re-renders don't jump the list.
            const picked = await new Promise<WorkspaceItem[] | undefined>((resolve) => {
                const initialReal = workspaceItems.filter(i => i.picked);

                const qp = vscode.window.createQuickPick<WorkspaceItem>();
                qp.canSelectMany = true;
                qp.keepScrollPosition = true;
                qp.items = workspaceItems;
                qp.selectedItems = initialReal;
                qp.title = makeTitle(initialReal);
                qp.placeholder = 'Select workspaces to index';

                let lastNonEmpty: readonly WorkspaceItem[] = initialReal;
                // Track whether all workspaces are currently selected so that
                // native deselect-all rolls back to the pre-select-all state
                // instead of snapping back to "all selected" again.
                let allWasSelected = initialReal.length === workspaceItems.length;
                let preAllSelection: readonly WorkspaceItem[] = allWasSelected ? initialReal : [];
                let pendingDeferred = false;

                qp.onDidChangeSelection(selected => {
                    if (pendingDeferred) {
                        pendingDeferred = false;
                        return;
                    }

                    if (selected.length === 0) {
                        // Native deselect-all or last item manually unchecked.
                        // Roll back to preAllSelection if we just came from "all selected",
                        // otherwise snap back to the last non-empty selection.
                        const restore = (allWasSelected && preAllSelection.length > 0)
                            ? [...preAllSelection] as WorkspaceItem[]
                            : [...lastNonEmpty] as WorkspaceItem[];
                        allWasSelected = false;
                        preAllSelection = [];
                        pendingDeferred = true;
                        setImmediate(() => { qp.selectedItems = restore; });
                        return;
                    }

                    // Entering "all selected" state — save current selection for rollback.
                    if (selected.length === workspaceItems.length && !allWasSelected) {
                        preAllSelection = [...lastNonEmpty];
                        allWasSelected = true;
                    } else if (selected.length < workspaceItems.length && allWasSelected) {
                        allWasSelected = false;
                        preAllSelection = [];
                    }

                    lastNonEmpty = selected as WorkspaceItem[];
                    qp.title = makeTitle(selected as WorkspaceItem[]);
                });

                let accepted = false;
                qp.onDidAccept(() => {
                    const result = [...qp.selectedItems] as WorkspaceItem[];
                    if (result.length === 0) {
                        qp.title = '⚠ Select at least one workspace';
                        return;
                    }
                    accepted = true;
                    resolve(result);
                    qp.hide();
                });

                qp.onDidHide(() => {
                    channel.appendLine(`[ManageWs] onDidHide accepted=${accepted}`);
                    if (!accepted) { resolve(undefined); }
                    qp.dispose();
                });

                qp.show();
            });

            // 7. Handle result.
            if (picked === undefined) {
                // Cancelled — no-op.
                return;
            }

            // Expand each selected folder row back to its individual source IDs.
            const newIds = picked.flatMap(item => item.wsIds);

            // Check if selection is unchanged (same IDs regardless of order).
            const sortedNew = [...newIds].sort();
            const sortedCurrent = [...currentSelectedIds].sort();
            const unchanged =
                sortedNew.length === sortedCurrent.length &&
                sortedNew.every((id, i) => id === sortedCurrent[i]);

            if (unchanged) {
                return;
            }

            // 8. Persist the new scope and restart the watcher.
            scopeManager.setSelectedIds(newIds);
            channel.appendLine(
                `[ChatWizard] Workspace scope updated — ${newIds.length} workspace(s) selected: ${newIds.join(', ')}`
            );

            const watcher = getWatcher();
            if (watcher) {
                await watcher.restart();
                channel.appendLine('[ChatWizard] Watcher restarted after scope change.');
            } else {
                channel.appendLine('[ChatWizard] Scope persisted — watcher not yet started, will use new scope on next start.');
            }
        })
    );
}
