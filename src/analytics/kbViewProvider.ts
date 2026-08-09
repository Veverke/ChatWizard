// src/analytics/kbViewProvider.ts
// Feature 23 — KB Dashboard as a sidebar WebviewView tab in the Chat Wizard panel.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { buildKbEntries, mergeIntoResult, removeFromResult, cleanSummary } from './kbEngine';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifySessionWithCategories } from './kbClassifier';
import { clusterEntries } from './kbClusterer';
import { exportKbAsync } from '../export/kbExporter';
import { KbDashboardPanel } from './kbDashboardPanel';
import { configureFallbackCategories } from './kbCategoryConfigurator';
import { DEFAULT_KB_TYPES } from '../types/kb';
import { KbStore } from './kbStore';

export class KbViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardKnowledgeBase';

    private _view?: vscode.WebviewView;
    private _lastResult: import('./kbEngine').KbEngineResult | null = null;
    private _categories: string[] | undefined;
    private _classifiedSessionIds: string[] | undefined;
    /** Debounce map: sessionId → timer for refreshForSession */
    private _refreshDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly _index: SessionIndex,
        private readonly _sidecarStore: SidecarMetadataStore,
        private readonly _globalState: vscode.Memento,
        private readonly _kbStore: KbStore,
    ) {
        // Restore persisted categories from previous session
        this._categories = _globalState.get<string[]>('chatwizard.kbCategories', undefined as unknown as string[]);
        this._classifiedSessionIds = _globalState.get<string[]>('chatwizard.kbClassifiedSessionIds', undefined as unknown as string[]);

        // Attempt to load persisted KB from disk (best-effort, non-blocking)
        void this._loadPersistedKb();
    }

    /**
     * Try to load a previously persisted KB result from disk.
     * If found, it becomes _lastResult and the view is updated.
     */
    private async _loadPersistedKb(): Promise<void> {
        try {
            const persisted = await this._kbStore.load();
            if (persisted && persisted.entries.length > 0) {
                this._lastResult = persisted;
                this._sendToView();
                this._notifyDashboardPanel();
            }
        } catch {
            // Ignore — no persisted data is fine
        }
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = { enableScripts: true };

        // Set shell HTML once — never reassigned
        webviewView.webview.html = KbDashboardPanel.getShellHtml();

        // When the webview signals ready, send the initial data
        webviewView.webview.onDidReceiveMessage((msg: { type?: string; command?: string; sessionId?: string }) => {
            if (msg.type === 'ready') {
                this._sendToView();
            } else if (msg.command === 'openSession' && msg.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId });
            } else if (msg.command === 'generateKb') {
                void this._handleGenerate();
            } else if (msg.command === 'export') {
                void this._handleExport();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendToView(); }
        });
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Full KB generation for all sessions. Called when the user clicks
     * "Generate Knowledge Base" or via the command palette.
     */
    async generateForAllChats(): Promise<void> {
        await this._computeResult();
        if (this._lastResult) {
            void this._kbStore.save(this._lastResult);
        }
        this._sendToView();
        this._notifyDashboardPanel();
    }

    /**
     * Incremental KB update for a single session. Called when a session is
     * upserted. Debounced per-sessionId: if multiple upserts fire for the same
     * session within 5 minutes, only the last one triggers a refresh.
     */
    async refreshForSession(sessionId: string): Promise<void> {
        // Cancel any pending debounce for this sessionId
        const existing = this._refreshDebounceTimers.get(sessionId);
        if (existing) { clearTimeout(existing); }

        // Schedule the actual work
        return new Promise<void>((resolve) => {
            const timer = setTimeout(async () => {
                this._refreshDebounceTimers.delete(sessionId);
                await this._doRefreshForSession(sessionId);
                resolve();
            }, 300000); // 5 minutes
            this._refreshDebounceTimers.set(sessionId, timer);
        });
    }

    private async _doRefreshForSession(sessionId: string): Promise<void> {
        const session = this._index.get(sessionId);
        if (!session) { return; }

        const cache = await this._sidecarStore.load();
        const useCategories = this._categories ?? DEFAULT_KB_TYPES;
        const { type: entryType, usedLlm } = await classifySessionWithCategories(session, useCategories);
        const meta = cache?.get(session.id);
        const tags = meta?.tags ?? [];
        const rawSummary = meta?.summary ?? session.title;
        const summary = cleanSummary(rawSummary);

        const newEntry: KbEntry = {
            sessionId: session.id,
            type: entryType,
            title: session.title,
            summary,
            tags,
            createdAt: session.createdAt,
            usedLlm,
        };

        if (this._lastResult) {
            this._lastResult = await mergeIntoResult(this._lastResult, [newEntry]);
            if (usedLlm) { this._lastResult.usedLlm = true; }
            void this._kbStore.save(this._lastResult);
        }
        // No _lastResult yet = user hasn't generated KB; don't auto-create one.

        this._sendToView();
        this._notifyDashboardPanel();
    }

    /**
     * Remove a session from the KB result. Called when a session is deleted.
     */
    removeSession(sessionId: string): void {
        if (!this._lastResult) { return; }
        this._lastResult = removeFromResult(this._lastResult, new Set([sessionId]));
        this._sendToView();
        this._notifyDashboardPanel();
    }

    /**
     * Set custom categories for the next KB generation.
     * Pass `undefined` to reset to default categories.
     */
    setCategories(categories: string[] | undefined): void {
        this._categories = categories;
    }

    private async _handleGenerate(): Promise<void> {
        const fallbackCategories = await configureFallbackCategories();
        // `undefined` = auto-detect (LLM generates freely; heuristic fallback uses built-in types)
        // `string[]` = custom fallback categories for when LLM is unavailable

        this._categories = fallbackCategories;
        this._lastResult = null; // Force fresh computation

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Chat Wizard: Generating knowledge base…',
                cancellable: false,
            },
            async (progress) => {
                await this._computeResult((done, total) => {
                    progress.report({
                        message: `${done} / ${total} sessions classified`,
                        increment: 100 / total,
                    });
                });
            },
        );

        this._saveState();
        if (this._lastResult) {
            void this._kbStore.save(this._lastResult);
        }
        this._sendToView();
        this._notifyDashboardPanel();
    }

    /** Forward the latest result to the standalone dashboard panel if open. */
    private _notifyDashboardPanel(): void {
        if (this._lastResult) {
            KbDashboardPanel.refresh(this._lastResult, () => this._handleExport());
        }
    }

    /**
     * Build the KB result from all sessions; stores it in `_lastResult`.
     * Does NOT require the view to be visible. Also auto-tags sessions
     * with their KB categories when chatwizard.kbAutoTagSessions is enabled.
     */
    private async _computeResult(onProgress?: (done: number, total: number) => void): Promise<void> {
        const summaries = this._index.getAllSummaries();
        const sessions = summaries
            .map(s => this._index.get(s.id))
            .filter((s): s is NonNullable<typeof s> => s !== null);

        if (sessions.length === 0) {
            this._lastResult = null;
            return;
        }

        const cache = await this._sidecarStore.load();
        const useCategories = this._categories ?? DEFAULT_KB_TYPES;
        const result = await buildKbEntries(sessions, cache, useCategories, onProgress);
        this._lastResult = result;

        // ── Auto-tag sessions with KB categories ─────────────────────────
        const autoTagEnabled = vscode.workspace.getConfiguration('chatwizard').get<boolean>('kbAutoTagSessions', true);
        if (autoTagEnabled && result.entries.length > 0) {
            // Build a reverse map: child category → parent group
            const childToParent = new Map<string, string>();
            if (result.topLevelGrouping) {
                for (const [parent, children] of result.topLevelGrouping.entries()) {
                    for (const child of children) {
                        // Keep the more general parent if a child appears in multiple groups
                        if (!childToParent.has(child)) {
                            childToParent.set(child, parent);
                        }
                    }
                }
            }

            // Tag each entry concurrently
            await Promise.all(result.entries.map(async (entry) => {
                // Remove prior KB tags first to avoid accumulation across generations
                const meta = cache?.get(entry.sessionId);
                const existingTags = meta?.tags ?? [];
                const nonKbTags = existingTags.filter(t => !t.startsWith('kb-category:') && !t.startsWith('kb-group:'));
                if (nonKbTags.length !== existingTags.length) {
                    await this._sidecarStore.patch(entry.sessionId, { tags: nonKbTags });
                }

                // Tag: kb-category:<fine-grained-category>
                const fineTag = `kb-category:${entry.type.toLowerCase().replace(/\s+/g, '-')}`;
                await this._sidecarStore.addTag(entry.sessionId, fineTag);

                // Tag: kb-group:<top-level-group> (if applicable)
                const parentGroup = childToParent.get(entry.type);
                if (parentGroup) {
                    const groupTag = `kb-group:${parentGroup.toLowerCase().replace(/\s+/g, '-')}`;
                    await this._sidecarStore.addTag(entry.sessionId, groupTag);
                }
            }));
        }
    }

    /**
     * Send the current `_lastResult` to the webview, or show loading/empty state.
     */
    private _sendToView(): void {
        if (!this._view?.visible) { return; }

        if (!this._lastResult) {
            const summaries = this._index.getAllSummaries();
            const sessionsReady = summaries.length > 0;
            void this._view.webview.postMessage({
                type: 'update',
                payload: { slices: [], total: 0, sessionsReady },
            });
            return;
        }

        const result = this._lastResult;
        void this._view.webview.postMessage({
            type: 'update',
            payload: {
                ...KbDashboardPanel.buildPayload(result),
                sessionsReady: true,
            },
        });
    }

    /**
     * Persist the current categories and classified session IDs to globalState.
     */
    private _saveState(): void {
        if (this._categories) {
            void this._globalState.update('chatwizard.kbCategories', this._categories);
        }
        if (this._lastResult) {
            const ids = this._lastResult.entries.map(e => e.sessionId);
            void this._globalState.update('chatwizard.kbClassifiedSessionIds', ids);
        }
    }

    private async _handleExport(): Promise<void> {
        const result = this._lastResult;
        if (!result || result.entries.length === 0) {
            void vscode.window.showInformationMessage('No knowledge base entries to export.');
            return;
        }

        const uri = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, openLabel: 'Select KB output folder',
        });
        if (!uri?.[0]) { return; }
        const outputDir = uri[0].fsPath;

        const embeddingFn = (_text: string): Float32Array => new Float32Array(384);
        const clusters = clusterEntries(result.entries, embeddingFn);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Chat Wizard: Generating knowledge base…', cancellable: false },
            () => exportKbAsync(result.entries, clusters, outputDir, { incrementalUpdate: true }),
        );

        void vscode.window.showInformationMessage(
            `Knowledge base exported to ${outputDir} — ${result.entries.length} entries.`,
            'Open Folder',
        ).then(choice => {
            if (choice === 'Open Folder') {
                void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
            }
        });
    }
}