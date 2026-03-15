// src/search/fullTextEngine.ts

import { Session } from '../types/index';
import { SearchQuery, SearchResult, SearchResponse } from './types';
import { extractSnippet, findFirstMatch } from './snippetExtractor';

/** Maximum number of results returned after the raw match phase (before sort). */
const MAX_RESULTS = 500;

/** Tokens longer than this are typically hashes, base64, or minified code — skip them. */
const MAX_TOKEN_LENGTH = 50;

/** Only promote tokens to the main index once they appear in this many distinct sessions. */
const MIN_DOC_FREQ = 2;

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/\W+/)
        .filter(t => t.length >= 2 && t.length <= MAX_TOKEN_LENGTH);
}

/** Statistics about the current state of the inverted index. */
export interface IndexStats {
    /** Unique tokens in the main inverted index (docFreq ≥ MIN_DOC_FREQ). */
    indexedTokenCount: number;
    /** Tokens seen in exactly 1 session — held in hapax store, not searchable via index. */
    hapaxTokenCount: number;
    /** indexedTokenCount + hapaxTokenCount. */
    totalTokenCount: number;
    /** Total posting entries across all indexed tokens. */
    postingCount: number;
    /** Rough heap estimate in KB (indexed tokens × 50 + postings × 40 + hapax × 90). */
    memoryEstimateKB: number;
}

export class FullTextSearchEngine {
    /** sessionId → Session */
    private readonly sessions = new Map<string, Session>();

    /** token → Set of "sessionId:messageIndex" strings (docFreq ≥ MIN_DOC_FREQ) */
    private readonly invertedIndex = new Map<string, Set<string>>();

    /** sessionId → Set of tokens indexed for that session (reverse map for O(1) removal) */
    private readonly sessionTokens = new Map<string, Set<string>>();

    /** token → set of sessionIds containing it (document-frequency tracking) */
    private readonly tokenDocSessions = new Map<string, Set<string>>();

    /**
     * Single-session tokens not yet promoted to the main index (hapax legomena).
     * These are excluded from search results to keep the main index bounded.
     */
    private readonly hapaxStore = new Map<string, { sessionId: string; postings: Set<string> }>();

    get size(): number {
        return this.sessions.size;
    }

