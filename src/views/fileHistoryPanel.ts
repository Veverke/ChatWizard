// src/views/fileHistoryPanel.ts
// Webview panel listing all sessions that touched the currently active file.
// Opened by the 'chatwizard.showFileHistory' command.
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';
import { friendlySourceName } from '../ui/sourceUi';

export class FileHistoryPanel implements vscode.Disposable {
    private static currentPanel: FileHistoryPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        extensionUri: vscode.Uri,
        private readonly sessionIndex: SessionIndex,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'chatwizardFileHistory',
            'ChatWizard: File History',
            vscode.ViewColumn.Beside,
            {
                enableScripts: false,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        this.disposables.push(
            this.panel.onDidDispose(() => this.dispose()),
        );
    }

    static show(
        extensionUri: vscode.Uri,
        sessionIndex: SessionIndex,
        filePath?: string,
    ): void {
        const targetPath = filePath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!targetPath) {
            void vscode.window.showInformationMessage('ChatWizard: No active file to show history for.');
            return;
        }

        if (!FileHistoryPanel.currentPanel) {
            FileHistoryPanel.currentPanel = new FileHistoryPanel(extensionUri, sessionIndex);
        }

        FileHistoryPanel.currentPanel.render(targetPath);
        FileHistoryPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    private render(filePath: string): void {
        const normPath = normalisePath(filePath);
        const sessions: Array<{ id: string; title: string; source: string; date: string }> = [];

        for (const summary of this.sessionIndex.getAllSummaries()) {
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }
            const sidecarEntities = this.sessionIndex.getSidecarMeta(summary.id)?.entities?.filePaths;
            if (
                sessionTouchesFile(session.importantFiles, normPath) ||
                sessionTouchesFile(session.chronicleData?.importantFiles, normPath) ||
                sessionMentionsFile(sidecarEntities, normPath)
            ) {
                sessions.push({
                    id: summary.id,
                    title: summary.title,
                    source: friendlySourceName(session.source),
                    date: session.updatedAt.slice(0, 10),
                });
            }
        }

        sessions.sort((a, b) => b.date.localeCompare(a.date));

        const shortPath = filePath.length > 60 ? '...' + filePath.slice(-57) : filePath;
        this.panel.title = `File History: ${shortPath}`;
        this.panel.webview.html = this.buildHtml(filePath, sessions);
    }

    private buildHtml(
        filePath: string,
        sessions: Array<{ id: string; title: string; source: string; date: string }>,
    ): string {
        const escHtml = (s: string): string =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const rows = sessions.length === 0
            ? '<tr><td colspan="3" style="color:var(--vscode-disabledForeground)">No sessions found for this file.</td></tr>'
            : sessions.map(s => `
                <tr>
                    <td>${escHtml(s.date)}</td>
                    <td>${escHtml(s.title)}</td>
                    <td>${escHtml(s.source)}</td>
                </tr>`).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; }
  h2 { font-size: 1.1em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 16px; font-size: 0.85em; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; font-weight: 600; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<h2>Sessions referencing this file</h2>
<p class="subtitle">${escHtml(filePath)}</p>
<table>
  <thead><tr><th>Date</th><th>Session</th><th>Source</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;
    }

    dispose(): void {
        FileHistoryPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}
