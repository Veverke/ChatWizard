// src/commands/sessionLifecycleCommands.ts
//
// Feature 28 — Session status lifecycle
// Feature 29 — Bookmarks
// Feature 30 — Inline annotations
// Feature 31 — Session linking
// Feature 32 — Response rating
// Feature 35 — Keyboard navigation
//
// All commands are registered in extension.ts via registerSessionLifecycleCommands().

import * as vscode from 'vscode';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { SessionIndex } from '../index/sessionIndex';
import { SessionTreeProvider, SessionTreeItem } from '../views/sessionTreeProvider';
import { SessionBookmark, SessionAnnotation, MessageRating } from '../types/index';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSessionLifecycleCommands(
    context: vscode.ExtensionContext,
    metaStore: SidecarMetadataStore,
    index: SessionIndex,
    provider: SessionTreeProvider,
    treeView: vscode.TreeView<SessionTreeItem>,
): void {

    // ── Feature 28: Session status lifecycle ──────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.setSessionStatus', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const current = await metaStore.get(sessionId);
            const currentStatus = current?.status;

            type StatusItem = vscode.QuickPickItem & { value: 'open' | 'resolved' | 'revisit' | 'none' };
            const items: StatusItem[] = [
                { label: '$(circle)  Open', description: 'Actively working on this', value: 'open', picked: currentStatus === 'open' },
                { label: '$(check)  Resolved', description: 'Completed / fixed', value: 'resolved', picked: currentStatus === 'resolved' },
                { label: '$(refresh)  Revisit', description: 'Needs follow-up', value: 'revisit', picked: currentStatus === 'revisit' },
                { label: '$(close)  Clear status', description: 'Remove status label', value: 'none', picked: !currentStatus },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: `Session Status — ${sessionId.slice(0, 8)}…`,
                placeHolder: 'Choose a status',
            });
            if (!pick) { return; }

            await metaStore.setStatus(sessionId, pick.value === 'none' ? undefined : pick.value);
            provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.filterByStatus', async () => {
            type StatusItem = vscode.QuickPickItem & { value: 'open' | 'resolved' | 'revisit' | 'all' };
            const items: StatusItem[] = [
                { label: '$(circle)  Open', value: 'open' },
                { label: '$(check)  Resolved', value: 'resolved' },
                { label: '$(refresh)  Revisit', value: 'revisit' },
                { label: '$(close)  Show all', value: 'all' },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Filter by Session Status',
                placeHolder: 'Choose a status to filter by',
            });
            if (!pick) { return; }

            const current = provider.getFilter();
            if (pick.value === 'all') {
                const { status, ...rest } = current as any;
                provider.setFilter(rest);
            } else {
                provider.setFilter({ ...current, status: pick.value });
            }
            treeView.description = provider.getDescription();
            provider.refresh();
        })
    );

    // ── Feature 29: Bookmarks ─────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.addBookmark', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const note = await vscode.window.showInputBox({
                title: `Add Bookmark — ${sessionId.slice(0, 8)}…`,
                placeHolder: 'Optional note for this bookmark',
                prompt: 'Enter a note (or leave empty)',
            });
            if (note === undefined) { return; } // cancelled

            const bookmark: SessionBookmark = {
                messageIndex: 0,
                note: note || undefined,
                createdAt: new Date().toISOString(),
            };
            await metaStore.addBookmark(sessionId, bookmark);
            vscode.window.showInformationMessage(`Bookmark added to session ${sessionId.slice(0, 8)}…`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.removeBookmark', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const meta = await metaStore.get(sessionId);
            const bookmarks = (meta as any)?.bookmarks as SessionBookmark[] | undefined;
            if (!bookmarks || bookmarks.length === 0) {
                vscode.window.showInformationMessage('No bookmarks on this session.');
                return;
            }

            type BmItem = vscode.QuickPickItem & { idx: number };
            const items: BmItem[] = bookmarks.map((b, i) => ({
                label: `📑 ${b.note || `Message #${b.messageIndex}`}`,
                description: new Date(b.createdAt).toLocaleDateString(),
                idx: i,
            }));

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Remove Bookmark',
                placeHolder: 'Select bookmark to remove',
            });
            if (!pick) { return; }

            await metaStore.removeBookmark(sessionId, bookmarks[pick.idx].messageIndex);
            vscode.window.showInformationMessage('Bookmark removed.');
        })
    );

    // ── Feature 30: Inline annotations ────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.addAnnotation', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const text = await vscode.window.showInputBox({
                title: `Add Annotation — ${sessionId.slice(0, 8)}…`,
                placeHolder: 'Annotation text',
                prompt: 'Enter your annotation for this session',
            });
            if (!text) { return; }

            const annotation: SessionAnnotation = {
                messageIndex: 0,
                noteText: text,
                createdAt: new Date().toISOString(),
            };
            await metaStore.addAnnotation(sessionId, annotation);
            vscode.window.showInformationMessage('Annotation added.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.removeAnnotation', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const meta = await metaStore.get(sessionId);
            const annotations = meta?.annotations;
            if (!annotations || annotations.length === 0) {
                vscode.window.showInformationMessage('No annotations on this session.');
                return;
            }

            type AnItem = vscode.QuickPickItem & { idx: number };
            const items: AnItem[] = annotations.map((a, i) => ({
                label: `💬 ${(a as any).noteText ?? (a as any).text ?? ''}`.slice(0, 64),
                description: new Date(a.createdAt).toLocaleDateString(),
                idx: i,
            }));

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Remove Annotation',
                placeHolder: 'Select annotation to remove',
            });
            if (!pick) { return; }

            await metaStore.removeAnnotation(sessionId, annotations[pick.idx].messageIndex);
            vscode.window.showInformationMessage('Annotation removed.');
        })
    );

    // ── Feature 31: Session linking ───────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.linkSession', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            // Show a quick pick of all sessions to link to
            const summaries = index.getAllSummaries().filter(s => s.id !== sessionId);
            type LinkItem = vscode.QuickPickItem & { id: string };
            const items: LinkItem[] = summaries.map(s => ({
                label: s.title || 'Untitled',
                description: `${s.source} · ${s.updatedAt.slice(0, 10)}`,
                id: s.id,
            }));

            const pick = await vscode.window.showQuickPick(items, {
                title: `Link Session — ${sessionId.slice(0, 8)}…`,
                placeHolder: 'Select a session to link',
                matchOnDescription: true,
            });
            if (!pick) { return; }

            await metaStore.addLinkedSession(sessionId, pick.id);
            await metaStore.addLinkedSession(pick.id, sessionId); // bidirectional
            vscode.window.showInformationMessage(`Linked to "${pick.label}".`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.unlinkSession', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            const meta = await metaStore.get(sessionId);
            const links = meta?.linkedSessionIds;
            if (!links || links.length === 0) {
                vscode.window.showInformationMessage('No linked sessions.');
                return;
            }

            type LinkItem = vscode.QuickPickItem & { id: string };
            const items: LinkItem[] = links.map(id => {
                const s = index.get(id);
                return {
                    label: s?.title || id.slice(0, 12) + '…',
                    description: s?.source ?? 'unknown',
                    id,
                };
            });

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Unlink Session',
                placeHolder: 'Select a linked session to remove',
            });
            if (!pick) { return; }

            await metaStore.removeLinkedSession(sessionId, pick.id);
            await metaStore.removeLinkedSession(pick.id, sessionId); // bidirectional
            vscode.window.showInformationMessage('Session unlinked.');
        })
    );

    // ── Feature 32: Response rating ───────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.rateSession', async (item?: SessionTreeItem) => {
            const sessionId = resolveSessionId(item);
            if (!sessionId) { return; }

            type RateItem = vscode.QuickPickItem & { value: 1 | -1 };
            const items: RateItem[] = [
                { label: '$(thumbsup)  Thumbs Up', description: 'Helpful response', value: 1 },
                { label: '$(thumbsdown)  Thumbs Down', description: 'Not helpful', value: -1 },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: `Rate Session — ${sessionId.slice(0, 8)}…`,
                placeHolder: 'Was this session helpful?',
            });
            if (!pick) { return; }

            const rating: MessageRating = {
                messageIndex: 0,
                rating: pick.value,
                createdAt: new Date().toISOString(),
            };
            await metaStore.setRating(sessionId, rating);
            vscode.window.showInformationMessage(
                pick.value === 1 ? 'Rated thumbs up.' : 'Rated thumbs down.'
            );
        })
    );

    // ── Feature 35: Keyboard navigation ───────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusSessionTree', () => {
            void vscode.commands.executeCommand('chatwizardSessions.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusCodeBlocks', () => {
            void vscode.commands.executeCommand('chatwizardCodeBlocks.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusSearch', () => {
            void vscode.commands.executeCommand('chatwizardSearch.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusAnalytics', () => {
            void vscode.commands.executeCommand('chatwizardAnalytics.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusTimeline', () => {
            void vscode.commands.executeCommand('chatwizardTimeline.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.focusPromptLibrary', () => {
            void vscode.commands.executeCommand('chatwizardPromptLibrary.focus');
        })
    );

    // Register keybinding commands for navigation within the session tree
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.treeView.selectNext', () => {
            simulateTreeNavigation(treeView, 'next');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.treeView.selectPrevious', () => {
            simulateTreeNavigation(treeView, 'previous');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.treeView.openSelected', () => {
            const selection = treeView.selection;
            if (selection.length === 1) {
                void vscode.commands.executeCommand('chatwizard.openSession', selection[0].summary);
            }
        })
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a session ID from a tree item or the active editor. */
function resolveSessionId(item?: SessionTreeItem): string | undefined {
    if (item?.summary?.id) { return item.summary.id; }

    // Fallback: try to get the active session from the tree view selection
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // Could try to extract from document URI, but for now just return undefined
        return undefined;
    }
    return undefined;
}

/** Simulate up/down arrow navigation in a tree view by revealing adjacent items. */
function simulateTreeNavigation(
    treeView: vscode.TreeView<SessionTreeItem>,
    direction: 'next' | 'previous',
): void {
    // This is a best-effort approach: we can't directly control tree focus,
    // but we provide the command for keybinding integration.
    // Actual keyboard navigation is handled natively by VS Code's tree widget.
    void vscode.commands.executeCommand(
        direction === 'next' ? 'list.focusDown' : 'list.focusUp'
    );
}