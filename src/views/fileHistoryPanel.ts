// src/views/fileHistoryPanel.ts
// Webview panel listing all sessions that touched the currently active file.
// Opened by the 'chatwizard.showFileHistory' command.
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { Session } from '../types/index';
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
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        this.disposables.push(
            this.panel.onDidDispose(() => this.dispose()),
        );

        // Handle messages sent from the webview rows (open session click)
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage((msg: { type: string; sessionId: string; searchTerm: string }) => {
                if (msg.type !== 'openSession') { return; }
                const session = this.sessionIndex.get(msg.sessionId);
                if (!session) { return; }
                void vscode.commands.executeCommand(
                    'chatwizard.openSession',
                    { id: msg.sessionId },
                    msg.searchTerm,
                );
            }),
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
        const basename = normPath.split('/').pop() ?? '';
        const sessions: Array<{ id: string; title: string; source: string; date: string; refs: number }> = [];

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
                    refs: this.countRefs(session, basename),
                });
            }
        }

        // Primary sort: refs descending; tiebreaker: date descending
        sessions.sort((a, b) => b.refs - a.refs || b.date.localeCompare(a.date));

        const shortPath = filePath.length > 60 ? '...' + filePath.slice(-57) : filePath;
        this.panel.title = `File History: ${shortPath}`;
        this.panel.webview.html = this.buildHtml(filePath, basename, sessions);
    }

    /** Counts total occurrences of `basename` (case-insensitive) across all messages of a session. */
    private countRefs(session: Session, basename: string): number {
        if (!basename) { return 0; }
        const needle = basename.toLowerCase();
        let total = 0;
        for (const msg of session.messages) {
            if (!msg.content) { continue; }
            const hay = msg.content.toLowerCase();
            let pos = 0;
            while ((pos = hay.indexOf(needle, pos)) !== -1) { total++; pos += needle.length; }
        }
        return Math.min(total, 9_999);
    }

    private buildHtml(
        filePath: string,
        searchTerm: string,
        sessions: Array<{ id: string; title: string; source: string; date: string; refs: number }>,
    ): string {
        const escHtml = (s: string): string =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const nonce = Math.random().toString(36).slice(2);

        const rows = sessions.length === 0
            ? '<tr><td colspan="4" style="color:var(--vscode-disabledForeground)">No sessions found for this file.</td></tr>'
            : sessions.map(s => `
                <tr class="session-row" data-session-id="${escHtml(s.id)}" data-search-term="${escHtml(searchTerm)}" data-refs="${s.refs}" data-date="${escHtml(s.date)}" title="Open session">
                    <td class="refs">${s.refs}</td>
                    <td>${escHtml(s.date)}</td>
                    <td>${escHtml(s.title)}</td>
                    <td>${escHtml(s.source)}</td>
                </tr>`).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; }
  h2 { font-size: 1.1em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 16px; font-size: 0.85em; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; font-weight: 600; }
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--vscode-textLink-foreground); }
  th.sort-active { color: var(--vscode-textLink-foreground); }
  th.sort-active::after { content: ' ↓'; }
  th.sort-active.sort-asc::after { content: ' ↑'; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .refs { font-weight: 600; color: var(--vscode-charts-blue); text-align: right; width: 3em; }
  .session-row { cursor: pointer; }
  .session-row:hover td { background: var(--vscode-list-hoverBackground); }
  .session-row:active td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
</style>
</head>
<body>
<h2>Sessions referencing this file</h2>
<p class="subtitle">${escHtml(filePath)}</p>
<table>
  <thead><tr>
    <th class="sortable sort-active" data-col="refs" title="References — total occurrences of the filename in the session">Refs</th>
    <th class="sortable" data-col="date">Date</th>
    <th class="sortable" data-col="title">Session</th>
    <th class="sortable" data-col="source">Source</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // ── row click → open session ──────────────────────────────────────────────
  document.querySelectorAll('.session-row').forEach(row => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'openSession', sessionId: row.dataset.sessionId, searchTerm: row.dataset.searchTerm });
    });
  });

  // ── column sorting ────────────────────────────────────────────────────────
  let sortCol = 'refs', sortAsc = false; // initial: refs descending
  const tbody = document.querySelector('tbody');
  const headers = document.querySelectorAll('th[data-col]');

  function cellVal(row, col) {
    switch (col) {
      case 'refs':   return parseInt(row.dataset.refs, 10);
      case 'date':   return row.dataset.date;
      case 'title':  return row.cells[2].textContent.trim().toLowerCase();
      case 'source': return row.cells[3].textContent.trim().toLowerCase();
      default:       return '';
    }
  }

  function applySort(col) {
    if (sortCol === col) {
      sortAsc = !sortAsc;
    } else {
      sortCol = col;
      sortAsc = col !== 'refs'; // refs defaults desc; text columns default asc
    }
    const rows = Array.from(tbody.querySelectorAll('tr.session-row'));
    rows.sort((a, b) => {
      const va = cellVal(a, col), vb = cellVal(b, col);
      const cmp = typeof va === 'number' ? va - vb : va.localeCompare(vb);
      return sortAsc ? cmp : -cmp;
    });
    for (const r of rows) { tbody.appendChild(r); }
    headers.forEach(h => {
      h.classList.remove('sort-active', 'sort-asc');
      if (h.dataset.col === col) {
        h.classList.add('sort-active');
        if (sortAsc) { h.classList.add('sort-asc'); }
      }
    });
  }

  headers.forEach(h => h.addEventListener('click', () => applySort(h.dataset.col)));
</script>
</body>
</html>`;
    }

    dispose(): void {
        FileHistoryPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}
