import * as vscode from 'vscode';
import { Session } from '../types/index';
import { cwThemeCss, syntaxHighlighterCss, cwInteractiveJs } from '../webview/cwTheme';
import {
    VisibleMessage,
    renderChunk,
    renderMessage,
    escapeHtml,
    markdownToHtml,
} from './sessionRenderer';

// ── Streaming constants ───────────────────────────────────────────────────────
const INITIAL_WINDOW = 50;   // messages shown in initial render (normal sessions)
const LARGE_THRESHOLD = 500; // sessions above this get a truncation banner
const LARGE_INITIAL   = 200; // initial window for large sessions
const CHUNK_SIZE      = 20;  // messages per setImmediate batch

// ── Internal types ────────────────────────────────────────────────────────────
interface ScrollInit {
    targetMsgIdx:      number | null;
    targetBlockContent: string | null;
    highlightColor:    string | null;
    shouldScroll:      boolean;
}

interface PanelMsgState {
    session:          Session;
    visibleMessages:  VisibleMessage[];
    renderedMessages: (string | null)[]; // null = not yet rendered
    windowStart:      number;            // first index currently in webview
    windowEnd:        number;            // exclusive end currently in webview
    isTruncated:      boolean;
    streamVersion:    number;            // bumped to abort stale streams
    assistantLabel:   string;
    panel:            vscode.WebviewPanel;
}

export class SessionWebviewPanel {
    static readonly _panels = new Map<string, vscode.WebviewPanel>();

    /** Cache: `sessionId::updatedAt` → rendered HTML per visible message (null = not yet rendered) */
    static readonly _renderCache = new Map<string, (string | null)[]>();

    /** Per-panel window / streaming state */
    static readonly _panelState = new Map<string, PanelMsgState>();

    // ── Public entry point ────────────────────────────────────────────────────

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

        const assistantLabel = session.source === 'copilot' ? 'Copilot' : 'Claude';

        // Compute visible messages (non-empty content)
        const visibleMessages: VisibleMessage[] = session.messages
            .map((msg, origIdx) => ({ msg, origIdx }))
            .filter(({ msg }) => msg.content.trim() !== '');

        const total     = visibleMessages.length;
        const isLarge   = total > LARGE_THRESHOLD;
        const initialSz = isLarge ? LARGE_INITIAL : INITIAL_WINDOW;

        // Default window = last N messages; adjust if targeting a specific message
        let windowStart = Math.max(0, total - initialSz);
        if (targetBlockMessageIndex !== undefined) {
            const targetVisibleIdx = visibleMessages.findIndex(
                vm => vm.origIdx === targetBlockMessageIndex
            );
            if (targetVisibleIdx >= 0 && targetVisibleIdx < windowStart) {
                // Ensure target is visible with a few messages of context above it
                windowStart = Math.max(0, targetVisibleIdx - 3);
            }
        }
        const isTruncated = isLarge && windowStart > 0;

        // Render cache keyed on sessionId + updatedAt
        const cacheKey = `${session.id}::${session.updatedAt}`;
        let renderedMessages = SessionWebviewPanel._renderCache.get(cacheKey);
        if (!renderedMessages) {
            renderedMessages = new Array<string | null>(total).fill(null);
            SessionWebviewPanel._renderCache.set(cacheKey, renderedMessages);
        }

        const scrollInit: ScrollInit = {
            targetMsgIdx:       targetBlockMessageIndex ?? null,
            targetBlockContent: targetBlockContent ?? null,
            highlightColor:     cbHighlightColor || null,
            shouldScroll:       cbScroll,
        };

        // ── Re-use existing panel ─────────────────────────────────────────────
        const existing = SessionWebviewPanel._panels.get(session.id);
        if (existing) {
            existing.reveal(vscode.ViewColumn.One);
            const prev = SessionWebviewPanel._panelState.get(session.id);
            const newVersion = (prev?.streamVersion ?? 0) + 1;
            SessionWebviewPanel._panelState.set(session.id, {
                session, visibleMessages, renderedMessages,
                windowStart, windowEnd: total,
                isTruncated, streamVersion: newVersion,
                assistantLabel, panel: existing,
            });
            void SessionWebviewPanel._startStream(
                session.id, newVersion, userColor, searchTerm, scrollInit
            );
            return;
        }

