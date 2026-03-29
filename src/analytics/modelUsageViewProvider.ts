// src/analytics/modelUsageViewProvider.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { computeModelUsage } from './modelUsageEngine';
import { cwThemeCss } from '../webview/cwTheme';
import { SessionWebviewPanel } from '../views/sessionWebviewPanel';

function toIsoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultDateRange(): { from: Date; to: Date } {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from, to };
}

export class ModelUsageViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'chatwizardModelUsage';

    private _view?: vscode.WebviewView;
    private _dateRange: { from: Date; to: Date } = defaultDateRange();
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _index: SessionIndex
    ) {
        // Subscribe to index changes and debounce refresh at 500ms
        const listener = _index.addTypedChangeListener(() => {
            this._scheduleRefresh();
        });
        _context.subscriptions.push(listener);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        // Set shell HTML once — never reassigned
        webviewView.webview.html = this.getShellHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: { type: string; from?: string; to?: string; sessionId?: string }) => {
            if (msg.type === 'ready') {
                this._sendUpdate(webviewView);
            } else if (msg.type === 'setDateRange') {
                this._handleSetDateRange(msg.from, msg.to, webviewView);
            } else if (msg.type === 'openSession' && msg.sessionId) {
                const session = this._index.get(msg.sessionId);
                if (session) {
                    void SessionWebviewPanel.show(this._context, session);
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendUpdate(webviewView); }
        });
    }

    private _handleSetDateRange(fromStr: string | undefined, toStr: string | undefined, view: vscode.WebviewView): void {
        if (!fromStr || !toStr) { return; }
        const from = new Date(fromStr);
        const to = new Date(toStr);
        if (isNaN(from.getTime()) || isNaN(to.getTime())) { return; }
        this._dateRange = from <= to ? { from, to } : { from: to, to: from };
        this._sendUpdate(view);
    }

    private _scheduleRefresh(): void {
        if (!this._view?.visible) { return; }
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); }
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            if (this._view?.visible) { this._sendUpdate(this._view); }
        }, 500);
    }

    private _sendUpdate(view: vscode.WebviewView): void {
        const summaries = this._index.getAllSummaries();
        const data = computeModelUsage(summaries, this._dateRange.from, this._dateRange.to);
        void view.webview.postMessage({
            type: 'update',
            data,
            dateRange: { from: toIsoDate(this._dateRange.from), to: toIsoDate(this._dateRange.to) },
        });
    }

    getShellHtml(_webview: vscode.Webview): string {
        const defaultRange = defaultDateRange();
        const fromStr = toIsoDate(defaultRange.from);
        const toStr   = toIsoDate(defaultRange.to);
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <title>Model Usage</title>
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0 0 32px 0;
      line-height: 1.5;
    }

    /* -- Date-range row ------------------------------------------ */
    .date-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--cw-border);
      background: var(--cw-surface);
    }

    .date-row label {
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
    }

    .date-row input[type="date"] {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 0.85em;
      background: var(--cw-surface-raised);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      padding: 2px 6px;
      cursor: pointer;
    }

    .date-row input[type="date"]:focus {
      outline: 1px solid var(--cw-accent);
      border-color: var(--cw-accent);
    }

    .presets {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-left: auto;
    }

    /* -- Content sections ----------------------------------------- */
    .section {
      padding: 14px 16px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.2));
    }

    h2 {
      font-size: 0.95em;
      font-weight: 600;
      margin: 0 0 10px 0;
      padding-bottom: 5px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.35));
      opacity: 0.85;
    }

    .chart-container {
      position: relative;
      width: 100%;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 20px 8px;
    }

    /* -- Summary table -------------------------------------------- */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }

    .data-table th {
      text-align: left;
      padding: 5px 8px;
      background: var(--cw-surface-subtle);
      border-bottom: 2px solid var(--cw-border-strong);
      font-weight: 600;
      white-space: nowrap;
      opacity: 0.85;
    }

    .data-table th.num,
    .data-table td.num { text-align: right; }

    .data-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.15));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }

    .data-table tr:last-child td { border-bottom: none; }

    .data-table tfoot td {
      font-weight: 700;
      border-top: 2px solid var(--cw-border-strong);
      background: var(--cw-surface-subtle);
    }

    .data-table tbody tr[data-sessions-idx]:hover {
      background: var(--cw-surface-raised);
      cursor: default;
    }

    .data-table td.model-sub {
      opacity: 0.55;
      font-size: 0.9em;
    }

    /* -- Shared overlay base -------------------------------------- */
    #session-overlay,
    #chart-overlay {
      position: fixed;
      z-index: 9999;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 5px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: none;
      max-width: 420px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      font-size: 0.88em;
    }

    /* -- Session hover overlay ------------------------------------ */
    #session-overlay {
      padding: 8px 0;
      min-width: 280px;
    }

    /* -- Chart bar tooltip overlay -------------------------------- */
    #chart-overlay {
      padding: 0;
      min-width: 220px;
    }

    .co-header {
      padding: 7px 14px 6px 14px;
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-menu-border, #454545);
    }

    .co-ws-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 5px 14px 2px 14px;
      font-weight: 600;
    }

    .co-ws-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .co-ws-count { flex-shrink: 0; }

    .co-asst-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 1px 14px 1px 26px;
      opacity: 0.8;
      font-size: 0.93em;
    }

    .co-asst-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .co-asst-count { flex-shrink: 0; }

    .co-asst-pct {
      opacity: 0.6;
      font-size: 0.9em;
    }

    .session-overlay-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 5px 14px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, inherit);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-overlay-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }

    .session-overlay-item:hover .sess-link {
      color: var(--vscode-menu-selectionForeground, #fff);
    }

    .sess-idx {
      opacity: 0.5;
      font-size: 0.85em;
      min-width: 18px;
      text-align: right;
      flex-shrink: 0;
    }

    .sess-req {
      color: var(--cw-accent);
      font-weight: 600;
      flex-shrink: 0;
    }

    .sess-link {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-editor-foreground);
      text-decoration: none;
      flex: 1;
    }

    /* -- Account section headings --------------------------------- */
    .account-section { display: none; } /* shown by JS when data exists */

    .account-heading {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .sel-total {
      display: none;
      margin-left: auto;
      font-size: 0.83em;
      font-weight: 600;
      color: var(--cw-accent);
      white-space: nowrap;
      letter-spacing: 0.01em;
    }

    /* -- Loading -------------------------------------------------- */
    /* -- Spinner -------------------------------------------------- */
    @keyframes cw-spin { to { transform: rotate(360deg); } }

    .cw-spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--cw-border-strong);
      border-top-color: var(--cw-accent, #5b8af5);
      border-radius: 50%;
      animation: cw-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }

    #loading-msg {
      padding: 32px 16px;
      text-align: center;
      opacity: 0.75;
    }

    #main-content { display: none; }
  </style>
