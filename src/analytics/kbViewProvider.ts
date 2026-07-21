// src/analytics/kbViewProvider.ts
// Feature 23 — KB Dashboard as a sidebar WebviewView tab in the Chat Wizard panel.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { buildKbEntries } from './kbEngine';
import { clusterEntries } from './kbClusterer';
import { exportKbAsync } from '../export/kbExporter';
import { KbDashboardPanel } from './kbDashboardPanel';

export class KbViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardKnowledgeBase';

    private _view?: vscode.WebviewView;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastResult: import('./kbEngine').KbEngineResult | null = null;

    constructor(
        private readonly _index: SessionIndex,
        private readonly _sidecarStore: SidecarMetadataStore,
    ) {}

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
                this._sendData();
            } else if (msg.command === 'openSession' && msg.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId });
            } else if (msg.command === 'generateKb') {
                void vscode.commands.executeCommand('chatwizard.generateKnowledgeBase');
            } else if (msg.command === 'export') {
                void this._handleExport();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendData(); }
        });
    }

    /** Re-render the view when the session index changes. Debounced 5 s. No-op if not visible. */
    refresh(): void {
        if (!this._view?.visible) { return; }
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); }
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            if (this._view?.visible) { this._sendData(); }
        }, 5000);
    }

    private _sendData(): void {
        if (!this._view) { return; }
        setImmediate(() => {
            if (!this._view?.visible) { return; }

            const summaries = this._index.getAllSummaries();
            const sessions = summaries
                .map(s => this._index.get(s.id))
                .filter((s): s is NonNullable<typeof s> => s !== null);

            if (sessions.length === 0) {
                this._lastResult = null;
                // No sessions indexed yet — show loading state, not Generate button
                void this._view.webview.postMessage({
                    type: 'update',
                    payload: { slices: [], total: 0, sessionsReady: false },
                });
                return;
            }

            void this._sidecarStore.load().then(cache => {
                const result = buildKbEntries(sessions, cache);
                this._lastResult = result;
                if (this._view?.visible) {
                    void this._view.webview.postMessage({
                        type: 'update',
                        payload: { ...KbDashboardPanel.buildPayload(result), sessionsReady: true },
                    });
                }
            });
        });
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