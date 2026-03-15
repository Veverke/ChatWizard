// src/timeline/timelineViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { buildTimeline, TimelineEntry } from './timelineBuilder';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';
import { generateNonce } from '../views/webviewUtils';

export interface TimelineFilter {
    workspacePath?: string;        // filter to a specific workspace path (exact match)
    source?: 'copilot' | 'claude'; // filter by source
}

const INITIAL_MONTHS = 3;
const LOAD_MORE_MONTHS = 3;

export class TimelineViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardTimeline';

    private _view?: vscode.WebviewView;
    private _filter: TimelineFilter = {};

    /** Full unfiltered timeline (for workspace dropdown). */
    private _allEntries: TimelineEntry[] = [];
    /** Filtered timeline (source of truth for pagination). */
    private _allFilteredEntries: TimelineEntry[] = [];
    /** YYYY-MM keys of months whose entries have been sent to the webview. */
    private _loadedMonthKeys: Set<string> = new Set();

    constructor(
        private readonly _index: SessionIndex,
        private readonly _extensionUri?: vscode.Uri
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        let codiconCssUri: string | undefined;
        if (this._extensionUri) {
            const codiconDistUri = vscode.Uri.joinPath(
                this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'
            );
            webviewView.webview.options = { enableScripts: true, localResourceRoots: [codiconDistUri] };
            codiconCssUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(codiconDistUri, 'codicon.css')
            ).toString();
        } else {
            webviewView.webview.options = { enableScripts: true };
        }
        this._view = webviewView;

        // Set shell HTML once — never reassigned
        webviewView.webview.html = TimelineViewProvider.getShellHtml(codiconCssUri, webviewView.webview.cspSource);

        webviewView.webview.onDidReceiveMessage((msg: { command?: string; sessionId?: string; filter?: TimelineFilter; type?: string; month?: string }) => {
            if (msg.command === 'openSession') {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId! });
            } else if (msg.command === 'setFilter') {
                this._filter = msg.filter ?? {};
                this._sendInitial();
            } else if (msg.command === 'loadMore') {
                this._sendMore();
            } else if (msg.command === 'jumpToMonth') {
                this._sendMore(msg.month);
            } else if (msg.type === 'ready') {
                this._sendInitial();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendInitial(); }
        });
    }

    /** Re-render the view when the session index changes. No-op if the view is not visible. */
    refresh(): void {
        if (this._view?.visible) { this._sendInitial(); }
    }

    // ── Pagination helpers ───────────────────────────────────────────────────

    private _rebuildCache(): void {
        const sessions = this._index.getAllSummaries()
            .map(s => this._index.get(s.id)!)
            .filter(Boolean);

        this._allEntries = buildTimeline(sessions);
        this._allFilteredEntries = this._allEntries.filter(entry => {
            if (this._filter.workspacePath !== undefined && entry.workspacePath !== this._filter.workspacePath) {
                return false;
            }
            if (this._filter.source !== undefined && entry.source !== this._filter.source) {
                return false;
            }
            return true;
        });
        this._loadedMonthKeys = new Set();
    }

    /**
     * Advance the loaded window by `monthCount` new months (or until `untilYm` inclusive).
     * Returns only the entries in the newly loaded months; mutates `_loadedMonthKeys`.
     */
    private _sliceNextMonths(monthCount: number, untilYm?: string): TimelineEntry[] {
        const result: TimelineEntry[] = [];
        const newMonths = new Set<string>();

        for (const entry of this._allFilteredEntries) {
            const ym = entry.date.slice(0, 7);
            if (this._loadedMonthKeys.has(ym)) { continue; }

            // Stop condition for regular loadMore: enough new months
            if (untilYm === undefined && !newMonths.has(ym) && newMonths.size >= monthCount) { break; }

            // Stop condition for jumpToMonth: we've gone past the target (entries newest-first)
            if (untilYm !== undefined && ym < untilYm) { break; }

            newMonths.add(ym);
            result.push(entry);
        }

        for (const ym of newMonths) { this._loadedMonthKeys.add(ym); }
        return result;
    }

    private _hasMore(): boolean {
        return this._allFilteredEntries.some(e => !this._loadedMonthKeys.has(e.date.slice(0, 7)));
    }

    // ── Send helpers ─────────────────────────────────────────────────────────

    /** Full reset + initial 3 months. */
    private _sendInitial(): void {
        if (!this._view) { return; }
        this._rebuildCache();
        const entries = this._sliceNextMonths(INITIAL_MONTHS);
        void this._view.webview.postMessage({
            type: 'update',
            data: { entries, filter: this._filter, allEntries: this._allEntries, hasMore: this._hasMore() },
        });
    }

    /** Load the next batch (or up to `untilYm`) and send as `appendMonths`. */
    private _sendMore(untilYm?: string): void {
        if (!this._view) { return; }
        const entries = this._sliceNextMonths(LOAD_MORE_MONTHS, untilYm);
        if (entries.length === 0) { return; }
        void this._view.webview.postMessage({
            type: 'appendMonths',
            data: { entries, hasMore: this._hasMore(), scrollToMonth: untilYm },
        });
    }

    static getShellHtml(codiconCssUri?: string, cspSource?: string): string {
        const nonce = generateNonce();
        const fontSrc   = cspSource ? ` font-src ${cspSource};` : '';
        const codiconLk = codiconCssUri
            ? `<link rel="stylesheet" href="${codiconCssUri}">`
            : '';
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${cspSource ?? ''};${fontSrc}">
  ${codiconLk}
  <style nonce="${nonce}">
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

    .load-more-btn {
      display: block;
      width: calc(100% - 20px);
      margin: 10px;
      padding: 8px;
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      cursor: pointer;
      font-family: inherit;
      font-size: 0.85em;
      text-align: center;
    }

    .load-more-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.22));
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
  <div id="timeline-content">
    <div id="cw-tl-skeleton">
      <div style="height:10px;width:38%;margin:10px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:68%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:42%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:88%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:38%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:92%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:74%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:44%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:78%"></div></div>
      <div style="height:10px;width:32%;margin:14px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:62%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:35%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:82%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:48%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:70%"></div></div>
    </div>
  </div>
  <div id="load-more-container"></div>
