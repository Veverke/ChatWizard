// src/analytics/kbViewProvider.ts
// Feature 23 — KB Dashboard as a sidebar WebviewView tab in the Chat Wizard panel.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { buildKbEntries } from './kbEngine';
import { clusterEntries } from './kbClusterer';
import { exportKbAsync } from '../export/kbExporter';
import { KbDashboardPanel } from './kbDashboardPanel';
import { configureCategories } from './kbCategoryConfigurator';
import { DEFAULT_KB_TYPES } from '../types/kb';

export class KbViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardKnowledgeBase';

    private _view?: vscode.WebviewView;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastResult: import('./kbEngine').KbEngineResult | null = null;
    private _categories: string[] | undefined;
    private _classifiedSessionIds: string[] | undefined;

    constructor(
        private readonly _index: SessionIndex,
        private readonly _sidecarStore: SidecarMetadataStore,
        private readonly _globalState: vscode.Memento,
    ) {
        // Restore persisted categories from previous session
        this._categories = _globalState.get<string[]>('chatwizard.kbCategories', undefined as unknown as string[]);
        this._classifiedSessionIds = _globalState.get<string[]>('chatwizard.kbClassifiedSessionIds', undefined as unknown as string[]);
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
            } else if (msg.command === 'generateKb' || msg.command === 'regenerateKb') {
                void this._handleGenerate();
            } else if (msg.command === 'export') {
                void this._handleExport();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendToView(); }
        });
    }

    /** Re-render the view when the session index changes. Debounced 5 s. No-op if not visible. */
    refresh(): void {
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); }
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            void this._computeResult().then(() => this._sendToView());
        }, 5000);
    }

    /**
     * Run KB classification in the background (no view needed).
     * Called on extension startup to auto-classify new sessions.
     */
    async preload(): Promise<void> {
        await this._computeResult();
    }

    /**
     * Set custom categories for the next KB generation.
     * Pass `undefined` to reset to default categories.
     */
    setCategories(categories: string[] | undefined): void {
        this._categories = categories;
    }

    private async _handleGenerate(): Promise<void> {
        const categories = await configureCategories();
        if (!categories) { return; } // user cancelled

        this._categories = categories;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Chat Wizard: Regenerating knowledge base…',
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
        this._sendToView();
    }

    /**
     * Build the KB result from all sessions; stores it in `_lastResult`.
     * Does NOT require the view to be visible.
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