    index(session: Session): void {
        // Idempotency: remove previous entries for this session first.
        if (this.sessions.has(session.id)) {
            this._removeFromInvertedIndex(session.id);
        }

        this.sessions.set(session.id, session);

        const tokenSet = new Set<string>();
        this.sessionTokens.set(session.id, tokenSet);

        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
            const message = session.messages[msgIdx];
            const tokens = tokenize(message.content);
            const entry = `${session.id}:${msgIdx}`;

            for (const token of tokens) {
                tokenSet.add(token);

                // — document-frequency tracking —
                let docSessions = this.tokenDocSessions.get(token);
                if (docSessions === undefined) {
                    docSessions = new Set<string>();
                    this.tokenDocSessions.set(token, docSessions);
                }
                docSessions.add(session.id);

                if (docSessions.size < MIN_DOC_FREQ) {
                    // Single-session token — store in hapax (not yet promoted).
                    let hapax = this.hapaxStore.get(token);
                    if (hapax === undefined) {
                        hapax = { sessionId: session.id, postings: new Set<string>() };
                        this.hapaxStore.set(token, hapax);
                    }
                    hapax.postings.add(entry);
                } else if (this.hapaxStore.has(token)) {
                    // Just crossed the threshold — promote from hapax to main index.
                    const hapax = this.hapaxStore.get(token)!;
                    const promoted = new Set(hapax.postings);
                    promoted.add(entry);
                    this.invertedIndex.set(token, promoted);
                    this.hapaxStore.delete(token);
                } else {
                    // Already in the main index (or re-entering after removal without demotion).
                    let postings = this.invertedIndex.get(token);
                    if (postings === undefined) {
                        postings = new Set<string>();
                        this.invertedIndex.set(token, postings);
                    }
                    postings.add(entry);
                }
            }
        }
    }

    /** Returns statistics about the current state of the index. */
    indexStats(): IndexStats {
        let postingCount = 0;
        for (const postings of this.invertedIndex.values()) {
            postingCount += postings.size;
        }
        const indexedTokenCount = this.invertedIndex.size;
        const hapaxTokenCount   = this.hapaxStore.size;
        const totalTokenCount   = indexedTokenCount + hapaxTokenCount;
        const memoryEstimateKB  = Math.round(
            (indexedTokenCount * 50 + postingCount * 40 + hapaxTokenCount * 90) / 1024
        );
        return { indexedTokenCount, hapaxTokenCount, totalTokenCount, postingCount, memoryEstimateKB };
    }

    remove(sessionId: string): void {
        this._removeFromInvertedIndex(sessionId);
        this.sessions.delete(sessionId);
    }



    search(query: SearchQuery): SearchResponse {
        if (query.text === '') {
            return { results: [], totalCount: 0 };
        }

        const filter = query.filter ?? {};
        const searchPrompts    = filter.searchPrompts    !== false;
        const searchResponses  = filter.searchResponses  !== false;

        const results: SearchResult[] = [];

        if (query.isRegex) {
            // Linear scan across all sessions.
            let regex: RegExp;
            try {
                regex = new RegExp(query.text);
            } catch {
                return { results: [], totalCount: 0 };
            }

            for (const session of this.sessions.values()) {
                if (!this._sessionPassesFilter(session, filter)) {
                    continue;
                }

                for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
                    const message = session.messages[msgIdx];
                    if (!this._roleAllowed(message.role, searchPrompts, searchResponses)) {
                        continue;
                    }

                    const match = findFirstMatch(message.content, regex);
                    if (match === undefined) {
                        continue;
                    }

                    const { snippet, matchStart, matchEnd } = extractSnippet(
                        message.content,
                        match.offset,
                        match.length
                    );

                    results.push({
                        sessionId:    session.id,
                        messageIndex: msgIdx,
                        messageRole:  message.role,
                        snippet,
                        matchStart,
                        matchEnd,
                        score: 1,
                    });
                }
            }
        } else {
            // Plain-text mode: use the inverted index.
            const queryTokens = tokenize(query.text);
            if (queryTokens.length === 0) {
                return { results: [], totalCount: 0 };
            }

            // Find candidate entries that contain ALL query tokens.
            let candidateSet: Set<string> | undefined;

            for (const token of queryTokens) {
                const postings = this.invertedIndex.get(token);
                if (postings === undefined || postings.size === 0) {
                    // No session contains this token → no matches possible.
                    return { results: [], totalCount: 0 };
                }

                if (candidateSet === undefined) {
                    candidateSet = new Set(postings);
                } else {
                    // Intersect.
                    for (const entry of candidateSet) {
                        if (!postings.has(entry)) {
                            candidateSet.delete(entry);
                        }
                    }
                }

                if (candidateSet.size === 0) {
                    return { results: [], totalCount: 0 };
                }
            }

            if (candidateSet === undefined || candidateSet.size === 0) {
                return { results: [], totalCount: 0 };
            }

            for (const entry of candidateSet) {
                const colonIdx = entry.indexOf(':');
                const sessionId = entry.slice(0, colonIdx);
                const msgIdx    = parseInt(entry.slice(colonIdx + 1), 10);

                const session = this.sessions.get(sessionId);
                if (session === undefined) {
                    continue;
                }

                if (!this._sessionPassesFilter(session, filter)) {
                    continue;
                }

                const message = session.messages[msgIdx];
                if (message === undefined) {
                    continue;
                }

                if (!this._roleAllowed(message.role, searchPrompts, searchResponses)) {
                    continue;
                }

                const match = findFirstMatch(message.content, query.text);
                if (match === undefined) {
                    continue;
                }

                const { snippet, matchStart, matchEnd } = extractSnippet(
                    message.content,
                    match.offset,
                    match.length
                );

                // Score = number of query tokens found in this message.
                const messageTokenSet = new Set(tokenize(message.content));
                const score = queryTokens.filter(t => messageTokenSet.has(t)).length;

                results.push({
                    sessionId:    session.id,
                    messageIndex: msgIdx,
                    messageRole:  message.role,
                    snippet,
                    matchStart,
                    matchEnd,
                    score,
                });
            }
        }

        const totalCount = results.length;

        // Cap to MAX_RESULTS before sort to keep sort complexity O(MAX_RESULTS log MAX_RESULTS).
        const toSort = totalCount > MAX_RESULTS ? results.slice(0, MAX_RESULTS) : results;

        // Pre-fetch updatedAt for each unique session in the result set (O(n) once)
        // so the sort comparator avoids repeated Map lookups inside the hot loop.
        const updatedAtMap = new Map<string, string>();
        for (const r of toSort) {
            if (!updatedAtMap.has(r.sessionId)) {
                updatedAtMap.set(r.sessionId, this.sessions.get(r.sessionId)?.updatedAt ?? '');
            }
        }

        // Sort: score descending, then updatedAt descending.
        toSort.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            const aUpdated = updatedAtMap.get(a.sessionId) ?? '';
            const bUpdated = updatedAtMap.get(b.sessionId) ?? '';
            return bUpdated < aUpdated ? -1 : bUpdated > aUpdated ? 1 : 0;
        });

        return { results: toSort, totalCount };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _removeFromInvertedIndex(sessionId: string): void {
        const prefix = `${sessionId}:`;
        const tokens = this.sessionTokens.get(sessionId);
        if (tokens !== undefined) {
            // O(unique_tokens_in_session) — fast path using reverse map
            for (const token of tokens) {
                // — update document-frequency tracking —
                const docSessions = this.tokenDocSessions.get(token);
                if (docSessions !== undefined) {
                    docSessions.delete(sessionId);
                    if (docSessions.size === 0) { this.tokenDocSessions.delete(token); }
                }

                // — remove from hapax store or main index (no demotion: once promoted, stays) —
                const hapax = this.hapaxStore.get(token);
                if (hapax !== undefined && hapax.sessionId === sessionId) {
                    this.hapaxStore.delete(token);
                } else {
                    const postings = this.invertedIndex.get(token);
                    if (postings !== undefined) {
                        for (const entry of postings) {
                            if (entry.startsWith(prefix)) { postings.delete(entry); }
                        }
                        if (postings.size === 0) { this.invertedIndex.delete(token); }
                    }
                }
            }
            this.sessionTokens.delete(sessionId);
        } else {
            // Fallback: O(total_tokens) scan — only hit if sessionTokens is out of sync
            for (const [token, postings] of this.invertedIndex) {
                for (const entry of postings) {
                    if (entry.startsWith(prefix)) { postings.delete(entry); }
                }
                if (postings.size === 0) { this.invertedIndex.delete(token); }
            }
        }
    }

    private _sessionPassesFilter(
        session: Session,
        filter: NonNullable<SearchQuery['filter']>
    ): boolean {
        if (filter.source !== undefined && session.source !== filter.source) {
            return false;
        }
        if (filter.workspaceId !== undefined && session.workspaceId !== filter.workspaceId) {
            return false;
        }
        if (filter.dateFrom !== undefined && session.updatedAt < filter.dateFrom) {
            return false;
        }
        if (filter.dateTo !== undefined && session.updatedAt > filter.dateTo) {
            return false;
        }
        return true;
    }

    private _roleAllowed(
        role: 'user' | 'assistant',
        searchPrompts: boolean,
        searchResponses: boolean
    ): boolean {
        if (role === 'user'      && !searchPrompts)   { return false; }
        if (role === 'assistant' && !searchResponses) { return false; }
        return true;
    }
}