<script nonce="${nonce}">
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
    // If the month is already in the DOM, scroll to it (or closest older one)
    const existing = document.querySelector('[data-month="' + month + '"]');
    if (existing) {
      existing.querySelector('.month-header').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Check if the month is older than what's currently loaded
    const headers = Array.from(document.querySelectorAll('[data-month]'));
    const oldest = headers.length > 0 ? headers[headers.length - 1].dataset.month : null;
    if (oldest && month < oldest) {
      // Request extension to load entries up to (and including) this month
      vscode.postMessage({ command: 'jumpToMonth', month: month });
      return;
    }
    // Scroll to closest loaded month at or before target
    const target = headers.find(function(el) { return el.dataset.month <= month; });
    if (target) { target.querySelector('.month-header').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  function monthLabel(ym) {
    return new Date(ym + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderEntryHtml(entry, fadeIdx) {
    const fadeAttr   = fadeIdx < 25 ? ' style="--cw-i:' + fadeIdx + '"' : '';
    const sourceLabel = entry.source === 'copilot' ? 'Copilot' : 'Claude';
    const badgeClass  = entry.source === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
    const wsMeta      = entry.workspaceName || '(unknown workspace)';
    const promptText  = entry.firstPrompt   || '(no prompt)';
    return '<div class="entry cw-fade-item"' + fadeAttr + ' data-sid="' + escHtml(entry.sessionId) + '">'
      + '<div class="entry-title">' + escHtml(entry.sessionTitle) + '<span class="' + badgeClass + '">' + escHtml(sourceLabel) + '</span></div>'
      + '<div class="entry-meta">' + escHtml(wsMeta) + ' \\u00b7 ' + entry.messageCount + ' messages \\u00b7 ' + entry.promptCount + ' prompts \\u00b7 ' + escHtml(entry.date) + '</div>'
      + '<div class="entry-prompt">' + escHtml(promptText) + '</div>'
      + '</div>';
  }

  function buildMonthGroupsHtml(entries, startFadeIdx) {
    const monthMap = new Map();
    entries.forEach(function(entry) {
      const ym = entry.date.slice(0, 7);
      if (!monthMap.has(ym)) { monthMap.set(ym, []); }
      monthMap.get(ym).push(entry);
    });

    let fadeIdx = startFadeIdx || 0;
    let html = '';
    monthMap.forEach(function(monthEntries, ym) {
      const label = monthLabel(ym);
      let entryRows = '';
      monthEntries.forEach(function(entry) { entryRows += renderEntryHtml(entry, fadeIdx++); });
      html +=
        '<div class="month-group" data-month="' + escHtml(ym) + '">'
        + '<div class="month-header" id="month-' + escHtml(ym) + '">' + escHtml(label) + '</div>'
        + entryRows
        + '</div>';
    });
    return html;
  }

  function setLoadMoreBtn(hasMore) {
    const container = document.getElementById('load-more-container');
    container.innerHTML = hasMore
      ? '<button class="load-more-btn" id="load-more-btn">Load earlier months</button>'
      : '';
    if (hasMore) {
      document.getElementById('load-more-btn').addEventListener('click', function() {
        vscode.postMessage({ command: 'loadMore' });
      });
    }
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
    document.getElementById('srcFilter').value = filter.source || '';

    // Render entries (full replace for filter change / initial load)
    const container = document.getElementById('timeline-content');
    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No sessions found.</div>';
    } else {
      container.innerHTML = buildMonthGroupsHtml(entries, 0);
    }

    setLoadMoreBtn(!!data.hasMore);
    window.scrollTo(0, scrollTop);
  }

  function appendMonths(data) {
    const entries = data.entries || [];
    if (entries.length === 0) { return; }

    // Count existing entries for fade index
    const existingCount = document.querySelectorAll('.entry').length;
    const html = buildMonthGroupsHtml(entries, existingCount);

    const container = document.getElementById('timeline-content');
    container.insertAdjacentHTML('beforeend', html);

    setLoadMoreBtn(!!data.hasMore);

    // Scroll to requested month if specified
    if (data.scrollToMonth) {
      const target = document.getElementById('month-' + data.scrollToMonth);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
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
    } else if (msg && msg.type === 'appendMonths') {
      appendMonths(msg.data);
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
</script>
<script nonce="${nonce}">${cwInteractiveJs()}</script>
</body>
</html>`;
    }

    static getHtml(entries: TimelineEntry[], filter: TimelineFilter = {}): string {
        const e = TimelineViewProvider._e.bind(TimelineViewProvider);
        const nonce = generateNonce();

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
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
<script nonce="${nonce}">
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
<script nonce="${nonce}">${cwInteractiveJs()}</script>
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
