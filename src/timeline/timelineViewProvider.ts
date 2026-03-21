// src/timeline/timelineViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { buildTimeline, TimelineEntry } from './timelineBuilder';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';

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
            } else if (msg.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
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
        const totalCount = this._index.getAllSummaries().length;
        void this._view.webview.postMessage({
            type: 'update',
            data: { entries, filter: this._filter, allEntries: this._allEntries, hasMore: this._hasMore(), totalCount },
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

    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }

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

    .filter-bar select {
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

    #freshness-bar {
      padding: 4px 14px;
      font-size: 0.78em;
      opacity: 0.55;
      border-bottom: 1px solid var(--cw-border);
      display: none;
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

    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }

    .cw-btn {
      font-size: 0.85em;
      padding: 4px 14px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
    }
    .cw-btn:hover { background: var(--cw-accent); color: var(--cw-accent-text); border-color: var(--cw-accent); }

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
    <select id="srcFilter" onchange="applyFilter()" aria-label="Filter by source">
      <option value="">All</option>
      <option value="copilot">Copilot</option>
      <option value="claude">Claude</option>
    </select>
    <label>Jump to</label>
    <select id="jumpDate" onchange="jumpToMonth(this.value)" aria-label="Jump to month">
      <option value="">Month&hellip;</option>
    </select>
    <label>Workspace</label>
    <select id="wsFilter" onchange="applyFilter()" aria-label="Filter by workspace">
      <option value="">All workspaces</option>
    </select>
  </div>
  <div id="freshness-bar" aria-live="polite"></div>
  <div id="timeline-content">
    <div id="cw-tl-skeleton">
      <div style="height:10px;width:38%;margin:10px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:68%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:42%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:88%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:38%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:92%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:74%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:44%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:78%"></div></div>
      <div style="height:10px;width:32%;margin:14px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:62%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:35%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:82%"></div></div>
    </div>
  </div>
  <div id="load-more-container"></div>
<script>
  ${cwInteractiveJs()}
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

  function jumpToMonth(val) {
    if (!val) { return; }
    const existing = document.querySelector('[data-month="' + val + '"]');
    if (existing) {
      const header = existing.querySelector('.month-header');
      if (header) {
        const top = header.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      return;
    }
    const headers = Array.from(document.querySelectorAll('[data-month]'));
    const oldest = headers.length > 0 ? headers[headers.length - 1].dataset.month : null;
    if (oldest && val < oldest) {
      vscode.postMessage({ command: 'jumpToMonth', month: val });
      return;
    }
    const target = headers.find(function(el) { return el.dataset.month <= val; });
    if (target) {
      const header = target.querySelector('.month-header');
      if (header) {
        const top = header.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  function monthLabel(ym) {
    return new Date(ym + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderEntryHtml(entry, fadeIdx) {
    const fadeAttr    = fadeIdx < 25 ? ' style="--cw-i:' + fadeIdx + '"' : '';
    const sourceLabel = entry.source === 'copilot' ? 'Copilot' : 'Claude';
    const badgeClass  = entry.source === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
    const wsMeta      = entry.workspaceName || '(unknown workspace)';
    const promptText  = entry.firstPrompt   || '(no prompt)';
    const ariaLabel   = escHtml(entry.sessionTitle) + ', ' + sourceLabel + ', ' + escHtml(entry.date);
    return '<div class="entry cw-fade-item"' + fadeAttr
      + ' data-sid="' + escHtml(entry.sessionId) + '"'
      + ' role="button" tabindex="0" aria-label="' + ariaLabel + '">'
      + '<div class="entry-title">' + escHtml(entry.sessionTitle) + '<span class="' + badgeClass + '">' + escHtml(sourceLabel) + '</span></div>'
      + '<div class="entry-meta">' + escHtml(wsMeta) + ' \u00b7 ' + entry.messageCount + ' messages \u00b7 ' + entry.promptCount + ' prompts \u00b7 ' + escHtml(entry.date) + '</div>'
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

  function populateJumpDropdown(allEntries, currentFilter) {
    const seenYm = new Set();
    const months = [];
    allEntries.forEach(function(e) {
      const ym = e.date.slice(0, 7);
      if (currentFilter && currentFilter.source && e.source !== currentFilter.source) { return; }
      if (currentFilter && currentFilter.workspacePath && e.workspacePath !== currentFilter.workspacePath) { return; }
      if (!seenYm.has(ym)) { seenYm.add(ym); months.push(ym); }
    });
    const sel = document.getElementById('jumpDate');
    const saved = sel.value;
    let opts = '<option value="">Month\u2026</option>';
    months.forEach(function(ym) {
      opts += '<option value="' + escHtml(ym) + '">' + escHtml(monthLabel(ym)) + '</option>';
    });
    sel.innerHTML = opts;
    if (saved && seenYm.has(saved)) { sel.value = saved; }
  }

  function renderTimeline(data) {
    const entries    = data.entries    || [];
    const filter     = data.filter     || {};
    const allEntries = data.allEntries || [];
    const scrollTop  = window.scrollY;

    // Rebuild workspace dropdown
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
    if (filter.workspacePath !== undefined) {
      wsFilter.value = filter.workspacePath;
    } else if (workspaces.some(function(w) { return w.workspacePath === savedWs; })) {
      wsFilter.value = savedWs;
    }

    document.getElementById('srcFilter').value = filter.source || '';

    populateJumpDropdown(allEntries, filter);

    const container = document.getElementById('timeline-content');
    if (entries.length === 0) {
      if (!data.totalCount) {
        container.innerHTML =
          '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No sessions indexed yet.</p>'
          + '<p class="empty-state-body">Chat Wizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="cw-btn" id="btn-cfg">Configure Paths</button>'
          + '</div></div>';
        document.getElementById('btn-cfg').addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); });
      } else {
        container.innerHTML = '<div class="empty-state">No sessions match this filter.</div>';
      }
    } else {
      container.innerHTML = buildMonthGroupsHtml(entries, 0);
    }

    setLoadMoreBtn(!!data.hasMore);
    window.scrollTo(0, scrollTop);

    if (data.totalCount) {
      var fb = document.getElementById('freshness-bar');
      fb.style.display = '';
      fb.textContent = data.totalCount.toLocaleString() + ' session' + (data.totalCount === 1 ? '' : 's') + ' indexed';
    }
  }

  function appendMonths(data) {
    const entries = data.entries || [];
    if (entries.length === 0) { return; }

    const existingCount = document.querySelectorAll('.entry').length;
    const html = buildMonthGroupsHtml(entries, existingCount);

    const container = document.getElementById('timeline-content');
    container.insertAdjacentHTML('beforeend', html);

    setLoadMoreBtn(!!data.hasMore);

    if (data.scrollToMonth) {
      const target = document.getElementById('month-' + data.scrollToMonth);
      if (target) {
        const top = target.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  document.addEventListener('click', function(e) {
    var entry = e.target && e.target.closest ? e.target.closest('.entry') : null;
    if (entry && entry.dataset.sid) {
      vscode.postMessage({ command: 'openSession', sessionId: entry.dataset.sid });
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    var entry = e.target && e.target.closest ? e.target.closest('.entry') : null;
    if (entry && entry.dataset.sid) {
      e.preventDefault();
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

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }


}
