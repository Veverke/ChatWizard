// src/analytics/analyticsPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { computeAnalytics, AnalyticsData } from './analyticsEngine';
import { countTokens } from './tokenCounter';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';

export class AnalyticsPanel {
    private static _panel: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext, index: SessionIndex): void {
        if (AnalyticsPanel._panel) {
            AnalyticsPanel._panel.reveal(vscode.ViewColumn.One);
            // Panel already has shell HTML — just push new data
            void AnalyticsPanel._panel.webview.postMessage({
                type: 'update',
                data: AnalyticsPanel.build(index),
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardAnalytics',
            'Chat Analytics',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        AnalyticsPanel._panel = panel;
        panel.webview.html = AnalyticsPanel.getShellHtml();

        // Wait for webview to signal ready before sending data
        panel.webview.onDidReceiveMessage((msg: { type?: string; command?: string; sessionId?: string }) => {
            if (msg.type === 'ready' && AnalyticsPanel._panel) {
                setImmediate(() => {
                    if (AnalyticsPanel._panel) {
                        void AnalyticsPanel._panel.webview.postMessage({
                            type: 'update',
                            data: AnalyticsPanel.build(index),
                        });
                    }
                });
            } else if (msg.command === 'openSession' && msg.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: msg.sessionId });
            } else if (msg.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
            } else if (msg.command === 'rescan') {
                void vscode.commands.executeCommand('chatwizard.rescan');
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
            AnalyticsPanel._panel = undefined;
        }, null, context.subscriptions);
    }

    static refresh(index: SessionIndex): void {
        if (!AnalyticsPanel._panel) { return; }
        void AnalyticsPanel._panel.webview.postMessage({
            type: 'update',
            data: AnalyticsPanel.build(index),
        });
    }

    static build(index: SessionIndex): AnalyticsData {
        const allSessions = index.getAllSummaries()
            .map(s => index.get(s.id)!)
            .filter(s => s !== null);
        return computeAnalytics(allSessions, countTokens);
    }

    private static _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    static getShellHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0 0 40px 0;
      line-height: 1.5;
    }

    h2 {
      font-size: 1em;
      font-weight: 600;
      margin: 0 0 12px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.35));
      opacity: 0.85;
    }

    .section {
      padding: 18px 20px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.2));
    }

    /* -- Summary cards -- */
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .summary-card {
      flex: 1 1 130px;
      min-width: 100px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      padding: 12px 14px;
      text-align: center;
    }

    .summary-value {
      font-size: 1.5em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--cw-accent);
      line-height: 1.2;
    }

    .summary-label {
      font-size: 0.82em;
      opacity: 0.7;
      margin-top: 4px;
    }

    .summary-sub {
      font-size: 0.75em;
      opacity: 0.5;
      margin-top: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* -- Chart containers -- */
    .chart-container {
      position: relative;
      width: 100%;
    }

    /* -- Tables -- */
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
    }

    .data-table th.num,
    .data-table td.num {
      text-align: right;
    }

    .data-table td {
      padding: 5px 10px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.15));
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .data-table tr:last-child td {
      border-bottom: none;
    }

    .data-table tr:hover td {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    }

    .data-table tr[data-sid] {
      cursor: pointer;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 20px 16px;
    }

    .empty-state-guided {
      text-align: center;
      padding: 40px 20px;
    }

    .empty-state-guided .empty-state-title {
      font-size: 1.05em;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .empty-state-guided .empty-state-body {
      opacity: 0.6;
      margin-bottom: 16px;
      font-size: 0.92em;
    }

    .empty-state-guided .empty-state-actions {
      display: flex;
      gap: 8px;
      justify-content: center;
    }

    .cw-action-btn {
      font-size: 0.85em;
      padding: 4px 14px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      transition: background 0.12s, color 0.12s;
    }

    .cw-action-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    .token-footnote {
      font-size: 0.78em;
      opacity: 0.5;
      padding: 12px 20px;
      margin: 0;
    }

    #freshness-bar {
      padding: 5px 20px;
      font-size: 0.78em;
      opacity: 0.55;
      border-bottom: 1px solid var(--cw-border);
      display: none;
    }

    #loading-msg {
      padding: 40px 20px;
      text-align: center;
      opacity: 0.6;
    }
  </style>
