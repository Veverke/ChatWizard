// src/analytics/analyticsPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { computeAnalytics, AnalyticsData } from './analyticsEngine';
import { countTokens } from './tokenCounter';

export class AnalyticsPanel {
    private static _panel: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext, index: SessionIndex): void {
        if (AnalyticsPanel._panel) {
            AnalyticsPanel._panel.reveal(vscode.ViewColumn.One);
            AnalyticsPanel._panel.webview.html = AnalyticsPanel.getLoadingHtml();
            setImmediate(() => {
                if (AnalyticsPanel._panel) {
                    AnalyticsPanel._panel.webview.html = AnalyticsPanel.getHtml(AnalyticsPanel.build(index));
                }
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardAnalytics',
            'Chat Analytics',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        AnalyticsPanel._panel = panel;
        panel.webview.html = AnalyticsPanel.getLoadingHtml();

        setImmediate(() => {
            if (AnalyticsPanel._panel) {
                AnalyticsPanel._panel.webview.html = AnalyticsPanel.getHtml(AnalyticsPanel.build(index));
            }
        });

        panel.onDidDispose(() => {
            AnalyticsPanel._panel = undefined;
        }, null, context.subscriptions);
    }

    static refresh(index: SessionIndex): void {
        if (!AnalyticsPanel._panel) { return; }
        AnalyticsPanel._panel.webview.html = AnalyticsPanel.getLoadingHtml();
        setImmediate(() => {
            if (AnalyticsPanel._panel) {
                AnalyticsPanel._panel.webview.html = AnalyticsPanel.getHtml(AnalyticsPanel.build(index));
            }
        });
    }

    static getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      gap: 14px;
    }
    .progress-track {
      width: 260px;
      height: 3px;
      background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 40%;
      background: var(--vscode-button-background, #007acc);
      border-radius: 2px;
      animation: slide 1.4s ease-in-out infinite;
    }
    @keyframes slide {
      0%   { transform: translateX(-150%) scaleX(0.6); }
      50%  { transform: translateX(80%)   scaleX(1);   }
      100% { transform: translateX(350%)  scaleX(0.6); }
    }
    .label { font-size: 0.82em; opacity: 0.55; }
  </style>
</head>
<body>
  <div class="progress-track"><div class="progress-fill"></div></div>
  <div class="label">Computing analytics…</div>
</body>
</html>`;
    }

    static build(index: SessionIndex): AnalyticsData {
        const allSessions = index.getAllSummaries()
            .map(s => index.get(s.id)!)
            .filter(s => s != null);
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

    static getHtml(data: AnalyticsData): string {
        const e = AnalyticsPanel._escapeHtml.bind(AnalyticsPanel);

        // Summary cards
        const timeSpanValue = data.timeSpanDays > 0
            ? `${data.timeSpanDays} day${data.timeSpanDays === 1 ? '' : 's'}`
            : '—';
        const timeSpanSub = (data.oldestDate && data.newestDate)
            ? `(${data.oldestDate} – ${data.newestDate})`
            : '';

        const summaryCards = [
            { label: 'Total Sessions',   value: data.totalSessions.toLocaleString(), sub: '' },
            { label: 'Total Prompts',    value: data.totalPrompts.toLocaleString(),   sub: '' },
            { label: 'Total Responses',  value: data.totalResponses.toLocaleString(), sub: '' },
            { label: 'Est. Tokens',      value: data.totalTokens.toLocaleString(),    sub: '' },
            { label: 'Copilot Sessions', value: data.copilotSessions.toLocaleString(), sub: '' },
            { label: 'Claude Sessions',  value: data.claudeSessions.toLocaleString(),  sub: '' },
            { label: 'Time Span',        value: timeSpanValue, sub: timeSpanSub },
        ].map(card => `
        <div class="summary-card">
          <div class="summary-value">${e(card.value)}</div>
          <div class="summary-label">${e(card.label)}</div>${card.sub ? `
          <div class="summary-sub">${e(card.sub)}</div>` : ''}
        </div>`).join('');

        // Daily activity chart
        const hasActivity = data.dailyActivity.length > 0;
        const dailyLabels  = JSON.stringify(data.dailyActivity.map(d => d.date));
        const dailyTokens  = JSON.stringify(data.dailyActivity.map(d => d.tokenCount));
        const dailyPrompts = JSON.stringify(data.dailyActivity.map(d => d.promptCount));

        const activityChartHtml = hasActivity
            ? `<div class="chart-container"><canvas id="activityChart"></canvas></div>`
            : `<p class="empty-state">No activity data yet.</p>`;

        // Projects table — top 10 by token count desc
        const topProjects = [...data.projectActivity]
            .sort((a, b) => b.tokenCount - a.tokenCount)
            .slice(0, 10);

        const projectRowsHtml = topProjects.length > 0
            ? topProjects.map(p => {
                const wsName = p.workspacePath
                    ? (p.workspacePath.replace(/\\/g, '/').split('/').pop() ?? p.workspacePath)
                    : '(unknown)';
                return `<tr>
              <td title="${e(p.workspacePath)}">${e(wsName)}</td>
              <td class="num">${p.sessionCount.toLocaleString()}</td>
              <td class="num">${p.promptCount.toLocaleString()}</td>
              <td class="num">${p.tokenCount.toLocaleString()}</td>
            </tr>`;
            }).join('\n')
            : `<tr><td colspan="4" class="empty-state">No project data.</td></tr>`;

        // Top terms chart — top 20
        const topTerms  = data.topTerms.slice(0, 20);
        const hasTerms  = topTerms.length > 0;
        const termLabels = JSON.stringify(topTerms.map(t => t.term));
        const termCounts = JSON.stringify(topTerms.map(t => t.count));
        const termsChartHeight = Math.max(180, topTerms.length * 24);

        const termsChartHtml = hasTerms
            ? `<div class="chart-container" style="height:${termsChartHeight}px"><canvas id="termsChart"></canvas></div>`
            : `<p class="empty-state">No term data yet.</p>`;

        // Longest by messages — top 10
        const byMsgRows = data.longestByMessages.slice(0, 10).map(s => {
            const ws = s.workspacePath
                ? (s.workspacePath.replace(/\\/g, '/').split('/').pop() ?? s.workspacePath)
                : '';
            return `<tr>
            <td title="${e(s.sessionId)}">${e(s.sessionTitle)}</td>
            <td>${e(s.sessionSource)}</td>
            <td title="${e(s.workspacePath ?? '')}">${e(ws)}</td>
            <td class="num">${s.totalMessageCount.toLocaleString()}</td>
            <td class="num">${s.totalTokens.toLocaleString()}</td>
          </tr>`;
        }).join('\n');

        const byMsgContent = byMsgRows.length > 0
            ? byMsgRows
            : `<tr><td colspan="5" class="empty-state">No sessions.</td></tr>`;

        // Longest by tokens — top 10
        const byTokRows = data.longestByTokens.slice(0, 10).map(s => {
            const ws = s.workspacePath
                ? (s.workspacePath.replace(/\\/g, '/').split('/').pop() ?? s.workspacePath)
                : '';
            return `<tr>
            <td title="${e(s.sessionId)}">${e(s.sessionTitle)}</td>
            <td>${e(s.sessionSource)}</td>
            <td title="${e(s.workspacePath ?? '')}">${e(ws)}</td>
            <td class="num">${s.totalMessageCount.toLocaleString()}</td>
            <td class="num">${s.totalTokens.toLocaleString()}</td>
          </tr>`;
        }).join('\n');

        const byTokContent = byTokRows.length > 0
            ? byTokRows
            : `<tr><td colspan="5" class="empty-state">No sessions.</td></tr>`;

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
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

    /* ── Summary cards ── */
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .summary-card {
      flex: 1 1 130px;
      min-width: 100px;
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
      border: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.25));
      border-radius: 6px;
      padding: 12px 14px;
      text-align: center;
    }

    .summary-value {
      font-size: 1.5em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-button-background, #007acc);
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

    /* ── Chart containers ── */
    .chart-container {
      position: relative;
      width: 100%;
    }

    /* ── Tables ── */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92em;
    }

    .data-table th {
      text-align: left;
      padding: 5px 10px;
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
      border-bottom: 2px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.4));
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

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 20px 16px;
    }
  </style>
</head>
<body>

  <!-- Overview -->
  <div class="section">
    <h2>Overview</h2>
    <div class="summary-row">${summaryCards}
    </div>
  </div>

  <!-- Daily Activity -->
  <div class="section">
    <h2>Daily Activity</h2>
    ${activityChartHtml}
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
          <th class="num">Est. Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${projectRowsHtml}
      </tbody>
    </table>
  </div>

  <!-- Top Terms -->
  <div class="section">
    <h2>Top Terms</h2>
    ${termsChartHtml}
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
          <th class="num">Est. Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${byMsgContent}
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
          <th class="num">Est. Tokens</th>
        </tr>
      </thead>
      <tbody>
        ${byTokContent}
      </tbody>
    </table>
  </div>

  <script>
    (function () {
      const hasActivity = ${hasActivity};
      const hasTerms    = ${hasTerms};

      // Apply VS Code theme colours to Chart.js defaults
      const style = getComputedStyle(document.body);
      const fgColor     = style.getPropertyValue('--vscode-editor-foreground').trim()         || '#cccccc';
      const borderColor = style.getPropertyValue('--vscode-textSeparator-foreground').trim()  || 'rgba(128,128,128,0.3)';
      Chart.defaults.color       = fgColor;
      Chart.defaults.borderColor = borderColor;

      if (hasActivity) {
        const ctx = document.getElementById('activityChart').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: ${dailyLabels},
            datasets: [
              {
                label: 'Tokens',
                data: ${dailyTokens},
                borderColor: 'rgba(0, 122, 204, 0.9)',
                backgroundColor: 'rgba(0, 122, 204, 0.15)',
                fill: true,
                tension: 0.3,
                yAxisID: 'yTokens'
              },
              {
                label: 'Prompts',
                data: ${dailyPrompts},
                borderColor: 'rgba(255, 140, 0, 0.9)',
                backgroundColor: 'rgba(255, 140, 0, 0.15)',
                fill: true,
                tension: 0.3,
                yAxisID: 'yPrompts'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'top' }
            },
            scales: {
              x: {
                ticks: { maxTicksLimit: 12, maxRotation: 45 }
              },
              yTokens: {
                type: 'linear',
                position: 'left',
                beginAtZero: true,
                title: { display: true, text: 'Tokens' }
              },
              yPrompts: {
                type: 'linear',
                position: 'right',
                beginAtZero: true,
                title: { display: true, text: 'Prompts' },
                grid: { drawOnChartArea: false }
              }
            }
          }
        });
      }

      if (hasTerms) {
        const ctx = document.getElementById('termsChart').getContext('2d');
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: ${termLabels},
            datasets: [
              {
                label: 'Count',
                data: ${termCounts},
                backgroundColor: 'rgba(0, 122, 204, 0.7)',
                borderColor:     'rgba(0, 122, 204, 1)',
                borderWidth: 1
              }
            ]
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { beginAtZero: true }
            }
          }
        });
      }
    })();
  </script>
</body>
</html>`;
    }
}
