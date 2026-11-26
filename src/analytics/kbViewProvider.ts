// src/analytics/kbViewProvider.ts
// Feature 23 — KB Dashboard as a sidebar WebviewView tab in the Chat Wizard panel.
//
// The KB renders ChatWizard's *one* classification, not a copy of it: the
// entry types/subtypes come from the shared structure (the auto-classified folder
// tree) when it exists, so **Group by Context** and this pie chart always agree —
// including folders the user created, renamed, moved or deleted, and chats they
// re-placed by hand. The model labels in `ClassificationStore` are only the
// proposal that structure is rebuilt from.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import type { FolderStore } from '../index/folderStore';
import type { SessionFolder } from '../types/index';
import { buildKbEntries, buildKbEntriesFromClassifications, mergeIntoResult, removeFromResult, cleanSummary } from './kbEngine';
import type { KbEngineResult } from './kbEngine';
import type { KbEntry, KbEntryType } from '../types/kb';
import { clusterEntries } from './kbClusterer';
import { exportKbAsync } from '../export/kbExporter';
import { KbDashboardPanel } from './kbDashboardPanel';
import { DEFAULT_KB_TYPES } from '../types/kb';
import { KbStore } from './kbStore';
import type { ClassificationStore } from './classificationStore';
import { sessionFingerprintFrom } from './classificationStore';
import { classifySessionsShared } from './classificationService';
import { applyFolderStructure } from './classificationStructure';

/**
 * How long a classification must be running before the "classifying" badge
 * appears. Keeps fast runs from flickering the indicator.
 */
const CLASSIFYING_INDICATOR_DELAY_MS = 400;

