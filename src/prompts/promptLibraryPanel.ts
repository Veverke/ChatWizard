// src/prompts/promptLibraryPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { cwThemeCss, cwInteractiveJs } from '../webview/cwTheme';
import { buildPromptLibrary, PromptEntry } from './promptExtractor';
import { clusterPrompts, PromptCluster, MAX_CLUSTER_ENTRIES } from './similarityEngine';

export class PromptLibraryPanel {
    private static _panel: vscode.WebviewPanel | undefined;
    private static _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private static _lastIndexVersion = -1;

    static show(context: vscode.ExtensionContext, index: SessionIndex): void {
        const entries = buildPromptLibrary(index);
        const clusters = clusterPrompts(entries);

        if (PromptLibraryPanel._panel) {
            PromptLibraryPanel._panel.reveal(vscode.ViewColumn.One);
            // Shell already set — push data update
            void PromptLibraryPanel._panel.webview.postMessage({
                type: 'update',
                data: { clusters, truncated: false },
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'chatwizardPromptLibrary',
            'Prompt Library',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        PromptLibraryPanel._panel = panel;
        panel.webview.html = PromptLibraryPanel.getShellHtml();

        panel.onDidDispose(() => {
            PromptLibraryPanel._panel = undefined;
        }, null, context.subscriptions);

        panel.webview.onDidReceiveMessage((message: { type?: string; command?: string; text?: string; sessionId?: string; searchTerm?: string; highlightContainer?: boolean }) => {
            if (message.command === 'copy') {
                void vscode.env.clipboard.writeText(message.text ?? '');
                void vscode.window.showInformationMessage('Prompt copied to clipboard.');
            } else if (message.command === 'openSession' && message.sessionId) {
                void vscode.commands.executeCommand('chatwizard.openSession', { id: message.sessionId }, message.searchTerm, message.highlightContainer);
            } else if (message.command === 'openSettings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard');
            } else if (message.command === 'rescan') {
                void vscode.commands.executeCommand('chatwizard.rescan');
            } else if (message.type === 'ready') {
                void panel.webview.postMessage({
                    type: 'update',
                    data: { clusters, truncated: false },
                });
            }
        }, undefined, context.subscriptions);
    }

    static refresh(index: SessionIndex): void {
        if (!PromptLibraryPanel._panel) { return; }
        if (PromptLibraryPanel._refreshTimer) { clearTimeout(PromptLibraryPanel._refreshTimer); }
        PromptLibraryPanel._refreshTimer = setTimeout(() => {
            PromptLibraryPanel._refreshTimer = null;
            if (!PromptLibraryPanel._panel) { return; }
            if (index.version === PromptLibraryPanel._lastIndexVersion) { return; }
            PromptLibraryPanel._lastIndexVersion = index.version;
            const entries = buildPromptLibrary(index);
            const clusters = clusterPrompts(entries);
            void PromptLibraryPanel._panel.webview.postMessage({
                type: 'update',
                data: { clusters, truncated: false },
            });
        }, 2_000);
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
      cursor: pointer;
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
    .variant-item[data-sessions] { cursor: pointer; }
    .variant-item[data-sessions]:hover { background: var(--cw-surface-subtle); border-radius: 3px; }

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

    #truncatedBanner {
      display: none;
      padding: 6px 16px;
      font-size: 0.82em;
      opacity: 0.7;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
      text-align: center;
    }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    .variants-summary:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }

    /* Session hover overlay — styled as a distinct floating popup */
    #sessionOverlay {
      display: none;
      position: fixed;
      z-index: 1000;
      /* Use quickInput palette: the same widget VS Code uses for command palette / quick open */
      background: var(--vscode-quickInput-background, #1e1e1e);
      color: var(--vscode-quickInput-foreground, #d4d4d4);
      border: 2px solid var(--cw-accent, #007acc);
      border-radius: 6px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.4);
      min-width: 240px;
      max-width: 340px;
      max-height: 260px;
      overflow-y: auto;
      padding: 0;
      font-size: 0.88em;
      /* Slightly offset from the panel so it reads as a layer above */
      backdrop-filter: none;
    }
    #sessionOverlay.visible { display: block; }
    .overlay-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7em;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cw-accent, #007acc);
      padding: 7px 10px 5px;
      background: var(--vscode-quickInput-background, #1e1e1e);
      border-bottom: 1px solid var(--cw-accent, #007acc);
      position: sticky;
      top: 0;
    }
    .overlay-header::before {
      content: '\\25BA';
      font-size: 0.8em;
      opacity: 0.7;
    }
    .overlay-session-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: border-color 0.1s, background 0.1s;
    }
    .overlay-session-row:hover {
      background: var(--vscode-quickInputList-focusBackground, rgba(0,122,204,0.2));
      border-left-color: var(--cw-accent, #007acc);
    }
    .overlay-session-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .overlay-session-title {
      font-size: 0.92em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .overlay-session-meta {
      font-size: 0.74em;
      opacity: 0.45;
      white-space: nowrap;
    }
    .overlay-session-icon {
      font-size: 0.8em;
      opacity: 0.4;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="promptCount">Loading&#8230;</span>
    <input id="searchInput" type="text" placeholder="Filter by text&#8230;" />
  </div>
  <div id="truncatedBanner"></div>
  <div class="prompts-list" id="promptsList"></div>
  <div id="sessionOverlay"></div>
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

    var MAX_PROMPT_DISPLAY = 300;
    function truncateDisplay(text, max) {
      if (text.length <= max) { return text; }
      return text.substring(0, max) + '\u2026';
    }

    const searchInput  = document.getElementById('searchInput');
    const countEl      = document.getElementById('promptCount');
    const listEl       = document.getElementById('promptsList');
    const bannerEl     = document.getElementById('truncatedBanner');

    function applyFilter() {
      const query = searchInput.value.toLowerCase();
      const cards = listEl.querySelectorAll('.prompt-card');
      let visible = 0;
      cards.forEach(function(card) {
        const text = card.dataset.text || '';
        const show = !query || text.includes(query);
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' prompt' + (visible === 1 ? '' : 's');
    }

    searchInput.addEventListener('input', applyFilter);

    // Hash guard: skip DOM rebuild if cluster data hasn't changed
    var _lastClustersJson = '';

    // Copy via event delegation -- survives DOM rebuilds
    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) { return; }
      const text = btn.dataset.text || '';
      vscode.postMessage({ command: 'copy', text });
      if (window.cwMorphCopy) { window.cwMorphCopy(btn, btn.textContent); }
    });

    function renderClusters(clusters) {
      var newJson = JSON.stringify(clusters);
      if (newJson === _lastClustersJson) { return; }
      _lastClustersJson = newJson;

      const scrollTop = window.scrollY;
      const savedQuery = searchInput.value;

      if (clusters.length === 0) {
        listEl.innerHTML = '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No prompts indexed yet.</p>'
          + '<p class="empty-state-body">ChatWizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="copy-btn" id="btn-open-settings">Configure Paths</button>'
          + '<button class="copy-btn" id="btn-rescan">Rescan</button>'
          + '</div></div>';
        var btnCfg = document.getElementById('btn-open-settings');
        var btnScan = document.getElementById('btn-rescan');
        if (btnCfg) { btnCfg.addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); }); }
        if (btnScan) { btnScan.addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); }); }
        countEl.textContent = '0 prompts';
        searchInput.value = savedQuery;
        return;
      }

      let totalEntries = 0;
      let cardsHtml = '';

      clusters.forEach(function(cluster, i) {
        const canonical      = cluster.canonical;
        const variants       = cluster.variants || [];
        const totalFrequency = cluster.totalFrequency;
        const allProjectIds  = cluster.allProjectIds || [];
        const projectCount   = allProjectIds.length;
        totalEntries += 1 + variants.length;

        const statsLabel = 'Asked ' + totalFrequency + ' time' + (totalFrequency === 1 ? '' : 's')
          + (projectCount > 0 ? ' across ' + projectCount + ' project' + (projectCount === 1 ? '' : 's') : '');

        const escapedText      = escHtml(canonical.text);
        const displayText      = escHtml(truncateDisplay(canonical.text, MAX_PROMPT_DISPLAY));
        const escapedTextLower = escHtml(canonical.text.toLowerCase());

        let variantsHtml = '';
        if (variants.length > 0) {
          const variantItems = variants.map(function(v) {
            const escapedV      = escHtml(v.text);
            const displayV      = escHtml(truncateDisplay(v.text, MAX_PROMPT_DISPLAY));
            const vMeta = v.sessionMeta || [];
            const vSessionsAttr = escHtml(JSON.stringify(vMeta));
            const vDirectAttr = vMeta.length === 1 ? (' data-direct="' + escHtml(vMeta[0].sessionId) + '"') : '';
            const vTitleAttr = vMeta.length === 1
              ? (' title="Click to open \u201c' + escHtml(vMeta[0].title) + '\u201d"')
              : (vMeta.length > 1 ? ' title="Hover or click to pick a session"' : '');
            const sessionInfoParts = vMeta.map(function(m) {
              const date = m.updatedAt ? m.updatedAt.substring(0, 10) : '';
              return escHtml(m.title + (date ? ' \u00b7 ' + date : ''));
            });
            const sessionInfoHtml = sessionInfoParts.length > 0
              ? '<span class="variant-session">' + sessionInfoParts.join(', ') + '</span>'
              : '';
            return '<li class="variant-item" data-sessions="' + vSessionsAttr + '" data-prompt="' + escapedV + '"' + vDirectAttr + vTitleAttr + '>'
              + '<div class="variant-body">'
              + '<span class="variant-text">' + displayV + '</span>'
              + sessionInfoHtml
              + '</div>'
              + '<span class="variant-freq">' + v.frequency + '\u00d7</span>'
              + '<button class="copy-btn copy-btn-sm" data-text="' + escapedV + '" title="Copy variant">Copy</button>'
              + '</li>';
          }).join('');
          variantsHtml = '<details class="variants-details">'
            + '<summary class="variants-summary">' + variants.length + ' similar variant' + (variants.length === 1 ? '' : 's') + '</summary>'
            + '<ul class="variants-list">' + variantItems + '</ul>'
            + '</details>';
        }

        const fadeAttr = i < 15 ? ' style="--cw-i:' + i + '"' : '';
        const sessionMeta = cluster.canonical.sessionMeta || [];
        const canonicalSessionsAttr = escHtml(JSON.stringify(sessionMeta));
        const canonicalDirectAttr = sessionMeta.length === 1 ? (' data-direct="' + escHtml(sessionMeta[0].sessionId) + '"') : '';
        const canonicalTitleAttr = sessionMeta.length === 1
          ? (' title="Click to open \u201c' + escHtml(sessionMeta[0].title) + '\u201d"')
          : (sessionMeta.length > 1 ? ' title="Hover or click to pick a session"' : '');
        const promptTextAttr = escapedText;
        cardsHtml +=
          '<div class="prompt-card cw-fade-item"' + fadeAttr + ' data-text="' + escapedTextLower + '">'
          + '\\n  <div class="card-header">'
          + '\\n    <span class="freq-badge">' + totalFrequency + '\\u00d7</span>'
          + '\\n    <span class="stats-label">' + escHtml(statsLabel) + '</span>'
          + '\\n    <button class="copy-btn" data-text="' + escapedText + '" title="Copy prompt">Copy</button>'
          + '\\n  </div>'
          + '\\n  <div class="prompt-text" data-sessions="' + canonicalSessionsAttr + '" data-prompt="' + promptTextAttr + '"' + canonicalDirectAttr + canonicalTitleAttr + '>' + displayText + '</div>'
          + variantsHtml
          + '\\n</div>';
      });

      listEl.innerHTML = cardsHtml;

      // Restore state
      searchInput.value = savedQuery;
      applyFilter();
      countEl.textContent = totalEntries + ' prompt' + (totalEntries === 1 ? '' : 's');

      window.scrollTo(0, scrollTop);
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        renderClusters(msg.data.clusters || []);
        if (msg.data.truncated) {
          bannerEl.style.display = '';
          bannerEl.textContent = 'Results truncated \\u2014 showing top entries only.';
        } else {
          bannerEl.style.display = 'none';
        }
      }
    });

    // ---- Session hover overlay ----
    var overlay   = document.getElementById('sessionOverlay');
    var hideTimer = null;
    var activeEl  = null;

    // Returns the canonical .prompt-text element under the event target (for overlay),
    // or null if the target is a copy button, a variant-item, or unrelated element.
    // Variant items are intentionally excluded — they navigate directly on click.
    function getInteractable(target) {
      if (!target || !target.closest) { return null; }
      if (target.closest('.copy-btn')) { return null; }
      if (target.closest('.variants-list')) { return null; }
      return target.closest('.prompt-text[data-sessions]');
    }

    function positionOverlay(el) {
      var rect  = el.getBoundingClientRect();
      var ovW   = 340;
      var gap   = 12;
      var left  = rect.right + gap;
      if (left + ovW > window.innerWidth - 4) {
        left = rect.left - ovW - gap;
        if (left < 4) { left = 4; }
      }
      var top = rect.top;
      var ovH = Math.min(260, overlay.scrollHeight || 160);
      if (top + ovH > window.innerHeight - 4) { top = window.innerHeight - ovH - 4; }
      if (top < 4) { top = 4; }
      overlay.style.left = left + 'px';
      overlay.style.top  = top  + 'px';
    }

    function showOverlay(el) {
      clearTimeout(hideTimer);
      var raw = el.dataset.sessions;
      if (!raw) { return; }
      var sessions;
      try { sessions = JSON.parse(raw); } catch(e) { return; }
      if (!sessions || sessions.length === 0) { return; }
      var promptText = el.dataset.prompt || '';
      activeEl = el;

      var rows = sessions.map(function(m) {
        var date = m.updatedAt ? m.updatedAt.substring(0, 10) : '';
        var srcLabel = m.source === 'copilot' ? 'Copilot' : 'Claude';
        return '<div class="overlay-session-row" data-sid="' + escHtml(m.sessionId) + '" data-prompt="' + escHtml(promptText) + '">'
          + '<span class="overlay-session-icon">\\u27A4</span>'
          + '<div class="overlay-session-body">'
          + '<span class="overlay-session-title">' + escHtml(m.title || m.sessionId) + '</span>'
          + '<span class="overlay-session-meta">' + escHtml(srcLabel + (date ? ' \\u00b7 ' + date : '')) + '</span>'
          + '</div>'
          + '</div>';
      }).join('');

      overlay.innerHTML = '<div class="overlay-header">Open in session</div>' + rows;
      positionOverlay(el);
      overlay.classList.add('visible');
    }

    function hideOverlay() {
      overlay.classList.remove('visible');
      activeEl = null;
    }

    function scheduleHide() {
      hideTimer = setTimeout(hideOverlay, 200);
    }

    // Click on a variant item: always navigate directly (no overlay), first session if multi-session
    document.addEventListener('click', function(e) {
      if (e.target && e.target.closest && e.target.closest('.copy-btn')) { return; }
      var vi = e.target && e.target.closest ? e.target.closest('.variant-item[data-sessions]') : null;
      if (!vi) { return; }
      var sid = vi.dataset.direct;
      if (!sid) {
        try {
          var sess = JSON.parse(vi.dataset.sessions);
          if (sess && sess.length > 0) { sid = sess[0].sessionId; }
        } catch (_) {}
      }
      if (!sid) { return; }
      hideOverlay();
      vscode.postMessage({ command: 'openSession', sessionId: sid, searchTerm: vi.dataset.prompt || '', highlightContainer: true });
    });

    // Click on canonical prompt-text: direct navigation (single session) or toggle overlay (multiple sessions)
    document.addEventListener('click', function(e) {
      var el = getInteractable(e.target);
      if (!el) { return; }
      if (el.dataset.direct) {
        hideOverlay();
        vscode.postMessage({ command: 'openSession', sessionId: el.dataset.direct, searchTerm: el.dataset.prompt || '', highlightContainer: true });
        return;
      }
      if (el === activeEl) { hideOverlay(); } else { showOverlay(el); }
    });

    // Hover: show overlay only for multi-session elements (single-session ones navigate on click)
    document.addEventListener('mouseover', function(e) {
      var el = getInteractable(e.target);
      if (!el || el.dataset.direct) { return; }
      if (el !== activeEl) { showOverlay(el); }
    });

    document.addEventListener('mouseout', function(e) {
      var el = getInteractable(e.target);
      if (!el) { return; }
      var toEl = e.relatedTarget;
      if (!(toEl && (toEl === overlay || overlay.contains(toEl)))) {
        scheduleHide();
      }
    });

    overlay.addEventListener('mouseenter', function() { clearTimeout(hideTimer); });
    overlay.addEventListener('mouseleave', scheduleHide);

    // Click on a session row in the overlay
    overlay.addEventListener('click', function(e) {
      var row = e.target && e.target.closest ? e.target.closest('.overlay-session-row') : null;
      if (!row) { return; }
      var sid    = row.dataset.sid || '';
      var prompt = row.dataset.prompt || '';
      hideOverlay();
      vscode.postMessage({ command: 'openSession', sessionId: sid, searchTerm: prompt, highlightContainer: true });
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
    }

    /** @deprecated Returns loading HTML shell. Use getShellHtml() + postMessage instead. */
    static getLoadingHtml(): string {
        return PromptLibraryPanel.getShellHtml();
    }

    static getHtml(clusters: PromptCluster[], truncated = false): string {
        const totalEntries = clusters.reduce((sum, c) => sum + 1 + c.variants.length, 0);

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
                        return PromptLibraryPanel._escapeHtml(`${m.title}${date ? ' &#183; ' + date : ''}`);
                    });
                    const sessionInfoHtml = sessionInfoParts.length > 0
                        ? `<span class="variant-session">${sessionInfoParts.join(', ')}</span>`
                        : '';
                    return `<li class="variant-item">
          <div class="variant-body">
            <span class="variant-text">${escapedV}</span>
            ${sessionInfoHtml}
          </div>
          <span class="variant-freq">${v.frequency}&#215;</span>
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
    <span class="freq-badge">${totalFrequency}&#215;</span>
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
      cursor: pointer;
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
  ${truncated ? `<div class="truncated-banner">Too many prompts to cluster \u2014 showing top ${MAX_CLUSTER_ENTRIES.toLocaleString()}</div>` : ''}
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
