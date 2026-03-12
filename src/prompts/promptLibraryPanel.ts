// src/prompts/promptLibraryPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';
import { buildPromptLibrary, PromptEntry } from './promptExtractor';
import { clusterPromptsAsync, PromptCluster, MAX_CLUSTER_ENTRIES } from './similarityEngine';

export class PromptLibraryPanel {
    private static _panel: vscode.WebviewPanel | undefined;
    private static _cacheVersion = 0;

    static async show(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
        if (PromptLibraryPanel._panel) {
            PromptLibraryPanel._panel.reveal(vscode.ViewColumn.One);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'chatwizardPromptLibrary',
                'Prompt Library',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            PromptLibraryPanel._panel = panel;
            panel.webview.html = PromptLibraryPanel.getLoadingHtml();

            panel.onDidDispose(() => {
                PromptLibraryPanel._panel = undefined;
            }, null, context.subscriptions);

            panel.webview.onDidReceiveMessage((message: { command: string; text: string }) => {
                if (message.command === 'copy') {
                    void vscode.env.clipboard.writeText(message.text);
                    void vscode.window.showInformationMessage('Prompt copied to clipboard.');
                }
            }, undefined, context.subscriptions);
        }

        const entries = buildPromptLibrary(index);
        const result = await clusterPromptsAsync(entries, 0.6, String(PromptLibraryPanel._cacheVersion));
        if (PromptLibraryPanel._panel) {
            PromptLibraryPanel._panel.webview.html = PromptLibraryPanel.getHtml(result.clusters, result.truncated);
        }
    }

    static async refresh(index: SessionIndex): Promise<void> {
        if (!PromptLibraryPanel._panel) { return; }
        PromptLibraryPanel._cacheVersion++;
        const entries = buildPromptLibrary(index);
        const result = await clusterPromptsAsync(entries, 0.6, String(PromptLibraryPanel._cacheVersion));
        if (PromptLibraryPanel._panel) {
            PromptLibraryPanel._panel.webview.html = PromptLibraryPanel.getHtml(result.clusters, result.truncated);
        }
    }