</head>
<body>

  <div id="freshness-bar"></div>

  <!-- Overview -->
  <div class="section">
    <h2>Overview</h2>
    <div class="summary-row" id="summary-row">
      <div class="summary-card sk cw-fade-item" style="--cw-i:0"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:1"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:2"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:3"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:4"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:5"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:6"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
    </div>
  </div>

  <!-- Daily Activity -->
  <div class="section">
    <h2>Daily Activity</h2>
    <div id="activity-container"><div class="cw-skeleton" style="height:180px;width:100%;border-radius:var(--cw-radius-sm)"></div></div>
  </div>

  <!-- Top Projects -->
  <div class="section">
    <h2>Top Projects</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Workspace</th>
          <th class="num">Sessions</th>
          <th class="num">Prompts</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="projects-tbody">
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:80%;margin:6px 0"></div></td></tr>
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:65%;margin:6px 0"></div></td></tr>
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:72%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>

  <!-- Top Terms -->
  <div class="section">
    <h2>Top Terms</h2>
    <div id="terms-container"><div class="cw-skeleton" style="height:140px;width:100%;border-radius:var(--cw-radius-sm)"></div></div>
  </div>

  <!-- Longest Sessions by Messages -->
  <div class="section">
    <h2>Longest Sessions (by Messages)</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Source</th>
          <th>Workspace</th>
          <th class="num">Messages</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="by-msg-tbody">
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:75%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:60%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:68%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>

  <!-- Longest Sessions by Tokens -->
  <div class="section">
    <h2>Longest Sessions (by Tokens)</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Source</th>
          <th>Workspace</th>
          <th class="num">Messages</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="by-tok-tbody">
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:80%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:55%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:70%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>
  <p class="token-footnote">* Token counts are estimates (Claude: characters÷4, Copilot: words×1.3) and are not billing-accurate.</p>

  <script>
    ${cwInteractiveJs()}

    (function () {
      var activityChart = null;
      var termsChart = null;
      var _firstRender = true;

      function escHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function getChartColors() {
        var style = getComputedStyle(document.body);
        return {
          fg:           style.getPropertyValue('--vscode-editor-foreground').trim()        || '#cccccc',
          border:       style.getPropertyValue('--vscode-textSeparator-foreground').trim() || 'rgba(128,128,128,0.3)',
          accent:       style.getPropertyValue('--cw-accent').trim()                       || '#5B8AF5',
          copilot:      style.getPropertyValue('--cw-copilot').trim()                      || '#f0883e',
          antigravity:  style.getPropertyValue('--cw-antigravity').trim()                  || '#4285F4',
        };
      }

      function renderSummary(data) {
        if (data.totalSessions === 0) {
          document.getElementById('summary-row').innerHTML =
            '<div class="empty-state-guided">'
            + '<p class="empty-state-title">No sessions indexed yet.</p>'
            + '<p class="empty-state-body">Chat Wizard reads your Claude Code, GitHub Copilot, Google Antigravity, and other AI chat history. Make sure the data paths are configured correctly.</p>'
            + '<div class="empty-state-actions">'
            + '<button class="cw-action-btn" id="btn-cfg-paths">Configure Paths</button>'
            + '<button class="cw-action-btn" id="btn-rescan">Rescan</button>'
            + '</div></div>';
          document.getElementById('btn-cfg-paths').addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); });
          document.getElementById('btn-rescan').addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); });
          return;
        }

        var timeSpanValue = data.timeSpanDays > 0
          ? data.timeSpanDays + ' day' + (data.timeSpanDays === 1 ? '' : 's')
          : '\\u2014';
        var timeSpanSub = (data.oldestDate && data.newestDate)
          ? '(' + escHtml(data.oldestDate) + ' \\u2013 ' + escHtml(data.newestDate) + ')'
          : '';

        var cards = [
          { label: 'Total Sessions',   value: data.totalSessions,   sub: '' },
          { label: 'Total Prompts',    value: data.totalPrompts,     sub: '' },
          { label: 'Total Responses',  value: data.totalResponses,   sub: '' },
          { label: 'Est. Tokens *',    value: data.totalTokens,      sub: '' },
          { label: 'Copilot Sessions',      value: data.copilotSessions,      sub: '' },
          { label: 'Claude Sessions',       value: data.claudeSessions,       sub: '' },
          { label: 'Antigravity Sessions',  value: data.antigravitySessions,  sub: '' },
          { label: 'Time Span',        value: timeSpanValue,         sub: timeSpanSub, noAnim: true },
        ];

        var html = cards.map(function(card, idx) {
          var valStr = typeof card.value === 'number' ? card.value.toLocaleString() : escHtml(String(card.value));
          var sub = card.sub ? '<div class="summary-sub">' + card.sub + '</div>' : '';
          return '<div class="summary-card cw-fade-item" style="--cw-i:' + idx + '">'
            + '<div class="summary-value">' + valStr + '</div>'
            + '<div class="summary-label">' + escHtml(card.label) + '</div>'
            + sub
            + '</div>';
        }).join('');

        document.getElementById('summary-row').innerHTML = html;

        // Count-up animation only on first render
        if (_firstRender) {
          document.querySelectorAll('.summary-value').forEach(function(el) {
            var raw = el.textContent.trim();
            if (!/^\\d[\\d,]*$/.test(raw)) { return; }
            var n = parseInt(raw.replace(/,/g, ''), 10);
            if (!n) { return; }
            var start = performance.now();
            (function tick(now) {
              var t    = Math.min((now - start) / 900, 1);
              var ease = 1 - Math.pow(1 - t, 4);
              el.textContent = Math.round(n * ease).toLocaleString();
              if (t < 1) { requestAnimationFrame(tick); }
              else { el.textContent = raw; }
            })(start);
          });
        }
      }

      function renderActivityChart(data) {
        var container = document.getElementById('activity-container');
        var colors = getChartColors();

        if (data.dailyActivity.length === 0) {
          if (activityChart) { activityChart.destroy(); activityChart = null; }
          container.innerHTML = '<p class="empty-state">No activity data yet.</p>';
          return;
        }

        var labels  = data.dailyActivity.map(function(d) { return d.date; });
        var tokens  = data.dailyActivity.map(function(d) { return d.tokenCount; });
        var prompts = data.dailyActivity.map(function(d) { return d.promptCount; });

        if (activityChart) {
          activityChart.data.labels = labels;
          activityChart.data.datasets[0].data = tokens;
          activityChart.data.datasets[1].data = prompts;
          activityChart.update('none');
        } else {
          container.innerHTML = '<div class="chart-container"><canvas id="activityChart"></canvas></div>';
          Chart.defaults.color       = colors.fg;
          Chart.defaults.borderColor = colors.border;
          var ctx = document.getElementById('activityChart').getContext('2d');
          activityChart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                {
                  label: 'Tokens',
                  data: tokens,
                  borderColor: colors.accent,
                  backgroundColor: colors.accent.replace(')', ', 0.15)').replace('rgb', 'rgba'),
                  fill: true,
                  tension: 0.4,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  yAxisID: 'yTokens'
                },
                {
                  label: 'Prompts',
                  data: prompts,
                  borderColor: colors.copilot,
                  backgroundColor: colors.copilot.replace(')', ', 0.12)').replace('rgb', 'rgba'),
                  fill: true,
                  tension: 0.4,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  yAxisID: 'yPrompts'
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              animation: { duration: 1200, easing: 'easeOutQuart' },
              interaction: { mode: 'index', intersect: false },
              plugins: { legend: { position: 'top' } },
              scales: {
                x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } },
                yTokens: {
                  type: 'linear', position: 'left', beginAtZero: true,
                  title: { display: true, text: 'Tokens' }
                },
                yPrompts: {
                  type: 'linear', position: 'right', beginAtZero: true,
                  title: { display: true, text: 'Prompts' },
                  grid: { drawOnChartArea: false }
                }
              }
            }
          });
        }
      }

      function renderProjectsTable(data) {
        var topProjects = data.projectActivity.slice().sort(function(a, b) {
          return b.tokenCount - a.tokenCount;
        }).slice(0, 10);

        var html;
        if (topProjects.length === 0) {
          html = '<tr><td colspan="4" class="empty-state">No project data.</td></tr>';
        } else {
          html = topProjects.map(function(p) {
            var wsName = p.workspacePath
              ? (p.workspacePath.replace(/\\\\/g, '/').split('/').pop() || p.workspacePath)
              : '(unknown)';
            return '<tr>'
              + '<td title="' + escHtml(p.workspacePath) + '">' + escHtml(wsName) + '</td>'
              + '<td class="num">' + p.sessionCount.toLocaleString() + '</td>'
              + '<td class="num">' + p.promptCount.toLocaleString() + '</td>'
              + '<td class="num">' + p.tokenCount.toLocaleString() + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById('projects-tbody').innerHTML = html;
      }

      function renderTermsChart(data) {
        var container = document.getElementById('terms-container');
        var topTerms = data.topTerms.slice(0, 20);
        var colors = getChartColors();

        if (topTerms.length === 0) {
          if (termsChart) { termsChart.destroy(); termsChart = null; }
          container.innerHTML = '<p class="empty-state">No term data yet.</p>';
          return;
        }

        var labels = topTerms.map(function(t) { return t.term; });
        var counts = topTerms.map(function(t) { return t.count; });
        var h = Math.max(180, topTerms.length * 24);

        if (termsChart) {
          termsChart.data.labels = labels;
          termsChart.data.datasets[0].data = counts;
          termsChart.update('none');
        } else {
          container.innerHTML = '<div class="chart-container" style="height:' + h + 'px"><canvas id="termsChart"></canvas></div>';
          var ctx = document.getElementById('termsChart').getContext('2d');
          termsChart = new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: 'Count',
                data: counts,
                backgroundColor: colors.accent.replace(')', ', 0.65)').replace('rgb', 'rgba'),
                borderColor:     colors.accent,
                borderWidth: 1,
                borderRadius: 3
              }]
            },
            options: {
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 900, easing: 'easeOutQuart' },
              plugins: { legend: { display: false } },
              scales: { x: { beginAtZero: true } }
            }
          });
        }
      }

      function renderSessionTable(tbodyId, sessions, colspan) {
        var rows;
        if (sessions.length === 0) {
          rows = '<tr><td colspan="' + colspan + '" class="empty-state">No sessions.</td></tr>';
        } else {
          rows = sessions.slice(0, 10).map(function(s) {
            var ws = s.workspacePath
              ? (s.workspacePath.replace(/\\\\/g, '/').split('/').pop() || '')
              : '';
            var srcBadge = s.sessionSource === 'copilot'
              ? '<span class="cw-badge-copilot">Copilot</span>'
              : '<span class="cw-badge-claude">Claude</span>';
            return '<tr data-sid="' + escHtml(s.sessionId) + '" title="Click to open session">'
              + '<td title="' + escHtml(s.sessionId) + '">' + escHtml(s.sessionTitle) + '</td>'
              + '<td>' + srcBadge + '</td>'
              + '<td title="' + escHtml(s.workspacePath || '') + '">' + escHtml(ws) + '</td>'
              + '<td class="num">' + s.totalMessageCount.toLocaleString() + '</td>'
              + '<td class="num">' + s.totalTokens.toLocaleString() + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById(tbodyId).innerHTML = rows;
      }

      function renderAll(data) {
        renderSummary(data);
        renderActivityChart(data);
        renderProjectsTable(data);
        renderTermsChart(data);
        renderSessionTable('by-msg-tbody', data.longestByMessages, 5);
        renderSessionTable('by-tok-tbody', data.longestByTokens, 5);
        _firstRender = false;

        // Freshness bar
        var fb = document.getElementById('freshness-bar');
        if (fb && data.totalSessions > 0) {
          fb.style.display = '';
          fb.textContent = data.totalSessions.toLocaleString() + ' session' + (data.totalSessions === 1 ? '' : 's') + ' indexed \u00b7 Updated ' + new Date().toLocaleTimeString();
        }
      }

      // Chart.js ResizeObserver doesn't reliably fire when a VS Code panel expands
      // (the canvas itself sets the min-size, blocking the observer). Calling resize()
      // explicitly on window.resize fixes the expand-direction blind spot.
      var _resizeTimer = null;
      window.addEventListener('resize', function() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
          if (activityChart) { activityChart.resize(); }
          if (termsChart) { termsChart.resize(); }
        }, 50);
      });

      var vscode = acquireVsCodeApi();

      // Session row click-through
      document.addEventListener('click', function(e) {
        var row = e.target && e.target.closest ? e.target.closest('tr[data-sid]') : null;
        if (row && row.dataset.sid) {
          vscode.postMessage({ command: 'openSession', sessionId: row.dataset.sid });
        }
      });

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg && msg.type === 'update') {
          renderAll(msg.data);
        }
      });

      // Signal ready to extension host
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
    }

    /** @deprecated */
    static getHtml(_data: AnalyticsData): string {
        return AnalyticsPanel.getShellHtml();
    }
}
