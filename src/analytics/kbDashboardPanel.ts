// src/analytics/kbDashboardPanel.ts
// Feature 23 — KB Dashboard webview with doughnut chart, drill-down table, and export.

import * as vscode from 'vscode';
import type { KbEntry } from '../types/kb';
import type { KbEngineResult } from './kbEngine';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';

const TYPE_LABELS: Record<string, string> = {
    decision:     'Decisions',
    learning:     'Learnings',
    pattern:      'Patterns',
    gotcha:       'Gotchas',
    architecture: 'Architecture',
};
const DEFAULT_COLORS = [
    '#5B8AF5',  // decision   — blue
    '#a67bf0',  // learning   — purple
    '#f0883e',  // pattern    — orange
    '#e74c3c',  // gotcha     — red
    '#2ecc71',  // architecture — green
];

/**
 * Extended palette for user-defined custom categories.
 *
 * Strategy: fills hue gaps around DEFAULT_COLORS so the full 20-color
 * palette spans the entire hue wheel without adjacent-family neighbours.
 * Where a CUSTOM color shares a broad hue sector with a DEFAULT entry
 * (e.g. both "blue"), the CUSTOM variant uses a very different
 * lightness level so they are clearly distinguishable on a chart.
 */
const CUSTOM_COLORS = [
    '#ffe119',  // bright yellow         unique hue
    '#bfef45',  // lime                  unique hue
    '#42d4f4',  // cyan                  unique hue
    '#f032e6',  // magenta               unique hue
    '#9a6324',  // brown                 muted, unique hue
    '#9e9e9e',  // neutral grey          achromatic
    '#fabed4',  // light pink            unique hue
    '#469990',  // teal                  unique hue
    '#808000',  // olive                 muted, unique hue
    '#800000',  // maroon                l=25% vs red l=57%
    '#aaffc3',  // mint                  l=84% vs green l=54%
    '#ffd8b1',  // peach                 l=86% vs orange l=59%
    '#bf360c',  // rust                  l=15% vs orange l=59%
    '#000075',  // navy                  l=13% vs blue l=66%
    '#4a148c',  // deep violet           l=20% vs purple l=71%
];

const TYPE_ORDER: string[] = ['decision', 'architecture', 'pattern', 'gotcha', 'learning'];

