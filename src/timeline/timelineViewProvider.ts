// src/timeline/timelineViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { buildTimeline, TimelineEntry } from './timelineBuilder';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';

export interface TimelineFilter {
    workspacePath?: string;        // filter to a specific workspace path (exact match)
    source?: 'copilot' | 'claude'; // filter by source
}

export class TimelineViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardTimeline';

    private _view?: vscode.WebviewView;
    private _filter: TimelineFilter = {};

    constructor(private readonly _index: SessionIndex) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        webviewView.webview.options = { enableScripts: true };
        this._view = webviewView;

        // Set shell HTML once — never reassigned
        webviewView.webview.html = TimelineViewProvider.getShellHtml();

        webviewView.webview.onDidReceiveMessage((msg: { command: string; sessionId?: string; filter?: TimelineFilter; type?: string }) => {
            if (msg.command === 'openSession') {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId! });
            } else if (msg.command === 'setFilter') {
                this._filter = msg.filter ?? {};
                this._sendData();
            } else if (msg.type === 'ready') {
                this._sendData();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendData(); }
        });
    }

    /** Re-render the view when the session index changes. No-op if the view is not visible. */
    refresh(): void {
        if (this._view?.visible) { this._sendData(); }
    }

    private _sendData(): void {
        if (!this._view) { return; }

        const allEntries = buildTimeline(
            this._index.getAllSummaries()
                .map(s => this._index.get(s.id)!)
                .filter(s => s != null)
        );

        const filtered = allEntries.filter(entry => {
            if (this._filter.workspacePath !== undefined && entry.workspacePath !== this._filter.workspacePath) {
                return false;
            }
            if (this._filter.source !== undefined && entry.source !== this._filter.source) {
                return false;
            }
            return true;
        });

        void this._view.webview.postMessage({
            type: 'update',
            data: { entries: filtered, filter: this._filter, allEntries },
        });
    }

    static getShellHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .filter-bar {
      position: sticky;
      top: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--cw-border);
      background: var(--cw-surface);
      z-index: 10;
    }

    .filter-bar select,
    .filter-bar input[type=date] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: inherit;
    }

    .filter-bar label {
      font-size: 0.82em;
      opacity: 0.7;
    }

    .month-group {
      margin: 0;
    }

    .month-header {
      font-size: 0.78em;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cw-accent);
      padding: 10px 14px 4px;
      position: sticky;
      top: 41px;
      background: var(--vscode-editor-background);
      z-index: 5;
      border-bottom: 1px solid var(--cw-border);
    }

    .entry {
      margin: 5px 10px;
      padding: 9px 14px;
      border-radius: var(--cw-radius);
      border: 1px solid var(--cw-border);
      background: var(--cw-surface-raised);
      box-shadow: var(--cw-shadow);
      cursor: pointer;
      transition: box-shadow 0.14s, background 0.14s, transform 0.14s, border-color 0.14s;
    }

    .entry:hover {
      background:   var(--cw-surface-subtle);
      box-shadow:   var(--cw-shadow-hover);
      transform:    translateY(-2px);
      border-color: var(--cw-border-strong);
    }

    .entry-title {
      font-weight: 600;
      font-size: 0.93em;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .entry-meta {
      font-size: 0.78em;
      opacity: 0.55;
      margin-bottom: 3px;
    }

    .entry-prompt {
      font-size: 0.85em;
      opacity: 0.75;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      opacity: 0.5;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="filter-bar" id="filter-bar">
    <label>Source</label>
    <select id="srcFilter" onchange="applyFilter()">
      <option value="">All</option>
      <option value="copilot">Copilot</option>
      <option value="claude">Claude</option>
    </select>
    <label>Jump to</label>
    <input type="date" id="jumpDate" onchange="jumpToDate(this.value)">
    <label>Workspace</label>
    <select id="wsFilter" onchange="applyFilter()">
      <option value="">All workspaces</option>
    </select>
  </div>
  <div id="timeline-content"></div>
<script>
  const vscode = acquireVsCodeApi();

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyFilter() {
    const src = document.getElementById('srcFilter').value;
    const ws  = document.getElementById('wsFilter').value;
    vscode.postMessage({ command: 'setFilter', filter: { source: src || undefined, workspacePath: ws || undefined } });
  }

  function jumpToDate(val) {
    if (!val) { return; }
    const month = val.slice(0, 7);
    const headers = Array.from(document.querySelectorAll('[data-month]'));
    const target = headers.find(function(el) { return el.dataset.month <= month; });
    if (target) { target.querySelector('.month-header').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  function monthLabel(ym) {
    return new Date(ym + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderTimeline(data) {
    const entries    = data.entries    || [];
    const filter     = data.filter     || {};
    const allEntries = data.allEntries || [];
    const scrollTop  = window.scrollY;

    // Rebuild workspace dropdown -- collect unique workspaces from allEntries
    const wsFilter  = document.getElementById('wsFilter');
    const savedWs   = wsFilter.value;
    const seenPaths = new Set();
    const workspaces = [];
    allEntries.forEach(function(entry) {
      if (!seenPaths.has(entry.workspacePath)) {
        seenPaths.add(entry.workspacePath);
        workspaces.push({ workspacePath: entry.workspacePath, workspaceName: entry.workspaceName });
      }
    });
    let wsOptHtml = '<option value="">All workspaces</option>';
    workspaces.forEach(function(ws) {
      const label    = ws.workspaceName || ws.workspacePath;
      const selected = filter.workspacePath === ws.workspacePath ? ' selected' : '';
      wsOptHtml += '<option value="' + escHtml(ws.workspacePath) + '"' + selected + '>' + escHtml(label) + '</option>';
    });
    wsFilter.innerHTML = wsOptHtml;

    // Restore saved value if it matches filter
    if (filter.workspacePath !== undefined) {
      wsFilter.value = filter.workspacePath;
    } else if (workspaces.some(function(w) { return w.workspacePath === savedWs; })) {
      wsFilter.value = savedWs;
    }

    // Update source filter
    const srcFilter = document.getElementById('srcFilter');
    srcFilter.value = filter.source || '';

    // Render entries
    const container = document.getElementById('timeline-content');

    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No sessions found.</div>';
      window.scrollTo(0, scrollTop);
      return;
    }

    // Group by YYYY-MM
    const monthMap = new Map();
    entries.forEach(function(entry) {
      const ym = entry.date.slice(0, 7);
      if (!monthMap.has(ym)) { monthMap.set(ym, []); }
      monthMap.get(ym).push(entry);
    });

    let fadeIdx = 0;
    let html = '';
    monthMap.forEach(function(monthEntries, ym) {
      const label = monthLabel(ym);
      let entryRows = '';
      monthEntries.forEach(function(entry) {
        const fi = fadeIdx++;
        const fadeAttr   = fi < 25 ? ' style="--cw-i:' + fi + '"' : '';
        const sourceLabel = entry.source === 'copilot' ? 'Copilot' : 'Claude';
        const badgeClass  = entry.source === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
        const wsMeta      = entry.workspaceName || '(unknown workspace)';
        const promptText  = entry.firstPrompt   || '(no prompt)';
        entryRows +=
          '<div class="entry cw-fade-item"' + fadeAttr + ' data-sid="' + escHtml(entry.sessionId) + '">'
          + '<div class="entry-title">' + escHtml(entry.sessionTitle) + '<span class="' + badgeClass + '">' + escHtml(sourceLabel) + '</span></div>'
          + '<div class="entry-meta">' + escHtml(wsMeta) + ' \\u00b7 ' + entry.messageCount + ' messages \\u00b7 ' + entry.promptCount + ' prompts \\u00b7 ' + escHtml(entry.date) + '</div>'
          + '<div class="entry-prompt">' + escHtml(promptText) + '</div>'
          + '</div>';
      });
      html +=
        '<div class="month-group" data-month="' + escHtml(ym) + '">'
        + '<div class="month-header" id="month-' + escHtml(ym) + '">' + escHtml(label) + '</div>'
        + entryRows
        + '</div>';
    });

    container.innerHTML = html;
    window.scrollTo(0, scrollTop);
  }

  // Event delegation for session clicks -- avoids inline onclick escaping issues
  document.addEventListener('click', function(e) {
    var entry = e.target && e.target.closest ? e.target.closest('.entry') : null;
    if (entry && entry.dataset.sid) {
      vscode.postMessage({ command: 'openSession', sessionId: entry.dataset.sid });
    }
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg && msg.type === 'update') {
      renderTimeline(msg.data);
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
</script>
<script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }

    static getHtml(entries: TimelineEntry[], filter: TimelineFilter = {}): string {
        const e = TimelineViewProvider._e.bind(TimelineViewProvider);

        // Collect unique workspaces (preserving first-seen order)
        const seenWorkspacePaths = new Set<string>();
        const uniqueWorkspaces: { workspacePath: string; workspaceName: string }[] = [];
        for (const entry of entries) {
            if (!seenWorkspacePaths.has(entry.workspacePath)) {
                seenWorkspacePaths.add(entry.workspacePath);
                uniqueWorkspaces.push({ workspacePath: entry.workspacePath, workspaceName: entry.workspaceName });
            }
        }

        const workspaceOptions = uniqueWorkspaces.map(ws => {
            const label = ws.workspaceName || ws.workspacePath;
            const selected = filter.workspacePath === ws.workspacePath ? ' selected' : '';
            return `<option value="${e(ws.workspacePath)}"${selected}>${e(label)}</option>`;
        }).join('');

        const filterBar = `<div class="filter-bar">
  <label>Source</label><select id="srcFilter" onchange="applyFilter()"><option value="">All</option><option value="copilot"${filter.source === 'copilot' ? ' selected' : ''}>Copilot</option><option value="claude"${filter.source === 'claude' ? ' selected' : ''}>Claude</option></select>
  <label>Jump to</label><input type="date" id="jumpDate" onchange="jumpToDate(this.value)">
  <label>Workspace</label><select id="wsFilter" onchange="applyFilter()"><option value="">All workspaces</option>${workspaceOptions}</select>
</div>`;

        // Group entries by YYYY-MM
        const monthMap = new Map<string, TimelineEntry[]>();
        for (const entry of entries) {
            const ym = entry.date.slice(0, 7);
            if (!monthMap.has(ym)) { monthMap.set(ym, []); }
            monthMap.get(ym)!.push(entry);
        }

        let timelineHtml: string;
        if (entries.length === 0) {
            timelineHtml = `<div class="empty-state">No sessions found.</div>`;
        } else {
            let fadeIdx = 0;
            timelineHtml = Array.from(monthMap.entries()).map(([ym, monthEntries]) => {
                const monthLabel = TimelineViewProvider._monthLabel(ym);
                const entryRows = monthEntries.map(entry => {
                    const fi = fadeIdx++;
                    const fadeAttr = fi < 25 ? ` style="--cw-i:${fi}"` : '';
                    const sourceLabel = entry.source === 'copilot' ? 'Copilot' : 'Claude';
                    const badgeClass = entry.source === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
                    const wsMeta = entry.workspaceName || '(unknown workspace)';
                    const promptText = entry.firstPrompt || '(no prompt)';
                    return `<div class="entry cw-fade-item"${fadeAttr} onclick="openSession('${e(entry.sessionId)}')">
  <div class="entry-title">${e(entry.sessionTitle)}<span class="${badgeClass}">${e(sourceLabel)}</span></div>
  <div class="entry-meta">${e(wsMeta)} &#183; ${entry.messageCount} messages · ${entry.promptCount} prompts · ${e(entry.date)}</div>
  <div class="entry-prompt">${e(promptText)}</div>
</div>`;
                }).join('\n');

                return `<div class="month-group" data-month="${e(ym)}">
  <div class="month-header" id="month-${e(ym)}">${e(monthLabel)}</div>
  ${entryRows}
</div>`;
            }).join('\n');
        }

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .filter-bar {
      position: sticky;
      top: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--cw-border);
      background: var(--cw-surface);
      z-index: 10;
    }

    .filter-bar select,
    .filter-bar input[type=date] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: inherit;
    }

    .filter-bar label {
      font-size: 0.82em;
      opacity: 0.7;
    }

    .month-group {
      margin: 0;
    }

    .month-header {
      font-size: 0.78em;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cw-accent);
      padding: 10px 14px 4px;
      position: sticky;
      top: 41px;
      background: var(--vscode-editor-background);
      z-index: 5;
      border-bottom: 1px solid var(--cw-border);
    }

    .entry {
      margin: 5px 10px;
      padding: 9px 14px;
      border-radius: var(--cw-radius);
      border: 1px solid var(--cw-border);
      background: var(--cw-surface-raised);
      box-shadow: var(--cw-shadow);
      cursor: pointer;
      transition: box-shadow 0.14s, background 0.14s, transform 0.14s, border-color 0.14s;
    }

    .entry:hover {
      background:   var(--cw-surface-subtle);
      box-shadow:   var(--cw-shadow-hover);
      transform:    translateY(-2px);
      border-color: var(--cw-border-strong);
    }

    .entry-title {
      font-weight: 600;
      font-size: 0.93em;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .entry-meta {
      font-size: 0.78em;
      opacity: 0.55;
      margin-bottom: 3px;
    }

    .entry-prompt {
      font-size: 0.85em;
      opacity: 0.75;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      opacity: 0.5;
      font-style: italic;
    }
  </style>
</head>
<body>
${filterBar}
${timelineHtml}
<script>
  const vscode = acquireVsCodeApi();

  function openSession(sessionId) {
      vscode.postMessage({ command: 'openSession', sessionId });
  }

  function applyFilter() {
      const src = document.getElementById('srcFilter').value;
      const ws  = document.getElementById('wsFilter').value;
      vscode.postMessage({ command: 'setFilter', filter: { source: src || undefined, workspacePath: ws || undefined } });
  }

  function jumpToDate(val) {
      if (!val) { return; }
      const month = val.slice(0, 7);
      // Find the closest month header at or before the selected month
      const headers = Array.from(document.querySelectorAll('[data-month]'));
      // months are in descending order, so find first one <= selected month
      const target = headers.find(el => el.dataset.month <= month);
      if (target) { target.querySelector('.month-header').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
</script>
<script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }

    private static _e(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private static _monthLabel(ym: string): string {
        return new Date(ym + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
}
