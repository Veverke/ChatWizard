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

    constructor(private readonly _index: SessionIndex) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = { enableScripts: true };

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._update(); }
        });

        this._update();
    }

    /** Re-render the view when the session index changes. No-op if the view is not visible. */
    refresh(): void {
        if (this._view?.visible) { this._update(); }
    }

    private _update(): void {
        if (!this._view) { return; }
        this._view.webview.html = AnalyticsPanel.getLoadingHtml();
        setImmediate(() => {
            if (this._view?.visible) {
                this._view.webview.html = AnalyticsPanel.getHtml(AnalyticsPanel.build(this._index));
            }
        });
    }
}