    static getLoadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family,sans-serif);padding:20px;opacity:0.6;"><p>Loading prompt library\u2026</p></body></html>`;
    }

    private static _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    static getHtml(clusters: PromptCluster[], truncated = false): string {
        const totalEntries = clusters.reduce((sum, c) => sum + 1 + c.variants.length, 0);
        const truncatedBanner = truncated
            ? `<div class="truncated-banner">Too many prompts to cluster \u2014 showing top ${MAX_CLUSTER_ENTRIES.toLocaleString()}</div>`
            : '';

        const cardsHtml = clusters.map((cluster, i) => {
            const { canonical, variants, totalFrequency, allProjectIds } = cluster;
            const projectCount = allProjectIds.length;
            const statsLabel = `Asked ${totalFrequency} time${totalFrequency === 1 ? '' : 's'}` +
                (projectCount > 0 ? ` across ${projectCount} project${projectCount === 1 ? '' : 's'}` : '');

            const escapedText = PromptLibraryPanel._escapeHtml(canonical.text);
            const escapedTextLower = PromptLibraryPanel._escapeHtml(canonical.text.toLowerCase());

            let variantsHtml = '';
            if (variants.length > 0) {
                const variantItems = variants.map(v => {
                    const escapedV = PromptLibraryPanel._escapeHtml(v.text);
                    const sessionInfoParts = v.sessionMeta.map(m => {
                        const date = m.updatedAt ? m.updatedAt.substring(0, 10) : '';
                        return PromptLibraryPanel._escapeHtml(`${m.title}${date ? ' · ' + date : ''}`);
                    });
                    const sessionInfoHtml = sessionInfoParts.length > 0
                        ? `<span class="variant-session">${sessionInfoParts.join(', ')}</span>`
                        : '';
                    return `<li class="variant-item">
          <div class="variant-body">
            <span class="variant-text">${escapedV}</span>
            ${sessionInfoHtml}
          </div>
          <span class="variant-freq">${v.frequency}×</span>
          <button class="copy-btn copy-btn-sm" data-text="${PromptLibraryPanel._escapeHtml(v.text)}" title="Copy variant">Copy</button>
        </li>`;
                }).join('\n');
                variantsHtml = `
        <details class="variants-details">
          <summary class="variants-summary">${variants.length} similar variant${variants.length === 1 ? '' : 's'}</summary>
          <ul class="variants-list">${variantItems}</ul>
        </details>`;
            }

            const fadeAttr = i < 15 ? ` style="--cw-i:${i}"` : '';
            return `<div class="prompt-card cw-fade-item"${fadeAttr} data-text="${escapedTextLower}">
  <div class="card-header">
    <span class="freq-badge">${totalFrequency}×</span>
    <span class="stats-label">${PromptLibraryPanel._escapeHtml(statsLabel)}</span>
    <button class="copy-btn" data-text="${escapedText}" title="Copy prompt">Copy</button>
  </div>
  <div class="prompt-text">${escapedText}</div>${variantsHtml}
</div>`;
        }).join('\n');

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

    .toolbar {
      position: sticky;
      top: 0;
      background: var(--cw-surface);
      padding: 8px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
    }

    #promptCount {
      font-size: 0.85em;
      opacity: 0.65;
      white-space: nowrap;
    }

    #searchInput {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
      flex: 1;
      min-width: 120px;
    }

    #searchInput:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .prompts-list {
      padding: 12px 16px;
    }

    .prompt-card {
      margin-bottom: 10px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
    }

    .freq-badge {
      font-size: 0.78em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--cw-accent-text, #fff);
      background: var(--cw-accent);
      padding: 2px 9px;
      border-radius: 10px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .stats-label {
      font-size: 0.82em;
      opacity: 0.7;
      flex: 1;
    }

    .copy-btn {
      font-size: 0.78em;
      padding: 2px 10px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .copy-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    .copy-btn-sm {
      font-size: 0.72em;
      padding: 1px 6px;
    }

    .prompt-text {
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.95em;
    }

    .variants-details {
      border-top: 1px solid var(--cw-border);
    }

    .variants-summary {
      padding: 5px 12px;
      cursor: pointer;
      font-size: 0.82em;
      opacity: 0.7;
      user-select: none;
    }

    .variants-summary:hover {
      opacity: 1;
    }

    .variants-list {
      list-style: none;
      margin: 0;
      padding: 4px 12px 8px;
    }

    .variant-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 0;
      border-top: 1px solid var(--cw-border);
      font-size: 0.88em;
    }

    .variant-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .variant-text {
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0.85;
    }

    .variant-session {
      font-size: 0.8em;
      opacity: 0.55;
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .variant-freq {
      font-size: 0.82em;
      opacity: 0.55;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 40px 16px;
    }

    .truncated-banner {
      background: var(--vscode-editorWarning-background, rgba(255,200,0,0.12));
      color: var(--vscode-editorWarning-foreground, #c8a800);
      border-bottom: 1px solid var(--vscode-editorWarning-border, rgba(200,168,0,0.3));
      font-size: 0.82em;
      padding: 5px 16px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="promptCount">${totalEntries} prompt${totalEntries === 1 ? '' : 's'}</span>
    <input id="searchInput" type="text" placeholder="Filter by text…" />
  </div>
  ${truncatedBanner}
  <div class="prompts-list" id="promptsList">
    ${clusters.length === 0
            ? '<p class="empty-state">No prompts found across all sessions.</p>'
            : cardsHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const cards = document.querySelectorAll('.prompt-card');
    const countEl = document.getElementById('promptCount');
    const totalCount = ${totalEntries};

    function applyFilter() {
      const query = searchInput.value.toLowerCase();
      let visible = 0;
      cards.forEach(card => {
        const text = card.dataset.text || '';
        const show = !query || text.includes(query);
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' prompt' + (visible === 1 ? '' : 's');
    }

    searchInput.addEventListener('input', applyFilter);

    document.addEventListener('click', e => {
      const btn = e.target.closest('.copy-btn');
      if (!btn) { return; }
      const text = btn.dataset.text || '';
      vscode.postMessage({ command: 'copy', text });
      if (window.cwMorphCopy) { window.cwMorphCopy(btn, btn.textContent); }
    });
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }
}
