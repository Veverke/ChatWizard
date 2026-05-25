// src/ui/sessionCostAdvicePanel.ts
//
// Webview panel opened when the user clicks "View Details" in the
// SessionCostAdvisorNotifier information message.
//
// Shows:
//   - The full consolidated prompt in a copyable textarea
//   - A cost breakdown table (actual vs. estimated consolidated)
//   - Savings in absolute USD and percentage

import * as vscode from 'vscode';
import type { CostAdvice } from '../analytics/sessionCostAdvisor';

function formatUsd(usd: number): string {
    if (usd < 0.001) { return '< $0.001'; }
    if (usd < 0.01)  { return `$${usd.toFixed(4)}`; }
    if (usd < 1)     { return `$${usd.toFixed(3)}`; }
    return `$${usd.toFixed(2)}`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildHtml(advice: CostAdvice): string {
    const consolidated = escapeHtml(advice.consolidatedPrompt);
    const actual       = formatUsd(advice.cumulativeCostUsd);
    const estimated    = formatUsd(advice.consolidatedCostUsd);
    const savings      = formatUsd(advice.savingsUsd);
    const pct          = advice.savingsPct;
    const model        = escapeHtml(advice.modelDisplayName || 'unknown model');
    const turns        = advice.turnCount;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Session Cost Advice</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-editorWidget-border, #454545);
    --accent: var(--vscode-textLink-foreground, #4fc1ff);
    --saving-green: #4ec9b0;
    --cost-red: #f48771;
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }
  body { background: var(--bg); color: var(--fg); margin: 20px; }
  h2 { margin-top: 0; color: var(--accent); }
  table { border-collapse: collapse; width: 100%; max-width: 480px; margin-bottom: 20px; }
  th, td { padding: 6px 12px; border: 1px solid var(--border); text-align: left; }
  th { background: rgba(255,255,255,0.05); }
  .savings { color: var(--saving-green); font-weight: bold; }
  .actual  { color: var(--cost-red); }
  textarea {
    width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
    color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
    padding: 10px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px; resize: vertical; min-height: 140px;
  }
  button {
    margin-top: 8px; padding: 6px 16px;
    background: var(--accent); color: #000; border: none;
    border-radius: 4px; cursor: pointer; font-size: 13px;
  }
  button:hover { opacity: 0.85; }
  .label { font-weight: bold; margin: 16px 0 6px; }
</style>
</head>
<body>
<h2>💰 Session Cost Advice</h2>

<table>
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Turns</td><td>${turns}</td></tr>
    <tr><td>Model</td><td>${model}</td></tr>
    <tr><td class="actual">Actual spend</td><td class="actual">${actual}</td></tr>
    <tr><td>Estimated (consolidated)</td><td>${estimated}</td></tr>
    <tr><td class="savings">Savings</td><td class="savings">${savings} (${pct}%)</td></tr>
  </tbody>
</table>

<div class="label">💡 Consolidated prompt you could have used:</div>
<textarea id="promptText" readonly>${consolidated}</textarea>
<br>
<button onclick="copyPrompt()">Copy to clipboard</button>

<script>
  function copyPrompt() {
    const ta = document.getElementById('promptText');
    ta.select();
    document.execCommand('copy');
    const btn = document.querySelector('button');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1500);
  }
</script>
</body>
</html>`;
}

export class SessionCostAdvicePanel {
    private static _panel: vscode.WebviewPanel | undefined;

    static show(advice: CostAdvice): void {
        if (SessionCostAdvicePanel._panel) {
            SessionCostAdvicePanel._panel.reveal(vscode.ViewColumn.Beside);
            SessionCostAdvicePanel._panel.webview.html = buildHtml(advice);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardCostAdvice',
            'Session Cost Advice',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: false },
        );

        SessionCostAdvicePanel._panel = panel;
        panel.webview.html = buildHtml(advice);

        panel.onDidDispose(() => {
            SessionCostAdvicePanel._panel = undefined;
        });
    }
}