        // ── Create new panel ──────────────────────────────────────────────────
        const panel = vscode.window.createWebviewPanel(
            'chatwizardSession3',
            session.title,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel.webview.html = SessionWebviewPanel._getShellHtml();

        SessionWebviewPanel._panelState.set(session.id, {
            session, visibleMessages, renderedMessages,
            windowStart, windowEnd: total,
            isTruncated, streamVersion: 0,
            assistantLabel, panel,
        });
        SessionWebviewPanel._panels.set(session.id, panel);

        panel.webview.onDidReceiveMessage(
            (msg: { type?: string; command?: string; text?: string; direction?: 'older' | 'newer' }) => {
                if (msg.type === 'ready') {
                    const st = SessionWebviewPanel._panelState.get(session.id);
                    void SessionWebviewPanel._startStream(
                        session.id, st?.streamVersion ?? 0, userColor, searchTerm, scrollInit
                    );
                } else if (msg.type === 'loadMoreMessages') {
                    void SessionWebviewPanel._loadMoreMessages(session.id, msg.direction ?? 'older');
                } else if (msg.type === 'loadAll') {
                    void SessionWebviewPanel._loadAll(session.id, userColor);
                } else if (msg.command === 'exportExcerpt') {
                    void vscode.commands.executeCommand('chatwizard.exportExcerpt', session.id);
                } else if (msg.command === 'exportSelection' && msg.text) {
                    void SessionWebviewPanel._saveSelection(msg.text, session.title);
                }
            },
            undefined,
            context.subscriptions
        );

        panel.onDidDispose(() => {
            SessionWebviewPanel._panels.delete(session.id);
            SessionWebviewPanel._panelState.delete(session.id);
        }, null, []);
    }

    // ── Streaming pipeline ────────────────────────────────────────────────────

    static async _startStream(
        panelId:    string,
        myVersion:  number,
        userColor:  string,
        searchTerm: string | undefined,
        scrollInit: ScrollInit
    ): Promise<void> {
        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state || state.streamVersion !== myVersion) { return; }

        const { visibleMessages, renderedMessages, windowStart, isTruncated, assistantLabel, panel, session } = state;
        const total = visibleMessages.length;

        // ── First chunk: rendered synchronously so first content appears immediately ──
        const firstEnd = Math.min(windowStart + CHUNK_SIZE, total);
        const firstHtml = SessionWebviewPanel._renderChunk(
            visibleMessages, renderedMessages, windowStart, firstEnd, assistantLabel, true
        );
        state.windowStart = windowStart;
        state.windowEnd   = firstEnd;

        void panel.webview.postMessage({
            type: 'render',
            title:        session.title,
            userColor,
            term:         searchTerm ?? null,
            scrollInit:   null, // scroll sent separately after all chunks via cwScroll
            messagesHtml: firstHtml,
            windowStart,
            windowEnd:    firstEnd,
            total,
            hasOlder:     windowStart > 0,
            hasNewer:     firstEnd < total,
            isTruncated,
        });

