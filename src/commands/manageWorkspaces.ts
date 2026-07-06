// src/commands/manageWorkspaces.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { ScopedWorkspace } from '../types/index';
import { WorkspaceScopeManager, calcWorkspaceSizeBytes, countWorkspaceSessions } from '../watcher/workspaceScope';
import { ChatWizardWatcher } from '../watcher/fileWatcher';
import { SessionIndex } from '../index/sessionIndex';
import { discoverCopilotWorkspacesAsync } from '../readers/copilotWorkspace';
import { discoverClaudeWorkspacesAsync } from '../readers/claudeWorkspace';
import { discoverCursorWorkspacesAsync } from '../readers/cursorWorkspace';

/** One row in the QuickPick — represents a workspace folder regardless of how many sources it has. */
type WorkspaceItem = vscode.QuickPickItem & {
    wsIds: string[];
    workspacePath: string;
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
            // 1. Discover all available workspaces (Copilot + Claude + Cursor) in parallel.
            const [copilotWs, claudeWs, cursorWs] = await Promise.all([
                discoverCopilotWorkspacesAsync().then(list =>
                    list.map(ws => ({
                        id: ws.workspaceId,
                        source: 'copilot' as const,
                        workspacePath: ws.workspacePath,
                        storageDir: ws.storageDir,
                    }) satisfies ScopedWorkspace)
                ).catch(() => [] as ScopedWorkspace[]),
                discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
                discoverCursorWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
            ]);
            const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs, ...cursorWs];

            if (allAvailable.length === 0) {
                void vscode.window.showInformationMessage(
                    'Chat Wizard: No Copilot, Claude, or Cursor workspaces found to manage.'
                );
                return;
            }

            // 2. Build size (bytes) and disk-session-count maps in parallel.
            const [byteCounts, diskCounts] = await Promise.all([
                Promise.all(allAvailable.map(ws => calcWorkspaceSizeBytes(ws.storageDir, ws.source))),
                Promise.all(allAvailable.map(ws => countWorkspaceSessions(ws.storageDir, ws.source))),
            ]);
            // Use additive accumulation so that when the same workspace ID appears in both
            // Code-stable and Code-Insiders storage roots, their sizes/counts are summed
            // rather than one overwriting the other.
            const byteMap = new Map<string, number>();
            const diskCountMap = new Map<string, number>();
            allAvailable.forEach((ws, i) => {
                byteMap.set(ws.id, (byteMap.get(ws.id) ?? 0) + byteCounts[i]);
                diskCountMap.set(ws.id, (diskCountMap.get(ws.id) ?? 0) + diskCounts[i]);
            });

            /** Format bytes to KB or MB depending on magnitude. */
            function formatSize(bytes: number): string {
                if (bytes === 0) { return '0 KB'; }
                if (bytes < 1024 * 1024) {
                    return `${(bytes / 1024).toFixed(2)} KB`;
                }
                return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
            }

            // Index-based session count.
            // Copilot/Cursor sessions have workspaceId = storage hash directory name → match by ID.
            // Claude sessions have workspaceId = session UUID (filename) → must match by filePath prefix.
            // We handle both: ID match covers Copilot/Cursor (and works across Code + Code-Insiders
            // roots since both resolve to the same hash); filePath prefix covers Claude.
            const allSummaries = index.getAllSummaries();
            function indexCountForIds(ids: string[]): number {
                const idSet = new Set(ids);
                const storageDirs = ids.map(id => {
                    const ws = allAvailable.find(w => w.id === id);
                    return ws ? path.normalize(ws.storageDir) : null;
                }).filter((d): d is string => d !== null);

                return allSummaries.filter(s =>
                    idSet.has(s.workspaceId) ||
                    storageDirs.some(dir => path.normalize(s.filePath).startsWith(dir + path.sep))
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

            // Remove any path that is a strict ancestor of another discovered workspace path.
            // e.g. if both "C:\Repos\Personal" and "C:\Repos\Personal\ChatWizard" are found,
            // the parent is not a real workspace and should be hidden.
            const allKeys = [...pathGroups.keys()];
            for (const key of allKeys) {
                const prefix = key.endsWith(path.sep) ? key : key + path.sep;
                if (allKeys.some(other => other !== key && other.startsWith(prefix))) {
                    pathGroups.delete(key);
                }
            }

            // 3. Determine currently selected IDs.
            const currentSelectedIds = scopeManager.getSelectedIds();

            // 4. Build QuickPick items — one per unique workspace folder.
            const workspaceItems: WorkspaceItem[] = [];
            for (const group of pathGroups.values()) {
                const representative = group[0];
                // Deduplicate IDs: Code-stable and Code-Insiders generate the same storage hash
                // for the same workspace folder, so the same ID can appear in the group twice.
                const allIds = [...new Set(group.map(ws => ws.id))];
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
                    workspacePath: representative.workspacePath,
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

            const TITLE_BASE = 'Chat Wizard: Manage Watched Workspaces';

            const TOTAL_INDEXED = index.size;

            function makeTitle(selectedItems: readonly WorkspaceItem[]): string {
                const bytes = selectedItems.reduce((sum, item) => sum + item.totalBytes, 0);
                const sessions = selectedItems.reduce((sum, item) => sum + item.sessionCount, 0);
                const indexedPart = TOTAL_INDEXED > 0
                    ? `  ·  ${TOTAL_INDEXED} total in index`
                    : '';
                return `${TITLE_BASE}  —  ${formatSize(bytes)}  /  ${sessions.toLocaleString()} session${sessions !== 1 ? 's' : ''} selected${indexedPart}`;
            }

            // 5. Show multi-select QuickPick.
            const picked = await new Promise<WorkspaceItem[] | undefined>((resolve) => {
                let accepted = false;
                const initialReal = workspaceItems.filter(i => i.picked);

                const qp = vscode.window.createQuickPick<WorkspaceItem>();
                qp.canSelectMany = true;
                qp.keepScrollPosition = true;
                qp.items = workspaceItems;
                qp.selectedItems = initialReal;
                qp.title = makeTitle(initialReal);
                qp.placeholder = 'Select workspaces to index';

                // Compute open-workspace items once, used for auto-restore on de-select-all.
                const openPaths = new Set(
                    (vscode.workspace.workspaceFolders ?? [])
                        .map(f => path.normalize(f.uri.fsPath).toLowerCase())
                );
                // Match items that ARE the open workspace folder (exact) OR that live
                // inside it (child path).  The ancestor-removal step above can remove
                // the exact path from workspaceItems when a deeper Cursor/Copilot
                // workspace is also discovered; the child-path fallback keeps
                // currentWsItems non-empty in that case so deselect-all correctly
                // restores to items within the current workspace instead of all items.
                const currentWsItems = workspaceItems.filter(item => {
                    const itemPath = path.normalize(item.workspacePath).toLowerCase();
                    return [...openPaths].some(
                        op => itemPath === op || itemPath.startsWith(op + path.sep)
                    );
                });

                qp.onDidChangeSelection(selected => {
                    if (selected.length === 0) {
                        // Immediately restore the currently open workspace to prevent an
                        // empty-scope state from becoming visible until Accept is clicked.
                        const restore = currentWsItems.length > 0 ? currentWsItems : workspaceItems;
                        // setImmediate ensures the assignment runs after VS Code's own
                        // selection-change processing completes, avoiding a re-render race.
                        setImmediate(() => {
                            qp.selectedItems = restore;
                            qp.title = makeTitle(restore);
                        });
                        return;
                    }
                    qp.title = makeTitle(selected as WorkspaceItem[]);
                });

                qp.onDidAccept(() => {
                    const result = [...qp.selectedItems] as WorkspaceItem[];
                    if (result.length === 0) {
                        // Auto-select items matching the currently open VS Code workspace.
                        if (currentWsItems.length > 0) {
                            qp.selectedItems = currentWsItems;
                            qp.title = makeTitle(currentWsItems);
                        } else {
                            qp.title = '⚠ Select at least one workspace';
                        }
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
                `[Chat Wizard] Workspace scope updated — ${newIds.length} workspace(s) selected: ${newIds.join(', ')}`
            );

            const watcher = getWatcher();
            if (watcher) {
                await watcher.restart();
                channel.appendLine('[Chat Wizard] Watcher restarted after scope change.');
            } else {
                channel.appendLine('[Chat Wizard] Scope persisted — watcher not yet started, will use new scope on next start.');
            }
        })
    );
}
