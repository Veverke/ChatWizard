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
    private _cacheVersion = 0;

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

        webviewView.webview.onDidReceiveMessage((message: { command?: string; type?: string; text?: string }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text ?? '');
                void vscode.window.showInformationMessage('Prompt copied to clipboard.');
            } else if (message.type === 'ready') {
                void this._sendData();
            }
        });

        void this._sendData();
    }

    /** Re-render the view when the session index changes. No-op if the view is not visible. */
    refresh(): void {
        if (this._view?.visible) {
            this._cacheVersion++;
            void this._sendData();
        }
    }

    private async _sendData(): Promise<void> {
        if (!this._view) { return; }
        const entries = buildPromptLibrary(this._index);
        const result = await clusterPromptsAsync(entries, 0.6, String(this._cacheVersion));
        if (this._view) {
            void this._view.webview.postMessage({
                type: 'update',
                data: { clusters: result.clusters, truncated: result.truncated },
            });
        }
    }
}
