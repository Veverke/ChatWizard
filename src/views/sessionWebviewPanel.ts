import * as vscode from 'vscode';
import { Session } from '../types/index';

export class SessionWebviewPanel {
    static readonly _panels = new Map<string, vscode.WebviewPanel>();

    static show(
        context: vscode.ExtensionContext,
        session: Session,
        searchTerm?: string,
        scrollToCodeBlock?: boolean
    ): void {
        const existing = SessionWebviewPanel._panels.get(session.id);
        if (existing) {
            existing.reveal(vscode.ViewColumn.One);
            // Re-render with the (possibly new) options so highlights update
            existing.webview.html = SessionWebviewPanel._getHtml(session, searchTerm, scrollToCodeBlock);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardSession',
            session.title,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = SessionWebviewPanel._getLoadingHtml(session.title);
        // Defer rendering so the loading state is painted first
        setTimeout(() => {
            if (!panel.visible && !SessionWebviewPanel._panels.has(session.id)) { return; }
            panel.webview.html = SessionWebviewPanel._getHtml(session, searchTerm, scrollToCodeBlock);
        }, 0);

        SessionWebviewPanel._panels.set(session.id, panel);

        panel.webview.onDidReceiveMessage(
            (msg: { command: string; text?: string }) => {
                if (msg.command === 'exportExcerpt') {
                    void vscode.commands.executeCommand('chatwizard.exportExcerpt', session.id);
                } else if (msg.command === 'exportSelection' && msg.text) {
                    void SessionWebviewPanel._saveSelection(msg.text, session.title);
                }
            },
            undefined,
            context.subscriptions
        );

        panel.onDidDispose(() => SessionWebviewPanel._panels.delete(session.id), null, []);
    }

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

    private static _getLoadingHtml(title: string): string {
        const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 16px 24px;
    }
    h1 { font-size: 1.4em; margin-bottom: 24px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444); }
    .loading { display: flex; align-items: center; gap: 10px; opacity: 0.7; margin-top: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 16px; height: 16px; flex-shrink: 0;
      border: 2px solid var(--vscode-editor-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <h1>${escaped}</h1>
  <p class="loading"><span class="spinner"></span>Loading conversation…</p>
</body>
</html>`;
    }

    private static _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Apply inline markdown: bold, italic, strikethrough, inline-code placeholders, links. */
    private static _applyInline(text: string): string {
        return text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    }

    /**
     * Convert a markdown string to safe HTML.
     * Handles: fenced code blocks, headings, hr, blockquotes, lists, bold, italic,
     * inline code, and links. Unknown HTML is escaped.
     */
    private static _markdownToHtml(markdown: string): string {
        // Step 1: extract fenced code blocks before any escaping
        const codeBlocks: string[] = [];
        let text = markdown.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
            const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const attr = lang.trim() ? ` class="language-${lang.trim()}"` : '';
            codeBlocks.push(`<pre><code${attr}>${esc}</code></pre>`);
            return `\x00CB${codeBlocks.length - 1}\x00`;
        });

        // Step 2: HTML-escape the remainder
        text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Step 3: extract inline code (content already escaped)
        const inlineCodes: string[] = [];
        text = text.replace(/`([^`]+)`/g, (_m, code) => {
            inlineCodes.push(`<code>${code}</code>`);
            return `\x00IC${inlineCodes.length - 1}\x00`;
        });

        // Step 4: process line by line for block elements
        const lines = text.split('\n');
        const out: string[] = [];
        let inUl = false;
        let inOl = false;
        let inTable = false;
        let columnAligns: string[] = []; // 'left' | 'center' | 'right' | ''
        let paragraphLines: string[] = [];
        const closeList = (): void => {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (inOl) { out.push('</ol>'); inOl = false; }
        };
        const closeTable = (): void => {
            if (inTable) { out.push('</tbody></table></div>'); inTable = false; columnAligns = []; }
        };
        const alignAttr = (colIdx: number, tag: 'th' | 'td'): string => {
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

            // Fenced code block placeholder (whole line)
            const cbMatch = line.trim().match(/^\x00CB(\d+)\x00$/);
            if (cbMatch) { flushParagraph(); closeList(); closeTable(); out.push(codeBlocks[+cbMatch[1]]); continue; }

            // 4-space indented code block
            if (line.startsWith('    ') && !inUl && !inOl) {
                flushParagraph(); closeList(); closeTable();
                const indentedLines: string[] = [line.slice(4)];
                while (i + 1 < lines.length && lines[i + 1].startsWith('    ')) {
                    i++;
                    indentedLines.push(lines[i].slice(4));
                }
                const esc = indentedLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                out.push(`<pre><code>${esc}</code></pre>`);
                continue;
            }

            // ATX headings: # ... through ######
            const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (hMatch) {
                flushParagraph(); closeList(); closeTable();
                const lvl = hMatch[1].length;
                out.push(`<h${lvl}>${SessionWebviewPanel._applyInline(hMatch[2])}</h${lvl}>`);
                continue;
            }

            // Horizontal rule (---, ***, ___) — must not be a table separator
            if (/^([-*_])\1\1+\s*$/.test(line)) { flushParagraph(); closeList(); closeTable(); out.push('<hr>'); continue; }

            // Blockquote — '>' is &gt; after HTML escaping
            const bqMatch = line.match(/^&gt;\s?(.*)$/);
            if (bqMatch) {
                flushParagraph(); closeList(); closeTable();
                out.push(`<blockquote><p>${SessionWebviewPanel._applyInline(bqMatch[1])}</p></blockquote>`);
                continue;
            }

            // Table row (pipe-delimited)
            if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
                // Check if next line is a separator row → this is the header
                const nextLine = lines[i + 1] ?? '';
                const isSeparator = /^\|[\s|:-]+\|$/.test(nextLine.trim());
                if (isSeparator && !inTable) {
                    flushParagraph(); closeList();
                    const headerCells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                    // Parse per-column alignment from separator row
                    const sepCells = nextLine.trim().slice(1, -1).split('|').map(c => c.trim());
                    columnAligns = sepCells.map(c => {
                        if (c.startsWith(':') && c.endsWith(':')) { return 'center'; }
                        if (c.endsWith(':')) { return 'right'; }
                        if (c.startsWith(':')) { return 'left'; }
                        return '';
                    });
                    out.push('<div class="table-wrap"><table><thead><tr>');
                    for (let ci = 0; ci < headerCells.length; ci++) {
                        out.push(`<th${alignAttr(ci, 'th')}>${SessionWebviewPanel._applyInline(headerCells[ci])}</th>`);
                    }
                    out.push('</tr></thead><tbody>');
                    inTable = true;
                    i++; // skip separator
                    continue;
                }
                if (/^\|[\s|:-]+\|$/.test(line.trim())) { continue; } // stray separator
                if (inTable || (!isSeparator && /^\|/.test(line.trim()))) {
                    if (!inTable) { flushParagraph(); closeList(); out.push('<div class="table-wrap"><table><tbody>'); inTable = true; }
                    const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                    out.push('<tr>');
                    for (let ci = 0; ci < cells.length; ci++) {
                        out.push(`<td${alignAttr(ci, 'td')}>${SessionWebviewPanel._applyInline(cells[ci])}</td>`);
                    }
                    out.push('</tr>');
                    continue;
                }
            } else if (inTable) {
                closeTable();
            }

            // Unordered list item
            const ulMatch = line.match(/^[-*+]\s+(.+)$/);
            if (ulMatch) {
                flushParagraph(); closeTable();
                if (inOl) { out.push('</ol>'); inOl = false; }
                if (!inUl) { out.push('<ul>'); inUl = true; }
                out.push(`<li>${SessionWebviewPanel._applyInline(ulMatch[1])}</li>`);
                continue;
            }

            // Ordered list item
            const olMatch = line.match(/^\d+\.\s+(.+)$/);
            if (olMatch) {
                flushParagraph(); closeTable();
                if (inUl) { out.push('</ul>'); inUl = false; }
                if (!inOl) { out.push('<ol>'); inOl = true; }
                out.push(`<li>${SessionWebviewPanel._applyInline(olMatch[1])}</li>`);
                continue;
            }

            // Empty line → paragraph break
            if (line.trim() === '') { flushParagraph(); closeList(); closeTable(); continue; }

            // Regular paragraph line — accumulate for joining
            closeList(); closeTable();
            paragraphLines.push(SessionWebviewPanel._applyInline(line));
        }
        flushParagraph();
        closeList();
        closeTable();

        // Step 5: restore inline code placeholders
        let result = out.join('\n');
        result = result.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[+i]);
        return result;
    }

