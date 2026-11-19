import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, ExtractedEntities, SessionBookmark } from '../types/index';
import type { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import type { ICacheManager } from '../cache/cacheManager';
import { cwThemeCss, syntaxHighlighterCss, cwInteractiveJs } from '../webview/cwTheme';
import { friendlyModelName } from '../analytics/modelNames';
import { friendlySourceName } from '../ui/sourceUi';
import { serializeSession } from '../export/markdownSerializer';
import {
    VisibleMessage,
    renderChunk,
    renderMessage,
    escapeHtml,
    markdownToHtml,
} from './sessionRenderer';
import { buildEntityTypeGroups } from './sessionEntities';

// ── Streaming constants ───────────────────────────────────────────────────────
const INITIAL_WINDOW = 50;   // messages shown in initial render
const CHUNK_SIZE      = 20;  // messages per setImmediate batch

/** Folder (inside the shared cache dir) holding generated "original conversation" files. */
const ORIGINAL_CONVERSATIONS_DIR = 'original-conversations';

// ── Internal types ────────────────────────────────────────────────────────────
interface ScrollInit {
    targetMsgIdx:      number | null;
    targetBlockIdx:    number | null;
    highlightColor:    string | null;
    shouldScroll:      boolean;
}

interface PanelMsgState {
    session:          Session;
    visibleMessages:  VisibleMessage[];
    renderedMessages: (string | null)[]; // null = not yet rendered
    windowStart:      number;            // first index currently in webview
    windowEnd:        number;            // exclusive end currently in webview
    streamVersion:    number;            // bumped to abort stale streams
    streamInFlight?:  boolean;           // initial-window stream currently appending
    assistantLabel:   string;
    tags?:            string[];
    entities?:        ExtractedEntities;
    summary?:         string;
    status?:          string;
    bookmarks?:       SessionBookmark[];
    annotations?:     import('../types/index').MessageAnnotation[];
    panel:            vscode.WebviewPanel;
}

export class SessionWebviewPanel {
    static readonly _panels = new Map<string, vscode.WebviewPanel>();

    /** Maximum number of sessions kept in the render cache. Oldest entry evicted when full. */
    static readonly RENDER_CACHE_MAX = 50;

    /** Cache: `sessionId::updatedAt` → rendered HTML per visible message (null = not yet rendered) */
    static readonly _renderCache = new Map<string, (string | null)[]>();

    /** Inserts an entry into _renderCache, evicting the oldest when capacity is reached. */
    static _renderCacheSet(key: string, value: (string | null)[]): void {
        const isUpdate = SessionWebviewPanel._renderCache.has(key);
        if (isUpdate) {
            // Delete first so the re-insertion below moves it to the end (LRU refresh).
            SessionWebviewPanel._renderCache.delete(key);
        } else if (SessionWebviewPanel._renderCache.size >= SessionWebviewPanel.RENDER_CACHE_MAX) {
            // Map preserves insertion order — first key is the oldest entry.
            const oldest = SessionWebviewPanel._renderCache.keys().next().value;
            if (oldest !== undefined) {
                SessionWebviewPanel._renderCache.delete(oldest);
            }
        }
        SessionWebviewPanel._renderCache.set(key, value);
    }

    /** Per-panel window / streaming state */
    static readonly _panelState = new Map<string, PanelMsgState>();

    /** Output channel for surfacing silent errors */
    static _channel: vscode.OutputChannel | undefined;

    /** Sidecar metadata store — set from extension.ts for bookmark/annotation persistence */
    static _sidecarStore: SidecarMetadataStore | undefined;
    /**
     * Feature 51 — SQLite cache (the "chat DB"). Set from extension.ts; when
     * absent (persistent cache disabled / non-VS Code host) turn removal is not
     * offered because it could not be persisted.
     */
    static _cacheStore: ICacheManager | undefined;
    /** Callback invoked after bookmark/annotation/rating changes to refresh the index sidecar cache. */
    static _onSidecarChanged: ((sessionId: string) => void) | undefined;
    /**
     * Feature 51 — invoked after the reader mutates a session in place (turn
     * removal) so the in-memory index re-publishes it: caches are invalidated,
     * dependent views refresh and the chat DB is re-persisted.
     */
    static _onSessionMutated: ((session: Session) => void) | undefined;

    // ── Public entry point ────────────────────────────────────────────────────

    static show(
        context: vscode.ExtensionContext,
        session: Session,
        searchTerm?: string,
        scrollToCodeBlock?: boolean,
        targetBlockMessageIndex?: number,
        _targetBlockContent?: string,  // deprecated — kept for call-site compat, unused
        targetBlockIdx?: number,
        highlightContainer?: boolean,
        tags?: string[],
        entities?: ExtractedEntities,
        summary?: string,
        status?: string,
        bookmarks?: SessionBookmark[],
        annotations?: import('../types/index').MessageAnnotation[],
    ): void {
        const config = vscode.workspace.getConfiguration('chatwizard');
        const userColor = config.get<string>('userMessageColor', '#007acc') || '#007acc';
        const cbHighlightColor = scrollToCodeBlock
            ? (config.get<string>('codeBlockHighlightColor', '#EA5C00') || '')
            : '';
        const cbScroll = scrollToCodeBlock
            ? (config.get<boolean>('scrollToFirstCodeBlock', true) ?? false)
            : false;

        const assistantLabel = friendlySourceName(session.source);

        // Compute visible messages (non-empty content, minus turns the user
        // removed — Feature 51). `origIdx` keeps pointing at the original index
        // so bookmarks / annotations / code blocks stay aligned.
        const visibleMessages: VisibleMessage[] = session.messages
            .map((msg, origIdx) => ({
                msg,
                origIdx,
                nextRemoved: session.messages[origIdx + 1]?.removed === true,
            }))
            .filter(({ msg }) => !msg.removed && (msg.content.trim() !== '' || !!msg.skipped));

        const total     = visibleMessages.length;
        const initialSz = INITIAL_WINDOW;

        // Always start from the beginning; the webview auto-loads more
        // batches if a navigation target (prompt, code block) is beyond
        // the initial window.
        let windowStart = 0;
        if (targetBlockMessageIndex !== undefined) {
            const targetVisibleIdx = visibleMessages.findIndex(
                vm => vm.origIdx === targetBlockMessageIndex
            );
            if (targetVisibleIdx >= 0) {
                windowStart = Math.max(0, targetVisibleIdx - 3);
            }
        }

        // Render cache keyed on sessionId + updatedAt
        const cacheKey = `${session.id}::${session.updatedAt}`;
        let renderedMessages = SessionWebviewPanel._renderCache.get(cacheKey);
        if (!renderedMessages) {
            renderedMessages = new Array<string | null>(total).fill(null);
            SessionWebviewPanel._renderCacheSet(cacheKey, renderedMessages);
        }

        const scrollInit: ScrollInit = {
            targetMsgIdx:   targetBlockMessageIndex ?? null,
            targetBlockIdx: targetBlockIdx ?? null,
            highlightColor: cbHighlightColor || null,
            shouldScroll:   cbScroll,
        };

        const initialWindowEnd = Math.min(windowStart + initialSz, total);

        // ── Re-use existing panel ─────────────────────────────────────────────
        const existing = SessionWebviewPanel._panels.get(session.id);
        if (existing) {
            existing.reveal(vscode.ViewColumn.One);
            const prev = SessionWebviewPanel._panelState.get(session.id);
            const newVersion = (prev?.streamVersion ?? 0) + 1;
            SessionWebviewPanel._panelState.set(session.id, {
                session, visibleMessages, renderedMessages,
                windowStart, windowEnd: initialWindowEnd,
                streamVersion: newVersion,
                assistantLabel, tags, entities, summary, status, bookmarks, annotations, panel: existing,
            });
            void SessionWebviewPanel._startStream(
                session.id, newVersion, userColor, searchTerm, scrollInit, highlightContainer
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
            windowStart, windowEnd: initialWindowEnd,
            streamVersion: 0,
                assistantLabel, tags, entities, summary, panel,
            status, bookmarks, annotations,
        });
        SessionWebviewPanel._panels.set(session.id, panel);

        panel.webview.onDidReceiveMessage(
            (msg: { type?: string; command?: string; text?: string; direction?: 'older' | 'newer' }) => {
                if (msg.type === 'ready') {
                    const st = SessionWebviewPanel._panelState.get(session.id);
                    void SessionWebviewPanel._startStream(
                        session.id, st?.streamVersion ?? 0, userColor, searchTerm, scrollInit, highlightContainer
                    );
                } else if (msg.type === 'loadMoreMessages') {
                    void SessionWebviewPanel._loadMoreMessages(session.id);
                } else if (msg.type === 'loadAllMessages') {
                    void SessionWebviewPanel._loadAllMessages(session.id);
                } else if (msg.command === 'exportExcerpt') {
                    void vscode.commands.executeCommand('chatwizard.exportExcerpt', session.id);
                } else if (msg.command === 'exportSelection' && msg.text) {
                    void SessionWebviewPanel._saveSelection(msg.text, session.title);
                } else if (msg.command === 'copy' && msg.text) {
                    void vscode.env.clipboard.writeText(msg.text);
                    void vscode.window.showInformationMessage('Chat copied to clipboard.');
                } else if (msg.command === 'copyTurnRef' && msg.text) {
                    void vscode.env.clipboard.writeText(msg.text);
                    void vscode.window.showInformationMessage('Reference copied to clipboard.');
                } else if ((msg as any).type === 'iife-error') {
                    const errMsg = `[ChatWizard] Webview IIFE error for session ${session.id}: ${(msg as any).message}`;
                    SessionWebviewPanel._channel?.appendLine(errMsg);
                    console.error(errMsg);
                } else if (msg.type === 'revealInTree') {
                    void vscode.commands.executeCommand('chatwizard.revealInSessionsTree', session.id);
                } else if ((msg as any).type === 'bookmarkMessage') {
                    const m = msg as any;
                    void SessionWebviewPanel._toggleBookmark(session.id, m.messageIndex as number);
                } else if ((msg as any).type === 'saveAnnotation') {
                    const m = msg as any;
                    void SessionWebviewPanel._saveAnnotation(session.id, m.messageIndex as number, m.text as string);
                } else if ((msg as any).type === 'deleteAnnotation') {
                    const m = msg as any;
                    void SessionWebviewPanel._deleteAnnotation(session.id, m.messageIndex as number);
                } else if ((msg as any).type === 'removeTurn') {
                    const m = msg as any;
                    void SessionWebviewPanel._removeTurn(session.id, m.messageIndex as number);
                } else if ((msg as any).type === 'openOriginalConversation') {
                    void SessionWebviewPanel._openOriginalConversation(session.id);
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
        panelId:          string,
        myVersion:        number,
        userColor:        string,
        searchTerm:       string | undefined,
        scrollInit:       ScrollInit,
        highlightContainer?: boolean
    ): Promise<void> {
        const st = SessionWebviewPanel._panelState.get(panelId);
        if (st && st.streamVersion === myVersion) { st.streamInFlight = true; }
        try {
        return await SessionWebviewPanel.__startStreamInner(
            panelId, myVersion, userColor, searchTerm, scrollInit, highlightContainer
        );
        } catch (err) {
            const msg = `[ChatWizard] _startStream error for panel ${panelId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
            SessionWebviewPanel._channel?.appendLine(msg);
            console.error(msg);
        } finally {
            const cur = SessionWebviewPanel._panelState.get(panelId);
            // Only the stream that owns the current version may clear the flag.
            if (cur && cur.streamVersion === myVersion) { cur.streamInFlight = false; }
        }
    }

    /** Waits until no initial-window stream is appending to this panel. */
    private static async _waitForStreamIdle(panelId: string): Promise<void> {
        while (SessionWebviewPanel._panelState.get(panelId)?.streamInFlight) {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }

    private static async __startStreamInner(
        panelId:          string,
        myVersion:        number,
        userColor:        string,
        searchTerm:       string | undefined,
        scrollInit:       ScrollInit,
        highlightContainer?: boolean
    ): Promise<void> {
        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state || state.streamVersion !== myVersion) { return; }

        const { visibleMessages, renderedMessages, windowStart, assistantLabel, panel, session } = state;
        const total      = visibleMessages.length;
        const windowEnd  = state.windowEnd;   // already capped at windowStart + initialSz

        // ── First chunk: rendered synchronously so first content appears immediately ──
        const firstEnd = Math.min(windowStart + CHUNK_SIZE, windowEnd);
        const firstHtml = SessionWebviewPanel._renderChunk(
            visibleMessages, renderedMessages, windowStart, firstEnd, assistantLabel, true
        );
        state.windowStart = windowStart;
        state.windowEnd   = firstEnd;

        void panel.webview.postMessage({
            type: 'render',
            title:            session.title,
            sessionId:        session.id,
            source:           session.source,
            assistantLabel,
            userColor,
            term:             searchTerm ?? null,
            scrollInit:       null, // scroll sent separately after all chunks via cwScroll
            messagesHtml:     firstHtml,
            windowStart,
            windowEnd:        firstEnd,
            total,
            hasMore:          windowEnd < total,
            userRequestCount: session.messages.filter(m => m.role === 'user' && !m.removed).length,
            // Feature 51 — how many turns the user removed + whether removal is
            // available at all (it needs the SQLite chat DB to persist).
            removedTurnCount: session.messages.filter(m => m.removed === true).length,
            canRemove:        !!SessionWebviewPanel._cacheStore,
            createdAt:        session.createdAt,
            model:            friendlyModelName(session.model),
            parseErrors:      session.parseErrors ?? [],
            sourceNotes:      session.sourceNotes ?? [],
            filePath:         session.filePath,
            branch:           session.gitContext?.branch ?? session.chronicleData?.branch ?? null,
            tags:             state.tags ?? [],
            entityGroups:     buildEntityTypeGroups(state.entities),
            summary:          state.summary ?? null,
            status:           state.status ?? null,
            bookmarks:        state.bookmarks?.map(b => ({
                messageIndex: b.messageIndex,
                note: b.note || null,
                createdAt: b.createdAt,
            })) ?? [],
            annotations:      state.annotations?.map(a => ({
                messageIndex: a.messageIndex,
                text: a.text,
                createdAt: a.createdAt,
                updatedAt: a.updatedAt || null,
            })) ?? [],
        });

        // ── Stream remaining initial window via setImmediate ──────────────────
        let cursor = firstEnd;
        while (cursor < windowEnd) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) { return; }

            const chunkEnd  = Math.min(cursor + CHUNK_SIZE, windowEnd);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, cursor, chunkEnd, assistantLabel, false
            );
            state.windowEnd = chunkEnd;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'end',
                newWindowEnd:   chunkEnd,
                hasMore:        windowEnd < total,
            });
            cursor = chunkEnd;
        }

        // ── Send search + scroll commands after all initial chunks are posted ─
        // Both messages arrive in the webview AFTER all appendChunk messages, so
        // the full initial window is guaranteed to be in the DOM at that point.
        if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion === myVersion) {
            if (searchTerm) {
                const msgType = highlightContainer ? 'cwHighlightMsg' : 'cwSearch';
                void panel.webview.postMessage({ type: msgType, term: searchTerm });
            }
            if (scrollInit.highlightColor || scrollInit.shouldScroll) {
                void panel.webview.postMessage({ type: 'cwScroll', ...scrollInit });
            }
        }

        // ── Background pre-render newer messages for fast load-more ──────────
        let bgCursor = windowEnd;
        while (bgCursor < total) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) { return; }

            const bgEnd = Math.min(bgCursor + CHUNK_SIZE, total);
            for (let i = bgCursor; i < bgEnd; i++) {
                if (renderedMessages[i] === null) {
                    renderedMessages[i] = renderMessage(
                        visibleMessages[i].msg, visibleMessages[i].origIdx,
                        i, visibleMessages, assistantLabel, undefined
                    );
                }
            }
            bgCursor = bgEnd;
        }
    }

    static async _loadMoreMessages(panelId: string): Promise<void> {
        const initial = SessionWebviewPanel._panelState.get(panelId);
        if (!initial) { return; }
        const myVersion = initial.streamVersion;

        // Appending while the initial window is still streaming would render the
        // same messages twice — wait for it to land instead.
        await SessionWebviewPanel._waitForStreamIdle(panelId);

        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state || state.streamVersion !== myVersion) { return; } // panel re-rendered meanwhile

        const { visibleMessages, renderedMessages, assistantLabel, panel } = state;
        const total = visibleMessages.length;

        if (state.windowEnd < total) {
            const newEnd    = Math.min(total, state.windowEnd + CHUNK_SIZE);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, state.windowEnd, newEnd, assistantLabel, false
            );
            state.windowEnd = newEnd;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'end',
                newWindowEnd:   newEnd,
                hasMore:        newEnd < total,
            });
        }
    }

    /**
     * Streams every remaining message into the webview, in `CHUNK_SIZE` batches.
     *
     * Used by the "Load all messages" button and, implicitly, by search: a search
     * that only covers the initially loaded excerpt of a long session is useless,
     * so the reader loads the whole transcript first and re-runs the query.
     *
     * Chunks are sent with `loadAll: true` so the webview keeps its progress
     * indicator running until the final batch arrives. The operation aborts
     * silently when a newer render starts (streamVersion bump — panel re-show).
     */
    static async _loadAllMessages(panelId: string): Promise<void> {
        const initial = SessionWebviewPanel._panelState.get(panelId);
        if (!initial) { return; }
        const myVersion = initial.streamVersion;

        // Same overlap rule as _loadMoreMessages: wait for the initial window.
        await SessionWebviewPanel._waitForStreamIdle(panelId);

        const state = SessionWebviewPanel._panelState.get(panelId);
        if (!state || state.streamVersion !== myVersion) { return; } // panel re-rendered meanwhile

        const { visibleMessages, renderedMessages, assistantLabel, panel } = state;
        const total = visibleMessages.length;

        while (true) {
            const st = SessionWebviewPanel._panelState.get(panelId);
            if (!st || st.streamVersion !== myVersion) { return; } // superseded by a newer render
            if (st.windowEnd >= total) { break; }

            const newEnd    = Math.min(total, st.windowEnd + CHUNK_SIZE);
            const chunkHtml = SessionWebviewPanel._renderChunk(
                visibleMessages, renderedMessages, st.windowEnd, newEnd, assistantLabel, false
            );
            st.windowEnd = newEnd;
            const hasMore = newEnd < total;
            void panel.webview.postMessage({
                type:           'appendChunk',
                messagesHtml:   chunkHtml,
                position:       'end',
                newWindowEnd:   newEnd,
                hasMore,
                loadAll:        true,
            });
            if (!hasMore) { break; }

            // Yield between batches so the extension host stays responsive and the
            // webview can paint / keep its spinner alive while the rest streams in.
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        const finalState = SessionWebviewPanel._panelState.get(panelId);
        if (finalState && finalState.streamVersion === myVersion) {
            void panel.webview.postMessage({
                type:    'loadAllDone',
                hasMore: finalState.windowEnd < total,
                loaded:  finalState.windowEnd,
                total,
            });
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
      margin-bottom: 4px;
      padding-bottom: 8px;
      border-bottom: none;
    }
    h1#session-title {
      cursor: pointer;
      transition: opacity 0.15s;
    }
    h1#session-title:hover { opacity: 0.65; }
    .session-meta {
      display: none;
      font-size: 0.82em;
      opacity: 0.7;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444);
      margin-bottom: 8px;
    }
    .session-meta span {
      font-weight: 600;
      opacity: 1;
    }
    .session-meta .cw-meta-model { color: var(--vscode-debugTokenExpression-name, #569cd6); }
    .session-meta .cw-meta-date { color: var(--vscode-debugTokenExpression-timestamp, #6a9955); }
    .session-meta .cw-meta-branch { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .session-meta .cw-meta-req { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .session-meta .cw-meta-label { opacity: 0.7; font-weight: 500; }
    #session-tags { min-height: 0; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444); }
    .cw-tag-chip {
      display: inline-flex; align-items: center;
      border-radius: 2em; padding: 1px 9px;
      font-size: 0.75em; font-weight: 500;
      margin: 0 4px 0 0; border: 1px solid currentColor; opacity: 0.88;
    }
    /* Always-visible one-line row: Entities [type] [entity] */
    #session-entities {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
      font-size: 0.82em;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444);
      min-width: 0;
    }
    .cw-entity-label {
      flex: 0 0 auto;
      font-weight: 600;
      opacity: 0.7;
      white-space: nowrap;
    }
    .cw-entity-select {
      flex: 0 1 auto;
      min-width: 6em;
      height: 20px;
      margin: 0;
      padding: 0 4px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 1em;
      line-height: 1.2;
      text-overflow: ellipsis;
      background-color: var(--vscode-dropdown-background, var(--vscode-input-background, #3c3c3c));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #cccccc));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, #555));
      border-radius: 2px;
      outline: none;
    }
    #entity-type-select { max-width: 13em; }
    #entity-value-select { flex: 1 1 auto; min-width: 9em; max-width: 34em; }
    .cw-entity-select:focus { border-color: var(--vscode-focusBorder, #007fd4); }
    .cw-entity-select:disabled { opacity: 0.55; }
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
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
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
    .cw-turn-label {
      font-size: 0.72em;
      font-family: var(--vscode-editor-font-family, monospace);
      opacity: 0.45;
      padding: 0 3px;
      border: 1px solid currentColor;
      border-radius: 3px;
      user-select: none;
    }
    .cw-copy-ref-btn {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      opacity: 0;
      padding: 1px 4px;
      font-size: 0.85em;
      color: inherit;
      transition: opacity 0.15s;
      border-radius: 3px;
      line-height: 1;
    }
    .message:hover .cw-copy-ref-btn { opacity: 0.4; }
    .cw-copy-ref-btn:hover { opacity: 1 !important; background: var(--cw-surface-subtle); }
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
    /* Auto-linked URIs and markdown links — visually distinct and clickable
       (VS Code opens http/https anchors in the user's default browser). */
    .message-body a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      cursor: pointer;
    }
    .message-body a:hover { text-decoration: underline; }
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
    .parse-errors-banner {
      background: rgba(200, 160, 0, 0.08);
      border: 1px solid rgba(200, 160, 0, 0.35);
      border-left: 3px solid #c8a800;
      border-radius: var(--cw-radius);
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 0.85em;
      color: var(--vscode-editorWarning-foreground, #c8a800);
    }
    .parse-errors-banner ul { margin: 6px 0 0; padding-left: 1.5em; }
    .parse-errors-banner li { margin: 3px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
    .source-notes-banner {
      background: rgba(0, 120, 212, 0.08);
      border: 1px solid rgba(0, 120, 212, 0.35);
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      border-radius: var(--cw-radius);
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 0.85em;
      color: var(--vscode-foreground, #ccc);
    }
    .source-notes-banner strong { color: var(--vscode-textLink-foreground, #3794ff); }
    .parse-error-path { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.8; }
    .skipped-notice { font-style: italic; color: var(--vscode-editorWarning-foreground, #c8a800); }
    mark {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33));
      color: inherit; border-radius: 2px; padding: 0 1px;
    }
    mark.cw-active {
      background-color: var(--vscode-editor-findMatchBackground, rgba(234,92,0,0.8));
      outline: 1px solid rgba(234,92,0,0.9);
    }
    .cw-msg-hl {
      outline: 2px solid var(--vscode-editor-findMatchHighlightBorder, rgba(234,92,0,0.5));
      border-radius: 4px;
    }
    .cw-msg-hl-active {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      border-radius: 4px;
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.12));
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
    #search-whole-word, #search-regex { padding: 3px 6px; border: 1px solid var(--vscode-input-border, #555); background: var(--vscode-input-background, #3c3c3c); font-weight: bold; letter-spacing: -0.02em; }
    #search-whole-word.cw-active, #search-regex.cw-active { background: var(--cw-accent); color: var(--cw-accent-text); border-color: var(--cw-accent); }
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
    #load-more-btn {
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
    #load-more-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
    /* "Load all messages" — the full-transcript button in the sticky toolbar */
    #load-all-btn {
      white-space: nowrap;
    }
    #load-all-btn .cw-spinner {
      display: none;
      width: 8px;
      height: 8px;
      margin-right: 6px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      vertical-align: -1px;
      animation: cw-spin 0.7s linear infinite;
    }
    #load-all-btn.cw-loading .cw-spinner { display: inline-block; }
    #load-all-btn.cw-loading,
    #load-all-btn:disabled { cursor: progress; opacity: 0.8; }
    #load-all-btn.cw-loading:hover,
    #load-all-btn:disabled:hover {
      background: var(--cw-surface-subtle);
      color: inherit;
      border-color: var(--cw-border-strong);
    }
    @keyframes cw-spin { to { transform: rotate(360deg); } }
    .cw-filter-label {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .cw-filter-label:hover { opacity: 1; }
    .cw-filter-label input { margin: 0; cursor: pointer; }
    /* Annotation button styles */
    .cw-annotation-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 1px 4px;
      font-size: 0.9em;
      color: inherit;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      border-radius: 3px;
      line-height: 1;
    }
    .message:hover .cw-annotation-btn { opacity: 0.4; }
    .cw-annotation-btn:hover { opacity: 1 !important; background: var(--cw-surface-subtle); }
    .cw-annotation-btn.cw-active { opacity: 1; color: var(--cw-accent, #f0c040); }
    /* Annotation block styles */
    .cw-annotation-block {
      margin: 6px 0 0;
      padding: 8px 12px;
      background: rgba(200, 200, 0, 0.06);
      border-left: 3px solid rgba(200, 200, 0, 0.4);
      border-radius: 3px;
      font-size: 0.88em;
    }
    .cw-annotation-block .cw-annotation-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .cw-annotation-block .cw-annotation-label {
      font-weight: 600;
      opacity: 0.6;
      font-size: 0.82em;
    }
    .cw-annotation-block .cw-annotation-date {
      opacity: 0.45;
      font-size: 0.78em;
    }
    .cw-annotation-block .cw-annotation-text {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .cw-annotation-block .cw-annotation-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .cw-annotation-block .cw-annotation-actions button {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.78em;
      opacity: 0.5;
      padding: 1px 6px;
      border-radius: 3px;
      color: inherit;
    }
    .cw-annotation-block .cw-annotation-actions button:hover { opacity: 1; background: var(--cw-surface-subtle); }
    /* Inline annotation editor */
    .cw-annotation-editor {
      margin: 6px 0 0;
      padding: 0;
    }
    .cw-annotation-editor textarea {
      width: 100%;
      min-height: 48px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 6px 8px;
      resize: vertical;
      box-sizing: border-box;
    }
    .cw-annotation-editor textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); outline: none; }
    .cw-annotation-editor .cw-annotation-editor-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .cw-annotation-editor .cw-annotation-editor-actions button {
      background: var(--cw-surface-subtle);
      color: inherit;
      border: 1px solid var(--cw-border-strong);
      padding: 2px 10px;
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .cw-annotation-editor .cw-annotation-editor-actions button:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
    /* Bookmark button styles */
    .cw-bookmark-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 1px 4px;
      font-size: 0.9em;
      color: inherit;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      border-radius: 3px;
      line-height: 1;
    }
    .message:hover .cw-bookmark-btn { opacity: 0.4; }
    .cw-bookmark-btn:hover { opacity: 1 !important; background: var(--cw-surface-subtle); }
    .cw-bookmark-btn.cw-active { opacity: 1; color: var(--cw-accent, #f0c040); }
    /* Bookmarks jump list */
    #bookmarks-section { display: none; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444); }
    #bookmarks-section summary { cursor: pointer; opacity: 0.65; user-select: none; font-size: 0.82em; }
    #bookmarks-section summary:hover { opacity: 1; }
    #bookmarks-list { padding: 4px 0; display: flex; flex-direction: column; gap: 3px; }
    .bookmark-item {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 6px; border-radius: 3px;
      cursor: pointer; font-size: 0.82em;
      transition: background 0.12s;
    }
    .bookmark-item:hover { background: var(--cw-surface-subtle); }
    .bookmark-item .bm-marker { color: var(--cw-accent, #f0c040); font-size: 0.85em; }
    .bookmark-item .bm-note { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bookmark-item .bm-date { opacity: 0.45; font-size: 0.85em; margin-left: auto; white-space: nowrap; }
    /* ── Feature 51 — turn selection & removal ──────────────────────────────── */
    .message { cursor: default; transition: box-shadow 0.12s, border-color 0.12s; }
    .message.cw-selected {
      box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4), var(--cw-shadow);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .cw-remove-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 1px 4px;
      font-size: 0.9em;
      color: inherit;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      border-radius: 3px;
      line-height: 1;
    }
    .message:hover .cw-remove-btn { opacity: 0.4; }
    .message.cw-selected .cw-remove-btn { opacity: 1; }
    .cw-remove-btn:hover {
      opacity: 1 !important;
      background: var(--cw-surface-subtle);
      color: var(--vscode-errorForeground, #f14c4c);
    }
    /* Removal is only offered when the chat DB is available to persist it. */
    body.cw-no-remove .cw-remove-btn { display: none !important; }
    .cw-ctx-danger { color: var(--vscode-errorForeground, #f14c4c); }
    .session-meta .cw-meta-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
    .session-meta .cw-meta-removed a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline; }
    .session-meta .cw-meta-removed a:hover { color: var(--vscode-textLink-activeForeground, #3794ff); }
  </style>
</head>
<body>
  <h1 id="session-title"><span class="cw-skeleton" style="display:inline-block;height:1.1em;width:50%;vertical-align:middle"></span></h1>
  <p id="session-summary" style="display:none;margin:4px 0 8px;opacity:0.7;font-size:0.875em;font-style:italic;"></p>
  <div id="session-tags" style="display:none"></div>
  <div class="session-meta" id="session-meta">
    <span id="session-date-field" class="cw-meta-date" style="display:none"><span class="cw-meta-label">Date:</span> <span id="session-date"></span></span>
    <span class="meta-sep" id="session-date-sep" style="display:none"> &nbsp;·&nbsp; </span>
    <span id="session-model-field" class="cw-meta-model" style="display:none"><span class="cw-meta-label">Model:</span> <span id="session-model"></span></span>
    <span class="meta-sep" id="session-meta-sep" style="display:none"> &nbsp;·&nbsp; </span>
    <span id="session-req-field" class="cw-meta-req" style="display:none"><span class="cw-meta-label">User Requests:</span> <span id="session-user-req"></span></span>
    <span class="meta-sep" style="display:none" id="session-status-sep"> &nbsp;·&nbsp; </span>
    <span id="session-status" style="display:none"></span>
    <span class="meta-sep" style="display:none" id="session-branch-sep"> &nbsp;·&nbsp; </span>
    <span id="session-branch-field" class="cw-meta-branch" style="display:none"><span id="session-branch-icon" style="opacity:0.6">⎇</span> <span class="cw-meta-label">Branch:</span> <span id="session-branch"></span></span>
    <span class="meta-sep" style="display:none" id="session-removed-sep"> &nbsp;·&nbsp; </span>
    <span id="session-removed-field" class="cw-meta-removed" style="display:none"><span class="cw-meta-label">Removed:</span> <span id="session-removed-count"></span> &nbsp;<a href="#" id="session-original-link" title="Open the complete conversation as it was before any turn was removed">original full conversation</a></span>
  </div>
  <div id="session-entities" role="group" aria-label="Entities">
    <span class="cw-entity-label">Entities</span>
    <select id="entity-type-select" class="cw-entity-select" aria-label="Entity type" title="Filter entities by type" disabled></select>
    <select id="entity-value-select" class="cw-entity-select" aria-label="Entity value" title="Select an entity to search for it in this session" disabled></select>
  </div>
  <div id="bookmarks-section">
    <summary style="cursor:pointer;opacity:0.65;user-select:none;font-size:0.82em;">&#9733; Bookmarks</summary>
    <div id="bookmarks-list"></div>
  </div>
  <div class="toolbar">
    <div class="search-group">
      <input id="search-input" type="text" placeholder="Search in messages&#8230;" autocomplete="off" aria-label="Search within session messages" />
      <span class="search-counter" id="search-counter" aria-live="polite"></span>
      <button id="search-whole-word" title="Match whole word (Alt+W)" aria-label="Match whole word" aria-pressed="false">W</button>
      <button id="search-regex" title="Use regular expression (Alt+R)" aria-label="Use regular expression" aria-pressed="false">.*</button>
      <button id="search-prev" title="Previous (Shift+Enter)" aria-label="Previous match">&#9650;</button>
      <button id="search-next" title="Next (Enter)" aria-label="Next match">&#9660;</button>
    </div>
    <button id="load-all-btn" style="display:none;" title="Load every message in this session, so search covers the whole chat"><span class="cw-spinner" aria-hidden="true"></span><span id="load-all-btn-label">Load all messages</span></button>
    <button id="export-excerpt-btn" style="opacity:0.7;" title="Export an excerpt of this session as Markdown">Export Excerpt&#8230;</button>
    <label class="cw-filter-label" title="Show only your messages"><input type="checkbox" id="filter-prompts" /> You</label>
    <label class="cw-filter-label" title="Show only assistant responses"><input type="checkbox" id="filter-responses" /> <span id="filter-responses-label">Responses</span></label>
  </div>
  <div id="messages-container">
    <div class="message user cw-fade-item" style="--cw-i:0">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:100px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:72%;margin:6px 0"></div></div>
    </div>
    <div class="message assistant cw-fade-item" style="--cw-i:1">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:48px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:110px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:96%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:84%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:62%;margin:5px 0"></div></div>
    </div>
    <div class="message user cw-fade-item" style="--cw-i:2">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:90px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:88%;margin:6px 0"></div><div class="cw-skeleton" style="height:13px;width:55%;margin:5px 0"></div></div>
    </div>
    <div class="message assistant cw-fade-item" style="--cw-i:3">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:48px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:105px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:92%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:78%;margin:5px 0"></div><div class="cw-skeleton" style="height:60px;width:100%;margin:8px 0;border-radius:var(--cw-radius-sm)"></div><div class="cw-skeleton" style="height:13px;width:70%;margin:5px 0"></div></div>
    </div>
    <div class="message user cw-fade-item" style="--cw-i:4">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:95px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:65%;margin:6px 0"></div></div>
    </div>
  </div>
  <button id="load-more-btn">Load more messages&#8230;</button>
  <button class="cw-back-top" id="backToTop" title="Back to top">&#8593;</button>
  <div id="sel-ctx-menu">
    <div class="ctx-item" id="ctx-export-sel">Export selection as Markdown&#8230;</div>
    <div class="ctx-item cw-ctx-danger" id="ctx-remove-turn">Remove turn from conversation</div>
  </div>
<script>
${cwInteractiveJs()}
(function() {
  var vscode = acquireVsCodeApi();
  try {

  // ── State ──────────────────────────────────────────────────────────────────
  var _hasMore     = false;
  var _loadingMore = false;
  // "Load all messages" in flight — keeps the spinner running and blocks the
  // per-batch "Load more" path from interleaving with it.
  var _loadingAll  = false;
  // Search term waiting for the full transcript to arrive; re-run on completion.
  var _pendingSearchQuery = null;
  var _bookmarks   = [];  // Array<{ messageIndex: number, note: string|null, createdAt: string }>
  var _annotations = [];  // Array<{ messageIndex: number, text: string, createdAt: string, updatedAt: string|null }>
  // Feature 51 — the turn currently selected for removal, and the turn the
  // context menu was opened on.
  var _selectedMsgEl = null;
  var _ctxMsgEl = null;

  // ── Turn selection (Feature 51) ────────────────────────────────────────────
  function isTurnEl(el) {
    return !!el && el.classList && el.classList.contains('message') &&
      !el.classList.contains('cw-role-response');
  }
  function clearTurnSelection() {
    if (_selectedMsgEl) { _selectedMsgEl.classList.remove('cw-selected'); }
    _selectedMsgEl = null;
  }
  function selectTurn(el) {
    if (!isTurnEl(el)) { return; }
    if (_selectedMsgEl === el) { el.classList.add('cw-selected'); return; }
    clearTurnSelection();
    _selectedMsgEl = el;
    el.classList.add('cw-selected');
  }
  function toggleTurn(el) {
    if (!isTurnEl(el)) { return; }
    if (_selectedMsgEl === el) { clearTurnSelection(); } else { selectTurn(el); }
  }
  function msgIndexFromTurn(el) {
    if (!el) { return -1; }
    return parseInt(el.getAttribute('data-msg-idx') || '-1', 10);
  }

  // ── Annotation helpers ─────────────────────────────────────────────────────
  function renderAnnotationBlock(a) {
    var date = new Date(a.createdAt).toLocaleDateString();
    var updatedLabel = a.updatedAt ? ' (edited ' + new Date(a.updatedAt).toLocaleDateString() + ')' : '';
    return '<div class="cw-annotation-block" data-annotation-msg-idx="' + a.messageIndex + '">' +
      '<div class="cw-annotation-meta">' +
        '<span class="cw-annotation-label">&#128221; Note</span>' +
        '<span class="cw-annotation-date">' + date + updatedLabel + '</span>' +
      '</div>' +
      '<div class="cw-annotation-text">' + escH(a.text) + '</div>' +
      '<div class="cw-annotation-actions">' +
        '<button class="cw-annotation-edit-btn" data-msg-idx="' + a.messageIndex + '">Edit</button>' +
        '<button class="cw-annotation-delete-btn" data-msg-idx="' + a.messageIndex + '">Delete</button>' +
      '</div>' +
    '</div>';
  }

  function openAnnotationEditor(msgIdx, existingText) {
    // Close any existing editor first
    var existing = document.querySelector('.cw-annotation-editor');
    if (existing) { existing.remove(); }
    // Find the message element
    var msgEl = document.querySelector('[data-msg-idx="' + msgIdx + '"]');
    if (!msgEl) { return; }
    // Remove existing annotation block for this message if editing
    var existingBlock = msgEl.querySelector('.cw-annotation-block[data-annotation-msg-idx="' + msgIdx + '"]');
    if (existingBlock) { existingBlock.style.display = 'none'; }
    // Create editor
    var editor = document.createElement('div');
    editor.className = 'cw-annotation-editor';
    var textarea = document.createElement('textarea');
    textarea.value = existingText || '';
    textarea.placeholder = 'Add your note here…';
    var actions = document.createElement('div');
    actions.className = 'cw-annotation-editor-actions';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = existingText ? 'Update' : 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    editor.appendChild(textarea);
    editor.appendChild(actions);
    msgEl.appendChild(editor);
    textarea.focus();
    textarea.select();
    saveBtn.addEventListener('click', function() {
      var text = textarea.value.trim();
      if (!text) { editor.remove(); if (existingBlock) { existingBlock.style.display = ''; } return; }
      vscode.postMessage({ type: 'saveAnnotation', messageIndex: msgIdx, text: text });
      editor.remove();
    });
    cancelBtn.addEventListener('click', function() {
      editor.remove();
      if (existingBlock) { existingBlock.style.display = ''; }
    });
  }

  // ── Tag color palette (matches tree view emoji palette) ───────────────────
  var _CW_TAG_PALETTE = ['#f47067','#f0883e','#e3b341','#56d364','#58a6ff','#bc8cff','#c29070'];
  function cwTagColor(tag) {
    var h = 0;
    for (var i = 0; i < tag.length; i++) { h = (h * 31 + tag.charCodeAt(i)) & 0xffff; }
    return _CW_TAG_PALETTE[h % _CW_TAG_PALETTE.length];
  }

  // ── Back to top ────────────────────────────────────────────────────────────
  var backTopBtn = document.getElementById('backToTop');
  window.addEventListener('scroll', function() {
    backTopBtn.classList.toggle('visible', window.scrollY > 300);
  });
  backTopBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ── Session title — click to reveal in Sessions tree ─────────────────────
  var titleEl = document.getElementById('session-title');
  titleEl.title = 'Click to reveal in Sessions panel';
  titleEl.addEventListener('click', function() {
    var sid = titleEl.dataset.cwSessionId;
    if (sid) { vscode.postMessage({ type: 'revealInTree', sessionId: sid }); }
  });

  // ── Export excerpt ─────────────────────────────────────────────────────────
  document.getElementById('export-excerpt-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'exportExcerpt' });
  });

  // ── Load more / Load all buttons ────────────────────────────────────────────
  var loadMoreBtn = document.getElementById('load-more-btn');
  var loadAllBtn  = document.getElementById('load-all-btn');
  var loadAllLbl  = document.getElementById('load-all-btn-label');
  loadMoreBtn.addEventListener('click', function() {
    if (_loadingMore || _loadingAll || !_hasMore) { return; }
    _loadingMore = true;
    vscode.postMessage({ type: 'loadMoreMessages' });
  });
  loadAllBtn.addEventListener('click', function() { startLoadAll(); });

  function updateLoadMoreButton() {
    // Redundant while the whole transcript is being loaded.
    loadMoreBtn.style.display = (_hasMore && !_loadingAll) ? 'block' : 'none';
  }

  function updateLoadAllButton() {
    loadAllBtn.style.display = _hasMore ? 'inline-block' : 'none';
    loadAllBtn.disabled = _loadingAll;
    loadAllBtn.classList.toggle('cw-loading', _loadingAll);
    if (loadAllLbl) { loadAllLbl.textContent = _loadingAll ? 'Loading all messages\\u2026' : 'Load all messages'; }
  }

  // Ask the host to stream every remaining message into the DOM.
  function startLoadAll() {
    if (_loadingAll || !_hasMore) { return; }
    _loadingAll = true;
    updateLoadAllButton();
    updateLoadMoreButton();
    vscode.postMessage({ type: 'loadAllMessages' });
  }

  // Everything is in the DOM: drop the spinner and re-run the search that was
  // waiting for it (so the counter / results cover the full conversation).
  function finishLoadAll() {
    if (!_loadingAll) { return; }
    _loadingAll = false;
    updateLoadAllButton();
    updateLoadMoreButton();
    applyRoleFilter();
    updateBookmarksUI();
    var query = _pendingSearchQuery;
    _pendingSearchQuery = null;
    if (query === null) { query = srchInput.value || null; }
    if (query) { srchInput.value = query; runSearch(query); }
    else       { srchCounter.textContent = ''; }
  }

  // ── Role filter checkboxes ──────────────────────────────────────────────────
  var filterPromptsEl   = document.getElementById('filter-prompts');
  var filterResponsesEl = document.getElementById('filter-responses');
  function applyRoleFilterTo(root) {
    var showPromptsOnly   = filterPromptsEl.checked;
    var showResponsesOnly = filterResponsesEl.checked;
    // If both or neither checked, show everything
    if (showPromptsOnly === showResponsesOnly) {
      root.querySelectorAll('.message').forEach(function(el) { el.style.display = ''; });
      return;
    }
    root.querySelectorAll('.message').forEach(function(el) {
      var isUser = el.classList.contains('user');
      if (showPromptsOnly)   { el.style.display = isUser ? '' : 'none'; }
      if (showResponsesOnly) { el.style.display = isUser ? 'none' : ''; }
    });
  }
  function applyRoleFilter() { applyRoleFilterTo(container); }
  filterPromptsEl.addEventListener('change', function() {
    if (filterPromptsEl.checked && filterResponsesEl.checked) { filterResponsesEl.checked = false; }
    applyRoleFilter();
  });
  filterResponsesEl.addEventListener('change', function() {
    if (filterResponsesEl.checked && filterPromptsEl.checked) { filterPromptsEl.checked = false; }
    applyRoleFilter();
  });

  // ── Copy-all: when nothing is selected, Ctrl+C / context-menu Copy copies the whole chat
  document.addEventListener('copy', function(e) {
    var sel = window.getSelection();
    if (sel && sel.toString().trim()) { return; } // normal selection copy — don't interfere
    var parts = [];
    document.querySelectorAll('.message').forEach(function(msgEl) {
      if (msgEl.classList.contains('aborted')) { return; }
      var roleEl = msgEl.querySelector('.role-label');
      var bodyEl = msgEl.querySelector('.message-body[data-raw]');
      if (roleEl && bodyEl) {
        var role = roleEl.textContent || '';
        var raw = bodyEl.getAttribute('data-raw') || bodyEl.textContent || '';
        parts.push(role + '\\n' + raw);
      }
    });
    if (!parts.length) { return; }
    vscode.postMessage({ command: 'copy', text: parts.join('\\n\\n---\\n\\n') });
    e.preventDefault();
  });

  // ── Context menu ───────────────────────────────────────────────────────────
  var ctxMenu = document.getElementById('sel-ctx-menu');
  var ctxExportItem = document.getElementById('ctx-export-sel');
  var ctxRemoveItem = document.getElementById('ctx-remove-turn');
  var savedSelText = '';
  function hideMenu() { ctxMenu.style.display = 'none'; }
  document.addEventListener('contextmenu', function(e) {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';
    var msgEl = e.target && e.target.closest ? e.target.closest('.message') : null;
    var showRemove = isTurnEl(msgEl) && !document.body.classList.contains('cw-no-remove');
    if (!text && !showRemove) { hideMenu(); return; }
    savedSelText = text;
    _ctxMsgEl = showRemove ? msgEl : null;
    ctxExportItem.style.display = text ? 'block' : 'none';
    ctxRemoveItem.style.display = showRemove ? 'block' : 'none';
    // Feature 51 — right-clicking a turn both selects it and offers its removal.
    if (showRemove) { selectTurn(msgEl); }
    e.preventDefault();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.style.display = 'block';
    var rect = ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   { ctxMenu.style.left = (e.clientX - rect.width)  + 'px'; }
    if (rect.bottom > window.innerHeight) { ctxMenu.style.top  = (e.clientY - rect.height) + 'px'; }
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideMenu(); clearTurnSelection(); } });
  ctxExportItem.addEventListener('click', function() {
    if (!savedSelText) { return; }
    vscode.postMessage({ command: 'exportSelection', text: savedSelText });
    savedSelText = '';
    hideMenu();
  });
  ctxRemoveItem.addEventListener('click', function() {
    var idx = msgIndexFromTurn(_ctxMsgEl);
    hideMenu();
    if (idx < 0) { return; }
    vscode.postMessage({ type: 'removeTurn', messageIndex: idx });
  });

  // ── Turn selection & removal (Feature 51) ──────────────────────────────────
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.closest) { return; }
    // The remove button acts on the turn it belongs to.
    var removeBtn = t.closest('.cw-remove-btn');
    if (removeBtn) {
      e.stopPropagation();
      var ownerEl = removeBtn.closest('.message');
      var ownerIdx = msgIndexFromTurn(ownerEl);
      if (ownerIdx >= 0) { vscode.postMessage({ type: 'removeTurn', messageIndex: ownerIdx }); }
      return;
    }
    // Clicks on controls / annotation UI must not change the selection.
    if (t.closest('button, a, select, input, textarea, summary, label, .cw-annotation-block, .cw-annotation-editor, .bookmark-item')) {
      return;
    }
    // A text selection (drag) is not a turn click.
    var sel = window.getSelection();
    if (sel && sel.toString().trim()) { return; }
    var msgEl = t.closest('.message');
    if (!msgEl) { clearTurnSelection(); return; }
    toggleTurn(msgEl);
  });

  // ── "Original full conversation" (Feature 51) ──────────────────────────────
  var originalLink = document.getElementById('session-original-link');
  if (originalLink) {
    originalLink.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'openOriginalConversation' });
    });
  }

  // ── Update bookmarks UI ─────────────────────────────────────────────────
  function updateBookmarksUI() {
    var sectionEl = document.getElementById('bookmarks-section');
    var listEl = document.getElementById('bookmarks-list');
    if (!listEl || !sectionEl) { return; }
    if (!_bookmarks || _bookmarks.length === 0) {
      sectionEl.style.display = 'none';
      return;
    }
    sectionEl.style.display = 'block';
    // Mark bookmarked messages in the DOM
    document.querySelectorAll('.message').forEach(function(msgEl) {
      var msgIdx = parseInt(msgEl.getAttribute('data-msg-idx') || '-1', 10);
      var bmBtn = msgEl.querySelector('.cw-bookmark-btn');
      if (bmBtn) {
        var isBookmarked = _bookmarks.some(function(b) { return b.messageIndex === msgIdx; });
        bmBtn.textContent = isBookmarked ? '\u2605' : '\u2606';
        bmBtn.classList.toggle('cw-active', isBookmarked);
      }
    });
    // Populate jump list
    listEl.innerHTML = _bookmarks.map(function(bm, i) {
      var dateStr = bm.createdAt ? bm.createdAt.slice(0, 16).replace('T', ' ') : '';
      var noteHtml = bm.note ? escH(bm.note) : '';
      return '<div class="bookmark-item" data-bm-idx="' + i + '" data-bm-msg-idx="' + bm.messageIndex + '">' +
        '<span class="bm-marker">\u2605</span>' +
        '<span class="bm-note">#' + bm.messageIndex + (noteHtml ? ' &mdash; ' + noteHtml : '') + '</span>' +
        '<span class="bm-date">' + dateStr + '</span>' +
        '</div>';
    }).join('');
    // Click handler for jump list items
    listEl.querySelectorAll('.bookmark-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var msgIdx = parseInt(item.getAttribute('data-bm-msg-idx') || '-1', 10);
        if (msgIdx >= 0) {
          vscode.postMessage({ type: 'bookmarkJumped', messageIndex: msgIdx });
        }
      });
    });
  }

  // ── Bookmark button click handler (delegated) ────────────────────────
  document.addEventListener('click', function(e) {
    var bmBtn = e.target && e.target.closest ? e.target.closest('.cw-bookmark-btn') : null;
    if (bmBtn) {
      var msgEl = bmBtn.closest('.message');
      if (msgEl) {
        var msgIdx = parseInt(bmBtn.getAttribute('data-msg-orig-idx') || msgEl.getAttribute('data-msg-idx') || '-1', 10);
        if (msgIdx >= 0) { vscode.postMessage({ type: 'bookmarkMessage', messageIndex: msgIdx }); }
      }
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest('.cw-copy-ref-btn') : null;
    if (!btn) { return; }
    e.stopPropagation();
    var turnLabel = btn.dataset.turn || '';
    var msgEl = btn.closest('.message');
    if (!msgEl) { return; }
    var bodyEl = msgEl.querySelector('.message-body[data-raw]');
    var raw = bodyEl ? (bodyEl.dataset.raw || '') : '';
    var lines = raw.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var firstLine = lines[0] || '';
    var lastLine  = lines.length > 1 ? lines[lines.length - 1] : '';
    var titleEl = document.getElementById('session-title');
    var sessionTitle = titleEl ? (titleEl.textContent || '').trim() : '';
    var ref = (lastLine && lastLine !== firstLine)
      ? '[Session: ' + sessionTitle + '] ' + turnLabel + '\\n\u21b3 "' + firstLine + '"\\n   "' + lastLine + '"'
      : '[Session: ' + sessionTitle + '] ' + turnLabel + '\\n\u21b3 "' + firstLine + '"';
    vscode.postMessage({ command: 'copyTurnRef', text: ref });
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
  var _deHighlighted = false;
  function highlightAll() {
    if (_deHighlighted) { return; } // don't overwrite de-highlighted state during active search
    document.querySelectorAll('pre code').forEach(function(block) {
      block.innerHTML = tokenize(block.textContent || '');
    });
  }
  function dehighlightCode() {
    if (_deHighlighted) { return; }
    document.querySelectorAll('pre code').forEach(function(block) {
      var text = block.textContent || '';
      while (block.firstChild) { block.removeChild(block.firstChild); }
      block.appendChild(document.createTextNode(text));
    });
    _deHighlighted = true;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  var cwMarks = [], cwIdx = -1;
  // Message-level marks for multi-line (stage-2) search
  var cwMsgMarks = [], cwMsgIdx = -1;
  // Pending prompt-library highlight: auto-loads more batches until the target is in DOM
  var _pendingHighlight = null;
  var srchInput     = document.getElementById('search-input');
  var srchCounter   = document.getElementById('search-counter');
  var srchPrev      = document.getElementById('search-prev');
  var srchNext      = document.getElementById('search-next');
  var srchWholeWord = document.getElementById('search-whole-word');
  var srchRegex     = document.getElementById('search-regex');
  var wholeWord     = false;
  var useRegex      = false;
  function escRx(s) { return s.replace(/[.*+?^{}()|$[\]\\]/g, '\\$&'); }
  function clearMsgMarks() {
    cwMsgMarks.forEach(function(el) { el.classList.remove('cw-msg-hl', 'cw-msg-hl-active'); });
    cwMsgMarks = []; cwMsgIdx = -1;
  }
  function clearMarks() {
    cwMarks.forEach(function(mk) {
      var p = mk.parentNode;
      if (p) { p.replaceChild(document.createTextNode(mk.textContent), mk); p.normalize(); }
    });
    cwMarks = []; cwIdx = -1;
    if (_deHighlighted) { _deHighlighted = false; highlightAll(); }
    clearMsgMarks();
  }
  function setActiveMsg(idx) {
    cwMsgMarks.forEach(function(el, ii) {
      el.classList.toggle('cw-msg-hl-active', ii === idx);
      el.classList.toggle('cw-msg-hl', ii !== idx);
    });
    if (cwMsgMarks[idx]) { cwScrollTo(cwMsgMarks[idx]); }
    srchCounter.textContent = cwMsgMarks.length > 0
      ? (idx + 1) + ' / ' + cwMsgMarks.length + ' message' + (cwMsgMarks.length === 1 ? '' : 's')
      : 'No matches';
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
    // Inline mark removal without re-highlighting (avoids unnecessary highlight/de-highlight cycle)
    cwMarks.forEach(function(mk) {
      var p = mk.parentNode;
      if (p) { p.replaceChild(document.createTextNode(mk.textContent), mk); p.normalize(); }
    });
    cwMarks = []; cwIdx = -1;
    clearMsgMarks();
    if (!query) {
      _pendingSearchQuery = null;
      if (_deHighlighted) { _deHighlighted = false; highlightAll(); }
      srchCounter.textContent = '';
      return;
    }
    // A search restricted to the initially loaded excerpt of a long chat is
    // useless: pull in every message first, then re-run this query on the
    // complete transcript (finishLoadAll does that when the last batch lands).
    if (_hasMore) {
      _pendingSearchQuery = query;
      srchCounter.textContent = 'Loading all messages\\u2026';
      startLoadAll();
      if (_loadingAll) { return; }
      _pendingSearchQuery = null;
    }
    dehighlightCode(); // flatten spans so multi-word searches work across tokens

    // Stage 1: exact regex match within text nodes (works for single-line content)
    var rx;
    if (useRegex) {
      try { rx = new RegExp(query, 'gi'); } catch (err) { srchCounter.textContent = 'Invalid regex'; return; }
    } else {
      var rxPat = wholeWord ? '\\\\b' + escRx(query) + '\\\\b' : escRx(query);
      rx = new RegExp(rxPat, 'gi');
    }
    document.querySelectorAll('.message-body').forEach(function(body) { walkBody(body, rx); });
    if (cwMarks.length > 0) { cwIdx = 0; setActive(cwIdx); return; }

    // Stage 2: whitespace-collapse match — uses the raw source content stored in data-raw
    // (avoids markdown rendering artefacts such as list markers lost from innerText).
    // Both query and content are normalised to single spaces before comparing.
    var normQuery = useRegex ? query : query.trim().replace(/\\s+/g, ' ').toLowerCase();
    var normQueryRx;
    if (useRegex) {
      try { normQueryRx = new RegExp(normQuery, 'i'); } catch (e) { normQueryRx = null; }
    } else {
      normQueryRx = wholeWord ? new RegExp('\\\\b' + escRx(normQuery) + '\\\\b', 'i') : null;
    }
    document.querySelectorAll('.message-body').forEach(function(body) {
      var raw = (body.dataset && body.dataset.raw !== undefined)
        ? body.dataset.raw
        : (body.innerText !== undefined ? body.innerText : (body.textContent || ''));
      var normBody = raw.replace(/\\s+/g, ' ').trim().toLowerCase();
      var matched = normQueryRx ? normQueryRx.test(normBody) : normBody.indexOf(normQuery) !== -1;
      if (matched) { cwMsgMarks.push(body); }
    });
    if (cwMsgMarks.length > 0) { cwMsgIdx = 0; setActiveMsg(cwMsgIdx); return; }

    srchCounter.textContent = 'No matches';
  }
  function navSearch(dir) {
    if (cwMarks.length > 0) {
      cwIdx = (cwIdx + dir + cwMarks.length) % cwMarks.length;
      setActive(cwIdx);
    } else if (cwMsgMarks.length > 0) {
      cwMsgIdx = (cwMsgIdx + dir + cwMsgMarks.length) % cwMsgMarks.length;
      setActiveMsg(cwMsgIdx);
    }
  }
  srchInput.addEventListener('input',   function() { runSearch(srchInput.value); });
  srchPrev.addEventListener('click',    function() { navSearch(-1); });
  srchNext.addEventListener('click',    function() { navSearch(1); });
  srchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { navSearch(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === 'Escape') { srchInput.value = ''; runSearch(''); }
  });
  srchWholeWord.addEventListener('click', function() {
    wholeWord = !wholeWord;
    srchWholeWord.classList.toggle('cw-active', wholeWord);
    srchWholeWord.setAttribute('aria-pressed', String(wholeWord));
    runSearch(srchInput.value);
  });
  srchRegex.addEventListener('click', function() {
    useRegex = !useRegex;
    srchRegex.classList.toggle('cw-active', useRegex);
    srchRegex.setAttribute('aria-pressed', String(useRegex));
    // whole-word is meaningless inside a regex — disable it
    if (useRegex && wholeWord) {
      wholeWord = false;
      srchWholeWord.classList.remove('cw-active');
      srchWholeWord.setAttribute('aria-pressed', 'false');
    }
    runSearch(srchInput.value);
  });
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      // Ctrl+F means "find in this chat" — make sure the whole transcript is
      // loaded, otherwise the search would only cover the initial excerpt.
      if (_hasMore && !_loadingAll) {
        srchCounter.textContent = 'Loading all messages\\u2026';
        startLoadAll();
      }
      srchInput.focus();
      srchInput.select();
    }
    if (e.altKey && e.key === 'w') {
      e.preventDefault();
      srchWholeWord.click();
    }
    if (e.altKey && e.key === 'r') {
      e.preventDefault();
      srchRegex.click();
    }
  });

  // ── Entity dropdowns ───────────────────────────────────────────────────────
  // Always-visible one-line row: Entities [type] [entity].
  // 1st dropdown: entity type (already sorted alphabetically by the host).
  // 2nd dropdown: the values of the selected type (also pre-sorted by the host).
  // Choosing a value reuses the search bar: the term is typed in and searched,
  // which scrolls the reader to the first occurrence.
  var entTypeSel   = document.getElementById('entity-type-select');
  var entValueSel  = document.getElementById('entity-value-select');
  var _entityGroups = [];
  function addPlaceholderOption(sel, text) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = text;
    sel.appendChild(opt);
  }
  function populateEntityValues() {
    if (!entTypeSel || !entValueSel) { return; }
    var group = _entityGroups[parseInt(entTypeSel.value, 10)];
    var items = group ? group.items : [];
    entValueSel.innerHTML = '';
    entValueSel.disabled = items.length === 0;
    if (items.length === 0) {
      addPlaceholderOption(entValueSel, '\\u2014');
      return;
    }
    addPlaceholderOption(entValueSel, 'Select an entity\\u2026');
    items.forEach(function(item, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = item;
      opt.title = item;
      entValueSel.appendChild(opt);
    });
  }
  function renderEntityDropdowns(groups) {
    _entityGroups = (groups || []).filter(function(g) {
      return !!g && !!g.items && g.items.length > 0;
    });
    if (!entTypeSel) { return; }
    entTypeSel.innerHTML = '';
    if (_entityGroups.length === 0) {
      addPlaceholderOption(entTypeSel, 'No entities');
      entTypeSel.disabled = true;
      populateEntityValues();
      return;
    }
    entTypeSel.disabled = false;
    _entityGroups.forEach(function(g, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = g.label;
      entTypeSel.appendChild(opt);
    });
    entTypeSel.value = '0';
    populateEntityValues();
  }
  function searchForEntity(value) {
    if (!value) { return; }
    srchInput.value = value;
    srchCounter.textContent = '';
    runSearch(value);
  }
  if (entTypeSel) { entTypeSel.addEventListener('change', populateEntityValues); }
  if (entValueSel) {
    entValueSel.addEventListener('change', function() {
      if (!entTypeSel) { return; }
      var group = _entityGroups[parseInt(entTypeSel.value, 10)];
      var idx   = parseInt(entValueSel.value, 10);
      if (!group || isNaN(idx) || group.items[idx] === undefined) { return; }
      searchForEntity(group.items[idx]);
    });
  }

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
      if (el) {
        // Use data-fence-idx to reliably locate the correct fenced code block
        var fencedPres = Array.from(el.querySelectorAll('pre[data-fence-idx]'));
        if (fencedPres.length > 0) {
          var idx = (p.targetBlockIdx !== null && p.targetBlockIdx !== undefined) ? p.targetBlockIdx : 0;
          var target = fencedPres[idx] || fencedPres[0];
          if (p.highlightColor) { target.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }
          cwScrollTo(target);
          return;
        }
        cwScrollTo(el); return;
      }
    }
    // Fallback: scroll to first fenced code block in the document (group-level click)
    var pres = Array.from(document.querySelectorAll('pre[data-fence-idx]'));
    if (pres.length === 0) { pres = Array.from(document.querySelectorAll('pre')); }
    if (p.highlightColor) { pres.forEach(function(x) { x.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }); }
    if (p.shouldScroll && pres.length > 0) { cwScrollTo(pres[0]); }
  }

  // ── DOM helpers for appending/prepending message chunks ───────────────────
  var container = document.getElementById('messages-container');

  function appendHtml(html, bulk) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    // Bulk (load-all) appends filter only the incoming nodes and skip the
    // whole-document bookmark pass — finishLoadAll applies both once at the end.
    if (bulk) { applyRoleFilterTo(tmp); }
    while (tmp.firstChild) { container.appendChild(tmp.firstChild); }
    highlightAll();
    if (!bulk) {
      applyRoleFilter();
      updateBookmarksUI();
    }
  }

  // Try to find and highlight the pending prompt in the DOM.
  // If not found and more messages are available, request another batch.
  function tryHighlightMsg() {
    if (!_pendingHighlight) { return; }
    var needle = _pendingHighlight.replace(/\\s+/g, ' ').trim().toLowerCase();
    var matchEl = null;
    document.querySelectorAll('.message.user').forEach(function(msgEl) {
      if (matchEl) { return; }
      var body = msgEl.querySelector('.message-body');
      var raw = body ? ((body.dataset && body.dataset.raw !== undefined)
        ? body.dataset.raw
        : (body.innerText !== undefined ? body.innerText : (body.textContent || ''))) : '';
      var normBody = raw.replace(/\\s+/g, ' ').trim().toLowerCase();
      if (normBody.indexOf(needle) !== -1) { matchEl = msgEl; }
    });
    if (matchEl) {
      _pendingHighlight = null;
      clearMsgMarks();
      matchEl.classList.add('cw-msg-hl-active');
      cwMsgMarks.push(matchEl);
      cwMsgIdx = 0;
      cwScrollTo(matchEl);
    } else if (_hasMore && _loadingAll) {
      // A full load-all is already streaming every message in — just wait for the
      // next appendChunk instead of requesting (and interleaving) another batch.
      return;
    } else if (_hasMore) {
      // Target not yet loaded — request next batch
      _loadingMore = true;
      vscode.postMessage({ type: 'loadMoreMessages' });
    } else {
      // All messages loaded, target not found
      _pendingHighlight = null;
    }
  }

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'render') {
      var titleNode = document.getElementById('session-title');
      titleNode.textContent = data.title;
      titleNode.dataset.cwSessionId = data.sessionId;
      var summaryEl = document.getElementById('session-summary');
      if (summaryEl) {
        if (data.summary) {
          summaryEl.textContent = data.summary;
          summaryEl.style.display = 'block';
        } else {
          summaryEl.textContent = '';
          summaryEl.style.display = 'none';
        }
      }
      document.documentElement.style.setProperty('--cw-user-color', data.userColor || '#007acc');
      if (data.source) {
        var srcLabel = data.assistantLabel || data.source;
        var respLabelEl = document.getElementById('filter-responses-label');
        if (respLabelEl) { respLabelEl.textContent = srcLabel; }
      }
      var metaEl      = document.getElementById('session-meta');
      var dateField   = document.getElementById('session-date-field');
      var dateEl      = document.getElementById('session-date');
      var dateSep     = document.getElementById('session-date-sep');
      var modelField  = document.getElementById('session-model-field');
      var modelEl     = document.getElementById('session-model');
      var reqField    = document.getElementById('session-req-field');
      var reqEl       = document.getElementById('session-user-req');
      var sepEl       = document.getElementById('session-meta-sep');
      var branchField = document.getElementById('session-branch-field');
      var branchEl    = document.getElementById('session-branch');
      var branchSep   = document.getElementById('session-branch-sep');
      var removedField = document.getElementById('session-removed-field');
      var removedCount = document.getElementById('session-removed-count');
      var removedSep   = document.getElementById('session-removed-sep');
      var showModel   = data.model && data.model !== 'Unknown';
      var showReq     = data.userRequestCount !== undefined;
      var showBranch  = !!data.branch;
      var showDate    = !!data.createdAt;
      // Feature 51 — "Removed: N turns · original full conversation"
      var removedN    = data.removedTurnCount || 0;
      var showRemoved = removedN > 0;
      if (metaEl && (showModel || showReq || showBranch || showDate || showRemoved)) {
        if (showDate && dateField && dateEl) {
          var d = new Date(data.createdAt);
          dateEl.textContent = isNaN(d.getTime()) ? data.createdAt : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
          dateField.style.display = 'inline';
        }
        if (showModel && modelField && modelEl) {
          modelEl.textContent = data.model;
          modelField.style.display = 'inline';
        }
        if (showReq && reqField && reqEl) {
          reqEl.textContent = data.userRequestCount;
          reqField.style.display = 'inline';
        }
        if (showBranch && branchField && branchEl) {
          branchEl.textContent = data.branch;
          branchField.style.display = 'inline';
        }
        if (showRemoved && removedField && removedCount) {
          removedCount.textContent = removedN + (removedN === 1 ? ' turn' : ' turns');
          removedField.style.display = 'inline';
        } else if (removedField) {
          removedField.style.display = 'none';
        }
        if (removedSep) {
          var beforeRemoved = (showModel ? 1 : 0) + (showReq ? 1 : 0) + (showBranch ? 1 : 0) + (showDate ? 1 : 0);
          removedSep.style.display = (showRemoved && beforeRemoved >= 1) ? 'inline' : 'none';
        }
        if (dateSep) { dateSep.style.display = (showDate && ((showModel ? 1 : 0) + (showReq ? 1 : 0) + (showBranch ? 1 : 0) >= 1)) ? 'inline' : 'none'; }
        if (sepEl) {
          var visibleCount = (showModel ? 1 : 0) + (showReq ? 1 : 0) + (showBranch ? 1 : 0) + (showDate ? 1 : 0);
          sepEl.style.display = visibleCount >= 2 ? 'inline' : 'none';
        }
        metaEl.style.display = 'block';
      }
      // Tags chips
      var tagsEl = document.getElementById('session-tags');
      if (tagsEl) {
        if (data.tags && data.tags.length > 0) {
          tagsEl.innerHTML = data.tags.map(function(t) {
            var c = cwTagColor(t);
            return '<span class="cw-tag-chip" style="color:' + c + '">#' + escH(t) + '</span>';
          }).join('');
          tagsEl.style.display = 'block';
        } else {
          tagsEl.innerHTML = '';
          tagsEl.style.display = 'none';
        }
      }
      // Entities row — always visible: Entities [type] [entity]
      renderEntityDropdowns(data.entityGroups || []);
      // Status chip
      var statusEl = document.getElementById('session-status');
      if (data.status) {
        var statusLabel = data.status === 'resolved' ? '\u2713 Resolved' : data.status === 'revisit' ? '\u27F2 Revisit' : '\u25CB Open';
        if (statusEl) { statusEl.textContent = statusLabel; statusEl.style.display = 'inline'; }
      } else if (statusEl) {
        statusEl.style.display = 'none';
      }
      // Initialize bookmarks and annotations
      if (data.bookmarks) { _bookmarks = data.bookmarks; }
      if (data.annotations) { _annotations = data.annotations; }
      // Feature 51 — removal needs the chat DB; the previous selection is gone
      // with the old DOM.
      _selectedMsgEl = null;
      _ctxMsgEl = null;
      document.body.classList.toggle('cw-no-remove', !data.canRemove);
      container.innerHTML = data.messagesHtml;
      updateBookmarksUI();
      // Render annotations for bookmarked messages
      _annotations.forEach(function(a) {
        var msgEl = document.querySelector('[data-msg-idx="' + a.messageIndex + '"]');
        if (!msgEl) { return; }
        // Remove existing block if any
        var existingBlock = msgEl.querySelector('.cw-annotation-block');
        if (existingBlock) { existingBlock.remove(); }
        var tmp = document.createElement('div');
        tmp.innerHTML = renderAnnotationBlock(a);
        while (tmp.firstChild) { msgEl.appendChild(tmp.firstChild); }
      });

      // Informational source notes (e.g. Cursor aiService-only recovery) — not parse failures
      if (data.sourceNotes && data.sourceNotes.length > 0) {
        var noteBanner = document.createElement('div');
        noteBanner.className = 'source-notes-banner';
        noteBanner.innerHTML =
          '<strong>About this session</strong>' +
          (data.filePath ? ' &mdash; <span class="parse-error-path">' + escH(data.filePath) + '</span>' : '') +
          '<ul style="margin:6px 0 0;padding-left:1.5em">' +
          data.sourceNotes.map(function(n) { return '<li>' + escH(n) + '</li>'; }).join('') +
          '</ul>';
        container.insertBefore(noteBanner, container.firstChild);
      }
      // Parse-errors banner — real read/parse failures only
      if (data.parseErrors && data.parseErrors.length > 0) {
        var banner = document.createElement('div');
        banner.className = 'parse-errors-banner';
        var errItems = data.parseErrors.map(function(e) {
          return '<li>' + escH(e) + '</li>';
        }).join('');
        banner.innerHTML =
          '&#9888; <strong>Parse errors in this session</strong>' +
          (data.filePath ? ' &mdash; <span class="parse-error-path">' + escH(data.filePath) + '</span>' : '') +
          '<ul>' + errItems + '</ul>';
        container.insertBefore(banner, container.firstChild);
      }

      highlightAll();

      _hasMore     = !!data.hasMore;
      _loadingMore = false;
      _loadingAll  = false;
      _pendingSearchQuery = null;
      updateLoadMoreButton();
      updateLoadAllButton();

      clearMarks();
      // Pre-fill the input now so the user sees the pending term immediately;
      // runSearch() is deferred to the cwSearch message which arrives after all
      // appendChunk messages have been processed (full window in DOM).
      if (data.term) { srchInput.value = data.term; srchCounter.textContent = ''; }
      else           { srchInput.value = ''; srchCounter.textContent = ''; }

    }

    if (data.type === 'cwSearch') {
      // Arrives after all initial appendChunk messages — full window is in DOM.
      if (data.term) { srchInput.value = data.term; runSearch(data.term); }
    }

    if (data.type === 'cwHighlightMsg') {
      // Highlight the full user message container (no text marks) — used when opening from Prompt Library.
      // If the target is not yet in the DOM (beyond the initial batch), auto-load more batches.
      clearMarks();
      if (!data.term) { return; }
      // Prefill search bar with a truncated version for context
      var displayTerm = data.term.replace(/\\s+/g, ' ').trim();
      if (displayTerm.length > 80) { displayTerm = displayTerm.substring(0, 80) + '\\u2026'; }
      srchInput.value = displayTerm;
      srchCounter.textContent = '';
      _pendingHighlight = data.term;
      tryHighlightMsg();
    }

    if (data.type === 'appendChunk') {
      appendHtml(data.messagesHtml, !!data.loadAll);
      _hasMore = !!data.hasMore;
      if (!_loadingAll) { _loadingMore = false; }
      updateLoadMoreButton();
      updateLoadAllButton();
      // Re-try pending highlight after new messages are in DOM
      if (_pendingHighlight) { tryHighlightMsg(); }
      // Final batch of a load-all: release the spinner and re-run the search
      if (_loadingAll && !_hasMore) { finishLoadAll(); }
    }

    if (data.type === 'loadAllDone') {
      // Host-side terminator: also covers the "nothing left to load" case and
      // guarantees the spinner is cleared even if the last chunk was dropped.
      _hasMore = !!data.hasMore;
      finishLoadAll();
    }

    if (data.type === 'annotationUpdated') {
      _annotations = data.annotations || [];
      // Render annotation blocks
      _annotations.forEach(function(a) {
        var msgEl = document.querySelector('[data-msg-idx="' + a.messageIndex + '"]');
        if (!msgEl) { return; }
        // Remove existing block if any
        var existingBlock = msgEl.querySelector('.cw-annotation-block');
        if (existingBlock) { existingBlock.remove(); }
        // Remove any open editor
        var editor = msgEl.querySelector('.cw-annotation-editor');
        if (editor) { editor.remove(); }
        // Insert new block
        var tmp = document.createElement('div');
        tmp.innerHTML = renderAnnotationBlock(a);
        while (tmp.firstChild) { msgEl.appendChild(tmp.firstChild); }
      });
    }

    if (data.type === 'bookmarkUpdated') {
      _bookmarks = data.bookmarks || [];
      // Update bookmark button states
      document.querySelectorAll('.cw-bookmark-btn').forEach(function(btn) {
        var idx = parseInt(btn.dataset.msgOrigIdx);
        var isBookmarked = _bookmarks.some(function(b) { return b.messageIndex === idx; });
        btn.classList.toggle('cw-active', isBookmarked);
      });
      // Update bookmarks section
      var bmSection = document.getElementById('bookmarks-section');
      if (_bookmarks.length > 0) {
        var list = document.getElementById('bookmarks-list');
        list.innerHTML = _bookmarks.map(function(b) {
          var label = b.note ? escH(b.note) : 'Message #' + b.messageIndex;
          return '<div class="bookmark-item" data-bm-idx="' + b.messageIndex + '">' +
            '<span class="bm-marker">&#9733;</span>' +
            '<span class="bm-note">' + label + '</span>' +
            '<span class="bm-date">' + new Date(b.createdAt).toLocaleDateString() + '</span>' +
          '</div>';
        }).join('');
        bmSection.style.display = 'block';
      } else {
        bmSection.style.display = 'none';
      }
    }

    if (data.type === 'cwScroll') {
      // Double rAF: first frame lets the browser apply any pending layout from
      // appended chunks, second frame ensures paint is complete before measuring.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { cwDoScroll(data); });
      });
    }
  });

  // ── Click delegation for annotation buttons ────────────────────────────
  document.addEventListener('click', function(e) {
    // Annotation add button
    var addBtn = e.target && e.target.closest ? e.target.closest('.cw-annotation-btn') : null;
    if (addBtn) {
      e.stopPropagation();
      var msgIdx = parseInt(addBtn.dataset.msgOrigIdx);
      // Check if annotation already exists
      var existingAn = _annotations.find(function(a) { return a.messageIndex === msgIdx; });
      openAnnotationEditor(msgIdx, existingAn ? existingAn.text : '');
      return;
    }
    // Annotation edit button
    var editBtn = e.target && e.target.closest ? e.target.closest('.cw-annotation-edit-btn') : null;
    if (editBtn) {
      e.stopPropagation();
      var msgIdx2 = parseInt(editBtn.dataset.msgIdx);
      var existingAn2 = _annotations.find(function(a) { return a.messageIndex === msgIdx2; });
      openAnnotationEditor(msgIdx2, existingAn2 ? existingAn2.text : '');
      return;
    }
    // Annotation delete button
    var delBtn = e.target && e.target.closest ? e.target.closest('.cw-annotation-delete-btn') : null;
    if (delBtn) {
      e.stopPropagation();
      var msgIdx3 = parseInt(delBtn.dataset.msgIdx);
      vscode.postMessage({ type: 'deleteAnnotation', messageIndex: msgIdx3 });
      return;
    }
    // Bookmark button
    var bmBtn = e.target && e.target.closest ? e.target.closest('.cw-bookmark-btn') : null;
    if (bmBtn) {
      e.stopPropagation();
      var bmIdx = parseInt(bmBtn.dataset.msgOrigIdx);
      vscode.postMessage({ type: 'bookmarkMessage', messageIndex: bmIdx });
      return;
    }
  });

  // Signal ready — extension host will send the 'render' payload
  vscode.postMessage({ type: 'ready' });
  } catch(err) {
    vscode.postMessage({ type: 'iife-error', message: String(err) });
  }
})();
</script>
</body>
</html>`;
    }

    // ── Bookmark toggle handler ──────────────────────────────────────────────

    static async _toggleBookmark(sessionId: string, messageIndex: number): Promise<void> {
        const store = SessionWebviewPanel._sidecarStore;
        if (!store) { return; }

        await store.toggleBookmark(sessionId, messageIndex);

        // Notify the index to refresh its sidecar cache
        SessionWebviewPanel._onSidecarChanged?.(sessionId);

        // Send updated bookmarks list to all panels for this session
        const panel = SessionWebviewPanel._panels.get(sessionId);
        if (panel) {
            const bookmarks = await store.getBookmarks(sessionId);
            void panel.webview.postMessage({
                type: 'bookmarkUpdated',
                bookmarks: bookmarks.map(b => ({
                    messageIndex: b.messageIndex,
                    note: b.note || null,
                    createdAt: b.createdAt,
                })),
            });
        }
    }

    // ── Annotation handlers ──────────────────────────────────────────────────

    static async _saveAnnotation(sessionId: string, messageIndex: number, text: string): Promise<void> {
        const store = SessionWebviewPanel._sidecarStore;
        if (!store) { return; }

        const annotation: import('../types/index').MessageAnnotation = {
            messageIndex,
            text,
            createdAt: new Date().toISOString(),
        };
        await store.upsertAnnotation(sessionId, annotation);

        // Notify the index to refresh its sidecar cache
        SessionWebviewPanel._onSidecarChanged?.(sessionId);

        // Send updated annotation state to all panels for this session
        const panel = SessionWebviewPanel._panels.get(sessionId);
        if (panel) {
            const annotations = await store.getAnnotations(sessionId);
            void panel.webview.postMessage({
                type: 'annotationUpdated',
                annotations: annotations.map(a => ({
                    messageIndex: a.messageIndex,
                    text: a.text,
                    createdAt: a.createdAt,
                    updatedAt: a.updatedAt || null,
                })),
            });
        }
    }

    static async _deleteAnnotation(sessionId: string, messageIndex: number): Promise<void> {
        const store = SessionWebviewPanel._sidecarStore;
        if (!store) { return; }

        await store.removeAnnotation(sessionId, messageIndex);

        // Notify the index to refresh its sidecar cache
        SessionWebviewPanel._onSidecarChanged?.(sessionId);

        const panel = SessionWebviewPanel._panels.get(sessionId);
        if (panel) {
            const annotations = await store.getAnnotations(sessionId);
            void panel.webview.postMessage({
                type: 'annotationUpdated',
                annotations: annotations.map(a => ({
                    messageIndex: a.messageIndex,
                    text: a.text,
                    createdAt: a.createdAt,
                    updatedAt: a.updatedAt || null,
                })),
            });
        }
    }

    // ── Feature 51 — turn removal & original conversation ────────────────────

    /**
     * Removes a single turn from the conversation, persists the decision in the
     * chat DB and re-renders the reader.
     *
     * The message stays in `session.messages` (flagged `removed`) so every
     * index-based reference — bookmarks, annotations, code blocks, action items —
     * keeps pointing at the right turn. Its bookmark / annotation are dropped
     * because they no longer describe anything visible.
     */
    static async _removeTurn(sessionId: string, messageIndex: number): Promise<void> {
        const st = SessionWebviewPanel._panelState.get(sessionId);
        if (!st) { return; }

        const message = st.session.messages[messageIndex];
        if (!message || message.removed) { return; }

        const store = SessionWebviewPanel._cacheStore;
        if (!store) {
            void vscode.window.showWarningMessage(
                'Chat Wizard: removing a turn needs the persistent cache ' +
                '(chatwizard.enablePersistentCache), because the removal is stored in the chat database.'
            );
            return;
        }

        try {
            store.removeTurn(sessionId, messageIndex, message);
        } catch (err) {
            const text = `[ChatWizard] Could not remove turn ${messageIndex} of session ${sessionId}: ${err}`;
            SessionWebviewPanel._channel?.appendLine(text);
            console.error(text);
            void vscode.window.showErrorMessage('Chat Wizard: the turn could not be removed (chat DB error).');
            return;
        }

        message.removed = true;

        // The turn's bookmark / annotation described a turn that is gone.
        const sidecar = SessionWebviewPanel._sidecarStore;
        if (sidecar) {
            try {
                await sidecar.removeBookmark(sessionId, messageIndex);
                await sidecar.removeAnnotation(sessionId, messageIndex);
                SessionWebviewPanel._onSidecarChanged?.(sessionId);
            } catch (err) {
                SessionWebviewPanel._channel?.appendLine(
                    `[ChatWizard] Could not drop sidecar refs for turn ${messageIndex}: ${err}`
                );
            }
        }

        // Refresh the index (invalidates its prompt/code-block caches and
        // re-persists the session without the removed turn's indexed content).
        SessionWebviewPanel._onSessionMutated?.(st.session);

        await SessionWebviewPanel._rerender(sessionId);
    }

    /**
     * Rebuilds the whole reader window from the current session state.
     *
     * Used after a turn is removed: the render cache is keyed on
     * `updatedAt` (unchanged by a removal), so the per-message HTML must be
     * rebuilt against the new visible-message list.
     */
    private static async _rerender(sessionId: string): Promise<void> {
        const st = SessionWebviewPanel._panelState.get(sessionId);
        if (!st) { return; }

        const { session, panel } = st;
        const visibleMessages: VisibleMessage[] = session.messages
            .map((msg, origIdx) => ({
                msg,
                origIdx,
                nextRemoved: session.messages[origIdx + 1]?.removed === true,
            }))
            .filter(({ msg }) => !msg.removed && (msg.content.trim() !== '' || !!msg.skipped));

        const total = visibleMessages.length;
        const renderedMessages = new Array<string | null>(total).fill(null);
        SessionWebviewPanel._renderCacheSet(`${session.id}::${session.updatedAt}`, renderedMessages);

        const config = vscode.workspace.getConfiguration('chatwizard');
        const userColor = config.get<string>('userMessageColor', '#007acc') || '#007acc';

        const version = st.streamVersion + 1;
        SessionWebviewPanel._panelState.set(sessionId, {
            ...st,
            visibleMessages,
            renderedMessages,
            windowStart: 0,
            windowEnd: Math.min(INITIAL_WINDOW, total),
            streamVersion: version,
            panel,
            // A bookmark / note attached to the turn we just removed must not
            // linger in the jump list or as an inline block.
            bookmarks: st.bookmarks?.filter(b => !session.messages[b.messageIndex]?.removed),
            annotations: st.annotations?.filter(a => !session.messages[a.messageIndex]?.removed),
        });

        await SessionWebviewPanel._startStream(
            sessionId,
            version,
            userColor,
            undefined,
            { targetMsgIdx: null, targetBlockIdx: null, highlightColor: null, shouldScroll: false }
        );
    }

    /**
     * Opens the complete conversation — including every turn the user removed —
     * in a text editor.
     *
     * The file is rebuilt from the chat DB (`messages` + `removed_turns`) and
     * written into the cache storage folder, so it survives restarts and source
     * files being pruned. The link is only offered when at least one turn was
     * removed.
     */
    static async _openOriginalConversation(sessionId: string): Promise<void> {
        const store = SessionWebviewPanel._cacheStore;
        const st = SessionWebviewPanel._panelState.get(sessionId);
        const stored = st?.session;

        let full: Session | undefined;
        try {
            full = store?.getOriginalSession(sessionId) ?? stored;
        } catch (err) {
            SessionWebviewPanel._channel?.appendLine(
                `[ChatWizard] Could not rebuild the original conversation for ${sessionId}: ${err}`
            );
        }
        if (!full) {
            void vscode.window.showErrorMessage('Chat Wizard: the original conversation is not available.');
            return;
        }

        const removedCount = store?.getRemovedTurnCount(sessionId)
            ?? full.messages.filter(m => m.removed).length;
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const header =
            `<!-- Chat Wizard — original conversation. ${removedCount} turn(s) removed on ${stamp}. -->\n\n` +
            `> **Original conversation.** This is the complete chat as it was before any turn was removed.\n` +
            `> ${removedCount} turn${removedCount === 1 ? '' : 's'} removed in Chat Wizard on ${stamp}.\n\n`;
        const markdown = header + serializeSession(full);

        try {
            const baseDir = store
                ? path.dirname(store.dbPath)
                : (stored ? path.dirname(stored.filePath) : undefined);
            if (!baseDir) { throw new Error('no storage folder available'); }
            const dir = path.join(baseDir, ORIGINAL_CONVERSATIONS_DIR);
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(
                dir,
                `${SessionWebviewPanel._safeFilePart(full.title)}-${SessionWebviewPanel._safeFilePart(full.id)}.md`
            );
            await fs.promises.writeFile(file, markdown, 'utf-8');
            await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        } catch (err) {
            const text = `[ChatWizard] Could not open the original conversation for ${sessionId}: ${err}`;
            SessionWebviewPanel._channel?.appendLine(text);
            console.error(text);
            void vscode.window.showErrorMessage('Chat Wizard: the original conversation could not be written.');
        }
    }

    /** Minimal filename-safe slug for the generated original-conversation file. */
    private static _safeFilePart(text: string): string {
        return (text || 'session')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'session';
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
