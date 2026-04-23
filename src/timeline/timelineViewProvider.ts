// src/timeline/timelineViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { buildTimeline, TimelineEntry } from './timelineBuilder';
import {
    buildHeatMap, buildWorkBursts, buildTopicDrift, buildTimelineStats, findFirstMatchingEntry,
    HeatMapCell, WorkBurst, WeekTerms, TimelineStats,
} from './timelineFeatures';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';
import { SessionSource } from '../types/index';

export interface TimelineFilter {
    source?: SessionSource; // filter by source
}

const INITIAL_MONTHS = 3;
const LOAD_MORE_MONTHS = 3;
const HEATMAP_MAX_DAYS = 364;

export class TimelineViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardTimeline';

    private _view?: vscode.WebviewView;
    private _filter: TimelineFilter = {};

    /** Full unfiltered timeline (for jump-to-month dropdown). */
    private _allEntries: TimelineEntry[] = [];
    /** Filtered timeline (source of truth for pagination). */
    private _allFilteredEntries: TimelineEntry[] = [];
    /** YYYY-MM keys of months whose entries have been sent to the webview. */
    private _loadedMonthKeys: Set<string> = new Set();

    // Feature caches
    private _stats: TimelineStats | null = null;
    private _heatMap: HeatMapCell[] = [];
    private _bursts: WorkBurst[] = [];
    private _topicDrift: WeekTerms[] = [];
    private _dayFilter: string | undefined = undefined;
    private _searchQuery: string = '';
    private _firstMatchId: string | undefined = undefined;

    constructor(
        private readonly _index: SessionIndex,
        private readonly _context: vscode.ExtensionContext,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        webviewView.webview.options = { enableScripts: true };
        this._view = webviewView;

        // Set shell HTML once — never reassigned
        webviewView.webview.html = TimelineViewProvider.getShellHtml();

        webviewView.webview.onDidReceiveMessage((msg: {
            command?: string; sessionId?: string; filter?: TimelineFilter;
            type?: string; month?: string; date?: string; query?: string; note?: string;
        }) => {
            if (msg.command === 'openSession') {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId! });
            } else if (msg.command === 'setFilter') {
                this._filter = msg.filter ?? {};
                this._dayFilter = undefined;
                this._sendInitial();
            } else if (msg.command === 'loadMore') {
                this._sendMore();
            } else if (msg.command === 'jumpToMonth') {
                this._sendMore(msg.month);
            } else if (msg.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
            } else if (msg.command === 'filterByDay') {
                this._dayFilter = msg.date || undefined;
                this._sendInitial();
            } else if (msg.command === 'clearDayFilter') {
                this._dayFilter = undefined;
                this._sendInitial();
            } else if (msg.command === 'setSearchQuery') {
                this._searchQuery = (msg.query ?? '').toLowerCase().trim();
                if (this._searchQuery) {
                    const match = findFirstMatchingEntry(this._allFilteredEntries, this._searchQuery);
                    this._firstMatchId = match?.sessionId;
                } else {
                    this._firstMatchId = undefined;
                }
                void this._view?.webview.postMessage({
                    type: 'searchResult',
                    data: { firstMatchId: this._firstMatchId, query: this._searchQuery },
                });
            } else if (msg.command === 'saveNote') {
                void this._setJournalNote(msg.date!, msg.note ?? '');
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

    // ── Journal note helpers ─────────────────────────────────────────────────

    private _getJournalNotes(): Record<string, string> {
        return this._context.globalState.get<Record<string, string>>('cwJournalNotes', {});
    }

    private async _setJournalNote(date: string, note: string): Promise<void> {
        const notes = this._getJournalNotes();
        if (note.trim() === '') {
            delete notes[date];
        } else {
            notes[date] = note.trim();
        }
        await this._context.globalState.update('cwJournalNotes', notes);
        void this._view?.webview.postMessage({ type: 'noteUpdate', data: { date, note: note.trim() } });
    }

    // ── Pagination helpers ───────────────────────────────────────────────────

    private _rebuildCache(): void {
        const sessions = this._index.getAllSummaries()
            .map(s => this._index.get(s.id)!)
            .filter(Boolean);

        this._allEntries = buildTimeline(sessions);

        const base = this._allEntries.filter(entry => {
            if (this._filter.source !== undefined && entry.source !== this._filter.source) {
                return false;
            }
            return true;
        });

        // Compute feature data on the full filtered set (not day-filtered)
        this._stats = buildTimelineStats(base);
        this._heatMap = buildHeatMap(base).slice(-HEATMAP_MAX_DAYS);
        this._bursts = buildWorkBursts(base);
        this._topicDrift = buildTopicDrift(base);

        // Apply day filter for the displayed entries
        if (this._dayFilter) {
            this._allFilteredEntries = base.filter(e => e.date === this._dayFilter);
        } else {
            this._allFilteredEntries = base;
        }

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

            if (untilYm === undefined && !newMonths.has(ym) && newMonths.size >= monthCount) { break; }
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

    private _burstsForEntries(entries: TimelineEntry[]): WorkBurst[] {
        const entryIds = new Set(entries.map(e => e.sessionId));
        return this._bursts.filter(b => b.sessionIds.some(sid => entryIds.has(sid)));
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
            data: {
                entries,
                filter: this._filter,
                allEntries: this._allEntries,
                hasMore: this._hasMore(),
                totalCount,
                stats: this._stats,
                heatMap: this._heatMap,
                topicDrift: this._topicDrift,
                bursts: this._burstsForEntries(entries),
                journalNotes: this._getJournalNotes(),
                dayFilter: this._dayFilter,
                firstMatchId: this._firstMatchId,
            },
        });
    }

    /** Load the next batch (or up to `untilYm`) and send as `appendMonths`. */
    private _sendMore(untilYm?: string): void {
        if (!this._view) { return; }
        const entries = this._sliceNextMonths(LOAD_MORE_MONTHS, untilYm);
        if (entries.length === 0) { return; }
        void this._view.webview.postMessage({
            type: 'appendMonths',
            data: {
                entries,
                hasMore: this._hasMore(),
                scrollToMonth: untilYm,
                bursts: this._burstsForEntries(entries),
                journalNotes: this._getJournalNotes(),
            },
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

    /* ── Stats banner ── */
    #stats-banner {
      display: none;
      flex-wrap: wrap;
      gap: 12px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--cw-border);
      font-size: 0.8em;
    }
    .stat-chip { opacity: 0.65; }
    .stat-chip strong { opacity: 1; color: var(--cw-accent); }

    /* ── On-this-day callout ── */
    #on-this-day {
      display: none;
      padding: 6px 14px;
      border-left: 3px solid var(--cw-accent);
      margin: 6px 10px;
      font-size: 0.82em;
      background: var(--cw-surface-raised);
      border-radius: 0 var(--cw-radius-sm) var(--cw-radius-sm) 0;
    }

    /* ── Topic drift ribbon ── */
    #drift-ribbon {
      display: none;
      overflow-x: auto;
      padding: 4px 10px;
      border-bottom: 1px solid var(--cw-border);
      font-size: 0.73em;
      white-space: nowrap;
    }
    .drift-week {
      display: inline-block;
      padding: 2px 8px;
      border-right: 1px solid var(--cw-border);
      opacity: 0.6;
    }
    .drift-week:last-child { border-right: none; }
    .drift-week-label { font-weight: 700; color: var(--cw-accent); margin-right: 4px; }

    /* ── Heat map ── */
    #heatmap-section {
      display: none;
      padding: 8px 14px 4px;
      border-bottom: 1px solid var(--cw-border);
    }
    #heatmap-container {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      line-height: 0;
    }
    .hm-cell {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      cursor: pointer;
      background: var(--cw-border);
    }
    .hm-cell[data-intensity="1"] { background: color-mix(in srgb, var(--cw-accent) 25%, transparent); }
    .hm-cell[data-intensity="2"] { background: color-mix(in srgb, var(--cw-accent) 50%, transparent); }
    .hm-cell[data-intensity="3"] { background: color-mix(in srgb, var(--cw-accent) 75%, transparent); }
    .hm-cell[data-intensity="4"] { background: var(--cw-accent); }
    .hm-cell.hm-selected { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
    #day-filter-bar {
      display: none;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 0.8em;
    }

    /* ── Search bar ── */
    #search-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--cw-border);
    }
    #tl-search {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      padding: 3px 7px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 0.85em;
    }
    #tl-search-status { font-size: 0.78em; opacity: 0.6; white-space: nowrap; }
    .entry.tl-first-match { outline: 2px solid var(--cw-accent); outline-offset: 2px; }

    /* ── Freshness bar ── */
    #freshness-bar {
      padding: 4px 14px;
      font-size: 0.78em;
      opacity: 0.55;
      border-bottom: 1px solid var(--cw-border);
      display: none;
    }

    /* ── Month groups ── */
    .month-group { margin: 0; }

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

    /* ── Work burst ── */
    .burst-header {
      margin: 8px 10px 2px;
      padding: 5px 14px;
      background: var(--cw-surface);
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-sm);
      font-size: 0.78em;
      font-weight: 600;
      opacity: 0.8;
    }

    /* ── Entries ── */
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

    .entry.entry-in-burst { margin-left: 18px; }

    .entry.tool-switch-highlight {
      border-color: var(--cw-accent);
      background: color-mix(in srgb, var(--cw-accent) 6%, var(--cw-surface-raised));
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

    /* ── Journal notes ── */
    .journal-note-area {
      font-size: 0.79em;
      padding: 2px 14px 4px;
      color: var(--cw-accent);
      font-style: italic;
      cursor: pointer;
      opacity: 0.75;
    }
    .journal-note-area:empty::before { content: '+ Add note'; opacity: 0.35; font-style: italic; }
    .journal-edit-row {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
      align-items: flex-start;
    }
    .journal-edit-row textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      border-radius: 3px;
      padding: 4px 6px;
      font-family: inherit;
      font-size: 0.82em;
      resize: vertical;
      min-height: 44px;
    }

    /* ── Empty / loading states ── */
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
      <option value="antigravity">Antigravity</option>
    </select>
    <label>Jump to</label>
    <select id="jumpDate" onchange="jumpToMonth(this.value)" aria-label="Jump to month">
      <option value="">Month&hellip;</option>
    </select>
  </div>

  <!-- Stats / streak banner -->
  <div id="stats-banner" aria-live="polite"></div>

  <!-- On-this-day callout -->
  <div id="on-this-day"></div>

  <!-- Topic drift ribbon -->
  <div id="drift-ribbon" aria-label="Topic drift by week"></div>

  <!-- Heat map -->
  <div id="heatmap-section">
    <div id="heatmap-container" role="grid" aria-label="Activity calendar"></div>
    <div id="day-filter-bar">
      Showing: <span id="day-filter-label"></span>
      <button id="clear-day-filter" class="cw-btn" style="padding:2px 8px;font-size:0.78em">Clear</button>
    </div>
  </div>

  <!-- First-occurrence search -->
  <div id="search-bar">
    <input id="tl-search" type="text" placeholder="Jump to first occurrence\u2026" aria-label="Timeline search">
    <button id="tl-search-btn" class="cw-btn">Find</button>
    <span id="tl-search-status"></span>
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

  // Global burst map (updated incrementally on appendMonths)
  var globalAllSidToBurst = new Map();
  // Global journal notes (full map, refreshed on each update/appendMonths)
  var globalJournalNotes = {};

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const SRC_LABEL = {
    claude: 'Claude Code', copilot: 'GitHub Copilot', cline: 'Cline',
    roocode: 'Roo Code', cursor: 'Cursor', windsurf: 'Windsurf', aider: 'Aider',
    antigravity: 'Google Antigravity'
  };

  function applyFilter() {
    const src = document.getElementById('srcFilter').value;
    vscode.postMessage({ command: 'setFilter', filter: { source: src || undefined } });
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

  // ── Heat map ────────────────────────────────────────────────────────────────

  function hmIntensity(count, max) {
    if (count === 0 || max === 0) { return 0; }
    const pct = count / max;
    if (pct < 0.25) { return 1; }
    if (pct < 0.5)  { return 2; }
    if (pct < 0.75) { return 3; }
    return 4;
  }

  function renderHeatMap(heatMap, dayFilter) {
    const section = document.getElementById('heatmap-section');
    if (!heatMap || heatMap.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    const max = Math.max.apply(null, heatMap.map(function(c) { return c.count; }));
    var cells = '';
    heatMap.forEach(function(cell) {
      const intensity = hmIntensity(cell.count, max);
      const selected  = dayFilter === cell.date ? ' hm-selected' : '';
      cells += '<div class="hm-cell' + selected + '" data-date="' + escHtml(cell.date)
             + '" data-count="' + cell.count + '" data-intensity="' + intensity
             + '" role="gridcell" tabindex="0" title="' + escHtml(cell.date) + ': ' + cell.count + ' sessions"></div>';
    });
    document.getElementById('heatmap-container').innerHTML = cells;
    const filterBar = document.getElementById('day-filter-bar');
    if (dayFilter) {
      filterBar.style.display = 'flex';
      document.getElementById('day-filter-label').textContent = dayFilter;
    } else {
      filterBar.style.display = 'none';
    }
  }

  // ── Stats banner ────────────────────────────────────────────────────────────

  function renderStatsBanner(stats) {
    var el = document.getElementById('stats-banner');
    if (!stats) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML =
      '<span class="stat-chip">This week: <strong>' + stats.activeDaysThisWeek + ' day' + (stats.activeDaysThisWeek === 1 ? '' : 's') + '</strong></span>'
      + '<span class="stat-chip">Sessions: <strong>' + stats.totalSessions + '</strong></span>'
      + '<span class="stat-chip">Streak: <strong>' + stats.currentStreak + 'd</strong></span>'
      + '<span class="stat-chip">Best: <strong>' + stats.longestStreak + 'd</strong></span>';
  }

  // ── On-this-day callout ─────────────────────────────────────────────────────

  function renderOnThisDay(onThisDay) {
    var el = document.getElementById('on-this-day');
    if (!onThisDay || onThisDay.length === 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    var label = onThisDay.length === 1
      ? escHtml(onThisDay[0].sessionTitle)
      : onThisDay.length + ' sessions';
    el.innerHTML = '&#128197; On this day last month: ' + label;
  }

  // ── Topic drift ribbon ──────────────────────────────────────────────────────

  function renderDriftRibbon(drift) {
    var el = document.getElementById('drift-ribbon');
    if (!drift || drift.length === 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    var html = '';
    drift.forEach(function(w) {
      html += '<span class="drift-week"><span class="drift-week-label">' + escHtml(w.weekKey) + '</span>'
           + escHtml(w.terms.join(', ')) + '</span>';
    });
    el.innerHTML = html;
  }

  // ── Burst map helpers ───────────────────────────────────────────────────────

  function updateGlobalBurstMap(bursts) {
    (bursts || []).forEach(function(b) {
      b.sessionIds.forEach(function(sid) { globalAllSidToBurst.set(sid, b); });
    });
  }

  function renderBurstHeaderHtml(burst) {
    const durText = burst.durationMinutes < 60
      ? burst.durationMinutes + 'm'
      : (burst.durationMinutes / 60).toFixed(1) + 'h';
    const srcText = burst.sources.join(' + ');
    return '<div class="burst-header">'
      + '&#9889; Work burst \u00b7 ' + burst.sessionCount + ' sessions \u00b7 ' + escHtml(durText)
      + ' \u00b7 ' + escHtml(srcText) + '</div>';
  }

  // ── Entry rendering ─────────────────────────────────────────────────────────

  function renderEntryHtml(entry, fadeIdx) {
    const fadeAttr     = fadeIdx < 25 ? ' style="--cw-i:' + fadeIdx + '"' : '';
    const sourceLabel  = (SRC_LABEL && SRC_LABEL[entry.source]) ? SRC_LABEL[entry.source] : entry.source;
    const badgeClass   = entry.source === 'copilot' ? 'cw-badge-copilot'
                       : entry.source === 'antigravity' ? 'cw-badge-antigravity'
                       : 'cw-badge-claude';
    const wsMeta       = entry.workspaceName || '(unknown workspace)';
    const promptText   = entry.firstPrompt   || '(no prompt)';
    const ariaLabel    = escHtml(entry.sessionTitle) + ', ' + sourceLabel + ', ' + escHtml(entry.date);
    const inBurst      = globalAllSidToBurst.has(entry.sessionId) ? ' entry-in-burst' : '';
    const switchClass  = entry.toolSwitchHighlight ? ' tool-switch-highlight' : '';
    const switchTip    = entry.toolSwitchHighlight ? ' title="Tool switch: you switched AI tools within the last 30 minutes"' : '';
    return '<div class="entry cw-fade-item' + inBurst + switchClass + '"' + fadeAttr
      + ' data-sid="' + escHtml(entry.sessionId) + '"'
      + ' role="button" tabindex="0" aria-label="' + ariaLabel + '"' + switchTip + '>'
      + '<div class="entry-title">' + escHtml(entry.sessionTitle) + '<span class="' + badgeClass + '">' + escHtml(sourceLabel) + '</span>'
      + (entry.toolSwitchHighlight ? '<span style="font-size:0.75em;opacity:0.6" title="Tool switch">&#8646;</span>' : '')
      + '</div>'
      + '<div class="entry-meta">' + escHtml(wsMeta) + ' \u00b7 ' + entry.messageCount + ' messages \u00b7 ' + entry.promptCount + ' prompts \u00b7 ' + escHtml(entry.date) + '</div>'
      + '<div class="entry-prompt">' + escHtml(promptText) + '</div>'
      + '</div>';
  }

  // ── Month group rendering ───────────────────────────────────────────────────

  function buildMonthGroupsHtml(entries, startFadeIdx) {
    // Group by month
    const monthMap = new Map();
    entries.forEach(function(entry) {
      const ym = entry.date.slice(0, 7);
      if (!monthMap.has(ym)) { monthMap.set(ym, new Map()); }
      const dayMap = monthMap.get(ym);
      if (!dayMap.has(entry.date)) { dayMap.set(entry.date, []); }
      dayMap.get(entry.date).push(entry);
    });

    let fadeIdx = startFadeIdx || 0;
    let html = '';

    monthMap.forEach(function(dayMap, ym) {
      let monthHtml = '<div class="month-header" id="month-' + escHtml(ym) + '">' + escHtml(monthLabel(ym)) + '</div>';

      const seenBursts = new Set();
      dayMap.forEach(function(dayEntries, date) {
        dayEntries.forEach(function(entry) {
          const burst = globalAllSidToBurst.get(entry.sessionId);
          if (burst && !seenBursts.has(burst.burstId)) {
            seenBursts.add(burst.burstId);
            monthHtml += renderBurstHeaderHtml(burst);
          }
          monthHtml += renderEntryHtml(entry, fadeIdx++);
        });
        // Journal note area for this day
        const note = (globalJournalNotes && globalJournalNotes[date]) || '';
        monthHtml += '<div class="journal-note-area" data-note-date="' + escHtml(date) + '">' + escHtml(note) + '</div>';
      });

      html += '<div class="month-group" data-month="' + escHtml(ym) + '">' + monthHtml + '</div>';
    });

    return html;
  }

  // ── Load more button ────────────────────────────────────────────────────────

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

  // ── Workspace / jump dropdowns ──────────────────────────────────────────────

  function populateJumpDropdown(allEntries, currentFilter) {
    const seenYm = new Set();
    const months = [];
    allEntries.forEach(function(e) {
      const ym = e.date.slice(0, 7);
      if (currentFilter && currentFilter.source && e.source !== currentFilter.source) { return; }
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

  // ── Main render functions ───────────────────────────────────────────────────

  function renderTimeline(data) {
    const entries    = data.entries    || [];
    const filter     = data.filter     || {};
    const allEntries = data.allEntries || [];
    const scrollTop  = window.scrollY;

    // Update globals
    globalAllSidToBurst = new Map();
    updateGlobalBurstMap(data.bursts);
    globalJournalNotes = data.journalNotes || {};

    document.getElementById('srcFilter').value = filter.source || '';
    populateJumpDropdown(allEntries, filter);

    // Render new features
    renderStatsBanner(data.stats);
    renderOnThisDay(data.stats ? data.stats.onThisDayLastMonth : []);
    renderDriftRibbon(data.topicDrift);
    renderHeatMap(data.heatMap, data.dayFilter);

    // Render main feed
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

    // Highlight first match if present
    if (data.firstMatchId) {
      var t = document.querySelector('[data-sid="' + data.firstMatchId + '"]');
      if (t) { t.classList.add('tl-first-match'); }
    }

    if (data.totalCount) {
      var fb = document.getElementById('freshness-bar');
      fb.style.display = '';
      fb.textContent = data.totalCount.toLocaleString() + ' session' + (data.totalCount === 1 ? '' : 's') + ' indexed'
        + (data.dayFilter ? ' \u00b7 Filtered to ' + data.dayFilter : '');
    }
  }

  function appendMonths(data) {
    const entries = data.entries || [];
    if (entries.length === 0) { return; }

    // Merge new burst data
    updateGlobalBurstMap(data.bursts);
    if (data.journalNotes) { globalJournalNotes = data.journalNotes; }

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

  // ── Search ──────────────────────────────────────────────────────────────────

  function applyTimelineSearch() {
    var q = document.getElementById('tl-search').value.trim();
    vscode.postMessage({ command: 'setSearchQuery', query: q });
  }

  document.getElementById('tl-search-btn').addEventListener('click', applyTimelineSearch);
  document.getElementById('tl-search').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { applyTimelineSearch(); }
  });

  // ── Click / keyboard handlers ───────────────────────────────────────────────

  document.addEventListener('click', function(e) {
    // Heat map cell
    var hmCell = e.target && e.target.closest ? e.target.closest('.hm-cell') : null;
    if (hmCell) {
      vscode.postMessage({ command: 'filterByDay', date: hmCell.dataset.date });
      return;
    }

    // Clear day filter
    var clearBtn = e.target && e.target.closest ? e.target.closest('#clear-day-filter') : null;
    if (clearBtn) {
      vscode.postMessage({ command: 'clearDayFilter' });
      return;
    }

    // Journal note area — toggle edit row
    var noteArea = e.target && e.target.closest ? e.target.closest('.journal-note-area') : null;
    if (noteArea && !(noteArea.nextElementSibling && noteArea.nextElementSibling.classList.contains('journal-edit-row'))) {
      var date = noteArea.dataset.noteDate;
      var existing = noteArea.textContent;
      var editRow = document.createElement('div');
      editRow.className = 'journal-edit-row';
      var ta = document.createElement('textarea');
      ta.value = existing;
      var saveBtn = document.createElement('button');
      saveBtn.className = 'cw-btn cw-btn-save-note';
      saveBtn.textContent = 'Save';
      saveBtn.dataset.date = date;
      editRow.appendChild(ta);
      editRow.appendChild(saveBtn);
      noteArea.insertAdjacentElement('afterend', editRow);
      ta.focus();
      return;
    }

    // Save note button
    var saveNoteBtn = e.target && e.target.closest ? e.target.closest('.cw-btn-save-note') : null;
    if (saveNoteBtn) {
      var date2 = saveNoteBtn.dataset.date;
      var note = saveNoteBtn.previousElementSibling.value;
      vscode.postMessage({ command: 'saveNote', date: date2, note: note });
      saveNoteBtn.closest('.journal-edit-row').remove();
      return;
    }

    // Session entry
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

  // ── Message handler ─────────────────────────────────────────────────────────

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg && msg.type === 'update') {
      renderTimeline(msg.data);
    } else if (msg && msg.type === 'appendMonths') {
      appendMonths(msg.data);
    } else if (msg && msg.type === 'searchResult') {
      // Remove previous highlight
      var prev = document.querySelector('.tl-first-match');
      if (prev) { prev.classList.remove('tl-first-match'); }
      var status = document.getElementById('tl-search-status');
      if (!msg.data.firstMatchId) {
        status.textContent = msg.data.query ? 'No match found' : '';
        return;
      }
      var target = document.querySelector('[data-sid="' + msg.data.firstMatchId + '"]');
      if (target) {
        target.classList.add('tl-first-match');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        status.textContent = 'Earliest match';
      } else {
        status.textContent = '(match in unloaded months \u2014 load more)';
      }
    } else if (msg && msg.type === 'noteUpdate') {
      var noteEl = document.querySelector('[data-note-date="' + msg.data.date + '"]');
      if (noteEl) { noteEl.textContent = msg.data.note; }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }


}
