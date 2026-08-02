// src/index/sessionIndex.ts

import { Session, SessionSummary, Prompt, SessionSource, IndexedCodeBlock, ChronicleData, SessionMetadata } from '../types/index';
import type { SidecarMetadataStore } from './sidecarMetadataStore';

export type SessionIndexEvent =
    | { type: 'upsert'; session: Session }
    | { type: 'remove'; sessionId: string }
    | { type: 'batch'; sessions: Session[] }
    | { type: 'clear' };

/**
 * Convert a full Session to a lightweight SessionSummary.
 * Counts are computed from the messages array; message content is not retained.
 */
/** Lightweight token estimate: word count divided by 4 (GPT-style approximation). */
function estimateTokens(text: string): number {
    // Split on whitespace — fast and allocation-minimal
    let count = 0;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        const ws = ch === 32 || ch === 9 || ch === 10 || ch === 13;
        if (!ws && !inWord) { count++; inWord = true; }
        else if (ws) { inWord = false; }
    }
    return Math.ceil(count / 4);
}

export function toSummary(session: Session): SessionSummary {
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let userTokens = 0;
    let assistantTokens = 0;

    for (const m of session.messages) {
        if (m.role === 'user') {
            userMessageCount++;
            userTokens += estimateTokens(m.content);
        } else {
            assistantMessageCount++;
            assistantTokens += estimateTokens(m.content);
        }
    }

    const lastMsg = session.messages[session.messages.length - 1];
    const interrupted = lastMsg?.role === 'user' ? true : undefined;

    return {
        id: session.id,
        title: session.title,
        source: session.source,
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        model: session.model,
        filePath: session.filePath,
        fileSizeBytes: session.fileSizeBytes,
        messageCount: session.messages.length,
        userMessageCount,
        assistantMessageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        interrupted,
        hasParseErrors: (session.parseErrors?.length ?? 0) > 0 || undefined,
        archived: session.archived || undefined,
        userArchived: session.userArchived || undefined,
        userTokens,
        assistantTokens,
        branch: session.gitContext?.branch ?? session.chronicleData?.branch ?? undefined,
    };
}

/** Sort comparator: descending by updatedAt (ISO strings sort lexicographically) */
function byUpdatedAtDesc(a: SessionSummary, b: SessionSummary): number {
    if (b.updatedAt > a.updatedAt) { return 1; }
    if (b.updatedAt < a.updatedAt) { return -1; }
    return 0;
}

/**
 * In-memory index of chat sessions.
 * Stores full Session objects keyed by session id and exposes
 * query helpers that return lightweight SessionSummary objects.
 */
export class SessionIndex {
    private sessions: Map<string, Session>;
    private _changeListeners: (() => void)[] = [];
    private _typedChangeListeners: ((event: SessionIndexEvent) => void)[] = [];
    private _version = 0;
    private _codeBlockCache: IndexedCodeBlock[] | null = null;
    private _promptCache: Prompt[] | null = null;
    private _summaryCache: SessionSummary[] | null = null;
    /** Preloaded sidecar metadata — set by `setSidecarCache()` after async load */
    private _sidecarCache: Map<string, SessionMetadata> | null = null;
    private _sidecarStore: SidecarMetadataStore | null = null;
    /** Debounce handle — plain change listeners are coalesced within a 0 ms task boundary. */
    private _notifyDebounce: ReturnType<typeof setTimeout> | null = null;

    /** Session retention: suppress sessions older than this many days (0 = no limit) */
    private _retentionDays = 0;

    constructor() {
        this.sessions = new Map();
    }

    /**
     * Set the session retention window (days). When > 0, sessions older than
     * this number of days are excluded from getAllSummaries(), search, and analytics.
     * Source files are never touched. Pass 0 to disable filtering.
     */
    setRetentionDays(days: number): void {
        const prev = this._retentionDays;
        this._retentionDays = Math.max(0, Math.round(days));
        if (prev !== this._retentionDays) {
            this._invalidateCaches();
            this._notifyListeners();
        }
    }

    /** Returns true when a session falls within the current retention window. */
    private _isWithinRetention(updatedAt: string): boolean {
        if (this._retentionDays === 0) { return true; }
        const cutoff = Date.now() - this._retentionDays * 86_400_000;
        const sessionTime = new Date(updatedAt).getTime();
        return !isNaN(sessionTime) && sessionTime >= cutoff;
    }

    /** Monotonically-increasing counter — incremented on every upsert, remove, or batchUpsert. */
    get version(): number { return this._version; }

    /**
     * Wires in the sidecar metadata store.
     * Call `store.load()` first, then pass the resulting Map here so the store
     * is immediately available for sync title/pin lookups.
     */
    setSidecarStore(store: SidecarMetadataStore, cache: Map<string, SessionMetadata>): void {
        const prev = this._sidecarCache;
        this._sidecarStore = store;
        this._sidecarCache = cache;
        this._invalidateCaches();

        // Re-index sessions whose effective title changed so the full-text search engine
        // can find them by their new title. We fire a typed 'upsert' event with the session
        // object patched to carry the new title — the engine's existing listener picks it up.
        for (const [sessionId, meta] of cache.entries()) {
            if (!meta.customTitle) { continue; }
            const session = this.sessions.get(sessionId);
            if (!session) { continue; }
            const prevTitle = prev?.get(sessionId)?.customTitle ?? session.title;
            if (meta.customTitle !== prevTitle) {
                this._notifyTyped({ type: 'upsert', session: { ...session, title: meta.customTitle } });
            }
        }

        this._notifyListeners();
    }

