// src/prompts/promptLibraryViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { buildPromptLibrary } from './promptExtractor';
import { clusterPromptsAsync } from './similarityEngine';
import { PromptLibraryPanel } from './promptLibraryPanel';

/**
 * Provides the Prompt Library as a sidebar WebviewView tab in the ChatWizard panel.
 */
export class PromptLibraryViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardPromptLibrary';

    private _view?: vscode.WebviewView;
    private _lastIndexVersion = -1;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly _index: SessionIndex) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = PromptLibraryPanel.getShellHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { void this._sendData(); }
        });

        webviewView.webview.onDidReceiveMessage((message: { command?: string; type?: string; text?: string; sessionId?: string; searchTerm?: string; highlightContainer?: boolean }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text ?? '');
                void vscode.window.showInformationMessage('Prompt copied to clipboard.');
            } else if (message.command === 'openSession' && message.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: message.sessionId }, message.searchTerm, message.highlightContainer);
            } else if (message.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
            } else if (message.command === 'rescan') {
                void vscode.commands.executeCommand('chatwizard.rescan');
            } else if (message.type === 'ready') {
                void this._sendData();
            }
        });

        void this._sendData();
    }

    /** Re-render the view when the session index changes. Debounced 2 s. No-op if not visible or index unchanged. */
    refresh(): void {
        if (!this._view?.visible) { return; }
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); }
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            if (this._view?.visible && this._index.version !== this._lastIndexVersion) {
                void this._sendData();
            }
        }, 2_000);
    }

    private async _sendData(): Promise<void> {
        if (!this._view) { return; }
        this._lastIndexVersion = this._index.version;
        const entries = buildPromptLibrary(this._index);
        const result = await clusterPromptsAsync(entries, 0.6, String(this._lastIndexVersion));
        if (this._view) {
            void this._view.webview.postMessage({
                type: 'update',
                data: { clusters: result.clusters, truncated: result.truncated },
            });
        }
    }
}
