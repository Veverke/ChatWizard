// src/index/sessionIndex.ts

import { Session, SessionSummary, Prompt, SessionSource, IndexedCodeBlock } from '../types/index';

export type SessionIndexEvent =
    | { type: 'upsert'; session: Session }
    | { type: 'remove'; sessionId: string }
    | { type: 'batch'; sessions: Session[] };

/**
 * Convert a full Session to a lightweight SessionSummary.
 * Counts are computed from the messages array; message content is not retained.
 */
export function toSummary(session: Session): SessionSummary {
    const userMessageCount = session.messages.filter(m => m.role === 'user').length;
    const assistantMessageCount = session.messages.filter(m => m.role === 'assistant').length;
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
    };
}

/** Sort comparator: descending by updatedAt (ISO strings sort lexicographically) */
function byUpdatedAtDesc(a: SessionSummary, b: SessionSummary): number {
    return b.updatedAt.localeCompare(a.updatedAt);
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

    constructor() {
        this.sessions = new Map();
    }

    /** Monotonically-increasing counter — incremented on every upsert, remove, or batchUpsert. */
    get version(): number { return this._version; }

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
        }
        this._notifyTyped({ type: 'batch', sessions });
        this._notifyListeners();
    }

    /** Get a full session by id. Returns undefined if not found. */
    get(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    /** Get all sessions as lightweight summaries, sorted by updatedAt descending. */
    getAllSummaries(): SessionSummary[] {
        return Array.from(this.sessions.values())
            .map(toSummary)
            .sort(byUpdatedAtDesc);
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

    /** Remove all sessions from the index. */
    clear(): void {
        this.sessions.clear();
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