export class KbViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardKnowledgeBase';

    private _view?: vscode.WebviewView;
    private _lastResult: import('./kbEngine').KbEngineResult | null = null;
    private _categories: string[] | undefined;
    private _classifiedSessionIds: string[] | undefined;
    /** ISO-8601 timestamp of the last KB update (generation or incremental refresh). */
    private _lastUpdated = '';
    /** Debounce map: sessionId → timer for refreshForSession */
    private _refreshDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Guards against re-entrant KB generation (double-click on Generate). */
    private _generating = false;
    /** Subscription to the shared classification store. */
    private readonly _sharedSubscription: { dispose: () => void };
    /** Subscription to the "a classification is running" signal. */
    private readonly _busySubscription: { dispose: () => void };
    /**
     * The shared *structure* — the auto-classified folder tree the Sessions view
     * renders. The KB derives each entry's type/subtype from it, so a folder the
     * user creates/renames/moves/deletes (or a chat they re-place) shows up here
     * too. `null` until the tree store is attached (auto-classification off).
     */
    private _folderStore: FolderStore | null = null;
    /** Subscription to structural edits of the shared tree. */
    private _folderSubscription: { dispose: () => void } | null = null;
    /** Delayed "classifying" indicator — avoids a flicker for instant runs. */
    private _busyTimer: ReturnType<typeof setTimeout> | null = null;
    /** Whether the classifying indicator is currently shown. */
    private _busyShown = false;

    constructor(
        private readonly _index: SessionIndex,
        private readonly _sidecarStore: SidecarMetadataStore,
        private readonly _globalState: vscode.Memento,
        private readonly _kbStore: KbStore,
        /** Classification state shared with the automatic folder tree. */
        private readonly _classificationStore: ClassificationStore,
    ) {
        // Restore persisted categories from previous session
        this._categories = _globalState.get<string[]>('chatwizard.kbCategories', undefined as unknown as string[]);
        this._classifiedSessionIds = _globalState.get<string[]>('chatwizard.kbClassifiedSessionIds', undefined as unknown as string[]);

        // Attempt to load persisted KB from disk (best-effort, non-blocking)
        void this._loadPersistedKb();

        // The automatic classifier (or a session edit) may update the shared
        // classification — render it without asking the user to regenerate.
        this._sharedSubscription = this._classificationStore.onDidChange(() => {
            if (this._generating) { return; }
            void this._syncFromSharedStore(true);
        });

        // A background classification is running: say so, instead of letting the
        // pie chart change under the user's feet with no explanation.
        this._busySubscription = this._classificationStore.onDidChangeBusy((busy, label) => {
            this._setClassifying(busy, label);
        });
    }

    /** Detaches from the shared classification store. */
    dispose(): void {
        this._sharedSubscription.dispose();
        this._busySubscription.dispose();
        this._folderSubscription?.dispose();
        this._folderSubscription = null;
        if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
    }

    /**
     * Attaches the shared classification *structure* — the auto-classified folder
     * tree the Sessions view renders.
     *
     * There is exactly one classification: this tree is it. Edits made in
     * **Group by Context** (create / rename / move / delete a folder, move a chat)
     * therefore re-render the KB from the new structure — no re-classification,
     * no model call.
     */
    setFolderStore(store: FolderStore | null): void {
        this._folderSubscription?.dispose();
        this._folderSubscription = null;
        this._folderStore = store;
        if (store) {
            this._folderSubscription = store.onDidChange(() => {
                // A re-classification is already rendering; let it finish first.
                if (this._generating) { return; }
                void this._syncFromSharedStore(true);
            });
        }
        void this._syncFromSharedStore(true);
    }

    /** The shared structure as a plain map, or `null` while none exists. */
    private _folders(): Map<string, SessionFolder> | null {
        return this._folderStore?.getCached() ?? null;
    }

    /**
     * Shows/hides the (non-blocking) "classifying" indicator.
     *
     * Showing is delayed: a run that finishes in a few milliseconds must not make
     * the badge blink, and the pie chart keeps being fully usable either way.
     */
    private _setClassifying(active: boolean, label?: string): void {
        // The blocking "Generating…" overlay already says it — do not stack badges.
        if (this._generating) { return; }
        if (active) {
            if (this._busyTimer || this._busyShown) { return; }
            this._busyTimer = setTimeout(() => {
                this._busyTimer = null;
                this._busyShown = true;
                this._postClassifying(true, label);
            }, CLASSIFYING_INDICATOR_DELAY_MS);
            return;
        }

        if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
        if (!this._busyShown) { return; }
        this._busyShown = false;
        this._postClassifying(false);
    }

    private _postClassifying(active: boolean, label?: string): void {
        void this._view?.webview.postMessage({ type: 'classifying', active, label });
        KbDashboardPanel.showClassifying(active, label);
    }

    /**
     * Try to load a previously persisted KB result from disk.
     * If found, it becomes _lastResult and the view is updated.
     */
    private async _loadPersistedKb(): Promise<void> {
        try {
            await this._classificationStore.load();
            const persisted = await this._kbStore.load();

            // A KB generated before the shared state existed becomes the shared
            // starting state — the automatic folder tree reuses it instead of
            // classifying everything again.
            if (this._classificationStore.isEmpty() && persisted && persisted.entries.length > 0) {
                const summaries = this._index.getAllSummaries();
                const byId = new Map(summaries.map(s => [s.id, s]));
                await this._classificationStore.importClassifications(
                    persisted.entries
                        // Never import a label an old view-level cap folded into
                        // "Other" — it would keep the KB at that coarser
                        // granularity forever. Such chats are re-classified.
                        .filter(entry => !(entry.type === 'Other' && !!entry.subtype))
                        .map(entry => ({
                            sessionId: entry.sessionId,
                            category: entry.type,
                            subcategory: entry.subtype,
                            usedLlm: entry.usedLlm,
                        })),
                    id => {
                        const summary = byId.get(id);
                        return summary ? sessionFingerprintFrom(summary.updatedAt, summary.messageCount) : undefined;
                    },
                );
            }

            // The shared state (whatever produced it) is the canonical source.
            const synced = await this._syncFromSharedStore(false);
            if (!synced && persisted && persisted.entries.length > 0) {
                this._lastResult = persisted;
                this._lastUpdated = persisted.lastUpdated ?? new Date().toISOString();
            }
            this._sendToView();
            this._notifyDashboardPanel();
        } catch {
            // Ignore — no persisted data is fine
        }
    }

    /**
     * Rebuilds the KB result from the shared classification state — no model call.
     * Returns true when the KB now has entries.
     *
     * `notify` re-renders the views, but only when the labels actually differ:
     * a background run that produced identical labels must not redraw the pie
     * chart (or rewrite the persisted KB).
     */
    private async _syncFromSharedStore(notify: boolean): Promise<boolean> {
        const data = await this._classificationStore.load();
        const classifications = this._classificationStore.toClassifications();
        if (classifications.length === 0) { return false; }

        const summaries = this._index.getAllSummaries();
        if (summaries.length === 0) { return false; }
        const sessions = summaries
            .map(s => this._index.get(s.id))
            .filter((s): s is NonNullable<typeof s> => s !== undefined && s !== null);
        if (sessions.length === 0) { return false; }

        const cache = await this._sidecarStore.load();
        const next = buildKbEntriesFromClassifications(sessions, cache, classifications, this._folders());
        if (next.entries.length === 0) { return false; }

        const changed = kbResultSignature(next) !== kbResultSignature(this._lastResult);
        this._lastResult = next;
        this._lastUpdated = data.lastUpdated ?? new Date().toISOString();

        if (notify && changed) {
            void this._kbStore.save(this._lastResult, this._lastUpdated);
            this._sendToView();
            this._notifyDashboardPanel();
        }
        return true;
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
                // The badge is per-webview state: restore it when the view is
                // (re)created while a classification is still running.
                if (this._classificationStore.isBusy()) {
                    this._busyShown = true;
                    this._postClassifying(true, this._classificationStore.getBusyLabel());
                }
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
            this._lastUpdated = new Date().toISOString();
            void this._kbStore.save(this._lastResult, this._lastUpdated);
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
        // Shared classification: unchanged chats come straight from the shared
        // store; only a new/edited chat reaches a model.
        const { classifications } = await classifySessionsShared(
            [session],
            this._classificationStore,
            { levels: 2, embeddingCategories: useCategories },
        );
        const classification = classifications[0];
        if (!classification) { return; }

        // The shared structure wins over the model label: if the user re-placed
        // this chat in the Sessions view, the KB shows it where it now lives.
        const resolved = applyFolderStructure([classification], this._folders()).classifications[0];
        if (!resolved) { return; }

        const entryType = resolved.category;
        const subtype = resolved.subcategory;
        const usedLlm = resolved.usedLlm;
        const meta = cache?.get(session.id);
        const tags = meta?.tags ?? [];
        const rawSummary = meta?.summary ?? session.title;
        const summary = cleanSummary(rawSummary);

        const newEntry: KbEntry = {
            sessionId: session.id,
            type: entryType,
            subtype: subtype ?? undefined,
            title: session.title,
            summary,
            tags,
            createdAt: session.createdAt,
            usedLlm,
        };

        if (this._lastResult) {
            this._lastResult = await mergeIntoResult(this._lastResult, [newEntry]);
            if (usedLlm) { this._lastResult.usedLlm = true; }
            this._lastUpdated = new Date().toISOString();
            void this._kbStore.save(this._lastResult, this._lastUpdated);
        }
        // No _lastResult yet = user hasn't generated KB; don't auto-create one.

        this._sendToView();
        this._notifyDashboardPanel();
    }

    /**
     * Remove a session from the KB result. Called when a session is deleted.
     */
    removeSession(sessionId: string): void {
        // Keep the shared classification in sync — a deleted chat must not stay
        // in the automatic folder tree either.
        void this._classificationStore.remove(sessionId);
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

    /**
     * Refresh the webview with the current state (loading, empty, or data).
     * Called when the index finishes building so the view transitions from
     * "Waiting for sessions to be indexed…" to the appropriate state.
     */
    refreshView(): void {
        this._sendToView();
    }

    private async _handleGenerate(): Promise<void> {
        if (this._generating) { return; }
        this._generating = true;
        this._lastResult = null; // Force fresh computation

        // Show the in-webview generating overlay (spinner + "Generating…")
        this._view?.webview.postMessage({ type: 'generating' });
        KbDashboardPanel.showGenerating();

        try {
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
                this._lastUpdated = new Date().toISOString();
                void this._kbStore.save(this._lastResult, this._lastUpdated);
            }
            this._sendToView();
            this._notifyDashboardPanel();
        } finally {
            this._generating = false;
            // A background classification may have kept running while the blocking
            // overlay was up — resume the subtle badge if it still is.
            this._setClassifying(this._classificationStore.isBusy(), this._classificationStore.getBusyLabel());
        }
    }

    /** Forward the latest result to the standalone dashboard panel if open. */
    private _notifyDashboardPanel(): void {
        if (this._lastResult) {
            KbDashboardPanel.refresh(this._lastResult, () => this._handleExport(), this._lastUpdated);
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
            .filter((s): s is NonNullable<typeof s> => s !== undefined && s !== null);

        if (sessions.length === 0) {
            this._lastResult = null;
            return;
        }

        const cache = await this._sidecarStore.load();
        const useCategories = this._categories ?? DEFAULT_KB_TYPES;
        const refineLabels = vscode.workspace.getConfiguration('chatwizard').get<boolean>('kbRefineLabels', true);
        // Shared + incremental: sessions the automatic classifier already covered
        // are reused; only new/updated chats are classified here.
        const result = await buildKbEntries(
            sessions, cache, useCategories, onProgress, refineLabels, this._classificationStore, this._folders(),
        );
        this._lastResult = result;

        // ── Auto-tag sessions with KB categories ─────────────────────────
        const autoTagEnabled = vscode.workspace.getConfiguration('chatwizard').get<boolean>('kbAutoTagSessions', true);
        if (autoTagEnabled && result.entries.length > 0) {
            // Tag each entry concurrently
            await Promise.all(result.entries.map(async (entry) => {
                // Remove prior KB tags first to avoid accumulation across generations
                const meta = cache?.get(entry.sessionId);
                const existingTags = meta?.tags ?? [];
                const nonKbTags = existingTags.filter(t => !t.startsWith('kb-category:') && !t.startsWith('kb-group:'));
                if (nonKbTags.length !== existingTags.length) {
                    await this._sidecarStore.patch(entry.sessionId, { tags: nonKbTags });
                }

                // Tag: kb-category:<top-level-folder>
                const folderTag = `kb-category:${entry.type.toLowerCase().replace(/\s+/g, '-')}`;
                await this._sidecarStore.addTag(entry.sessionId, folderTag);
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
                payload: { slices: [], total: 0, sessionsReady, lastUpdated: this._lastUpdated },
            });
            return;
        }

        const result = this._lastResult;
        void this._view.webview.postMessage({
            type: 'update',
            payload: {
                ...KbDashboardPanel.buildPayload(result, this._lastUpdated),
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

/**
 * Stable signature of a KB result's *labels* (session → topic / sub-topic).
 *
 * Used to skip redrawing the pie chart when a background classification run
 * produced exactly the same labels — the user must never see the chart change
 * for no reason at all.
 */
export function kbResultSignature(result: KbEngineResult | null): string {
    if (!result || result.entries.length === 0) { return ''; }
    const parts = result.entries
        .map(e => `${e.sessionId}\u0001${e.type}\u0001${e.subtype ?? ''}`)
        .sort();
    return `${parts.length}:${parts.join('\u0002')}`;
}