        // ── Stream remaining initial window via setImmediate ──────────────────
        let cursor = firstEnd;
        while (cursor < total) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) { return; }

            const chunkEnd  = Math.min(cursor + CHUNK_SIZE, total);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, cursor, chunkEnd, assistantLabel, false
            );
            state.windowEnd = chunkEnd;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'end',
                newWindowStart: state.windowStart,
                newWindowEnd:   chunkEnd,
                hasOlder:       state.windowStart > 0,
                hasNewer:       false,
            });
            cursor = chunkEnd;
        }

        // ── Send scroll command after all initial chunks are posted ───────────
        // cwScroll arrives in the webview AFTER all appendChunk messages, so
        // the target element is guaranteed to be in the DOM at that point.
        if (scrollInit.highlightColor || scrollInit.shouldScroll) {
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion === myVersion) {
                void panel.webview.postMessage({ type: 'cwScroll', ...scrollInit });
            }
        }

        // ── Background pre-render older messages for fast load-more ──────────
        let bgCursor = windowStart - 1;
        while (bgCursor >= 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) { return; }

            const bgStart = Math.max(0, bgCursor - CHUNK_SIZE + 1);
            for (let i = bgStart; i <= bgCursor; i++) {
                if (renderedMessages[i] === null) {
                    renderedMessages[i] = renderMessage(
                        visibleMessages[i].msg, visibleMessages[i].origIdx,
                        i, visibleMessages, assistantLabel, undefined
                    );
                }
            }
            bgCursor = bgStart - 1;
        }
    }

    static async _loadMoreMessages(panelId: string, direction: 'older' | 'newer'): Promise<void> {
        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state) { return; }

        const { visibleMessages, renderedMessages, assistantLabel, panel } = state;
        const total = visibleMessages.length;

        if (direction === 'older' && state.windowStart > 0) {
            const newStart  = Math.max(0, state.windowStart - CHUNK_SIZE);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, newStart, state.windowStart, assistantLabel, false
            );
            state.windowStart = newStart;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'start',
                newWindowStart: newStart,
                newWindowEnd:   state.windowEnd,
                hasOlder:       newStart > 0,
                hasNewer:       state.windowEnd < total,
            });
        } else if (direction === 'newer' && state.windowEnd < total) {
            const newEnd    = Math.min(total, state.windowEnd + CHUNK_SIZE);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, state.windowEnd, newEnd, assistantLabel, false
            );
            state.windowEnd = newEnd;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'end',
                newWindowStart: state.windowStart,
                newWindowEnd:   newEnd,
                hasOlder:       state.windowStart > 0,
                hasNewer:       newEnd < total,
            });
        }
    }

    static async _loadAll(panelId: string, userColor: string): Promise<void> {
        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state) { return; }
        const myVersion = ++state.streamVersion;

        const { visibleMessages, renderedMessages, assistantLabel, panel, session } = state;
        const total = visibleMessages.length;

        let cursor = 0;
        while (cursor < total) {
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) { return; }

            const chunkEnd  = Math.min(cursor + CHUNK_SIZE, total);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, cursor, chunkEnd, assistantLabel, cursor === 0
            );

            if (cursor === 0) {
                void panel.webview.postMessage({
                    type:         'render',
                    title:        session.title,
                    userColor,
                    term:         null,
                    scrollInit:   null,
                    messagesHtml: chunkHtml,
                    windowStart:  0,
                    windowEnd:    chunkEnd,
                    total,
                    hasOlder:     false,
                    hasNewer:     chunkEnd < total,
                    isTruncated:  false,
                });
            } else {
                void panel.webview.postMessage({
                    type:           'appendChunk',
                    messagesHtml:   chunkHtml,
                    position:       'end',
                    newWindowStart: 0,
                    newWindowEnd:   chunkEnd,
                    hasOlder:       false,
                    hasNewer:       chunkEnd < total,
                });
            }
            state.windowStart = 0;
            state.windowEnd   = chunkEnd;
            cursor = chunkEnd;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }

    // ── Render helpers (delegate to sessionRenderer.ts) ─────────────────────

    static _renderChunk(
        visibleMessages:  VisibleMessage[],
        renderedMessages: (string | null)[],
        start: number, end: number,
        assistantLabel: string, withFade: boolean
    ): string {
        return renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade);
    }

    static _renderMessage(
        ...args: Parameters<typeof renderMessage>
    ): string {
        return renderMessage(...args);
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
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
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
    #truncation-banner {
      display: none;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.12));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,200,0,0.4));
      border-radius: var(--cw-radius-xs);
      padding: 6px 14px;
      margin-bottom: 12px;
      font-size: 0.85em;
      display: none;
      align-items: center;
      gap: 10px;
    }
    #truncation-banner button {
      background: none;
      border: 1px solid currentColor;
      border-radius: var(--cw-radius-xs);
      padding: 2px 8px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
    }
    #load-older-btn, #load-newer-btn {
      display: none;
      width: 100%;
      margin: 6px 0;
      background: var(--cw-surface-subtle);
      color: inherit;
      border: 1px solid var(--cw-border-strong);
      padding: 5px 10px;
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
    }
    #load-older-btn:hover, #load-newer-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
  </style>
</head>
<body>
  <h1 id="session-title"></h1>
  <div class="toolbar">
    <div class="search-group">
      <input id="search-input" type="text" placeholder="Search in messages&#8230;" autocomplete="off" aria-label="Search within session messages" />
      <span class="search-counter" id="search-counter" aria-live="polite"></span>
      <button id="search-prev" title="Previous (Shift+Enter)" aria-label="Previous match">&#9650;</button>
      <button id="search-next" title="Next (Enter)" aria-label="Next match">&#9660;</button>
    </div>
    <button id="export-excerpt-btn" style="opacity:0.7;" title="Export an excerpt of this session as Markdown">Export Excerpt&#8230;</button>
  </div>
  <div id="truncation-banner"></div>
  <button id="load-older-btn">&#8679; Load older messages</button>
  <div id="messages-container"></div>
  <button id="load-newer-btn">&#8681; Load newer messages</button>
  <button class="cw-back-top" id="backToTop" title="Back to top">&#8593;</button>
  <div id="sel-ctx-menu">
    <div class="ctx-item" id="ctx-export-sel">Export selection as Markdown&#8230;</div>
  </div>
