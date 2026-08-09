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

/** Extended palette for user-defined custom categories. */
const CUSTOM_COLORS = [
    '#e84393',  // hot pink
    '#fdcb6e',  // amber
    '#00cec9',  // teal
    '#6c5ce7',  // deep purple
    '#e17055',  // terracotta
    '#55efc4',  // mint
    '#fd79a8',  // rose
    '#74b9ff',  // light blue
    '#a29bfe',  // lavender
    '#ffeaa7',  // cream
    '#00b894',  // emerald
    '#d63031',  // crimson
    '#badc58',  // lime
    '#55a3e8',  // sky blue
    '#f19066',  // salmon
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
    private static _exportCb: (() => Promise<void>) | null = null;

    static show(
        context: vscode.ExtensionContext,
        result: KbEngineResult,
        exportFn: () => Promise<void>,
    ): void {
        KbDashboardPanel._currentResult = result;
        KbDashboardPanel._exportCb = exportFn;

        if (KbDashboardPanel._panel) {
            KbDashboardPanel._panel.reveal(vscode.ViewColumn.One);
            void KbDashboardPanel._panel.webview.postMessage({
                type: 'update',
                payload: KbDashboardPanel._buildPayload(result),
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
                            payload: KbDashboardPanel._buildPayload(KbDashboardPanel._currentResult),
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

    static refresh(result: KbEngineResult, exportFn: () => Promise<void>): void {
        KbDashboardPanel._currentResult = result;
        KbDashboardPanel._exportCb = exportFn;
        if (!KbDashboardPanel._panel) { return; }
        void KbDashboardPanel._panel.webview.postMessage({
            type: 'update',
            payload: KbDashboardPanel._buildPayload(result),
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

    static buildPayload(result: KbEngineResult): object {
        return KbDashboardPanel._buildPayload(result);
    }

    // ── Payload builder ─────────────────────────────────────────────────────

    private static _buildPayload(result: KbEngineResult): object {
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

        // ── Top-level data: each type IS a top-level folder ─────────────
        const topLevelData = allTypes.map((t) => {
            const rawEntries = result.grouped.get(t) ?? [];
            return {
                parent: getTypeLabel(t),
                parentColor: getTypeColor(t, allTypes.indexOf(t)),
                childEntries: [{
                    type: t,
                    label: getTypeLabel(t),
                    count: rawEntries.length,
                    color: getTypeColor(t, allTypes.indexOf(t)),
                    entries: rawEntries.map(mapEntry),
                }],
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

        return { slices, total: result.total, topLevelData, usedLlm: result.usedLlm, mode };
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

    .empty-state {
      text-align: center;
      opacity: 0.5;
      padding: 40px 20px;
      font-style: italic;
    }
    .generate-btn-wrap {
      text-align: center;
      padding: 40px 20px;
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
    #loading-state { text-align: center; padding: 40px 20px; opacity: 0.6; }
    /* ── Generating overlay ── */
    #generating-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(26, 31, 46, 0.88);
      z-index: 100;
      align-items: center;
      justify-content: center;
      flex-direction: column;
    }
    #generating-overlay .spinner {
      display: inline-block;
      width: 32px;
      height: 32px;
      border: 3px solid var(--cw-border, rgba(255,255,255,0.15));
      border-top-color: var(--cw-accent, #5B8AF5);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
  <div class="section">
    <!-- Generating overlay: shown over all content during generation -->
    <div id="generating-overlay">
      <div class="spinner"></div>
      <p>Generating knowledge base…</p>
    </div>

    <!-- Loading state: shown before sessions are indexed -->
    <div id="loading-state">
      <p>Waiting for sessions to be indexed…</p>
    </div>

    <!-- Empty state: shown when KB has never been generated (total === 0) -->
    <div id="empty-state">
      <div class="generate-btn-wrap">
        <p style="opacity:0.7;margin:0 0 16px 0;">No knowledge base entries yet.</p>
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
        <button class="action-btn" id="exportBtn">📤 Export to Markdown</button>
      </div>

      <!-- Pie chart + legend (overview / child-level) -->
      <div id="pie-view">
        <div class="chart-wrap">
          <div class="chart-container"><canvas id="kbChart"></canvas></div>
        </div>
        <div class="legend-row" id="legend-row"></div>
      </div>

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
        var st = vscode.getState && vscode.getState() || {};
        vscode.setState(st);
        // Re-render using the stored payload
        if (st.lastPayload) {
          renderDashboard(st.lastPayload);
        }
      }

      function renderBreadcrumbs() {
        var el = document.getElementById('breadcrumbs');
        if (!el) return;
        el.innerHTML = '';
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

        // Save current drill payload so sort can re-render; preserve lastPayload
        var cur = vscode.getState && vscode.getState() || {};
        cur._drillPayload = { label: typeLabel, entries: entries };
        vscode.setState(cur);

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

        // Render breadcrumbs (cleared — no multi-level drill)
        renderBreadcrumbs();

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
                  // Read current state for overviewSlices
                  var st2 = vscode.getState && vscode.getState() || {};
                  var topTl = st2._topLevelData;
                  // Build current chartSlices the same way as renderDashboard
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
                    if (sl.isTopLevel) {
                      // Top-level slice: gather all entries from the sole child
                      var allEntries = sl.entries;
                      if (allEntries && allEntries.length > 0) {
                        showDrillView(sl.label, allEntries);
                      }
                    } else if (sl.entries) {
                      // Show drill-down table
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

      // Legend chip click → drill down
      document.getElementById('legend-row').addEventListener('click', function(e) {
        var chip = e.target && e.target.closest ? e.target.closest('.legend-chip') : null;
        if (!chip) { return; }
        var type = chip.dataset.type;
        var st = vscode.getState && vscode.getState() || {};
        var topTl = st._topLevelData;
        var payload = st.lastPayload;

        if (topTl) {
          // Find the top-level group and show its entries
          var tlG = topTl.find(function(t) { return t.parent === type; });
          if (tlG && tlG.childEntries.length > 0) {
            var allEntries = tlG.childEntries[0].entries;
            if (allEntries && allEntries.length > 0) {
              showDrillView(tlG.parent, allEntries);
            }
          }
        } else {
          // Flat view fallback: find slice by type
          if (payload) {
            var sl = payload.slices.find(function(s) { return s.type === type; });
            if (sl && sl.count > 0) { showDrillView(sl.label, sl.entries); }
          }
        }
      });

      // Breadcrumb clicks
      document.getElementById('breadcrumbs').addEventListener('click', function(e) {
        var crumb = e.target && e.target.closest ? e.target.closest('.crumb') : null;
        if (!crumb) return;
        var idx = crumb.dataset.crumb;
        if (idx === 'root') {
          showPieView();
          return;
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