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

/** Distinct slice colours — same order as typeOrder below. */
const DEFAULT_COLORS = [
    '#5B8AF5',  // decision   — blue
    '#a67bf0',  // learning   — purple
    '#f0883e',  // pattern    — orange
    '#e74c3c',  // gotcha     — red
    '#2ecc71',  // architecture — green
];

/** Extended palette for user-defined custom categories. */
const CUSTOM_COLORS = [
    '#e84393', '#00cec9', '#6c5ce7', '#fd79a8', '#00b894',
    '#0984e3', '#e17055', '#636e72', '#b2bec3', '#d63031',
    '#fdcb6e', '#e056fd', '#badc58', '#f19066', '#3dc1d3',
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

    // ── Public API (used by KbViewProvider) ────────────────────────────────

    static getShellHtml(): string {
        return KbDashboardPanel._getShellHtml();
    }

    static buildPayload(result: KbEngineResult): object {
        return KbDashboardPanel._buildPayload(result);
    }

    // ── Payload builder ─────────────────────────────────────────────────────

    private static _buildPayload(result: KbEngineResult): object {
        const HEURISTIC_TYPES = new Set(['decision', 'learning', 'pattern', 'gotcha', 'architecture']);

        // Determine mode: all LLM, all heuristic, or mixed
        const hasEntries = result.entries.length > 0;
        const allLlm = hasEntries && result.entries.every(e => e.usedLlm);
        const allHeuristic = hasEntries && result.entries.every(e => !e.usedLlm);
        const mixed = hasEntries && !allLlm && !allHeuristic;
        const mode: 'llm' | 'heuristic' | 'mixed' = allHeuristic ? 'heuristic' : mixed ? 'mixed' : 'llm';

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

        // ── Top-level grouping ───────────────────────────────────────────
        let topLevelData: Array<{
            parent: string;
            parentColor: string;
            childEntries: Array<{
                type: string;
                label: string;
                count: number;
                color: string;
                entries: object[];
            }>;
        }> | null = null;

        // Helper: map entry to display object
        const mapEntry = (e: KbEntry) => ({
            sessionId: e.sessionId,
            title: e.title,
            summary: e.summary.slice(0, 200),
            createdAt: e.createdAt.slice(0, 10),
            tags: e.tags,
        });

        // Helper: build child entry from type
        const buildChildEntry = (t: string, colorIdx: number) => {
            const rawEntries = result.grouped.get(t) ?? [];
            if (rawEntries.length === 0) return null;
            return {
                type: t,
                label: getTypeLabel(t),
                count: rawEntries.length,
                color: getTypeColor(t, colorIdx >= 0 ? colorIdx : allTypes.length),
                entries: rawEntries.map(mapEntry),
            };
        };

        const tlColors = ['#5B8AF5', '#e74c3c', '#2ecc71', '#f0883e', '#a67bf0', '#e84393', '#00cec9', '#6c5ce7', '#fd79a8', '#00b894', '#0984e3', '#e17055'];

        function getTlColor(label: string): string {
            const hash = Array.from(label.toLowerCase()).reduce((acc, c) => acc + c.charCodeAt(0), 0);
            return tlColors[hash % tlColors.length];
        }

        if (result.topLevelGrouping && result.topLevelGrouping.size > 0) {
            topLevelData = [];

            // Collect all child labels covered by top-level groups
            const coveredChildren = new Set<string>();
            for (const childLabels of result.topLevelGrouping.values()) {
                for (const cl of childLabels) { coveredChildren.add(cl); }
            }

            // Find types that exist but aren't covered by any group
            const uncoveredTypes = Array.from(presentTypes).filter(t => !coveredChildren.has(t));

            // Heuristic types that are uncovered
            const heuristicUncovered = uncoveredTypes.filter(t => HEURISTIC_TYPES.has(t));

            // Non-heuristic uncovered types (LLM categories the LLM forgot to group)
            const llmUncovered = uncoveredTypes.filter(t => !HEURISTIC_TYPES.has(t));

            // Build top-level groups from the LLM result.
            for (const [parentLabel, childLabels] of result.topLevelGrouping.entries()) {
                const isOther = parentLabel.toLowerCase() === 'other';
                const childEntries: Array<{
                    type: string; label: string; count: number; color: string; entries: object[];
                }> = [];

                // Add LLM children — skip children whose label matches the parent
                // (self-referential pair, e.g. "Vs Code" → ["Vs Code", "Vs Code Config"])
                for (const childLabel of childLabels) {
                    if (childLabel === parentLabel) continue;
                    const child = buildChildEntry(childLabel, allTypes.indexOf(childLabel));
                    if (child) childEntries.push(child);
                }

                // If all children were self-referential, treat the parent as uncovered
                // so it renders as a flat slice instead of disappearing.
                let allSelfReferential = false;
                if (childEntries.length === 0 && childLabels.length > 0) {
                    allSelfReferential = true;
                    coveredChildren.delete(parentLabel);
                }

                if (childEntries.length === 0) continue;

                if (isOther) {
                    // "Other" is not a meaningful group name — flatten its LLM children
                    // as individual top-level slices in all modes.
                    for (const child of childEntries) {
                        topLevelData.push({
                            parent: child.label,
                            parentColor: getTlColor(child.label),
                            childEntries: [child],
                        });
                    }
                } else {
                    // Normal group: add as a top-level group with sub-children
                    topLevelData.push({
                        parent: parentLabel,
                        parentColor: getTlColor(parentLabel),
                        childEntries,
                    });
                }
            }

            // In mixed mode: add heuristic uncovered types under "Other"
            if (mixed && heuristicUncovered.length > 0) {
                const otherChildren: Array<{
                    type: string; label: string; count: number; color: string; entries: object[];
                }> = [];
                for (const ht of heuristicUncovered) {
                    const child = buildChildEntry(ht, allTypes.indexOf(ht));
                    if (child) otherChildren.push(child);
                }
                if (otherChildren.length > 0) {
                    topLevelData.push({
                        parent: 'Other',
                        parentColor: getTlColor('Other'),
                        childEntries: otherChildren,
                    });
                }
            }

            // Add any LLM-uncovered types as individual top-level slices (all modes)
            for (const t of llmUncovered) {
                const child = buildChildEntry(t, allTypes.indexOf(t));
                if (!child) continue;
                topLevelData.push({
                    parent: getTypeLabel(t),
                    parentColor: getTlColor(getTypeLabel(t)),
                    childEntries: [child],
                });
            }
        }

        // ── Flat slices (fallback / child drill view) ────────────────────
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

        // In all-heuristic mode, signal that clicking a pie slice should go
        // directly to the drill-down table, not a sub-pie chart.
        const skipChildPieChart = allHeuristic;

        return { slices, total: result.total, topLevelData, usedLlm: result.usedLlm, mode, skipChildPieChart };
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
    .mode-badge.heuristic {
      background: #f0883e;
      color: #fff;
    }
    .mode-badge.mixed {
      background: #e67e22;
      color: #fff;
    }
    #dashboard-content { display: none; }
    #empty-state { display: none; }
    #loading-state { text-align: center; padding: 40px 20px; opacity: 0.6; }
    </style>
</head>
<body>
  <div class="section">
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
        var st = vscode.getState && vscode.getState() || {};
        st._drillStack = [];
        vscode.setState(st);
        // Re-render using the stored payload
        if (st.lastPayload) {
          renderDashboard(st.lastPayload);
        }
      }

      function renderBreadcrumbs(drillStack, topLevelData) {
        var el = document.getElementById('breadcrumbs');
        if (!el) return;
        if (!drillStack || drillStack.length === 0) {
          el.innerHTML = '';
          return;
        }
        var parts = [];
        // "All Categories" crumb
        parts.push('<span class="crumb" data-crumb="root">All Categories</span>');
        parts.push('<span class="sep">›</span>');
        // Drill stack: each level is a crumb
        drillStack.forEach(function(level, idx) {
          var isLast = idx === drillStack.length - 1;
          parts.push('<span class="crumb' + (isLast ? ' active' : '') + '" data-crumb="' + idx + '">' + escHtml(level) + '</span>');
          if (!isLast) {
            parts.push('<span class="sep">›</span>');
          }
        });
        el.innerHTML = parts.join('');
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

        // Render breadcrumbs with current label appended for display only
        // (don't mutate persistent _drillStack, so breadcrumb navigation still works)
        var parentStack = cur._drillStack || [];
        var displayStack = parentStack.concat([typeLabel + ' (' + entries.length + ')']);
        var topTl = cur._topLevelData;
        renderBreadcrumbs(displayStack, topTl);
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
        var mode = payload.mode || (usedLlm ? 'llm' : 'heuristic');

        // Update mode badge
        var badge = document.getElementById('mode-badge');
        if (total > 0) {
          var modeLabel = mode === 'mixed' ? 'LLM+Heuristics' : mode === 'llm' ? 'LLM' : 'Heuristic';
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

        var st = vscode.getState && vscode.getState() || {};
        var drillStack = st._drillStack || [];

        // Render breadcrumbs
        renderBreadcrumbs(drillStack, topLevelData);

        // Decide which slices to render in the chart
        var chartSlices = null;

        if (drillStack.length === 0 && topLevelData) {
          // ── Top-level overview ──
          chartSlices = topLevelData.map(function(tl, idx) {
            var childCount = tl.childEntries.reduce(function(sum, c) { return sum + c.count; }, 0);
            return {
              type: tl.parent,
              label: tl.parent,
              count: childCount,
              color: tl.parentColor,
              entries: null,
              childData: tl.childEntries,
              isTopLevel: true,
            };
          });
          st._topLevelData = topLevelData;
          vscode.setState(st);
        } else if (drillStack.length > 0 && topLevelData) {
          // ── Child level: drillStack[0] is the selected parent ──
          var activeParent = drillStack[0];
          var tlGroup = topLevelData.find(function(t) { return t.parent === activeParent; });
          if (tlGroup) {
            chartSlices = tlGroup.childEntries.map(function(c) {
              return {
                type: c.type,
                label: c.label,
                count: c.count,
                color: c.color,
                entries: c.entries,
                childData: null,
                isTopLevel: false,
              };
            });
          } else {
            chartSlices = slices;
          }
        } else {
          // ── Flat fallback (no hierarchy) ──
          chartSlices = slices;
        }

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
                  var dStack = st2._drillStack || [];
                  // Build current chartSlices the same way as renderDashboard
                  var curSlices;
                  if (dStack.length === 0 && topTl) {
                    curSlices = topTl.map(function(tl) {
                      return {
                        type: tl.parent,
                        label: tl.parent,
                        count: tl.childEntries.reduce(function(s, c) { return s + c.count; }, 0),
                        entries: null,
                        childData: tl.childEntries,
                        isTopLevel: true,
                      };
                    });
                  } else if (dStack.length > 0 && topTl) {
                    var activeP = dStack[0];
                    var tlG = topTl.find(function(t) { return t.parent === activeP; });
                    curSlices = tlG ? tlG.childEntries.map(function(c) {
                      return { type: c.type, label: c.label, count: c.count, color: c.color, entries: c.entries, isTopLevel: false };
                    }) : (st2.lastPayload && st2.lastPayload.slices || []);
                  } else {
                    curSlices = st2.lastPayload && st2.lastPayload.slices || [];
                  }
                  var sl = curSlices && curSlices[idx];
                  if (sl && sl.count > 0) {
                    if (sl.isTopLevel && sl.childData) {
                      // Drill into top-level → show child pie chart
                      var newStack = [sl.type];
                      var ns = vscode.getState && vscode.getState() || {};
                      ns._drillStack = newStack;
                      vscode.setState(ns);
                      // Re-render with stored payload
                      if (ns.lastPayload) { renderDashboard(ns.lastPayload); }
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
        var dStack = st._drillStack || [];
        var payload = st.lastPayload;

        if (dStack.length === 0 && topTl) {
          // Top-level: find the parent group and drill
          var tlG = topTl.find(function(t) { return t.parent === type; });
          if (tlG && tlG.childEntries.length > 0) {
            st._drillStack = [type];
            vscode.setState(st);
            if (payload) { renderDashboard(payload); }
          }
        } else if (dStack.length > 0 && topTl) {
          // Child level: find the child slice entries
          var activeP = dStack[0];
          var tlG2 = topTl.find(function(t) { return t.parent === activeP; });
          if (tlG2) {
            var child = tlG2.childEntries.find(function(c) { return c.type === type; });
            if (child && child.entries && child.count > 0) {
              showDrillView(child.label, child.entries);
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
        idx = parseInt(idx, 10);
        if (isNaN(idx)) return;
        var st = vscode.getState && vscode.getState() || {};
        var dStack = st._drillStack || [];
        if (idx < dStack.length - 1) {
          // Navigate to that level
          st._drillStack = dStack.slice(0, idx + 1);
          vscode.setState(st);
          if (st.lastPayload) { renderDashboard(st.lastPayload); }
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
        if (msg && msg.type === 'update') {
          renderDashboard(msg.payload);
          // Persist payload so legend chip clicks can drill down; preserve existing state
          var existing = vscode.getState && vscode.getState() || {};
          existing.lastPayload = msg.payload;
          // Preserve _drillStack if set; if payload has topLevelData, store it
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