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

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { void this._update(); }
        });

        webviewView.webview.onDidReceiveMessage((message: { command: string; text: string }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text);
                void vscode.window.showInformationMessage('Prompt copied to clipboard.');
            }
        });

        void this._update();
    }

    /** Re-render the view when the session index changes. No-op if the view is not visible. */
    refresh(): void {
        if (this._view?.visible) {
            this._cacheVersion++;
            void this._update();
        }
    }

    private async _update(): Promise<void> {
        if (!this._view) { return; }
        this._view.webview.html = PromptLibraryPanel.getLoadingHtml();
        const entries = buildPromptLibrary(this._index);
        const result = await clusterPromptsAsync(entries, 0.6, String(this._cacheVersion));
        if (this._view) {
            this._view.webview.html = PromptLibraryPanel.getHtml(result.clusters, result.truncated);
        }
    }
}
