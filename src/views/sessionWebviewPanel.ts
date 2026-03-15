import * as vscode from 'vscode';
import { Session } from '../types/index';
import { cwThemeCss, syntaxHighlighterCss, cwInteractiveJs } from '../webview/cwTheme';

export class SessionWebviewPanel {
    static readonly _panels = new Map<string, vscode.WebviewPanel>();

    static show(
        context: vscode.ExtensionContext,
        session: Session,
        searchTerm?: string,
        scrollToCodeBlock?: boolean,
        targetBlockMessageIndex?: number,
        targetBlockContent?: string
    ): void {
        const config = vscode.workspace.getConfiguration('chatwizard');
        const userColor = config.get<string>('userMessageColor', '#007acc') || '#007acc';
        const cbHighlightColor = scrollToCodeBlock
            ? (config.get<string>('codeBlockHighlightColor', '#EA5C00') || '')
            : '';
        const cbScroll = scrollToCodeBlock
            ? (config.get<boolean>('scrollToFirstCodeBlock', true) ?? false)
            : false;

        const payload = SessionWebviewPanel._buildPayload(
            session, userColor, searchTerm,
            cbHighlightColor, cbScroll,
            targetBlockMessageIndex, targetBlockContent
        );

        // Re-use existing panel: just push new data
        const existing = SessionWebviewPanel._panels.get(session.id);
        if (existing) {
            existing.reveal(vscode.ViewColumn.One);
            void existing.webview.postMessage(payload);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardSession3',
            session.title,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        // Set shell ONCE — no user content, so document.write() never sees session data
        panel.webview.html = SessionWebviewPanel._getShellHtml();

        panel.webview.onDidReceiveMessage(
            (msg: { type?: string; command?: string; text?: string }) => {
                if (msg.type === 'ready') {
                    // Webview signalled it is ready — send session data
                    void panel.webview.postMessage(payload);
                } else if (msg.command === 'exportExcerpt') {
                    void vscode.commands.executeCommand('chatwizard.exportExcerpt', session.id);
                } else if (msg.command === 'exportSelection' && msg.text) {
                    void SessionWebviewPanel._saveSelection(msg.text, session.title);
                }
            },
            undefined,
            context.subscriptions
        );

        SessionWebviewPanel._panels.set(session.id, panel);
        panel.onDidDispose(() => SessionWebviewPanel._panels.delete(session.id), null, []);
    }

    // ── Payload builder ──────────────────────────────────────────────────────

    private static _buildPayload(
        session: Session,
        userColor: string,
        searchTerm: string | undefined,
        cbHighlightColor: string,
        cbScroll: boolean,
        targetBlockMessageIndex: number | undefined,
        targetBlockContent: string | undefined
    ): {
        type: 'render';
        title: string;
        userColor: string;
        assistantLabel: string;
        messagesHtml: string;
        term: string | null;
        scrollInit: {
            targetMsgIdx: number | null;
            targetBlockContent: string | null;
            highlightColor: string | null;
            shouldScroll: boolean;
        };
    } {
        const title = session.title;
        const assistantLabel = session.source === 'copilot' ? 'Copilot' : 'Claude';

        const visibleMessages = session.messages
            .map((msg, origIdx) => ({ msg, origIdx }))
            .filter(({ msg }) => msg.content.trim() !== '');

        const messagesHtml = visibleMessages.flatMap(({ msg, origIdx }, i) => {
            const roleClass = msg.role === 'user' ? 'user' : 'assistant';
            const label = msg.role === 'user' ? 'You' : assistantLabel;
            const timestamp = msg.timestamp
                ? `<span class="timestamp">${SessionWebviewPanel._escapeHtml(new Date(msg.timestamp).toLocaleString())}</span>`
                : '';
            const renderedContent = SessionWebviewPanel._markdownToHtml(msg.content);
            const fadeStyle = i < 16 ? ` style="--cw-i:${i}"` : '';
            const html = `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}">
  <div class="message-header">
    <span class="role-label">${label}</span>${timestamp}
  </div>
  <div class="message-body">${renderedContent}</div>
</div>`;
            const nextEntry = visibleMessages[i + 1];
            if (msg.role === 'user' && (!nextEntry || nextEntry.msg.role === 'user')) {
                const aborted = `<div class="message aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice">&#9888; Response not available &mdash; cancelled or incomplete</div>
</div>`;
                return [html, aborted];
            }
            return [html];
        }).join('\n');

        return {
            type: 'render',
            title,
            userColor,
            assistantLabel,
            messagesHtml,
            term: searchTerm ?? null,
            scrollInit: {
                targetMsgIdx: targetBlockMessageIndex ?? null,
                targetBlockContent: targetBlockContent ?? null,
                highlightColor: cbHighlightColor || null,
                shouldScroll: cbScroll,
            },
        };
    }

    // ── Shell HTML (set once, no user content) ───────────────────────────────

    private static _getShellHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    ${syntaxHighlighterCss()}
    :root { --cw-user-color: #007acc; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 16px 24px;
      line-height: 1.6;
    }
    h1 {
      font-size: 1.4em;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444);
    }
    .toolbar {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      padding: 8px 0 10px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
      margin-bottom: 16px;
    }
    .toolbar button {
      background: var(--cw-surface-subtle);
      color: inherit;
      border: 1px solid var(--cw-border-strong);
      padding: 3px 10px;
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .toolbar button:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
    .search-group {
      display: flex;
      flex: 1;
      gap: 4px;
      align-items: center;
      min-width: 160px;
    }
    .message {
      margin-bottom: 14px;
      border-radius: var(--cw-radius);
      padding: 12px 16px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      box-shadow: var(--cw-shadow);
    }
    .message.user   { border-left: 3px solid var(--cw-user-color); }
    .message.assistant { border-left: 3px solid var(--cw-claude, #a67bf0); }
    .message-header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 6px;
    }
    .role-label {
      font-weight: bold;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.75;
    }
    .message.user .role-label { color: var(--cw-user-color); }
    .timestamp { font-size: 0.78em; opacity: 0.5; }
    .message-body { word-wrap: break-word; }
    .message-body p { margin: 0.4em 0; }
    .message-body h1, .message-body h2, .message-body h3,
    .message-body h4, .message-body h5, .message-body h6 {
      margin: 0.8em 0 0.3em; font-weight: bold; line-height: 1.3;
    }
    .message-body h1 { font-size: 1.3em; }
    .message-body h2 { font-size: 1.15em; }
    .message-body h3 { font-size: 1.05em; }
    .message-body h4, .message-body h5, .message-body h6 { font-size: 1em; }
    .message-body ul, .message-body ol { margin: 0.4em 0; padding-left: 1.5em; }
    .message-body li { margin: 0.15em 0; }
    .message-body blockquote {
      margin: 0.5em 0; padding: 4px 12px;
      border-left: 3px solid var(--vscode-textPreformat-background, #555);
      opacity: 0.85;
    }
    .message-body blockquote p { margin: 0; }
    .message-body hr {
      border: none;
      border-top: 1px solid var(--vscode-textBlockQuote-background, #444);
      margin: 0.8em 0;
    }
    .message-body strong { font-weight: bold; }
    .message-body em { font-style: italic; }
    .message-body del { text-decoration: line-through; opacity: 0.75; }
    .table-wrap { overflow-x: auto; margin: 0.5em 0; max-width: 100%; }
    .message-body table { border-collapse: collapse; font-size: 0.92em; white-space: nowrap; }
    .message-body th, .message-body td {
      border: 1px solid var(--vscode-textBlockQuote-background, #444);
      padding: 4px 10px;
    }
    .message-body th {
      background-color: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.06));
      font-weight: bold; position: sticky; top: 0;
    }
    .message-body :not(pre) > code {
      background-color: var(--vscode-textPreformat-background, #2d2d2d);
      border-radius: 3px; padding: 1px 4px;
    }
    pre { border-radius: var(--cw-radius-sm); padding: 12px; overflow-x: auto; margin: 8px 0; white-space: pre; }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .message.aborted {
      background-color: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-errorForeground, #f48771);
      opacity: 0.7;
    }
    .aborted-notice { font-style: italic; color: var(--vscode-errorForeground, #f48771); }
    mark {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33));
      color: inherit; border-radius: 2px; padding: 0 1px;
    }
    mark.cw-active {
      background-color: var(--vscode-editor-findMatchBackground, rgba(234,92,0,0.8));
      outline: 1px solid rgba(234,92,0,0.9);
    }
    #search-input {
      flex: 1;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px; padding: 3px 6px; outline: none;
    }
    #search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
    .search-counter { font-size: 0.8em; opacity: 0.6; white-space: nowrap; min-width: 56px; text-align: right; }
    #sel-ctx-menu {
      position: fixed; z-index: 9999;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 4px; padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: none; min-width: 200px;
    }
    .ctx-item {
      padding: 5px 14px; cursor: pointer; font-size: 0.92em;
      color: var(--vscode-menu-foreground, inherit); white-space: nowrap;
    }
    .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
  </style>
</head>
<body>
  <h1 id="session-title"></h1>
  <div class="toolbar">
    <button id="export-excerpt-btn">Export Excerpt&#8230;</button>
    <div class="search-group">
      <input id="search-input" type="text" placeholder="Search in messages&#8230;" autocomplete="off" />
      <span class="search-counter" id="search-counter"></span>
      <button id="search-prev" title="Previous (Shift+Enter)">&#9650;</button>
      <button id="search-next" title="Next (Enter)">&#9660;</button>
    </div>
  </div>
  <div id="messages-container"></div>
  <button class="cw-back-top" id="backToTop" title="Back to top">&#8593;</button>
  <div id="sel-ctx-menu">
    <div class="ctx-item" id="ctx-export-sel">Export selection as Markdown&#8230;</div>
  </div>
<script>
${cwInteractiveJs()}
(function() {
  var vscode = acquireVsCodeApi();

  // Back to top
  var backTopBtn = document.getElementById('backToTop');
  window.addEventListener('scroll', function() {
    backTopBtn.classList.toggle('visible', window.scrollY > 300);
  });
  backTopBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // Export excerpt
  document.getElementById('export-excerpt-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'exportExcerpt' });
  });

  // Context menu
  var ctxMenu = document.getElementById('sel-ctx-menu');
  var savedSelText = '';
  function hideMenu() { ctxMenu.style.display = 'none'; }
  document.addEventListener('contextmenu', function(e) {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';
    if (!text) { hideMenu(); return; }
    savedSelText = text;
    e.preventDefault();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.style.display = 'block';
    var rect = ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   { ctxMenu.style.left = (e.clientX - rect.width)  + 'px'; }
    if (rect.bottom > window.innerHeight) { ctxMenu.style.top  = (e.clientY - rect.height) + 'px'; }
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideMenu(); } });
  document.getElementById('ctx-export-sel').addEventListener('click', function() {
    if (!savedSelText) { return; }
    vscode.postMessage({ command: 'exportSelection', text: savedSelText });
    savedSelText = '';
    hideMenu();
  });

  // Syntax highlighter (tokenize exposed via closure below)
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
  function escH(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sp(cls, text) { return '<span class="' + cls + '">' + escH(text) + '</span>'; }
  function tokenize(code) {
    var out = '', i = 0, len = code.length;
    while (i < len) {
      var ch = code[i];
      if (ch === '/' && code[i+1] === '*') {
        var ce = code.indexOf('*/', i+2); if (ce === -1) { ce = len-2; }
        out += sp('tok-comment', code.slice(i, ce+2)); i = ce+2; continue;
      }
      if (ch === '/' && code[i+1] === '/') {
        var nl = code.indexOf('\\n', i); if (nl === -1) { nl = len; }
        out += sp('tok-comment', code.slice(i, nl)); i = nl; continue;
      }
      if (ch === '#') {
        var nh = code.indexOf('\\n', i); if (nh === -1) { nh = len; }
        out += sp('tok-comment', code.slice(i, nh)); i = nh; continue;
      }
      if (ch === '"' || ch === "'") {
        var q = ch, j = i+1;
        while (j < len) { if (code[j] === '\\\\') { j+=2; continue; } if (code[j] === q) { j++; break; } j++; }
        out += sp('tok-string', code.slice(i, j)); i = j; continue;
      }
      if (ch >= '0' && ch <= '9') {
        var k = i;
        while (k < len) {
          var c = code[k];
          if (!((c>='0'&&c<='9')||c==='.'||c==='_'||c==='x'||c==='X'||(c>='a'&&c<='f')||(c>='A'&&c<='F'))) { break; }
          k++;
        }
        out += sp('tok-number', code.slice(i, k)); i = k; continue;
      }
      if ((ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||ch==='_') {
        var m = i;
        while (m < len) {
          var mc = code[m];
          if (!((mc>='a'&&mc<='z')||(mc>='A'&&mc<='Z')||(mc>='0'&&mc<='9')||mc==='_')) { break; }
          m++;
        }
        var word = code.slice(i, m), next = code[m]||'';
        if (KEYWORDS.has(word))                    { out += sp('tok-keyword',  word); }
        else if (next === '(')                     { out += sp('tok-function', word); }
        else if (word[0]>='A' && word[0]<='Z')    { out += sp('tok-type',     word); }
        else                                       { out += escH(word); }
        i = m; continue;
      }
      out += escH(ch); i++;
    }
    return out;
  }
  function highlightAll() {
    document.querySelectorAll('pre code').forEach(function(block) {
      block.innerHTML = tokenize(block.textContent || '');
    });
  }

  // Search
  var cwMarks = [], cwIdx = -1;
  var srchInput   = document.getElementById('search-input');
  var srchCounter = document.getElementById('search-counter');
  var srchPrev    = document.getElementById('search-prev');
  var srchNext    = document.getElementById('search-next');
  function escRx(s) { return s.replace(/[.*+?^{}()|$[\]\\]/g, '\\$&'); }
  function clearMarks() {
    cwMarks.forEach(function(mk) {
      var p = mk.parentNode;
      if (p) { p.replaceChild(document.createTextNode(mk.textContent), mk); p.normalize(); }
    });
    cwMarks = []; cwIdx = -1;
  }
  function walkBody(root, rx) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [], n;
    while ((n = walker.nextNode())) { nodes.push(n); }
    nodes.forEach(function(textNode) {
      var text = textNode.nodeValue;
      if (!rx.test(text)) { rx.lastIndex = 0; return; }
      rx.lastIndex = 0;
      var frag = document.createDocumentFragment(), last = 0, mm;
      while ((mm = rx.exec(text)) !== null) {
        if (mm.index > last) { frag.appendChild(document.createTextNode(text.slice(last, mm.index))); }
        var mark = document.createElement('mark');
        mark.textContent = mm[0];
        frag.appendChild(mark);
        cwMarks.push(mark);
        last = rx.lastIndex;
      }
      if (last < text.length) { frag.appendChild(document.createTextNode(text.slice(last))); }
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }
  function setActive(idx) {
    cwMarks.forEach(function(mk, ii) { mk.classList.toggle('cw-active', ii === idx); });
    if (cwMarks[idx]) { cwMarks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    srchCounter.textContent = cwMarks.length > 0 ? (idx + 1) + ' / ' + cwMarks.length : 'No matches';
  }
  function runSearch(query) {
    clearMarks();
    if (!query) { srchCounter.textContent = ''; return; }
    var rx = new RegExp(escRx(query), 'gi');
    document.querySelectorAll('.message-body').forEach(function(body) { walkBody(body, rx); });
    if (cwMarks.length === 0) { srchCounter.textContent = 'No matches'; return; }
    cwIdx = 0; setActive(cwIdx);
  }
  function navSearch(dir) {
    if (cwMarks.length === 0) { return; }
    cwIdx = (cwIdx + dir + cwMarks.length) % cwMarks.length;
    setActive(cwIdx);
  }
  srchInput.addEventListener('input',   function() { runSearch(srchInput.value); });
  srchPrev.addEventListener('click',    function() { navSearch(-1); });
  srchNext.addEventListener('click',    function() { navSearch(1); });
  srchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { navSearch(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === 'Escape') { srchInput.value = ''; runSearch(''); }
  });

  // Scroll to element, offsetting for sticky toolbar
  var _toolbar = document.querySelector('.toolbar');
  function cwScrollTo(el) {
    el.scrollIntoView({ block: 'start' });
    var toolbarH = _toolbar ? _toolbar.offsetHeight : 0;
    if (toolbarH > 0) { window.scrollBy(0, -(toolbarH + 8)); }
  }

  // Scroll to code block
  function cwDoScroll(p) {
    if (!p || (!p.highlightColor && !p.shouldScroll)) { return; }
    if (p.targetMsgIdx !== null && p.targetMsgIdx !== undefined) {
      var el = document.querySelector('[data-msg-idx="' + p.targetMsgIdx + '"]');
      var msgPres = el ? Array.from(el.querySelectorAll('pre')) : [];
      if (msgPres.length > 0) {
        var target;
        if (p.targetBlockContent && msgPres.length > 1) {
          var needle = p.targetBlockContent.trim().slice(0, 60);
          target = msgPres.find(function(pr) { return pr.textContent.trim().slice(0, 60) === needle; }) || msgPres[0];
        } else {
          target = msgPres[0];
        }
        if (p.highlightColor) { target.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }
        cwScrollTo(target);
        return;
      }
      if (el) { cwScrollTo(el); return; }
    }
    var pres = Array.from(document.querySelectorAll('pre'));
    if (p.highlightColor) { pres.forEach(function(x) { x.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }); }
    if (p.shouldScroll && pres.length > 0) { cwScrollTo(pres[0]); }
  }

  // Message handler: receives rendered session data
  window.addEventListener('message', function(event) {
    var data = event.data;
    if (data.type === 'render') {
      // Update title
      document.getElementById('session-title').textContent = data.title;
      // Update user colour CSS variable
      document.documentElement.style.setProperty('--cw-user-color', data.userColor || '#007acc');
      // Insert messages HTML
      var container = document.getElementById('messages-container');
      container.innerHTML = data.messagesHtml;
      // Syntax highlight new code blocks
      highlightAll();
      // Initialise search
      clearMarks();
      if (data.term) { srchInput.value = data.term; runSearch(data.term); }
      else           { srchInput.value = ''; srchCounter.textContent = ''; }
      // Scroll to code block if requested
      if (data.scrollInit && (data.scrollInit.highlightColor || data.scrollInit.shouldScroll)) {
        setTimeout(function() { cwDoScroll(data.scrollInit); }, 50);
      }
    }
    if (data.type === 'cwScroll') {
      cwDoScroll(data);
    }
  });

  // Signal ready — extension host will send the 'render' payload
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static async _saveSelection(text: string, sessionTitle: string): Promise<void> {
        const safe = sessionTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
        const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '/';
        const defaultUri = vscode.Uri.file(`${home}/${safe}-selection.md`);
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Markdown': ['md'] },
            title: 'Export Selection as Markdown',
        });
        if (!uri) { return; }
        const content = `# Selection from: ${sessionTitle}\n\n${text}\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        await vscode.window.showTextDocument(uri);
    }

    private static _escapeHtml(text: string): string {
        return text
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/[^\x00-\x7F]/gu, c => `&#${c.codePointAt(0)};`);
    }

    private static _applyInline(text: string): string {
        return text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    }

    private static _markdownToHtml(markdown: string): string {
        // Strip non-printable control characters (keep \t \n \r)
        markdown = markdown.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        // Encode non-ASCII as HTML entities
        markdown = markdown.replace(/[^\x00-\x7F]/gu, c => `&#${c.codePointAt(0)};`);

        const codeBlocks: string[] = [];
        let text = markdown.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
            const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const attr = lang.trim() ? ` class="language-${lang.trim()}"` : '';
            codeBlocks.push(`<pre><code${attr}>${esc}</code></pre>`);
            return `\x00CB${codeBlocks.length - 1}\x00`;
        });

        text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const inlineCodes: string[] = [];
        text = text.replace(/`([^`]+)`/g, (_m, code) => {
            inlineCodes.push(`<code>${code}</code>`);
            return `\x00IC${inlineCodes.length - 1}\x00`;
        });

        const lines = text.split('\n');
        const out: string[] = [];
        let inUl = false, inOl = false, inTable = false;
        let columnAligns: string[] = [];
        let paragraphLines: string[] = [];

        const closeList  = (): void => {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (inOl) { out.push('</ol>'); inOl = false; }
        };
        const closeTable = (): void => {
            if (inTable) { out.push('</tbody></table></div>'); inTable = false; columnAligns = []; }
        };
        const alignAttr = (colIdx: number): string => {
            const a = columnAligns[colIdx] ?? '';
            return a ? ` style="text-align:${a}"` : '';
        };
        const flushParagraph = (): void => {
            if (paragraphLines.length > 0) {
                out.push(`<p>${paragraphLines.join('<br>')}</p>`);
                paragraphLines = [];
            }
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            const cbMatch = line.trim().match(/^\x00CB(\d+)\x00$/);
            if (cbMatch) { flushParagraph(); closeList(); closeTable(); out.push(codeBlocks[+cbMatch[1]]); continue; }

            if (line.startsWith('    ') && !inUl && !inOl) {
                flushParagraph(); closeList(); closeTable();
                const indentedLines: string[] = [line.slice(4)];
                while (i + 1 < lines.length && lines[i + 1].startsWith('    ')) {
                    i++; indentedLines.push(lines[i].slice(4));
                }
                const esc = indentedLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                out.push(`<pre><code>${esc}</code></pre>`);
                continue;
            }

            const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (hMatch) {
                flushParagraph(); closeList(); closeTable();
                const lvl = hMatch[1].length;
                out.push(`<h${lvl}>${SessionWebviewPanel._applyInline(hMatch[2])}</h${lvl}>`);
                continue;
            }

            if (/^([-*_])\1\1+\s*$/.test(line)) { flushParagraph(); closeList(); closeTable(); out.push('<hr>'); continue; }

            const bqMatch = line.match(/^&gt;\s?(.*)$/);
            if (bqMatch) {
                flushParagraph(); closeList(); closeTable();
                out.push(`<blockquote><p>${SessionWebviewPanel._applyInline(bqMatch[1])}</p></blockquote>`);
                continue;
            }

            if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
                const nextLine = lines[i + 1] ?? '';
                const isSeparator = /^\|[\s|:-]+\|$/.test(nextLine.trim());
                if (isSeparator && !inTable) {
                    flushParagraph(); closeList();
                    const headerCells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                    const sepCells    = nextLine.trim().slice(1, -1).split('|').map(c => c.trim());
                    columnAligns = sepCells.map(c => {
                        if (c.startsWith(':') && c.endsWith(':')) { return 'center'; }
                        if (c.endsWith(':')) { return 'right'; }
                        if (c.startsWith(':')) { return 'left'; }
                        return '';
                    });
                    out.push('<div class="table-wrap"><table><thead><tr>');
                    for (let ci = 0; ci < headerCells.length; ci++) {
                        out.push(`<th${alignAttr(ci)}>${SessionWebviewPanel._applyInline(headerCells[ci])}</th>`);
                    }
                    out.push('</tr></thead><tbody>');
                    inTable = true; i++; continue;
                }
                if (/^\|[\s|:-]+\|$/.test(line.trim())) { continue; }
                if (inTable || (!isSeparator && /^\|/.test(line.trim()))) {
                    if (!inTable) { flushParagraph(); closeList(); out.push('<div class="table-wrap"><table><tbody>'); inTable = true; }
                    const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                    out.push('<tr>');
                    for (let ci = 0; ci < cells.length; ci++) {
                        out.push(`<td${alignAttr(ci)}>${SessionWebviewPanel._applyInline(cells[ci])}</td>`);
                    }
                    out.push('</tr>');
                    continue;
                }
            } else if (inTable) {
                closeTable();
            }

            const ulMatch = line.match(/^[-*+]\s+(.+)$/);
            if (ulMatch) {
                flushParagraph(); closeTable();
                if (inOl) { out.push('</ol>'); inOl = false; }
                if (!inUl) { out.push('<ul>'); inUl = true; }
                out.push(`<li>${SessionWebviewPanel._applyInline(ulMatch[1])}</li>`);
                continue;
            }

            const olMatch = line.match(/^\d+\.\s+(.+)$/);
            if (olMatch) {
                flushParagraph(); closeTable();
                if (inUl) { out.push('</ul>'); inUl = false; }
                if (!inOl) { out.push('<ol>'); inOl = true; }
                out.push(`<li>${SessionWebviewPanel._applyInline(olMatch[1])}</li>`);
                continue;
            }

            if (line.trim() === '') { flushParagraph(); closeList(); closeTable(); continue; }

            closeList(); closeTable();
            paragraphLines.push(SessionWebviewPanel._applyInline(line));
        }
        flushParagraph(); closeList(); closeTable();

        let result = out.join('\n');
        result = result.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[+i]);
        result = result.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[+i]);
        return result;
    }

}