function getTypeLabel(type: string): string {
    return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Deterministic color assignment based on type name.
 * Ensures the same category always gets the same color,
 * even when new categories are added or the result is regenerated.
 */
function getTypeColor(type: string, _index?: number): string {
    // Simple hash of the type string for deterministic selection
    const hash = Array.from(type.toLowerCase()).reduce((acc, c) => {
        return acc + c.charCodeAt(0);
    }, 0);
    const palette = [...DEFAULT_COLORS, ...CUSTOM_COLORS];
    return palette[hash % palette.length];
}

export class KbDashboardPanel {
    private static _panel: vscode.WebviewPanel | undefined;
    private static _currentResult: KbEngineResult | null = null;
    private static _lastUpdated = '';
    private static _exportCb: (() => Promise<void>) | null = null;

    static show(
        context: vscode.ExtensionContext,
        result: KbEngineResult,
        exportFn: () => Promise<void>,
        lastUpdated?: string,
    ): void {
        KbDashboardPanel._currentResult = result;
        KbDashboardPanel._lastUpdated = lastUpdated ?? '';
        KbDashboardPanel._exportCb = exportFn;

        if (KbDashboardPanel._panel) {
            KbDashboardPanel._panel.reveal(vscode.ViewColumn.One);
            void KbDashboardPanel._panel.webview.postMessage({
                type: 'update',
                payload: KbDashboardPanel._buildPayload(result, lastUpdated),
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardKbDashboard',
            'Knowledge Base Dashboard',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        KbDashboardPanel._panel = panel;
        panel.webview.html = KbDashboardPanel._getShellHtml();

        panel.webview.onDidReceiveMessage((msg: { type?: string; command?: string; sessionId?: string }) => {
            if (msg.type === 'ready' && KbDashboardPanel._panel && KbDashboardPanel._currentResult) {
                setImmediate(() => {
                    if (KbDashboardPanel._panel && KbDashboardPanel._currentResult) {
                        void KbDashboardPanel._panel.webview.postMessage({
                            type: 'update',
                            payload: KbDashboardPanel._buildPayload(KbDashboardPanel._currentResult, KbDashboardPanel._lastUpdated),
                        });
                    }
                });
            } else if (msg.command === 'openSession' && msg.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId });
            } else if (msg.command === 'export') {
                setImmediate(() => {
                    void KbDashboardPanel._exportCb?.();
                });
            } else if (msg.command === 'generateKb') {
                // Focus the sidebar KB view — it handles generation via its own message handler
                void vscode.commands.executeCommand('chatwizardKnowledgeBase.focus');
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
            KbDashboardPanel._panel = undefined;
            KbDashboardPanel._currentResult = null;
            KbDashboardPanel._exportCb = null;
        }, null, context.subscriptions);
    }

    static refresh(result: KbEngineResult, exportFn: () => Promise<void>, lastUpdated?: string): void {
        KbDashboardPanel._currentResult = result;
        KbDashboardPanel._lastUpdated = lastUpdated ?? '';
        KbDashboardPanel._exportCb = exportFn;
        if (!KbDashboardPanel._panel) { return; }
        void KbDashboardPanel._panel.webview.postMessage({
            type: 'update',
            payload: KbDashboardPanel._buildPayload(result, lastUpdated),
        });
    }

    static close(): void {
        KbDashboardPanel._panel?.dispose();
    }

    /** Send a 'generating' message to the standalone panel if open. */
    static showGenerating(): void {
        if (KbDashboardPanel._panel) {
            void KbDashboardPanel._panel.webview.postMessage({ type: 'generating' });
        }
    }

    // ── Public API (used by KbViewProvider) ────────────────────────────────

    static getShellHtml(): string {
        return KbDashboardPanel._getShellHtml();
    }

    static buildPayload(result: KbEngineResult, lastUpdated?: string): object {
        return KbDashboardPanel._buildPayload(result, lastUpdated);
    }

    // ── Payload builder ─────────────────────────────────────────────────────

    private static _buildPayload(result: KbEngineResult, lastUpdated?: string): object {
        // Determine mode: any LLM or all embedding fallback
        const hasEntries = result.entries.length > 0;
        const mode: 'llm' | 'fallback' = hasEntries && result.usedLlm ? 'llm' : 'fallback';

        // Collect all types present in the result
        const presentTypes = new Set<string>();
        for (const key of result.grouped.keys()) {
            presentTypes.add(key);
        }

        // Order: known types first (in TYPE_ORDER), then custom types alphabetically
        const knownTypes = TYPE_ORDER.filter(t => presentTypes.has(t));
        const customTypes = Array.from(presentTypes)
            .filter(t => !TYPE_ORDER.includes(t))
            .sort();

        const allTypes = [...knownTypes, ...customTypes];

        // Helper: map entry to display object
        const mapEntry = (e: KbEntry) => ({
            sessionId: e.sessionId,
            title: e.title,
            summary: e.summary.slice(0, 200),
            createdAt: e.createdAt.slice(0, 10),
            tags: e.tags,
        });

        // ── Top-level data: each type IS a top-level folder with SUBTYPE children ──
        const topLevelData = allTypes.map((t) => {
            const rawEntries = result.grouped.get(t) ?? [];
            // Group by subtype
            const subtypeMap = new Map<string, KbEntry[]>();
            for (const entry of rawEntries) {
                const key = entry.subtype || 'General';
                const arr = subtypeMap.get(key);
                if (arr) { arr.push(entry); } else { subtypeMap.set(key, [entry]); }
            }
            const childEntries = Array.from(subtypeMap.entries()).map(([subtype, entries]) => ({
                type: subtype,
                label: subtype,
                count: entries.length,
                color: getTypeColor(t + '|' + subtype, 0),
                entries: entries.map(mapEntry),
            }));
            // Sort children by count descending
            childEntries.sort((a, b) => b.count - a.count);
            return {
                parent: getTypeLabel(t),
                parentColor: getTypeColor(t, allTypes.indexOf(t)),
                childEntries,
            };
        });

        // ── Flat slices (used as fallback / child drill view) ───────────
        const slices = allTypes.map((t, i) => {
            const entries = result.grouped.get(t) ?? [];
            return {
                type: t,
                label: getTypeLabel(t),
                count: entries.length,
                color: getTypeColor(t, i),
                entries: entries.map(mapEntry),
            };
        });

        return { slices, total: result.total, topLevelData, usedLlm: result.usedLlm, mode, lastUpdated: lastUpdated ?? '' };
    }

    // ── Shell HTML ──────────────────────────────────────────────────────────

    private static _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private static _getShellHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2/dist/chartjs-plugin-datalabels.min.js"></script>
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

    .section {
      padding: 18px 20px;
      position: relative;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.2));
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-header h2 {
      font-size: 1em;
      font-weight: 600;
      margin: 0;
      padding-bottom: 0;
      border-bottom: none;
      opacity: 0.85;
    }

    /* ── Breadcrumbs ── */
    #breadcrumbs {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      font-size: 0.88em;
      margin-bottom: 10px;
      padding: 4px 0;
      min-height: 24px;
    }
    #breadcrumbs .crumb {
      cursor: pointer;
      color: var(--cw-accent, #5B8AF5);
      opacity: 0.7;
      transition: opacity 0.15s;
      white-space: nowrap;
    }
    #breadcrumbs .crumb:hover {
      opacity: 1;
      text-decoration: underline;
    }
    #breadcrumbs .crumb.active {
      opacity: 1;
      font-weight: 600;
      cursor: default;
      text-decoration: none;
    }
    #breadcrumbs .sep {
      opacity: 0.35;
      user-select: none;
      font-size: 0.85em;
    }

    /* ── Action buttons ── */
    .toolbar-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .action-btn {
      background: var(--cw-surface-raised, #1f2438);
      border: 1px solid var(--cw-border-strong, rgba(255,255,255,0.13));
      color: var(--vscode-editor-foreground);
      border-radius: var(--cw-radius-sm, 5px);
      padding: 5px 14px;
      cursor: pointer;
      font-size: 0.85em;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s;
    }
    .action-btn:hover {
      background: var(--cw-accent, #5B8AF5);
      color: #fff;
      border-color: var(--cw-accent, #5B8AF5);
    }

    /* ── Chart ── */

    /* ── Chart ── */
    .chart-wrap {
      display: flex;
      justify-content: center;
      padding: 10px 0;
    }
    .chart-container {
      position: relative;
      width: 300px;
      max-width: 100%;
    }

    /* ── Count chips on legend ── */
    .legend-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin: 8px 0 0 0;
    }
    .legend-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--cw-surface-subtle, #252b40);
      border-radius: var(--cw-radius-xs, 3px);
      padding: 3px 10px 3px 6px;
      font-size: 0.82em;
      cursor: pointer;
      transition: background 0.15s;
    }
    .legend-chip:hover {
      background: var(--cw-surface-raised, #1f2438);
    }
    .legend-chip .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .legend-chip .count-badge {
      display: inline-block;
      background: var(--cw-accent, #5B8AF5);
      color: #fff;
      border-radius: 99px;
      padding: 0 6px;
      font-size: 0.78em;
      font-weight: 600;
      line-height: 1.5;
      min-width: 18px;
      text-align: center;
    }

    /* ── Subtype level (pie chart drill) ── */
    #subtype-view { display: none; }

    /* ── Table (drill-down) ── */
    #drilldown-view { display: none; }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92em;
    }
    .data-table th {
      text-align: left;
      padding: 5px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 2px solid var(--cw-border-strong);
      font-weight: 600;
      white-space: nowrap;
      opacity: 0.85;
      cursor: pointer;
      user-select: none;
    }
    .data-table th:hover {
      opacity: 1;
    }
    .data-table th .sort-arrow {
      display: inline-block;
      margin-left: 4px;
      opacity: 0.5;
      font-size: 0.8em;
    }
    .data-table th.sorted-asc .sort-arrow::after { content: ' ▲'; opacity: 1; }
    .data-table th.sorted-desc .sort-arrow::after { content: ' ▼'; opacity: 1; }
    .data-table td {
      padding: 5px 10px;
      border-bottom: 1px solid var(--cw-border, rgba(255,255,255,0.07));
      vertical-align: top;
    }
    .data-table tr:hover td {
      background: var(--cw-surface-subtle, #252b40);
    }
    .data-table .clickable {
      color: var(--cw-accent, #5B8AF5);
      cursor: pointer;
      text-decoration: none;
    }
    .data-table .clickable:hover {
      text-decoration: underline;
    }
    .desc-cell {
      opacity: 0.8;
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag-badge {
      display: inline-block;
      background: var(--cw-accent, #5B8AF5);
      color: #fff;
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 0.82em;
      margin: 1px 3px 1px 0;
      white-space: nowrap;
    }

    .generate-btn {
      background: var(--cw-accent, #5B8AF5);
      color: #fff;
      border: none;
      border-radius: var(--cw-radius-sm, 5px);
      padding: 10px 28px;
      font-size: 1.1em;
      cursor: pointer;
    }
    .generate-btn:hover {
      opacity: 0.85;
    }
    .mode-badge {
      display: inline-block;
      font-size: 0.55em;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 99px;
      vertical-align: middle;
      margin-left: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .mode-badge.llm {
      background: #2ecc71;
      color: #fff;
    }
    .mode-badge.fallback {
      background: #f0883e;
      color: #fff;
    }
    #dashboard-content { display: none; }
    #empty-state { display: none; }
    #loading-state { display: none; }
    /* ── Centered card container for loading/empty states ── */
    .state-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
      gap: 16px;
    }
    .state-card .state-icon {
      font-size: 2.2em;
      line-height: 1;
      opacity: 0.5;
    }
    .state-card .state-title {
      font-size: 1.05em;
      font-weight: 600;
      margin: 0;
      opacity: 0.8;
    }
    .state-card .state-desc {
      font-size: 0.88em;
      margin: 0;
      opacity: 0.5;
      max-width: 280px;
      line-height: 1.5;
    }
    .state-card .spinner {
      width: 28px;
      height: 28px;
      border: 3px solid var(--cw-border, rgba(255,255,255,0.12));
      border-top-color: var(--cw-accent, #5B8AF5);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Generating overlay ── */
    #generating-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    </style>
</head>
<body>
  <div class="section">
    <!-- Generating overlay: shown over all content during generation -->
    <div id="generating-overlay">
      <div class="state-card">
        <div class="spinner"></div>
        <p class="state-title">Generating knowledge base…</p>
        <p class="state-desc">Classifying sessions by topic. This may take a moment.</p>
      </div>
    </div>

    <!-- Loading state: shown before sessions are indexed -->
    <div id="loading-state">
      <div class="state-card">
        <div class="spinner"></div>
        <p class="state-title">Waiting for sessions</p>
        <p class="state-desc">Session indexing is in progress. The knowledge base will be available once complete.</p>
      </div>
    </div>

    <!-- Empty state: shown when KB has never been generated (total === 0) -->
    <div id="empty-state">
      <div class="state-card">
        <div class="state-icon">📘</div>
        <p class="state-title">No knowledge base yet</p>
        <p class="state-desc">Generate a knowledge base from your chat history to discover patterns, decisions, and recurring topics.</p>
        <button class="generate-btn" id="generateKbBtn">⚡ Generate Knowledge Base</button>
      </div>
    </div>

    <!-- Dashboard content: shown when entries exist -->
    <div id="dashboard-content" style="position:relative;">
      <!-- Breadcrumbs -->
      <div id="breadcrumbs"></div>

      <!-- Toolbar row (right-aligned) -->
      <div class="toolbar-row">
        <span style="font-size:0.75em;opacity:0.6;margin-right:auto;">Mode: <span id="mode-badge" class="mode-badge"></span></span>
        <span id="last-updated-label" style="font-size:0.72em;opacity:0.5;margin-right:8px;"></span>
        <button class="action-btn" id="exportBtn">📤 Export to Markdown</button>
      </div>

      <!-- Pie chart + legend (overview / child-level) -->
      <div id="pie-view">
        <div class="chart-wrap">
          <div class="chart-container"><canvas id="kbChart"></canvas></div>
        </div>
        <div class="legend-row" id="legend-row"></div>
      </div>

      <!-- Subtype level placeholder (pie chart replaces content dynamically) -->
      <div id="subtype-view"></div>

      <!-- Drill-down table -->
      <div id="drilldown-view">
        <table class="data-table">
          <thead>
            <tr><th>#</th><th data-col="title">Title<span class="sort-arrow"></span></th><th data-col="tags">Tags<span class="sort-arrow"></span></th><th data-col="description">Description</th><th data-col="createdAt">Chat Date<span class="sort-arrow"></span></th></tr>
          </thead>
          <tbody id="drilldown-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    (function() {
      var vscode = acquireVsCodeApi();
      var kbChart = null;

      function escHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function showPieView() {
        hideGeneratingOverlay();
        document.getElementById('drilldown-view').style.display = 'none';
        document.getElementById('pie-view').style.display = 'block';
        renderBreadcrumbs(['Dashboard']);
        var st = vscode.getState && vscode.getState() || {};
        st._navLevel = 'top';
        vscode.setState(st);
        // Re-render using the stored payload
        if (st.lastPayload) {
          renderDashboard(st.lastPayload);
        }
      }

      function showSubtypeChart(parentLabel, childData) {
        document.getElementById('drilldown-view').style.display = 'none';
        document.getElementById('pie-view').style.display = 'block';
        renderBreadcrumbs(['Dashboard', parentLabel]);

        // Save navigation state
        var st = vscode.getState && vscode.getState() || {};
        st._navLevel = 'subtype';
        st._subtypeCategory = parentLabel;
        st._subtypeChildren = childData;
        vscode.setState(st);

        // Build chart from childData
        var labels = childData.map(function(c) { return c.label + ' (' + c.count + ')'; });
        var data   = childData.map(function(c) { return c.count; });
        var colors = childData.map(function(c) { return c.color; });

        // Legend chips
        var chipsHtml = childData.map(function(c) {
          return '<span class="legend-chip" data-type="' + escHtml(c.type) + '">' +
            '<span class="dot" style="background:' + c.color + '"></span>' +
            escHtml(c.label) +
            ' <span class="count-badge">' + c.count + '</span>' +
            '</span>';
        }).join('');
        document.getElementById('legend-row').innerHTML = chipsHtml;

        // Update chart data (chart and onClick already exist from renderDashboard)
        var ctx = document.getElementById('kbChart').getContext('2d');
        if (kbChart) {
          kbChart.data.labels = labels;
          kbChart.data.datasets[0].data = data;
          kbChart.data.datasets[0].backgroundColor = colors;
          kbChart.update('none');
        }
      }

      function renderBreadcrumbs(path) {
        var el = document.getElementById('breadcrumbs');
        if (!el) return;
        path = path || [];
        var html = '';
        for (var i = 0; i < path.length; i++) {
          if (i > 0) {
            html += '<span class="sep">›</span>';
          }
          var isLast = (i === path.length - 1);
          html += '<span class="crumb' + (isLast ? ' active' : '') + '" data-idx="' + i + '">' + escHtml(path[i]) + '</span>';
        }
        el.innerHTML = html;
      }

      function showGeneratingOverlay() {
        var el = document.getElementById('generating-overlay');
        if (el) el.style.display = 'flex';
      }

      function hideGeneratingOverlay() {
        var el = document.getElementById('generating-overlay');
        if (el) el.style.display = 'none';
      }

      var _sortCol = null;
      var _sortAsc = true;

      function sortEntries(entries, col, asc) {
        var arr = entries.slice();
        arr.sort(function(a, b) {
          var va = (a[col] || '').toLowerCase();
          var vb = (b[col] || '').toLowerCase();
          if (va < vb) return asc ? -1 : 1;
          if (va > vb) return asc ? 1 : -1;
          return 0;
        });
        return arr;
      }

      function showDrillView(typeLabel, entries) {
        document.getElementById('pie-view').style.display = 'none';
        document.getElementById('drilldown-view').style.display = 'block';

        // Determine breadcrumb path: if label contains " / ", it's category / subtype
        var parts = typeLabel.split(' / ');
        if (parts.length > 1) {
          renderBreadcrumbs(['Dashboard', parts[0], parts[1]]);
        } else {
          renderBreadcrumbs(['Dashboard', typeLabel]);
        }

        // Save current drill payload so sort can re-render and breadcrumbs can navigate back; preserve lastPayload
        var cur = vscode.getState && vscode.getState() || {};
        cur._navLevel = 'drill';
        cur._drillPayload = { label: typeLabel, entries: entries };
        vscode.setState(cur);

        // Clear sort state on new drill
        _sortCol = null;
        _sortAsc = true;

        // Apply current sort if any
        if (_sortCol) {
          entries = sortEntries(entries, _sortCol, _sortAsc);
        }

        var tbody = document.getElementById('drilldown-tbody');
        var rows = entries.map(function(e, i) {
          var desc = e.summary ? escHtml(e.summary.replace(/[\\n\\r]+/g, ' ')) : '—';
          var tags = (e.tags && e.tags.length > 0)
            ? e.tags.map(function(t) { return '<span class="tag-badge">' + escHtml(t) + '</span>'; }).join('')
            : '—';
          return '<tr>' +
            '<td style="text-align:right;opacity:0.6;font-size:0.9em;width:32px;">' + (i + 1) + '</td>' +
            '<td><a class="clickable" data-sid="' + escHtml(e.sessionId) + '">' + escHtml(e.title) + '</a></td>' +
            '<td>' + tags + '</td>' +
            '<td class="desc-cell" title="' + desc + '">' + desc + '</td>' +
            '<td>' + escHtml(e.createdAt) + '</td>' +
            '</tr>';
        }).join('');
        tbody.innerHTML = rows || '<tr><td colspan="5" class="empty-state">No entries.</td></tr>';

        // Update sort arrow classes on header
        var ths = document.querySelectorAll('#drilldown-view .data-table th[data-col]');
        ths.forEach(function(th) {
          th.classList.remove('sorted-asc', 'sorted-desc');
          if (th.dataset.col === _sortCol) {
            th.classList.add(_sortAsc ? 'sorted-asc' : 'sorted-desc');
          }
        });
      }

      // Sortable column headers (delegated)
      document.getElementById('drilldown-view').addEventListener('click', function(e) {
        var th = e.target && e.target.closest ? e.target.closest('th[data-col]') : null;
        if (!th) { return; }
        var col = th.dataset.col;
        if (!col) { return; }
        if (_sortCol === col) {
          _sortAsc = !_sortAsc;
        } else {
          _sortCol = col;
          _sortAsc = true;
        }
        var vscodeState = vscode.getState && vscode.getState();
        if (vscodeState && vscodeState._drillPayload) {
          showDrillView(vscodeState._drillPayload.label, vscodeState._drillPayload.entries);
        }
      });

      function renderDashboard(payload) {
        var slices = payload.slices || [];
        var total = payload.total || 0;
        var sessionsReady = payload.sessionsReady === true;
        var topLevelData = payload.topLevelData || null;
        var usedLlm = payload.usedLlm === true;
        var mode = payload.mode || (usedLlm ? 'llm' : 'fallback');
        var lastUpdated = payload.lastUpdated || '';

        // Update mode badge
        var badge = document.getElementById('mode-badge');
        if (total > 0) {
          var modeLabel = mode === 'fallback' ? 'Fallback' : 'LLM';
          badge.textContent = modeLabel;
          badge.className = 'mode-badge ' + mode;
        } else {
          badge.textContent = '';
          badge.className = 'mode-badge';
        }

        // Update "Last Updated" label
        var lastUpdatedEl = document.getElementById('last-updated-label');
        if (total > 0 && lastUpdated) {
          var d = new Date(lastUpdated);
          var dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          var timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          lastUpdatedEl.textContent = 'Last updated: ' + dateStr + ' ' + timeStr;
        } else {
          lastUpdatedEl.textContent = '';
        }

        document.getElementById('loading-state').style.display = 'none';
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('dashboard-content').style.display = 'none';

        if (!sessionsReady) {
          document.getElementById('loading-state').style.display = 'block';
          return;
        }
        if (total === 0) {
          document.getElementById('empty-state').style.display = 'block';
          return;
        }
        document.getElementById('dashboard-content').style.display = 'block';

        // Render breadcrumbs (reset to root)
        renderBreadcrumbs(['Dashboard']);

        // Decide which slices to render in the chart
        var chartSlices = null;

        if (topLevelData) {
          // ── Top-level overview ──
          chartSlices = topLevelData.map(function(tl, idx) {
            var childCount = tl.childEntries.reduce(function(sum, c) { return sum + c.count; }, 0);
            return {
              type: tl.parent,
              label: tl.parent,
              count: childCount,
              color: tl.parentColor,
              entries: tl.childEntries[0] && tl.childEntries[0].entries,
              childData: tl.childEntries,
              isTopLevel: true,
            };
          });
          var st = vscode.getState && vscode.getState() || {};
          st._topLevelData = topLevelData;
          vscode.setState(st);
        } else {
          // ── Flat fallback (no hierarchy) ──
          chartSlices = slices;
        }

        // Sort slices alphabetically by label for consistent chip order
        chartSlices.sort(function(a, b) {
          return a.label.localeCompare(b.label);
        });

        // ── Render chart ──
        var labels = chartSlices.map(function(s) { return s.label + ' (' + s.count + ')'; });
        var data   = chartSlices.map(function(s) { return s.count; });
        var colors = chartSlices.map(function(s) { return s.color; });

        // Legend chips
        var chipsHtml = chartSlices.map(function(s) {
          return '<span class="legend-chip" data-type="' + escHtml(s.type) + '">' +
            '<span class="dot" style="background:' + s.color + '"></span>' +
            escHtml(s.label) +
            ' <span class="count-badge">' + s.count + '</span>' +
            '</span>';
        }).join('');
        document.getElementById('legend-row').innerHTML = chipsHtml;

        // Ensure pie-view is visible and drilldown is hidden
        document.getElementById('pie-view').style.display = 'block';
        document.getElementById('drilldown-view').style.display = 'none';

        // Chart
        var ctx = document.getElementById('kbChart').getContext('2d');

        if (kbChart) {
          kbChart.data.labels = labels;
          kbChart.data.datasets[0].data = data;
          kbChart.data.datasets[0].backgroundColor = colors;
          kbChart.update('none');
        } else {
          Chart.defaults.color = getComputedStyle(document.body)
            .getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
          Chart.register(ChartDataLabels);
          kbChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: labels,
              datasets: [{
                data: data,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: getComputedStyle(document.body)
                  .getPropertyValue('--vscode-editor-background').trim() || '#181c2a',
                hoverOffset: 8,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function(ctx) {
                      var val = ctx.parsed;
                      var total = ctx.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                      var pct = total > 0 ? ' (' + Math.round(val / total * 100) + '%)' : '';
                      return ctx.label + pct;
                    }
                  }
                },
                datalabels: {
                  color: '#fff',
                  font: { weight: 'bold', size: 11 },
                  formatter: function(value, ctx2) {
                    var total = ctx2.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                    return total > 0 ? Math.round(value / total * 100) + '%' : '';
                  },
                  display: function(ctx2) {
                    var total = ctx2.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                    return total > 0 && (ctx2.dataset.data[ctx2.dataIndex] / total) >= 0.05;
                  }
                }
              },
              onClick: function(e, items) {
                if (items.length > 0) {
                  var idx = items[0].index;
                  var st2 = vscode.getState && vscode.getState() || {};
                  var navLevel = st2._navLevel || 'top';

                  if (navLevel === 'subtype') {
                    // Subtype chart — clicking a slice opens the drill table
                    var children = st2._subtypeChildren;
                    if (children && children[idx]) {
                      var child = children[idx];
                      if (child.entries && child.entries.length > 0) {
                        showDrillView(st2._subtypeCategory + ' / ' + child.label, child.entries);
                      }
                    }
                    return;
                  }

                  // Top-level navigation
                  var topTl = st2._topLevelData;
                  var curSlices;
                  if (topTl) {
                    curSlices = topTl.map(function(tl) {
                      return {
                        type: tl.parent,
                        label: tl.parent,
                        count: tl.childEntries.reduce(function(s, c) { return s + c.count; }, 0),
                        entries: tl.childEntries[0] && tl.childEntries[0].entries,
                        childData: tl.childEntries,
                        isTopLevel: true,
                      };
                    });
                  } else {
                    curSlices = st2.lastPayload && st2.lastPayload.slices || [];
                  }
                  var sl = curSlices && curSlices[idx];
                  if (sl && sl.count > 0) {
                    if (sl.isTopLevel && sl.childData && sl.childData.length > 1) {
                      // Multiple subtypes — show subtype pie chart
                      showSubtypeChart(sl.label, sl.childData);
                    } else if (sl.isTopLevel && sl.childData && sl.childData.length === 1) {
                      // Single subtype — go straight to table
                      var entries = sl.childData[0].entries;
                      if (entries && entries.length > 0) {
                        showDrillView(sl.label, entries);
                      }
                    } else if (sl.entries) {
                      showDrillView(sl.label, sl.entries);
                    }
                  }
                }
              }
            }
          });
        }
      }

      // ── Event wiring ──────────────────────────────────────────────────────

      // Legend chip click → drill to subtype chart or table
      document.getElementById('legend-row').addEventListener('click', function(e) {
        var chip = e.target && e.target.closest ? e.target.closest('.legend-chip') : null;
        if (!chip) { return; }
        var type = chip.dataset.type;
        var st = vscode.getState && vscode.getState() || {};
        var navLevel = st._navLevel || 'top';

        if (navLevel === 'subtype') {
          // Subtype level — clicking a legend chip opens the drill table
          var children = st._subtypeChildren;
          if (children) {
            var child = children.find(function(c) { return c.type === type; });
            if (child && child.entries && child.entries.length > 0) {
              showDrillView(st._subtypeCategory + ' / ' + child.label, child.entries);
            }
          }
          return;
        }

        // Top-level navigation
        var topTl = st._topLevelData;
        var payload = st.lastPayload;
        if (topTl) {
          var tlG = topTl.find(function(t) { return t.parent === type; });
          if (tlG && tlG.childEntries.length > 0) {
            if (tlG.childEntries.length > 1) {
              showSubtypeChart(tlG.parent, tlG.childEntries);
            } else {
              var entries = tlG.childEntries[0].entries;
              if (entries && entries.length > 0) {
                showDrillView(tlG.parent, entries);
              }
            }
          }
        } else {
          if (payload) {
            var sl = payload.slices.find(function(s) { return s.type === type; });
            if (sl && sl.count > 0) { showDrillView(sl.label, sl.entries); }
          }
        }
      });

      // Subtype pie chart legend chip click → drill to table
      // (handled by the same legend-row listener, no separate listener needed)

      // Breadcrumb clicks — support 3 levels: Dashboard (0) → Category (1) → Subtype (2)
      document.getElementById('breadcrumbs').addEventListener('click', function(e) {
        var crumb = e.target && e.target.closest ? e.target.closest('.crumb') : null;
        if (!crumb) return;
        var idx = parseInt(crumb.dataset.idx, 10);
        if (idx === 0) {
          showPieView();
          return;
        }
        if (idx === 1) {
          // Go back to subtype pie chart for this category
          var st = vscode.getState && vscode.getState() || {};
          var topTl = st._topLevelData;
          if (topTl) {
            // Determine which category — check drill payload or subtype state
            var catLabel;
            var drillPayload = st._drillPayload;
            if (drillPayload && drillPayload.label) {
              var parts = drillPayload.label.split(' / ');
              catLabel = parts[0];
            } else if (st._subtypeCategory) {
              catLabel = st._subtypeCategory;
            }
            if (catLabel) {
              var tlG = topTl.find(function(t) { return t.parent === catLabel; });
              if (tlG && tlG.childEntries.length > 0) {
                if (tlG.childEntries.length > 1) {
                  showSubtypeChart(tlG.parent, tlG.childEntries);
                } else {
                  var entries = tlG.childEntries[0].entries;
                  if (entries && entries.length > 0) {
                    showDrillView(tlG.parent, entries);
                  }
                }
                return;
              }
            }
          }
          // Last resort: just go back to pie
          showPieView();
        }
      });

      // Export button
      document.getElementById('exportBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'export' });
      });

      // Generate KB button
      document.getElementById('generateKbBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'generateKb' });
      });

      // Clickable title cells → open session
      document.getElementById('drilldown-tbody').addEventListener('click', function(e) {
        var link = e.target && e.target.closest ? e.target.closest('.clickable') : null;
        if (link && link.dataset.sid) {
          vscode.postMessage({ command: 'openSession', sessionId: link.dataset.sid });
        }
      });

      // Resize handler
      var _resizeTimer = null;
      window.addEventListener('resize', function() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
          if (kbChart) { kbChart.resize(); }
        }, 50);
      });

      // ── Message handler ──────────────────────────────────────────────────
      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg && msg.type === 'generating') {
          showGeneratingOverlay();
          return;
        }
        if (msg && msg.type === 'update') {
          renderDashboard(msg.payload);
          hideGeneratingOverlay();
          hideGeneratingOverlay();
          // Persist payload so legend chip clicks can drill down; preserve existing state
          var existing = vscode.getState && vscode.getState() || {};
          existing.lastPayload = msg.payload;
          // If payload has topLevelData, store it
          if (msg.payload.topLevelData) {
            existing._topLevelData = msg.payload.topLevelData;
          }
          vscode.setState(existing);
        }
      });

      // Signal ready
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
    }
}