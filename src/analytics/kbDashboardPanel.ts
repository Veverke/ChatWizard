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

function getTypeColor(type: string, index: number): string {
    if (index < DEFAULT_COLORS.length) { return DEFAULT_COLORS[index]; }
    return CUSTOM_COLORS[(index - DEFAULT_COLORS.length) % CUSTOM_COLORS.length];
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
                void vscode.commands.executeCommand('chatwizard.generateKnowledgeBase');
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

        const slices = allTypes.map((t, i) => {
            const entries = result.grouped.get(t) ?? [];
            return {
                type: t,
                label: getTypeLabel(t),
                count: entries.length,
                color: getTypeColor(t, i),
                entries: entries.map(e => ({
                    sessionId: e.sessionId,
                    title: e.title,
                    summary: e.summary.slice(0, 200),
                    createdAt: e.createdAt.slice(0, 10),
                    tags: e.tags,
                })),
            };
        });
        return { slices, total: result.total };
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

    .back-btn {
      background: var(--cw-accent, #5B8AF5);
      border: none;
      color: #fff;
      border-radius: var(--cw-radius-sm, 5px);
      padding: 6px 14px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: opacity 0.15s;
    }
    .back-btn:hover { opacity: 0.85; }

    /* ── Action buttons ── */
    .action-bar {
      display: flex;
      gap: 8px;
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
    #drilldown-title {
      margin: 0;
      font-size: 1.05em;
      font-weight: 700;
      color: var(--cw-accent, #5B8AF5);
      background: var(--cw-surface-subtle, #252b40);
      padding: 6px 12px;
      border-radius: var(--cw-radius-sm, 5px);
      border-left: 4px solid var(--cw-accent, #5B8AF5);
    }
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
    <div id="dashboard-content">
      <div class="section-header">
        <h2>Knowledge Base Dashboard</h2>
        <div class="action-bar">
          <button class="action-btn" id="exportBtn">📤 Export to Markdown</button>
          <button class="action-btn" id="regenerateBtn">🔄 Regenerate</button>
        </div>
      </div>

      <!-- Pie chart + legend (overview) -->
      <div id="pie-view">
        <div class="chart-wrap">
          <div class="chart-container"><canvas id="kbChart"></canvas></div>
        </div>
        <div class="legend-row" id="legend-row"></div>
      </div>

      <!-- Drill-down table -->
      <div id="drilldown-view">
        <div class="section-header">
          <button class="back-btn" id="backBtn">← Back to Overview</button>
          <h3 id="drilldown-title"></h3>
        </div>
        <table class="data-table">
          <thead>
            <tr><th data-col="title">Title<span class="sort-arrow"></span></th><th data-col="tags">Tags<span class="sort-arrow"></span></th><th data-col="description">Description</th><th data-col="createdAt">Chat Date<span class="sort-arrow"></span></th></tr>
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
        document.getElementById('pie-view').style.display = 'block';
        document.getElementById('drilldown-view').style.display = 'none';
        document.getElementById('backBtn').style.display = 'none';
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
        document.getElementById('backBtn').style.display = 'inline-block';
        document.getElementById('drilldown-title').textContent = typeLabel + ' (' + entries.length + ' entries)';

        // Save current drill payload so sort can re-render; preserve lastPayload
        var cur = vscode.getState && vscode.getState() || {};
        cur._drillPayload = { label: typeLabel, entries: entries };
        vscode.setState(cur);

        // Apply current sort if any
        if (_sortCol) {
          entries = sortEntries(entries, _sortCol, _sortAsc);
        }

        var tbody = document.getElementById('drilldown-tbody');
        var rows = entries.map(function(e) {
          var desc = e.summary ? escHtml(e.summary.replace(/[\\n\\r]+/g, ' ')) : '—';
          var tags = (e.tags && e.tags.length > 0)
            ? e.tags.map(function(t) { return '<span class="tag-badge">' + escHtml(t) + '</span>'; }).join('')
            : '—';
          return '<tr>' +
            '<td><a class="clickable" data-sid="' + escHtml(e.sessionId) + '">' + escHtml(e.title) + '</a></td>' +
            '<td>' + tags + '</td>' +
            '<td class="desc-cell" title="' + desc + '">' + desc + '</td>' +
            '<td>' + escHtml(e.createdAt) + '</td>' +
            '</tr>';
        }).join('');
        tbody.innerHTML = rows || '<tr><td colspan="4" class="empty-state">No entries.</td></tr>';

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
        // Toggle: same col → flip direction, else asc
        if (_sortCol === col) {
          _sortAsc = !_sortAsc;
        } else {
          _sortCol = col;
          _sortAsc = true;
        }
        // Re-render with current entries from the stored payload
        var vscodeState = vscode.getState && vscode.getState();
        if (vscodeState && vscodeState._drillPayload) {
          showDrillView(vscodeState._drillPayload.label, vscodeState._drillPayload.entries);
        }
      });

      function renderDashboard(payload) {
        var slices = payload.slices || [];
        var total = payload.total || 0;
        var sessionsReady = payload.sessionsReady === true;

        // Hide everything first
        document.getElementById('loading-state').style.display = 'none';
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('dashboard-content').style.display = 'none';

        if (!sessionsReady) {
          // No sessions indexed yet — show loading
          document.getElementById('loading-state').style.display = 'block';
          return;
        }

        if (total === 0) {
          // Sessions exist but no KB entries — show empty state with Generate button
          document.getElementById('empty-state').style.display = 'block';
          return;
        }

        // Entries exist — show dashboard
        document.getElementById('dashboard-content').style.display = 'block';

        // Legend chips with count badges
        var chipsHtml = slices.map(function(s) {
          return '<span class="legend-chip" data-type="' + escHtml(s.type) + '">' +
            '<span class="dot" style="background:' + s.color + '"></span>' +
            escHtml(s.label) +
            ' <span class="count-badge">' + s.count + '</span>' +
            '</span>';
        }).join('');
        document.getElementById('legend-row').innerHTML = chipsHtml;

        // Chart.js doughnut
        var labels = slices.map(function(s) { return s.label + ' (' + s.count + ')'; });
        var data   = slices.map(function(s) { return s.count; });
        var colors = slices.map(function(s) { return s.color; });

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
                  // Always read from the persisted payload to avoid stale closure
                  var vscodeState = vscode.getState && vscode.getState();
                  var currentSlices = vscodeState && vscodeState.lastPayload && vscodeState.lastPayload.slices;
                  var sl = currentSlices && currentSlices[idx];
                  if (sl && sl.count > 0) {
                    showDrillView(sl.label, sl.entries);
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
        // Find the matching slice from the last received payload
        var vscodeState = vscode.getState && vscode.getState();
        if (vscodeState && vscodeState.lastPayload) {
          var sl = vscodeState.lastPayload.slices.find(function(s) { return s.type === type; });
          if (sl && sl.count > 0) {
            showDrillView(sl.label, sl.entries);
          }
        }
      });

      // Back button
      document.getElementById('backBtn').addEventListener('click', function() {
        showPieView();
      });

      // Export button
      document.getElementById('regenerateBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'regenerateKb' });
      });

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
          // Persist payload so legend chip clicks can drill down; preserve _drillPayload if set
          var existing = vscode.getState && vscode.getState() || {};
          existing.lastPayload = msg.payload;
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