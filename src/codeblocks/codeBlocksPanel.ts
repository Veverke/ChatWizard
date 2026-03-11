import * as vscode from 'vscode';
import { IndexedCodeBlock } from '../types/index';
import { SessionIndex } from '../index/sessionIndex';
import { CodeBlockSearchEngine } from './codeBlockSearchEngine';
import { cwThemeCss, syntaxHighlighterCss, syntaxHighlighterJs, cwInteractiveJs } from '../webview/cwTheme';

export class CodeBlocksPanel {
    private static _panel: vscode.WebviewPanel | undefined;

    static show(
        context: vscode.ExtensionContext,
        index: SessionIndex,
        engine: CodeBlockSearchEngine
    ): void {
        // Rebuild the engine with current blocks
        const blocks = index.getAllCodeBlocks();
        engine.index(blocks);

        if (CodeBlocksPanel._panel) {
            CodeBlocksPanel._panel.reveal(vscode.ViewColumn.One);
            CodeBlocksPanel._panel.webview.html = CodeBlocksPanel._getHtml(blocks, engine);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardCodeBlocks',
            'Code Blocks',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        CodeBlocksPanel._panel = panel;
        panel.webview.html = CodeBlocksPanel._getHtml(blocks, engine);

        panel.onDidDispose(() => {
            CodeBlocksPanel._panel = undefined;
        }, null, context.subscriptions);

        // Handle copy messages from webview
        panel.webview.onDidReceiveMessage((message: { command: string; text: string }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text);
                void vscode.window.showInformationMessage('Code block copied to clipboard.');
            }
        }, undefined, context.subscriptions);
    }

    /** Call this when the index changes to refresh the open panel if visible */
    static refresh(index: SessionIndex, engine: CodeBlockSearchEngine): void {
        if (!CodeBlocksPanel._panel) { return; }
        const blocks = index.getAllCodeBlocks();
        engine.index(blocks);
        CodeBlocksPanel._panel.webview.html = CodeBlocksPanel._getHtml(blocks, engine);
    }

    private static _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private static _getHtml(blocks: IndexedCodeBlock[], engine: CodeBlockSearchEngine): string {
        const totalCount = blocks.length;
        const languages = engine.getLanguages();

        // Build language options
        const langOptions = languages
            .map(lang => `<option value="${CodeBlocksPanel._escapeHtml(lang)}">${CodeBlocksPanel._escapeHtml(lang)}</option>`)
            .join('\n        ');

        // Build block cards
        const cardsHtml = blocks.map((block, i) => {
            const lang = block.language || '';
            const langDisplay = lang || 'plain';
            const roleLabel = block.messageRole === 'user' ? 'User' : 'AI';
            const sourceLabel = block.sessionSource === 'copilot' ? 'Copilot' : 'Claude';
            const dateStr = block.sessionUpdatedAt ? block.sessionUpdatedAt.slice(0, 10) : '';
            const workspaceName = block.sessionWorkspacePath
                ? block.sessionWorkspacePath.replace(/\\/g, '/').split('/').pop() ?? ''
                : '';

            const escapedTitle = CodeBlocksPanel._escapeHtml(block.sessionTitle);
            const escapedContent = CodeBlocksPanel._escapeHtml(block.content);
            const escapedLang = CodeBlocksPanel._escapeHtml(lang);
            const escapedLangDisplay = CodeBlocksPanel._escapeHtml(langDisplay);
            const escapedLangLower = CodeBlocksPanel._escapeHtml(lang.toLowerCase());
            // data-content is lowercased for case-insensitive client-side search
            const escapedContentLower = CodeBlocksPanel._escapeHtml(block.content.toLowerCase());
            // data-full-content carries the raw content for copy (HTML-attribute-escaped)
            const escapedFullContent = CodeBlocksPanel._escapeHtml(block.content);
            const escapedWorkspace = CodeBlocksPanel._escapeHtml(workspaceName);
            const escapedDate = CodeBlocksPanel._escapeHtml(dateStr);
            const escapedSource = CodeBlocksPanel._escapeHtml(sourceLabel);
            const escapedRole = CodeBlocksPanel._escapeHtml(roleLabel);

            const fadeAttr = i < 15 ? ` style="--cw-i:${i}"` : '';
            return `<div class="block-card cw-fade-item"${fadeAttr} data-lang="${escapedLangLower}" data-content="${escapedContentLower}" data-full-content="${escapedFullContent}">
  <div class="card-header">
    <span class="badge badge-lang" data-lang="${escapedLangLower}">${escapedLangDisplay}</span>
    <span class="badge badge-role">${escapedRole}</span>
    <span class="source-label">${escapedSource}</span>
    <span class="session-title">${escapedTitle}</span>
    <span class="session-date">${escapedDate}</span>${workspaceName ? `\n    <span class="session-workspace">${escapedWorkspace}</span>` : ''}
    <button class="copy-btn" title="Copy code block">Copy</button>
  </div>
  <pre><code${lang ? ` class="language-${escapedLang}"` : ''}>${escapedContent}</code></pre>
</div>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    ${syntaxHighlighterCss()}
    * {
      box-sizing: border-box;
    }

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

    .toolbar label {
      font-size: 0.85em;
      opacity: 0.75;
      white-space: nowrap;
    }

    #blockCount {
      font-size: 0.85em;
      opacity: 0.65;
      white-space: nowrap;
      margin-right: 4px;
    }

    #langFilter,
    #searchInput {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
    }

    #langFilter:focus,
    #searchInput:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    #searchInput {
      flex: 1;
      min-width: 120px;
    }

    .blocks-list {
      padding: 12px 16px;
    }

    .block-card {
      margin-bottom: 12px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 6px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
      position: relative;
    }

    .badge {
      font-size: 0.78em;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 3px;
      white-space: nowrap;
    }

    .badge-lang {
      background: var(--cw-surface-subtle);
      color: var(--cw-accent);
      border: 1px solid var(--cw-border-strong);
      text-transform: lowercase;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .badge-lang[data-lang="javascript"], .badge-lang[data-lang="js"],
    .badge-lang[data-lang="typescript"], .badge-lang[data-lang="ts"],
    .badge-lang[data-lang="jsx"],        .badge-lang[data-lang="tsx"] {
      background: rgba(78,201,78,0.12); color: #4ec94e; border-color: rgba(78,201,78,0.3);
    }
    .badge-lang[data-lang="python"], .badge-lang[data-lang="py"] {
      background: rgba(91,155,213,0.12); color: #5b9bd5; border-color: rgba(91,155,213,0.3);
    }
    .badge-lang[data-lang="rust"] {
      background: rgba(240,136,62,0.12); color: #f0883e; border-color: rgba(240,136,62,0.3);
    }
    .badge-lang[data-lang="go"] {
      background: rgba(41,190,176,0.12); color: #29beb0; border-color: rgba(41,190,176,0.3);
    }
    .badge-lang[data-lang="shell"], .badge-lang[data-lang="bash"], .badge-lang[data-lang="sh"] {
      background: rgba(166,123,240,0.12); color: #a67bf0; border-color: rgba(166,123,240,0.3);
    }
    .badge-lang[data-lang="json"] {
      background: rgba(226,201,111,0.12); color: #e2c96f; border-color: rgba(226,201,111,0.3);
    }
    .badge-lang[data-lang="html"], .badge-lang[data-lang="css"] {
      background: rgba(244,112,103,0.12); color: #f47067; border-color: rgba(244,112,103,0.3);
    }

    .badge-role {
      background: var(--cw-surface-subtle);
      color: var(--cw-text-muted);
      border: 1px solid var(--cw-border-strong);
    }

    .source-label {
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
    }

    .session-title {
      font-size: 0.85em;
      font-weight: 500;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-date {
      font-size: 0.78em;
      opacity: 0.55;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .session-workspace {
      font-size: 0.78em;
      opacity: 0.5;
      white-space: nowrap;
      font-style: italic;
    }

    .copy-btn {
      margin-left: auto;
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

    pre {
      margin: 0;
      padding: 12px 14px;
      overflow-x: auto;
      white-space: pre;
    }

    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 40px 16px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="blockCount">${totalCount} block${totalCount === 1 ? '' : 's'}</span>
    <label for="langFilter">Language:</label>
    <select id="langFilter">
      <option value="">All languages</option>
      ${langOptions}
    </select>
    <input id="searchInput" type="text" placeholder="Filter by content…" />
  </div>
  <div class="blocks-list">
    ${blocks.length === 0 ? '<p class="empty-state">No code blocks found across all sessions.</p>' : cardsHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    const langSelect = document.getElementById('langFilter');
    const searchInput = document.getElementById('searchInput');
    const cards = document.querySelectorAll('.block-card');
    const countEl = document.getElementById('blockCount');

    function applyFilters() {
      const lang = langSelect.value;
      const query = searchInput.value.toLowerCase();
      let visible = 0;
      cards.forEach(card => {
        const cardLang = card.dataset.lang || '';
        const cardContent = card.dataset.content || '';
        const langMatch = !lang || cardLang === lang;
        const queryMatch = !query || cardContent.includes(query);
        const show = langMatch && queryMatch;
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' block' + (visible === 1 ? '' : 's');
    }

    langSelect.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = btn.closest('.block-card').dataset.fullContent;
        vscode.postMessage({ command: 'copy', text: content });
        if (window.cwMorphCopy) { window.cwMorphCopy(btn, 'Copy'); }
      });
    });
  </script>
  <script>${syntaxHighlighterJs()}</script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }
}
