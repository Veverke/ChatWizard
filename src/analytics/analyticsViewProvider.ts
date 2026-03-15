// src/analytics/analyticsViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { AnalyticsPanel } from './analyticsPanel';

/**
 * Provides the Analytics Dashboard as a sidebar WebviewView tab in the ChatWizard panel.
 */
export class AnalyticsViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardAnalytics';

    private _view?: vscode.WebviewView;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly _index: SessionIndex) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = { enableScripts: true };

        // Set shell HTML once — never reassigned
        webviewView.webview.html = AnalyticsPanel.getShellHtml();

        // When the webview signals ready, send the initial data
        webviewView.webview.onDidReceiveMessage((msg: { type: string }) => {
            if (msg.type === 'ready') { this._sendData(); }
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
            if (this._view?.visible) {
                void this._view.webview.postMessage({
                    type: 'update',
                    data: AnalyticsPanel.build(this._index),
                });
            }
        });
    }
}