</head>
<body>

<div id="loading-msg"><span class="cw-spinner"></span>Loading\u2026</div>

<div id="main-content">
  <!-- Date range controls -->
  <div class="date-row">
    <label for="from-input">From</label>
    <input type="date" id="from-input" value="${fromStr}">
    <label for="to-input">To</label>
    <input type="date" id="to-input" value="${toStr}">
    <div class="presets">
      <button class="cw-btn" id="btn-this-month">This Month</button>
      <button class="cw-btn" id="btn-last-30">Last 30 Days</button>
      <button class="cw-btn" id="btn-last-3m">Last 3 Months</button>
      <button class="cw-btn" id="btn-all-time">All Time</button>
    </div>
  </div>

  <!-- Claude models section -->
  <div class="section account-section" id="section-claude">
    <h2 class="account-heading">
      <span class="cw-badge-claude">Claude</span> models
      <span class="sel-total" id="sel-total-claude"></span>
    </h2>
    <div id="chart-claude"></div>
  </div>

  <!-- Other models section -->
  <div class="section account-section" id="section-copilot">
    <h2 class="account-heading">
      <span class="cw-badge-copilot">Other</span> models
      <span class="sel-total" id="sel-total-copilot"></span>
    </h2>
    <div id="chart-copilot"></div>
  </div>

  <!-- Combined summary table -->
  <div class="section">
    <h2>Summary</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Model</th>
          <th>Coding Assistant</th>
          <th class="num">Sessions</th>
          <th class="num">Requests</th>
          <th class="num">% of Total</th>
        </tr>
      </thead>
      <tbody id="summary-tbody"></tbody>
      <tfoot id="summary-tfoot"></tfoot>
    </table>
  </div>