<script>
${cwInteractiveJs()}
(function() {
  var vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  var _hasOlder    = false;
  var _hasNewer    = false;
  var _loadingMore = false;

  // ── Back to top ────────────────────────────────────────────────────────────
  var backTopBtn = document.getElementById('backToTop');
  window.addEventListener('scroll', function() {
    backTopBtn.classList.toggle('visible', window.scrollY > 300);
    if (!_loadingMore && _hasOlder && window.scrollY < 300) {
      _loadingMore = true;
      vscode.postMessage({ type: 'loadMoreMessages', direction: 'older' });
    }
  });
  backTopBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ── Export excerpt ─────────────────────────────────────────────────────────
  document.getElementById('export-excerpt-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'exportExcerpt' });
  });

  // ── Load older/newer buttons ───────────────────────────────────────────────
  document.getElementById('load-older-btn').addEventListener('click', function() {
    if (_loadingMore || !_hasOlder) { return; }
    _loadingMore = true;
    vscode.postMessage({ type: 'loadMoreMessages', direction: 'older' });
  });
  document.getElementById('load-newer-btn').addEventListener('click', function() {
    if (_loadingMore || !_hasNewer) { return; }
    _loadingMore = true;
    vscode.postMessage({ type: 'loadMoreMessages', direction: 'newer' });
  });

  function updateLoadMoreButtons() {
    document.getElementById('load-older-btn').style.display = _hasOlder ? 'block' : 'none';
    document.getElementById('load-newer-btn').style.display = _hasNewer ? 'block' : 'none';
  }

  // ── Context menu ───────────────────────────────────────────────────────────
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

  // ── Syntax highlighter ─────────────────────────────────────────────────────
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

  // ── Search ─────────────────────────────────────────────────────────────────
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

  // ── Scroll helpers ─────────────────────────────────────────────────────────
  var _toolbar = document.querySelector('.toolbar');
  function cwScrollTo(el) {
    var toolbarH = _toolbar ? _toolbar.offsetHeight : 0;
    var rect = el.getBoundingClientRect();
    var targetY = window.scrollY + rect.top - toolbarH - 8;
    window.scrollTo(0, Math.max(0, targetY));
  }

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

  // ── DOM helpers for appending/prepending message chunks ───────────────────
  var container = document.getElementById('messages-container');

  function appendHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) { container.appendChild(tmp.firstChild); }
    highlightAll();
  }

  function prependHtml(html) {
    var prevScrollY   = window.scrollY;
    var prevHeight    = document.body.scrollHeight;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    // Insert children in reverse order so their DOM order is preserved
    var kids = Array.from(tmp.childNodes).reverse();
    kids.forEach(function(child) {
      container.insertBefore(child, container.firstChild);
    });
    highlightAll();
    // Compensate scroll so the viewport doesn't jump
    var delta = document.body.scrollHeight - prevHeight;
    if (delta > 0) { window.scrollTo(0, prevScrollY + delta); }
  }

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'render') {
      document.getElementById('session-title').textContent = data.title;
      document.documentElement.style.setProperty('--cw-user-color', data.userColor || '#007acc');
      container.innerHTML = data.messagesHtml;
      highlightAll();

      // Truncation banner
      var banner = document.getElementById('truncation-banner');
      if (data.isTruncated) {
        var shown = data.total - data.windowStart;
        banner.innerHTML =
          'Showing last <strong>' + shown + '</strong> of <strong>' + data.total +
          '</strong> messages. <button id="load-all-btn">Load all</button>';
        banner.style.display = 'flex';
        document.getElementById('load-all-btn').addEventListener('click', function() {
          vscode.postMessage({ type: 'loadAll' });
          banner.style.display = 'none';
        });
      } else {
        banner.style.display = 'none';
      }

      _hasOlder    = !!data.hasOlder;
      _hasNewer    = !!data.hasNewer;
      _loadingMore = false;
      updateLoadMoreButtons();

      clearMarks();
      if (data.term) { srchInput.value = data.term; runSearch(data.term); }
      else           { srchInput.value = ''; srchCounter.textContent = ''; }

    }

    if (data.type === 'appendChunk') {
      if (data.position === 'start') {
        prependHtml(data.messagesHtml);
      } else {
        appendHtml(data.messagesHtml);
      }
      _hasOlder    = !!data.hasOlder;
      _hasNewer    = !!data.hasNewer;
      _loadingMore = false;
      updateLoadMoreButtons();
    }

    if (data.type === 'cwScroll') {
      // Double rAF: first frame lets the browser apply any pending layout from
      // appended chunks, second frame ensures paint is complete before measuring.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { cwDoScroll(data); });
      });
    }
  });

  // Signal ready — extension host will send the 'render' payload
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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

}