    /**
     * Returns the effective title for a session, applying any `customTitle` override
     * from the sidecar metadata store.
     */
    getTitleFor(sessionId: string): string | undefined {
        const custom = this._sidecarCache?.get(sessionId)?.customTitle;
        if (custom) { return custom; }
        return this.sessions.get(sessionId)?.title;
    }

    /** Returns the sidecar metadata for a session, if available. */
    getSidecarMeta(sessionId: string): SessionMetadata | undefined {
        return this._sidecarCache?.get(sessionId);
    }

    /**
     * Refreshes a single sidecar metadata entry from the store into the cache.
     * Call this after modifying bookmarks, annotations, ratings, etc. so that
     * subsequent getSidecarMeta() calls return the latest data.
     */
    async refreshSidecarMeta(sessionId: string): Promise<void> {
        if (!this._sidecarStore) { return; }
        const meta = await this._sidecarStore.get(sessionId);
        if (meta && this._sidecarCache) {
            this._sidecarCache.set(sessionId, meta);
        }
    }

    /** Exposes the sidecar store for commands that need to write metadata. */
    get sidecarStore(): SidecarMetadataStore | null {
        return this._sidecarStore;
    }

    addChangeListener(fn: () => void): { dispose: () => void } {
        this._changeListeners.push(fn);
        return { dispose: () => { this._changeListeners = this._changeListeners.filter(l => l !== fn); } };
    }

    addTypedChangeListener(fn: (event: SessionIndexEvent) => void): { dispose: () => void } {
        this._typedChangeListeners.push(fn);
        return { dispose: () => { this._typedChangeListeners = this._typedChangeListeners.filter(l => l !== fn); } };
    }

    private _notifyListeners(): void {
        for (const fn of this._changeListeners) { fn(); }
    }


    private _notifyTyped(event: SessionIndexEvent): void {
        for (const fn of this._typedChangeListeners) { fn(event); }
    }

    private _invalidateCaches(): void {
        this._codeBlockCache = null;
        this._promptCache = null;
        this._summaryCache = null;
    }

    /** Add or replace a session by id. */
    upsert(session: Session): void {
        this.sessions.set(session.id, session);
        this._version++;
        this._invalidateCaches();
        this._notifyTyped({ type: 'upsert', session });
        this._notifyListeners();
    }

    /**
     * Remove a session by id.
     * Returns true if the session existed and was removed, false otherwise.
     */
    remove(sessionId: string): boolean {
        const removed = this.sessions.delete(sessionId);
        if (removed) {
            this._version++;
            this._invalidateCaches();
            this._notifyTyped({ type: 'remove', sessionId });
            this._notifyListeners();
        }
        return removed;
    }

    /**
     * After re-parsing a `state.vscdb`, drop indexed sessions from the same file/source
     * whose ids are no longer present (e.g. old merged `…-cursor-aiservice` vs per-composer ids).
     */
    removeSessionsForStateFileNotIn(filePath: string, source: SessionSource, keepIds: Set<string>): void {
        const toRemove: string[] = [];
        for (const [id, session] of this.sessions) {
            if (session.filePath === filePath && session.source === source && !keepIds.has(id)) {
                toRemove.push(id);
            }
        }
        for (const id of toRemove) {
            this.remove(id);
        }
    }

    /**
     * Insert or replace all sessions in the array, then fire one typed 'batch' event
     * and one plain change notification.
     */
    batchUpsert(sessions: Session[]): void {
        for (const session of sessions) {
            this.sessions.set(session.id, session);
        }
        if (sessions.length > 0) {
            this._version++;
            this._invalidateCaches();
            // Pre-build the summary cache so the first getAllSummaries() call after a bulk
            // load is O(1). The sort cost is paid here (outside any UI hot-path).
            this._buildSummaryCache();
        }
        this._notifyTyped({ type: 'batch', sessions });
        this._notifyListeners();
    }

