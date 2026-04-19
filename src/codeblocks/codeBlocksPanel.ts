import * as vscode from 'vscode';
import { IndexedCodeBlock } from '../types/index';
import { SessionIndex } from '../index/sessionIndex';
import { CodeBlockSearchEngine } from './codeBlockSearchEngine';
import { cwThemeCss, syntaxHighlighterCss, cwInteractiveJs } from '../webview/cwTheme';

interface CodeBlockPayloadItem {
    language: string;
    content: string;
    sessionTitle: string;
    sessionSource: string;
    sessionUpdatedAt: string;
    sessionWorkspacePath?: string;
    messageRole: string;
}

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
            // Shell already set — push data update
            void CodeBlocksPanel._panel.webview.postMessage({
                type: 'update',
                data: CodeBlocksPanel.buildPayload(blocks, engine),
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardCodeBlocks',
            'Code Blocks',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        CodeBlocksPanel._panel = panel;
        panel.webview.html = CodeBlocksPanel.getShellHtml();

        panel.onDidDispose(() => {
            CodeBlocksPanel._panel = undefined;
        }, null, context.subscriptions);

        // Handle messages from webview
        panel.webview.onDidReceiveMessage((message: { type?: string; command?: string; text?: string }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text ?? '');
                void vscode.window.showInformationMessage('Code block copied to clipboard.');
            } else if (message.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
            } else if (message.command === 'rescan') {
                void vscode.commands.executeCommand('chatwizard.rescan');
            } else if (message.type === 'ready') {
                void panel.webview.postMessage({
                    type: 'update',
                    data: CodeBlocksPanel.buildPayload(blocks, engine),
                });
            }
        }, undefined, context.subscriptions);
    }

    /** Call this when the index changes to refresh the open panel if visible */
    static refresh(index: SessionIndex, engine: CodeBlockSearchEngine): void {
        if (!CodeBlocksPanel._panel) { return; }
        const blocks = index.getAllCodeBlocks();
        engine.index(blocks);
        void CodeBlocksPanel._panel.webview.postMessage({
            type: 'update',
            data: CodeBlocksPanel.buildPayload(blocks, engine),
        });
    }

    static buildPayload(
        blocks: IndexedCodeBlock[],
        engine: CodeBlockSearchEngine
    ): { blocks: CodeBlockPayloadItem[]; languages: string[] } {
        return {
            blocks: blocks.map(b => ({
                language: b.language || '',
                content: b.content,
                sessionTitle: b.sessionTitle,
                sessionSource: b.sessionSource,
                sessionUpdatedAt: b.sessionUpdatedAt ?? '',
                sessionWorkspacePath: b.sessionWorkspacePath,
                messageRole: b.messageRole,
            })),
            languages: engine.getLanguages(),
        };
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
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="blockCount">Loading&#8230;</span>
    <label for="langFilter">Language:</label>
    <select id="langFilter">
      <option value="">All languages</option>
    </select>
    <input id="searchInput" type="text" placeholder="Filter by content&#8230;" />
  </div>
  <div class="blocks-list" id="blocks-list"></div>
  <script>
    const vscode = acquireVsCodeApi();

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const langSelect  = document.getElementById('langFilter');
    const searchInput = document.getElementById('searchInput');
    const countEl     = document.getElementById('blockCount');
    const listEl      = document.getElementById('blocks-list');

    function applyFilters() {
      const lang  = langSelect.value;
      const query = searchInput.value.toLowerCase();
      const cards = listEl.querySelectorAll('.block-card');
      let visible = 0;
      cards.forEach(function(card) {
        const cardLang    = card.dataset.lang    || '';
        const cardContent = card.dataset.content || '';
        const langMatch   = !lang  || cardLang === lang;
        const queryMatch  = !query || cardContent.includes(query);
        const show = langMatch && queryMatch;
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' block' + (visible === 1 ? '' : 's');
    }

    langSelect.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);

    // Copy via event delegation -- survives DOM rebuilds
    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) { return; }
      const content = btn.closest('.block-card') && btn.closest('.block-card').dataset.fullContent;
      if (content !== undefined) {
        vscode.postMessage({ command: 'copy', text: content });
        if (window.cwMorphCopy) { window.cwMorphCopy(btn, 'Copy'); }
      }
    });

    function renderData(payload) {
      const scrollTop = window.scrollY;

      // Save current filter selections
      const savedLang  = langSelect.value;
      const savedQuery = searchInput.value;

      // Rebuild language options
      const langs = payload.languages || [];
      let optHtml = '<option value="">All languages</option>';
      langs.forEach(function(lang) {
        optHtml += '<option value="' + escHtml(lang) + '">' + escHtml(lang) + '</option>';
      });
      langSelect.innerHTML = optHtml;

      // Restore saved lang if still available
      if (langs.includes(savedLang)) {
        langSelect.value = savedLang;
      } else {
        langSelect.value = '';
      }
      searchInput.value = savedQuery;

      const blocks = payload.blocks || [];

      if (blocks.length === 0) {
        listEl.innerHTML = '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No code blocks indexed yet.</p>'
          + '<p class="empty-state-body">Chat Wizard indexes code blocks from your AI chat sessions. Configure your data paths and rescan to see results.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="copy-btn" id="btn-open-settings">Configure Paths</button>'
          + '<button class="copy-btn" id="btn-rescan">Rescan</button>'
          + '</div></div>';
        var btnCfg = document.getElementById('btn-open-settings');
        var btnScan = document.getElementById('btn-rescan');
        if (btnCfg) { btnCfg.addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); }); }
        if (btnScan) { btnScan.addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); }); }
        countEl.textContent = '0 blocks';
        return;
      }

      let cardsHtml = '';
      blocks.forEach(function(block, i) {
        const lang         = block.language || '';
        const langDisplay  = lang || 'plain';
        const langLower    = lang.toLowerCase();
        const roleLabel    = block.messageRole === 'user' ? 'User' : 'AI';
        const SRC_LABEL = {
          claude: 'Claude Code', copilot: 'GitHub Copilot', cline: 'Cline',
          roocode: 'Roo Code', cursor: 'Cursor', windsurf: 'Windsurf', aider: 'Aider'
        };
        const sourceLabel  = SRC_LABEL[block.sessionSource] || block.sessionSource;
        const sourceBadge  = block.sessionSource === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
        const dateStr      = block.sessionUpdatedAt ? block.sessionUpdatedAt.slice(0, 10) : '';
        const wsPath       = block.sessionWorkspacePath || '';
        const wsName       = wsPath ? (wsPath.replace(/\\\\/g, '/').split('/').pop() || '') : '';
        const contentLower = block.content.toLowerCase();

        const fadeAttr = i < 15 ? ' style="--cw-i:' + i + '"' : '';
        const wsSpan   = wsName
          ? '\\n    <span class="session-workspace">' + escHtml(wsName) + '</span>'
          : '';

        cardsHtml +=
          '<div class="block-card cw-fade-item"' + fadeAttr
          + ' data-lang="' + escHtml(langLower) + '"'
          + ' data-content="' + escHtml(contentLower) + '"'
          + ' data-full-content="' + escHtml(block.content) + '">'
          + '\\n  <div class="card-header">'
          + '\\n    <span class="badge badge-lang" data-lang="' + escHtml(langLower) + '">' + escHtml(langDisplay) + '</span>'
          + '\\n    <span class="badge badge-role">' + escHtml(roleLabel) + '</span>'
          + '\\n    <span class="' + sourceBadge + '">' + escHtml(sourceLabel) + '</span>'
          + '\\n    <span class="session-title">' + escHtml(block.sessionTitle) + '</span>'
          + '\\n    <span class="session-date">' + escHtml(dateStr) + '</span>'
          + wsSpan
          + '\\n    <button class="copy-btn" title="Copy code block">Copy</button>'
          + '\\n  </div>'
          + '\\n  <pre><code' + (lang ? ' class="language-' + escHtml(lang) + '"' : '') + '>'
          + escHtml(block.content)
          + '</code></pre>'
          + '\\n</div>';
      });

      listEl.innerHTML = cardsHtml;

      // Re-run syntax highlighter on new DOM
      if (window._cwRunHighlighter) { window._cwRunHighlighter(); }

      // Apply current filters
      applyFilters();

      // Restore scroll position
      window.scrollTo(0, scrollTop);
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        renderData(msg.data);
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
  <script>
    // Expose tokenize globally so renderData can re-run after DOM rebuild
    (function() {
      var KEYWORDS = new Set([
        'abstract','as','async','await','break','case','catch','class','const',
        'continue','debugger','declare','default','delete','do','else','enum',
        'export','extends','false','finally','for','from','function','get','if',
        'implements','import','in','instanceof','interface','let','namespace',
        'new','null','of','package','private','protected','public','readonly',
        'return','set','static','super','switch','this','throw','true','try',
        'type','typeof','undefined','var','void','while','with','yield',
        'def','elif','except','exec','lambda','nonlocal','pass','print','raise',
        'and','not','or','is',
        'fn','mut','pub','use','mod','impl','struct','trait','where',
        'int','float','double','char','long','short','byte','unsigned','signed',
        'auto','register','extern','volatile','inline','None','True','False','self'
      ]);

      function escH(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function sp(cls, text) { return '<span class="' + cls + '">' + escH(text) + '</span>'; }
      function cwTokenize(code) {
        var out = ''; var i = 0; var len = code.length;
        while (i < len) {
          var ch = code[i];
          if (ch === '/' && code[i+1] === '*') { var ce = code.indexOf('*/', i+2); if (ce===-1){ce=len-2;} out+=sp('tok-comment',code.slice(i,ce+2)); i=ce+2; continue; }
          if (ch === '/' && code[i+1] === '/') { var nl = code.indexOf('\\n',i); if(nl===-1){nl=len;} out+=sp('tok-comment',code.slice(i,nl)); i=nl; continue; }
          if (ch === '#') { var nh = code.indexOf('\\n',i); if(nh===-1){nh=len;} out+=sp('tok-comment',code.slice(i,nh)); i=nh; continue; }
          if (ch==='"'||ch==="'") { var q=ch,j=i+1; while(j<len){if(code[j]==='\\\\'){j+=2;continue;}if(code[j]===q){j++;break;}j++;} out+=sp('tok-string',code.slice(i,j)); i=j; continue; }
          if (ch>='0'&&ch<='9') { var k=i; while(k<len){var c=code[k];if(!((c>='0'&&c<='9')||c==='.'||c==='_'||c==='x'||c==='X'||(c>='a'&&c<='f')||(c>='A'&&c<='F'))){break;}k++;} out+=sp('tok-number',code.slice(i,k)); i=k; continue; }
          if ((ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||ch==='_') { var m=i; while(m<len){var mc=code[m];if(!((mc>='a'&&mc<='z')||(mc>='A'&&mc<='Z')||(mc>='0'&&mc<='9')||mc==='_')){break;}m++;} var word=code.slice(i,m),next=code[m]||''; if(KEYWORDS.has(word)){out+=sp('tok-keyword',word);}else if(next==='('){out+=sp('tok-function',word);}else if(word[0]>='A'&&word[0]<='Z'){out+=sp('tok-type',word);}else{out+=escH(word);} i=m; continue; }
          out+=escH(ch); i++;
        }
        return out;
      }
      window._cwRunHighlighter = function() {
        document.querySelectorAll('pre code').forEach(function(block) {
          block.innerHTML = cwTokenize(block.textContent || '');
        });
      };
      // Run once on initial load
      window._cwRunHighlighter();
    })();
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }
}