</div>

<!-- Session breakdown overlay -->
<div id="session-overlay"></div>

<!-- Chart bar tooltip overlay -->
<div id="chart-overlay"></div>

<script>
(function() {
  var vscode = acquireVsCodeApi();
  var charts = { claude: null, copilot: null };
  // Tooltip lookup maps — mutated in-place so existing Chart.js closures always read latest data
  var tooltipMaps = {
    claude:  { pct: {}, ws: {}, total: 0 },
    copilot: { pct: {}, ws: {}, total: 0 }
  };
  /** Session lists for Summary table rows — avoids broken JSON in HTML attributes (titles with quotes, &, etc.). */
  var sessionRowSessions = [];
  // Bar selection state — cleared on data update
  var selectedBars   = { claude: {}, copilot: {} }; // model → true
  var requestCounts  = { claude: {}, copilot: {} }; // model → userRequests (refreshed per update)

  // -- Helpers ---------------------------------------------------
  function toIsoDate(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var ACCOUNT_LABEL = { claude: 'Claude', copilot: 'GitHub Copilot' };

  // Deterministic hue from string, shifted toward account base hue
  var ACCOUNT_BASE_HUE = { claude: 270, copilot: 30 }; // purple / orange
  function modelColor(name, source, alpha) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    var base = ACCOUNT_BASE_HUE[source] || 200;
    var hue = (base + (hash % 60) - 30 + 360) % 360; // ±30° around account base
    return 'hsla(' + hue + ', 65%, 58%, ' + (alpha || 1) + ')';
  }

  function updateSelectionDisplay(source) {
    var sel = selectedBars[source];
    var keys = Object.keys(sel);
    var el = document.getElementById('sel-total-' + source);
    if (!el) { return; }
    if (keys.length === 0) { el.style.display = 'none'; return; }
    var total = 0;
    keys.forEach(function(m) { total += requestCounts[source][m] || 0; });
    el.style.display = 'inline';
    el.textContent = 'Total requests: ' + total.toLocaleString();
  }

  function getChartColors() {
    var style = getComputedStyle(document.body);
    return {
      fg:     style.getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc',
      border: style.getPropertyValue('--vscode-textSeparator-foreground').trim() || 'rgba(128,128,128,0.3)',
    };
  }

  // -- Posting date range ----------------------------------------
  function sendDateRange() {
    var from = document.getElementById('from-input').value;
    var to   = document.getElementById('to-input').value;
    if (from && to) {
      vscode.postMessage({ type: 'setDateRange', from: from, to: to });
    }
  }

  document.getElementById('from-input').addEventListener('change', sendDateRange);
  document.getElementById('to-input').addEventListener('change', sendDateRange);

  // -- Preset buttons --------------------------------------------
  document.getElementById('btn-this-month').addEventListener('click', function() {
    var now = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    document.getElementById('to-input').value   = toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    sendDateRange();
  });

  document.getElementById('btn-last-30').addEventListener('click', function() {
    var to = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000));
    document.getElementById('to-input').value   = toIsoDate(to);
    sendDateRange();
  });

  document.getElementById('btn-last-3m').addEventListener('click', function() {
    var to = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(to.getFullYear(), to.getMonth() - 3, to.getDate()));
    document.getElementById('to-input').value   = toIsoDate(to);
    sendDateRange();
  });

  document.getElementById('btn-all-time').addEventListener('click', function() {
    document.getElementById('from-input').value = '2000-01-01';
    document.getElementById('to-input').value   = '2099-12-31';
    sendDateRange();
  });

  // -- Render one account chart ----------------------------------
  function renderAccountChart(source, models, totalUserRequests) {
    var containerId = 'chart-' + source;
    var sectionId   = 'section-' + source;
    var canvasId    = 'canvas-' + source;
    var container   = document.getElementById(containerId);
    var section     = document.getElementById(sectionId);

    if (models.length === 0) {
      if (charts[source]) { charts[source].destroy(); charts[source] = null; }
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    var labels   = models.map(function(m) { return m.model; });
    var counts   = models.map(function(m) { return m.userRequests; });
    var bgColors = models.map(function(m) { return modelColor(m.model, source, 0.65); });
    var bdColors = models.map(function(m) { return modelColor(m.model, source, 1); });
    var h = Math.max(80, models.length * 32);

    // Always refresh tooltip maps in-place so existing closures stay current
    var tm = tooltipMaps[source];
    for (var k in tm.pct) { delete tm.pct[k]; }
    for (var k in tm.ws)  { delete tm.ws[k]; }
    tm.total = totalUserRequests;
    models.forEach(function(m) {
      tm.pct[m.model] = m.percentage;
      tm.ws[m.model]  = m.workspaceBreakdown || [];
    });

    // Refresh request counts; reset selection (data changed, stale selection would mislead)
    requestCounts[source] = {};
    models.forEach(function(m) { requestCounts[source][m.model] = m.userRequests; });
    selectedBars[source] = {};
    updateSelectionDisplay(source);

    if (charts[source]) {
      charts[source].data.labels = labels;
      charts[source].data.datasets[0].data = counts;
      charts[source].data.datasets[0].backgroundColor = bgColors;
      charts[source].data.datasets[0].borderColor = bdColors;
      charts[source].update('none');
      // Resize container height if model count changed
      var wrap = container.querySelector('.chart-container');
      if (wrap) { wrap.style.height = h + 'px'; }
    } else {
      container.innerHTML = '<div class="chart-container" style="height:' + h + 'px"><canvas id="' + canvasId + '"></canvas></div>';
      var chartColors = getChartColors();
      Chart.defaults.color       = chartColors.fg;
      Chart.defaults.borderColor = chartColors.border;
      var ctx = document.getElementById(canvasId).getContext('2d');
      charts[source] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'User Requests',
            data: counts,
            backgroundColor: bgColors,
            borderColor: bdColors,
            borderWidth: 1,
            borderRadius: 3
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeOutQuart' },
          onClick: function(evt, elements) {
            if (!elements || !elements.length) { return; }
            var idx = elements[0].index;
            var modelName = charts[source].data.labels[idx];
            if (!modelName) { return; }
            var sel = selectedBars[source];
            if (sel[modelName]) { delete sel[modelName]; } else { sel[modelName] = true; }
            var anySelected = Object.keys(sel).length > 0;
            charts[source].data.datasets[0].backgroundColor = charts[source].data.labels.map(function(m) {
              if (!anySelected) { return modelColor(m, source, 0.65); }
              return sel[m] ? modelColor(m, source, 0.9) : modelColor(m, source, 0.2);
            });
            charts[source].update('none');
            updateSelectionDisplay(source);
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: function(context) {
                var tooltipModel = context.tooltip;
                if (tooltipModel.opacity === 0 || !tooltipModel.dataPoints || !tooltipModel.dataPoints.length) {
                  if (!isChartOverlayHovered) { scheduleHideChartOverlay(); }
                  return;
                }
                cancelHideChartOverlay();
                var modelName = tooltipModel.dataPoints[0].label;
                var tm = tooltipMaps[source];
                var count = tooltipModel.dataPoints[0].parsed.x;
                var pct = tm.pct[modelName] !== undefined ? tm.pct[modelName] : 0;
                var ws = tm.ws[modelName] || [];

                var html = '<div class="co-header">' + escHtml(modelName) + '<br>'
                  + count.toLocaleString() + ' requests (' + pct + '% of total)</div>';
                ws.forEach(function(w) {
                  var norm = w.workspace.split(String.fromCharCode(92)).join('/');
                  var parts = norm.split('/').filter(Boolean);
                  var display = parts.length > 0 ? parts[parts.length - 1] : w.workspace;
                  html += '<div class="co-ws-row"><span class="co-ws-name" title="' + escHtml(w.workspace) + '">'
                    + escHtml(display) + '</span><span class="co-ws-count">' + w.userRequests.toLocaleString() + '</span></div>';
                  if (w.assistantBreakdown && w.assistantBreakdown.length > 0) {
                    var grandTotal = tm.total || 1;
                    w.assistantBreakdown.forEach(function(a) {
                      var label = ASST_LABEL[a.assistant] || a.assistant;
                      var pctOfTotal = (a.userRequests / grandTotal * 100).toFixed(1);
                      html += '<div class="co-asst-row"><span class="co-asst-name">\u2514 ' + escHtml(label)
                        + '</span><span class="co-asst-count">' + a.userRequests.toLocaleString()
                        + ' <span class="co-asst-pct">(' + pctOfTotal + '%)</span></span></div>';
                    });
                  }
                });
                chartOverlay.innerHTML = html;

                // position:fixed — viewport coords only, no scrollY/scrollX.
                var canvasRect = context.chart.canvas.getBoundingClientRect();
                var top  = canvasRect.top  + tooltipModel.caretY;
                var left = canvasRect.left + tooltipModel.caretX + 12;
                chartOverlay.style.display = 'block';
                chartOverlay.style.left = '0';
                chartOverlay.style.top  = '0';
                var ow = chartOverlay.offsetWidth;
                var oh = chartOverlay.offsetHeight;
                if (left + ow > window.innerWidth - 8) { left = Math.max(4, canvasRect.left + tooltipModel.caretX - ow - 8); }
                if (top  + oh > window.innerHeight - 8) { top = Math.max(0, window.innerHeight - oh - 8); }
                chartOverlay.style.left = left + 'px';
                chartOverlay.style.top  = top  + 'px';
              }
            }
          },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
        }
      });
    }
  }

  // -- Render combined table -------------------------------------
  function renderTable(data) {
    var tbody = document.getElementById('summary-tbody');
    var tfoot = document.getElementById('summary-tfoot');
    sessionRowSessions = [];

    if (data.models.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for selected range.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    // Group rows: Claude models first, then others; within each sorted by userRequests desc (already sorted)
    var claudeRows = data.models.filter(function(m) { return m.model.startsWith('Claude'); });
    var otherRows  = data.models.filter(function(m) { return !m.model.startsWith('Claude'); });

    function accountBadge(model) {
      return model.startsWith('Claude')
        ? '<span class="cw-badge-claude">Claude</span>'
        : '<span class="cw-badge-copilot">Other</span>';
    }

    function makeRows(rows) {
      return rows.map(function(m) {
        var badge = accountBadge(m.model);
        // One row per contributing assistant (sourceBreakdown), or fall back to single row
        var srcRows = (m.sourceBreakdown && m.sourceBreakdown.length > 0)
          ? m.sourceBreakdown
          : [{ source: (m.sources || [])[0] || '', sessionCount: m.sessionCount, userRequests: m.userRequests, percentage: m.percentage, sessionBreakdown: m.sessionBreakdown || [] }];

        return srcRows.map(function(sr, si) {
          var sess = sr.sessionBreakdown && sr.sessionBreakdown.length > 0 ? sr.sessionBreakdown : null;
          var sessIdxAttr = '';
          if (sess) {
            var sidx = sessionRowSessions.length;
            sessionRowSessions.push(sess);
            sessIdxAttr = ' data-sessions-idx="' + sidx + '"';
          }
          var asstLabel = ASST_LABEL[sr.source] || sr.source;
          // Show provider badge and model name only on the first source row for this model
          var providerCell = si === 0 ? '<td>' + badge + '</td>' : '<td></td>';
          var modelCell    = si === 0
            ? '<td title="' + escHtml(m.model) + '">' + escHtml(m.model) + '</td>'
            : '<td class="model-sub" title="' + escHtml(m.model) + '">' + escHtml(m.model) + '</td>';
          return '<tr' + sessIdxAttr + '>'
            + providerCell
            + modelCell
            + '<td title="' + escHtml(asstLabel) + '">' + escHtml(asstLabel) + '</td>'
            + '<td class="num">' + sr.sessionCount.toLocaleString() + '</td>'
            + '<td class="num">' + sr.userRequests.toLocaleString() + '</td>'
            + '<td class="num">' + sr.percentage.toFixed(2) + '%</td>'
            + '</tr>';
        }).join('');
      }).join('');
    }

    tbody.innerHTML = makeRows(claudeRows) + makeRows(otherRows);

    // Per-row mouseenter/mouseleave: delegated pointerover on tbody is unreliable in some VS Code webviews (e.g. Cursor).
    var overlayEl = document.getElementById('session-overlay');
    tbody.querySelectorAll('tr[data-sessions-idx]').forEach(function(tr) {
      tr.addEventListener('mouseenter', function() {
        isRowHovered = true;
        cancelHide();
        var sidx = tr.getAttribute('data-sessions-idx');
        var idx = sidx === null || sidx === '' ? NaN : parseInt(sidx, 10);
        var sessions = !isNaN(idx) ? sessionRowSessions[idx] : null;
        if (sessions) { showOverlay(sessions, tr.getBoundingClientRect()); }
      });
      tr.addEventListener('mouseleave', function(e) {
        var rt = e.relatedTarget;
        if (rt && overlayEl && overlayEl.contains(rt)) { return; }
        isRowHovered = false;
        scheduleHide();
      });
    });

    tfoot.innerHTML = '<tr>'
      + '<td colspan="3"><strong>Total</strong></td>'
      + '<td class="num"><strong>' + data.totalSessions.toLocaleString() + '</strong></td>'
      + '<td class="num"><strong>' + data.totalUserRequests.toLocaleString() + '</strong></td>'
      + '<td class="num"><strong>100%</strong></td>'
      + '</tr>';
  }

  // -- Chart bar tooltip overlay ---------------------------------
  var chartOverlay = document.getElementById('chart-overlay');
  var chartOverlayHideTimer = null;
  var isChartOverlayHovered = false;

  function hideChartOverlay() {
    chartOverlay.style.display = 'none';
    chartOverlay.innerHTML = '';
  }

  function scheduleHideChartOverlay() {
    if (chartOverlayHideTimer) { clearTimeout(chartOverlayHideTimer); }
    chartOverlayHideTimer = setTimeout(hideChartOverlay, 400);
  }

  function cancelHideChartOverlay() {
    if (chartOverlayHideTimer) { clearTimeout(chartOverlayHideTimer); chartOverlayHideTimer = null; }
  }

  chartOverlay.addEventListener('mouseenter', function() {
    isChartOverlayHovered = true;
    cancelHideChartOverlay();
  });
  chartOverlay.addEventListener('mouseleave', function() {
    isChartOverlayHovered = false;
    scheduleHideChartOverlay();
  });

  // -- Session hover overlay -------------------------------------
  var overlay = document.getElementById('session-overlay');
  var overlayHideTimer = null;
  var isOverlayHovered = false;
  var isRowHovered = false;

  var ASST_LABEL = {
    claude: 'Claude Code', copilot: 'GitHub Copilot', cline: 'Cline',
    roocode: 'Roo Code', cursor: 'Cursor', windsurf: 'Windsurf', aider: 'Aider'
  };

  function showOverlay(sessions, anchorRect) {
    if (!sessions || sessions.length === 0) { return; }
    var html = '';
    sessions.forEach(function(s, i) {
      html += '<div class="session-overlay-item" data-session-id="' + escHtml(s.sessionId) + '">'
        + '<span class="sess-idx">' + (i + 1) + '.</span>'
        + '<span class="sess-req">Requests: ' + s.userRequests + '</span>'
        + '<span class="sess-link" title="' + escHtml(s.sessionTitle) + '">' + escHtml(s.sessionTitle) + '</span>'
        + '</div>';
    });
    overlay.innerHTML = html;

    // position:fixed uses viewport coordinates — do NOT add scrollY/scrollX.
    // Overlap row by several px so the pointer path can reach the overlay.
    var top  = anchorRect.bottom - 6;
    var left = anchorRect.left;
    overlay.style.display = 'block';
    overlay.style.left = '0';
    overlay.style.top = '0';

    var ow = overlay.offsetWidth;
    var oh = overlay.offsetHeight;
    if (left + ow > window.innerWidth) { left = Math.max(0, window.innerWidth - ow - 8); }
    if (top + oh > window.innerHeight) { top = Math.max(0, anchorRect.top - oh - 2); }
    overlay.style.left = left + 'px';
    overlay.style.top  = top  + 'px';
  }

  function hideOverlay() {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
  }

  function scheduleHide() {
    if (overlayHideTimer) { clearTimeout(overlayHideTimer); }
    overlayHideTimer = setTimeout(function() {
      if (!isRowHovered && !isOverlayHovered) { hideOverlay(); }
    }, 900);
  }

  function cancelHide() {
    if (overlayHideTimer) { clearTimeout(overlayHideTimer); overlayHideTimer = null; }
  }

  var tbody = document.getElementById('summary-tbody');

  overlay.addEventListener('pointerenter', function() {
    isOverlayHovered = true;
    cancelHide();
  });
  overlay.addEventListener('pointerleave', function(e) {
    isOverlayHovered = false;
    var rt = e.relatedTarget;
    if (rt && tbody.contains(rt)) { return; } // moving back onto the table
    scheduleHide();
  });

  overlay.addEventListener('click', function(e) {
    var item = e.target.closest('.session-overlay-item');
    if (!item) { return; }
    var sid = item.getAttribute('data-session-id');
    if (sid) { vscode.postMessage({ type: 'openSession', sessionId: sid }); }
  });

  // Hide both overlays immediately when the pointer leaves the webview entirely.
  document.addEventListener('mouseleave', function() {
    isRowHovered = false;
    isOverlayHovered = false;
    isChartOverlayHovered = false;
    hideOverlay();
    hideChartOverlay();
  });

  // -- Message handler -------------------------------------------
  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type !== 'update') { return; }

    document.getElementById('loading-msg').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    if (msg.dateRange) {
      document.getElementById('from-input').value = msg.dateRange.from;
      document.getElementById('to-input').value   = msg.dateRange.to;
    }

    var claudeModels = msg.data.models.filter(function(m) { return m.model.startsWith('Claude'); });
    var otherModels  = msg.data.models.filter(function(m) { return !m.model.startsWith('Claude'); });

    renderAccountChart('claude',  claudeModels, msg.data.totalUserRequests);
    renderAccountChart('copilot', otherModels,  msg.data.totalUserRequests);
    renderTable(msg.data);
  });

  // -- Ready signal ----------------------------------------------
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