    /** Get a full session by id. Returns undefined if not found. */
    get(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Attach Chronicle checkpoint data to existing Copilot sessions.
     * Matches by sessionId. Silently ignores IDs that are not in the index.
     */
    mergeChronicleData(entries: Array<{ sessionId: string; data: ChronicleData }>): void {
        let changed = false;
        for (const { sessionId, data } of entries) {
            const session = this.sessions.get(sessionId);
            if (session) {
                this.sessions.set(sessionId, { ...session, chronicleData: data });
                changed = true;
            }
        }
        if (changed) {
            this._version++;
            this._invalidateCaches();
            this._notifyListeners();
        }
    }

    /** Build (or rebuild) the sorted summary cache from current sessions. */
    private _buildSummaryCache(): void {
        this._summaryCache = Array.from(this.sessions.values())
            .filter(s => this._isWithinRetention(s.updatedAt))
            .map(s => {
                const summary = toSummary(s);
                const custom = this._sidecarCache?.get(s.id)?.customTitle;
                return custom ? { ...summary, title: custom } : summary;
            })
            .sort(byUpdatedAtDesc);
    }

    /** Get all sessions as lightweight summaries, sorted by updatedAt descending. */
    getAllSummaries(): SessionSummary[] {
        if (this._summaryCache !== null) { return this._summaryCache; }
        this._buildSummaryCache();
        return this._summaryCache!;
    }

    /** Get summaries filtered to a specific source, sorted by updatedAt descending. */
    getSummariesBySource(source: SessionSource): SessionSummary[] {
        return Array.from(this.sessions.values())
            .filter(s => s.source === source)
            .map(toSummary)
            .sort(byUpdatedAtDesc);
    }

    /** Get summaries filtered to a specific workspaceId, sorted by updatedAt descending. */
    getSummariesByWorkspace(workspaceId: string): SessionSummary[] {
        return Array.from(this.sessions.values())
            .filter(s => s.workspaceId === workspaceId)
            .map(toSummary)
            .sort(byUpdatedAtDesc);
    }

    /**
     * Extract all user-turn prompts across every session.
     * Order is: sessions in insertion order, messages in message order.
     * Result is cached; invalidated on any mutation.
     */
    getAllPrompts(): Prompt[] {
        if (this._promptCache !== null) { return this._promptCache; }
        const prompts: Prompt[] = [];
        for (const session of this.sessions.values()) {
            session.messages.forEach((message, messageIndex) => {
                if (message.role === 'user') {
                    prompts.push({
                        content: message.content,
                        sessionId: session.id,
                        messageIndex,
                        timestamp: message.timestamp,
                    });
                }
            });
        }
        this._promptCache = prompts;
        return prompts;
    }

    /**
     * Extract all fenced code blocks across every session, with session metadata attached.
     * Order: sessions in insertion order, messages in message order, blocks in occurrence order.
     * Result is cached; invalidated on any mutation.
     */
    getAllCodeBlocks(): IndexedCodeBlock[] {
        if (this._codeBlockCache !== null) { return this._codeBlockCache; }
        const blocks: IndexedCodeBlock[] = [];
        for (const session of this.sessions.values()) {
            for (const message of session.messages) {
                for (const block of message.codeBlocks) {
                    blocks.push({
                        language: block.language,
                        content: block.content,
                        sessionId: block.sessionId,
                        messageIndex: block.messageIndex,
                        blockIndexInMessage: block.blockIndexInMessage,
                        messageRole: message.role,
                        sessionTitle: session.title,
                        sessionSource: session.source,
                        sessionUpdatedAt: session.updatedAt,
                        sessionWorkspacePath: session.workspacePath,
                    });
                }
            }
        }
        this._codeBlockCache = blocks;
        return blocks;
    }

    /** Number of indexed code blocks, without allocating a new array. */
    getCodeBlockCount(): number {
        if (this._codeBlockCache !== null) { return this._codeBlockCache.length; }
        let count = 0;
        for (const session of this.sessions.values()) {
            for (const message of session.messages) {
                count += message.codeBlocks.length;
            }
        }
        return count;
    }

    /** Number of sessions currently held in the index. */
    get size(): number {
        return this.sessions.size;
    }

    /** Remove all sessions from the index. Fires a typed 'clear' event and a plain change notification. */
    clear(): void {
        this.sessions.clear();
        this._version++;
        this._invalidateCaches();
        this._notifyTyped({ type: 'clear' });
        this._notifyListeners();
    }

    /**
     * Basic full-text search across sessions.
     *
     * - Case-insensitive substring match against message content.
     * - `searchPrompts`  (default true): search user messages.
     * - `searchResponses` (default true): search assistant messages.
     * - `source`: when provided, only sessions from that source are considered.
     *
     * Returns SessionSummary[] sorted by updatedAt descending.
     */
    search(
        query: string,
        options?: { searchPrompts?: boolean; searchResponses?: boolean; source?: SessionSource }
    ): SessionSummary[] {
        const searchPrompts = options?.searchPrompts !== false;
        const searchResponses = options?.searchResponses !== false;
        const sourceFilter = options?.source;
        const lowerQuery = query.toLowerCase();

        const results: SessionSummary[] = [];

        for (const session of this.sessions.values()) {
            // Apply retention filter
            if (!this._isWithinRetention(session.updatedAt)) {
                continue;
            }

            if (sourceFilter !== undefined && session.source !== sourceFilter) {
                continue;
            }

            const matched = session.messages.some(message => {
                if (message.role === 'user' && !searchPrompts) {
                    return false;
                }
                if (message.role === 'assistant' && !searchResponses) {
                    return false;
                }
                return message.content.toLowerCase().includes(lowerQuery);
            });

            if (matched) {
                results.push(toSummary(session));
            }
        }

        return results.sort(byUpdatedAtDesc);
    }
}