    private static _nonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let n = '';
        for (let i = 0; i < 32; i++) { n += chars[Math.floor(Math.random() * chars.length)]; }
        return n;
    }

    private static _getHtml(session: Session, searchTerm?: string, scrollToCodeBlock?: boolean): string {
        const nonce = SessionWebviewPanel._nonce();
        const config = vscode.workspace.getConfiguration('chatwizard');
        const userColor = config.get<string>('userMessageColor', '#007acc') || '#007acc';
        const cbHighlightColor = config.get<string>('codeBlockHighlightColor', '#EA5C00') || '';
        const cbScroll = scrollToCodeBlock && config.get<boolean>('scrollToFirstCodeBlock', true);
        const termJs = searchTerm ? JSON.stringify(searchTerm) : 'null';
        const cbHighlightJs = (scrollToCodeBlock && cbHighlightColor) ? JSON.stringify(cbHighlightColor) : 'null';
        const cbScrollJs = cbScroll ? 'true' : 'false';

        const title = SessionWebviewPanel._escapeHtml(session.title);
        const assistantLabel = session.source === 'copilot' ? 'Copilot' : 'Claude';

        const visibleMessages = session.messages.filter(msg => msg.content.trim() !== '');

        const messagesHtml = visibleMessages.flatMap((msg, i) => {
            const roleClass = msg.role === 'user' ? 'user' : 'assistant';
            const label = msg.role === 'user' ? 'You' : assistantLabel;
            const timestamp = msg.timestamp
                ? `<span class="timestamp">${new Date(msg.timestamp).toLocaleString()}</span>`
                : '';
            const renderedContent = SessionWebviewPanel._markdownToHtml(msg.content);

            const html = `<div class="message ${roleClass}">
  <div class="message-header">
    <span class="role-label">${label}</span>${timestamp}
  </div>
  <div class="message-body">${renderedContent}</div>
</div>`;

            // If this is a user message with no following assistant reply, add a placeholder
            const nextMsg = visibleMessages[i + 1];
            if (msg.role === 'user' && (!nextMsg || nextMsg.role === 'user')) {
                const aborted = `<div class="message aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice">&#9888; Response not available — cancelled or incomplete</div>
</div>`;
                return [html, aborted];
            }

            return [html];
        }).join('\n');

        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
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
      margin-bottom: 20px;
      display: flex;
      gap: 8px;
    }

    .toolbar button {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
    }

    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.14));
    }

    .message {
      margin-bottom: 16px;
      border-radius: 6px;
      padding: 12px 16px;
    }

    .message.user {
      background-color: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.05));
      border-left: 3px solid ${userColor};
    }

    .message.assistant {
      background-color: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-textPreformat-background, #444);
    }

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

    .message.user .role-label {
      color: ${userColor};
    }

    .timestamp {
      font-size: 0.78em;
      opacity: 0.5;
    }

    .message-body {
      word-wrap: break-word;
    }

    .message-body p {
      margin: 0.4em 0;
    }

    .message-body h1, .message-body h2, .message-body h3,
    .message-body h4, .message-body h5, .message-body h6 {
      margin: 0.8em 0 0.3em;
      font-weight: bold;
      line-height: 1.3;
    }
    .message-body h1 { font-size: 1.3em; }
    .message-body h2 { font-size: 1.15em; }
    .message-body h3 { font-size: 1.05em; }
    .message-body h4, .message-body h5, .message-body h6 { font-size: 1em; }

    .message-body ul, .message-body ol {
      margin: 0.4em 0;
      padding-left: 1.5em;
    }

    .message-body li {
      margin: 0.15em 0;
    }

    .message-body blockquote {
      margin: 0.5em 0;
      padding: 4px 12px;
      border-left: 3px solid var(--vscode-textPreformat-background, #555);
      opacity: 0.85;
    }

    .message-body blockquote p {
      margin: 0;
    }

    .message-body hr {
      border: none;
      border-top: 1px solid var(--vscode-textBlockQuote-background, #444);
      margin: 0.8em 0;
    }

    .message-body strong { font-weight: bold; }
    .message-body em { font-style: italic; }
    .message-body del { text-decoration: line-through; opacity: 0.75; }

    .table-wrap {
      overflow-x: auto;
      margin: 0.5em 0;
      max-width: 100%;
    }
    .message-body table {
      border-collapse: collapse;
      font-size: 0.92em;
      white-space: nowrap;
    }
    .message-body th, .message-body td {
      border: 1px solid var(--vscode-textBlockQuote-background, #444);
      padding: 4px 10px;
    }
    .message-body th {
      background-color: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.06));
      font-weight: bold;
      position: sticky;
      top: 0;
    }

    .message-body :not(pre) > code {
      background-color: var(--vscode-textPreformat-background, #2d2d2d);
      border-radius: 3px;
      padding: 1px 4px;
    }

    pre {
      background-color: var(--vscode-textPreformat-background, #1e1e1e);
      border-radius: 4px;
      padding: 12px;
      overflow-x: auto;
      margin: 8px 0;
      white-space: pre;
    }

    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }

    .message.aborted {
      background-color: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-errorForeground, #f48771);
      opacity: 0.7;
    }

    .aborted-notice {
      font-style: italic;
      color: var(--vscode-errorForeground, #f48771);
    }

    mark {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }

    #sel-ctx-menu {
      position: fixed;
      z-index: 9999;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: none;
      min-width: 200px;
    }

    .ctx-item {
      padding: 5px 14px;
      cursor: pointer;
      font-size: 0.92em;
      color: var(--vscode-menu-foreground, inherit);
      white-space: nowrap;
    }

    .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="toolbar">
    <button id="export-excerpt-btn">Export Excerpt…</button>
  </div>
  ${messagesHtml}
  <div id="sel-ctx-menu">
    <div class="ctx-item" id="ctx-export-sel">Export selection as Markdown…</div>
  </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
(function() {
  document.getElementById('export-excerpt-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'exportExcerpt' });
  });
})();
(function() {
  const menu = document.getElementById('sel-ctx-menu');
  let savedSelText = '';
  function hideMenu() { menu.style.display = 'none'; }
  document.addEventListener('contextmenu', function(e) {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text) { hideMenu(); return; }
    savedSelText = text;
    e.preventDefault();
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) { menu.style.left = (e.clientX - rect.width) + 'px'; }
    if (rect.bottom > window.innerHeight) { menu.style.top = (e.clientY - rect.height) + 'px'; }
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideMenu(); } });
  document.getElementById('ctx-export-sel').addEventListener('click', function() {
    if (!savedSelText) { return; }
    vscode.postMessage({ command: 'exportSelection', text: savedSelText });
    savedSelText = '';
    hideMenu();
  });
})();
(function() {
  const term = ${termJs};
  if (!term) { return; }
  function escRx(s) { return s.replace(/[.*+?^{}()|$[\]\\]/g, '\\$&'); }
  const rx = new RegExp(escRx(term), 'gi');
  function walk(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) { nodes.push(n); }
    for (const textNode of nodes) {
      const text = textNode.nodeValue;
      if (!rx.test(text)) { rx.lastIndex = 0; continue; }
      rx.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = rx.exec(text)) !== null) {
        if (m.index > last) { frag.appendChild(document.createTextNode(text.slice(last, m.index))); }
        const mark = document.createElement('mark');
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = rx.lastIndex;
      }
      if (last < text.length) { frag.appendChild(document.createTextNode(text.slice(last))); }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }
  document.querySelectorAll('.message-body').forEach(walk);
  const first = document.querySelector('mark');
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
})();
(function() {
  const highlightColor = ${cbHighlightJs};
  const shouldScroll = ${cbScrollJs};
  if (!highlightColor && !shouldScroll) { return; }
  const pres = document.querySelectorAll('pre');
  if (highlightColor) {
    pres.forEach(function(pre) { pre.style.boxShadow = '0 0 0 2px ' + highlightColor; });
  }
  if (shouldScroll && pres.length > 0) {
    pres[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
</script>
</body>
</html>`;
    }
}
