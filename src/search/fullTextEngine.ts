// src/search/fullTextEngine.ts

import { Session, ExtractedEntities } from '../types/index';
import { SearchQuery, SearchResult, SearchResponse } from './types';
import { extractSnippet, findFirstMatch } from './snippetExtractor';

/** Maximum number of results returned after the raw match phase (before sort). */
const MAX_RESULTS = 500;

/** Tokens longer than this are typically hashes, base64, or minified code — skip them. */
const MAX_TOKEN_LENGTH = 50;

/** Only promote tokens to the main index once they appear in this many distinct sessions. */
const MIN_DOC_FREQ = 2;

// SEC-5: ReDoS defenses
/** Maximum length of a user-supplied regex pattern in characters. */
const MAX_REGEX_LEN = 200;
/** Abort regex search across sessions if this many milliseconds have elapsed. */
const REGEX_SEARCH_TIMEOUT_MS = 1_000;
/**
 * Structural ReDoS detector. Checks for two common catastrophic patterns:
 *   1. Nested quantifiers:  (a+)+, (a*)*, ([a-z]+)+
 *   2. Quantified alternation: (a|b)+, (x|y|z)*
 * This is a conservative heuristic — it may block some safe patterns but eliminates
 * the main ReDoS attack vectors without requiring a full regex parser.
 */
const RE_REDOS_PATTERNS = /\([^()]*[+*{][^)]*\)\s*[+*?]|\([^)]*\|[^)]*\)\s*[+*?]/;

function isReDoS(pattern: string): boolean {
    return pattern.length > MAX_REGEX_LEN || RE_REDOS_PATTERNS.test(pattern);
}

/**
 * Common English stop words that carry little topical meaning.
 * Filtered out of relaxed OR queries so specific terms (e.g. "docker") are
 * not drowned out by noise words ("not", "and", "does") that match everywhere.
 */
export const STOP_WORDS = new Set([
    // articles / conjunctions / prepositions
    'the', 'and', 'or', 'but', 'nor', 'for', 'yet', 'so',
    'of', 'in', 'on', 'at', 'to', 'by', 'as', 'an', 'a',
    'from', 'into', 'with', 'about', 'above', 'after', 'before',
    'between', 'during', 'over', 'under', 'through', 'than', 'then',
    // pronouns
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her',
    'it', 'its', 'they', 'their', 'them', 'this', 'that', 'these', 'those',
    'who', 'what', 'which', 'there', 'here',
    // common verbs / auxiliaries
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'get', 'got',
    'use', 'used', 'make', 'made', 'let', 'set', 'put', 'take',
    'start', 'stop', 'run', 'try', 'keep', 'work', 'need', 'want',
    // negations / qualifiers (frequent in ALL sessions — not distinctive)
    'not', 'no', 'now', 'just', 'only', 'also', 'even', 'still',
    'back', 'more', 'most', 'some', 'any', 'all', 'both', 'each',
    'how', 'when', 'where', 'why', 'if', 'up', 'out', 'off',
    // generic nouns ubiquitous in computing contexts — not topically distinctive
    'machine', 'system', 'server', 'process', 'service', 'instance',
    'file', 'code', 'data', 'value', 'type', 'item', 'list',
]);

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/\W+/)
        .filter(t => t.length >= 2 && t.length <= MAX_TOKEN_LENGTH);
}

/**
 * Tokenize a user-supplied query and remove stop words.
 * Used when we want the most topically-meaningful tokens for search
 * (e.g. keyword AND search and relaxed OR scoring).
 */
export function tokenizeQuery(query: string): string[] {
    const base = tokenize(query).filter(t => !STOP_WORDS.has(t));
    // Also add de-pluralized form (strip trailing 's') so "BDDs" matches "BDD",
    // "errors" matches "error", etc. Only applied when de-s'd result is >= 3 chars.
    const expanded = new Set(base);
    for (const t of base) {
        if (t.length >= 4 && t.endsWith('s')) {
            const stem = t.slice(0, -1);
            if (stem.length >= 3) { expanded.add(stem); }
        }
    }
    return [...expanded];
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

    /**
     * Content fingerprint: sessionId → `${updatedAt}:${messages.length}`
     * Used to skip re-tokenization when neither timestamp nor message count changed.
     */
    private readonly _contentVersions = new Map<string, string>();

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

    /** Optional getter for session metadata (used for entity-aware filtering) */
    private _getMetadata?: (sessionId: string) => { entities?: ExtractedEntities } | undefined;

    /** Wire up a metadata getter so entity filters work in `_sessionPassesFilter`. */
    setMetadataGetter(getter: (sessionId: string) => { entities?: ExtractedEntities } | undefined): void {
        this._getMetadata = getter;
    }

    get size(): number {
        return this.sessions.size;
    }

    /** Remove all indexed sessions and clear every internal map. */
    clear(): void {
        this.sessions.clear();
        this.invertedIndex.clear();
        this.sessionTokens.clear();
        this.tokenDocSessions.clear();
        this.hapaxStore.clear();
        this._contentVersions.clear();
    }

    index(session: Session): void {
        // Skip re-tokenization when content is unchanged (only metadata like title changed).
        // Include a lightweight content hash so re-indexing the same session with
        // different message content (same updatedAt + same count) forces re-tokenization.
        // XOR-fold a simple djb2-style hash over each character to detect content changes
        // that share the same total byte count (avoids false-unchanged on transpositions/swaps).
        const contentHash = session.messages.reduce((acc, m) => {
            let h = acc;
            for (let i = 0; i < m.content.length; i++) { h = (Math.imul(h, 33) ^ m.content.charCodeAt(i)) >>> 0; }
            return h;
        }, 0);
        const fingerprint = `${session.updatedAt}:${session.messages.length}:${contentHash}`;
        if (this.sessions.has(session.id) && this._contentVersions.get(session.id) === fingerprint) {
            // Content identical — just update the stored session reference (title may have changed)
            this.sessions.set(session.id, session);
            return;
        }

        // Idempotency: remove previous entries for this session first.
        if (this.sessions.has(session.id)) {
            this._removeFromInvertedIndex(session.id);
        }

        this.sessions.set(session.id, session);

        const tokenSet = new Set<string>();
        this.sessionTokens.set(session.id, tokenSet);

        // Index session title with sentinel msgIdx -1 so title terms are searchable.
        const titleEntry = `${session.id}:-1`;
        for (const token of tokenize(session.title)) {
            this._indexToken(token, session.id, titleEntry, tokenSet);
        }

        this._contentVersions.set(session.id, fingerprint);

        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
            const message = session.messages[msgIdx];
            const tokens = tokenize(message.content);
            const entry = `${session.id}:${msgIdx}`;

            for (const token of tokens) {
                this._indexToken(token, session.id, entry, tokenSet);
            }
        }
    }

    /** Shared token-insertion logic used by both title and message indexing. */
    private _indexToken(token: string, sessionId: string, entry: string, tokenSet: Set<string>): void {
        tokenSet.add(token);

                // — document-frequency tracking —
                let docSessions = this.tokenDocSessions.get(token);
                if (docSessions === undefined) {
                    docSessions = new Set<string>();
                    this.tokenDocSessions.set(token, docSessions);
                }
                docSessions.add(sessionId);

                if (docSessions.size < MIN_DOC_FREQ) {
                    // Single-session token — store in hapax (not yet promoted).
                    let hapax = this.hapaxStore.get(token);
                    if (hapax === undefined) {
                        hapax = { sessionId, postings: new Set<string>() };
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
        this._contentVersions.delete(sessionId);
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
            // SEC-5: reject ReDoS-prone patterns before compilation
            if (isReDoS(query.text)) {
                return { results: [], totalCount: 0 };
            }
            let regex: RegExp;
            try {
                regex = new RegExp(query.text);
            } catch {
                return { results: [], totalCount: 0 };
            }

            const searchStartMs = Date.now();
            for (const session of this.sessions.values()) {
                // SEC-5: time-box per-session regex search to prevent worst-case backtracking
                if (Date.now() - searchStartMs > REGEX_SEARCH_TIMEOUT_MS) { break; }
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
                // Try exact token first; fall back to de-pluralized form (e.g. "BDDs" → "BDD").
                let postings = this.invertedIndex.get(token);
                if ((postings === undefined || postings.size === 0) && token.length >= 4 && token.endsWith('s')) {
                    const stem = token.slice(0, -1);
                    if (stem.length >= 3) { postings = this.invertedIndex.get(stem); }
                }
                if (postings === undefined || postings.size === 0) {
                    // Token is absent from the main index (hapax, or a boundary fragment of a
                    // longer word — e.g. querying "he thing" where the text contains "the thing").
                    // Skip it: remaining tokens still narrow the candidate set, and findFirstMatch
                    // below performs the definitive substring verification.
                    continue;
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

                // Sentinel msgIdx -1 means this posting came from the session title.
                if (msgIdx === -1) {
                    const titleTokenSet = new Set(tokenize(session.title));
                    const score = queryTokens.filter(t => titleTokenSet.has(t)).length;
                    results.push({
                        sessionId:    session.id,
                        messageIndex: -1,
                        messageRole:  'user',
                        snippet:      session.title,
                        matchStart:   0,
                        matchEnd:     session.title.length,
                        score,
                    });
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
        if (filter.entityType !== undefined && filter.entityValue !== undefined) {
            const meta = this._getMetadata?.(session.id);
            const list: string[] = meta?.entities?.[filter.entityType] ?? [];
            const term = filter.entityValue.toLowerCase();
            if (!list.some(e => e.toLowerCase().includes(term))) { return false; }
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

    /**
     * Relaxed OR search across both the main inverted index and the hapax store.
     *
     * Unlike `search()` (which requires ALL tokens to appear in the same message),
     * this method finds sessions where ANY query token appears — including hapax
     * tokens that are excluded from the strict AND index. Sessions are ranked by
     * the number of distinct query tokens they contain.
     *
     * Intended as a fallback for GetContextTool when the strict keyword search
     * yields no results (e.g. because a topic-specific token only appears in one
     * session and is therefore in the hapax store).
     */
    searchRelaxedBySession(
        queryText: string,
        limit: number,
        filter?: SearchQuery['filter'],
    ): Array<{ sessionId: string; score: number; snippet: string }> {
        // Strip stop words first so high-frequency noise words ("not", "and",
        // "does") don't inflate scores and bury rare, specific tokens like "docker".
        const tokens = tokenizeQuery(queryText).filter(t => t.length >= 3);
        if (tokens.length === 0) { return []; }

        const f = filter ?? {};
        const sessionScores = new Map<string, number>();

        // IDF-like weight: tokens appearing in fewer sessions are more distinctive
        // and therefore get a higher score. This ensures rare acronyms (e.g. "PAT",
        // "MCP") outweigh common coding words (e.g. "generate", "repo") when
        // both are present in the query but only the acronym appears in a session.
        // Guard n >= 2 so log2 is always positive.
        const n = Math.max(2, this.sessions.size);
        const idfWeight = (docCount: number): number =>
            Math.max(1, Math.round(Math.log2(n / Math.max(1, docCount))));

        for (const token of tokens) {
            // Main index (docFreq ≥ MIN_DOC_FREQ).
            const postings = this.invertedIndex.get(token);
            if (postings) {
                const docCount = this.tokenDocSessions.get(token)?.size ?? MIN_DOC_FREQ;
                const weight = idfWeight(docCount);
                for (const entry of postings) {
                    const colonIdx = entry.indexOf(':');
                    const sessionId = entry.slice(0, colonIdx);
                    const session = this.sessions.get(sessionId);
                    if (session && this._sessionPassesFilter(session, f)) {
                        sessionScores.set(sessionId, (sessionScores.get(sessionId) ?? 0) + weight);
                    }
                }
            }

            // Hapax store (docCount = 1 by definition → highest IDF weight).
            const hapax = this.hapaxStore.get(token);
            if (hapax) {
                const session = this.sessions.get(hapax.sessionId);
                if (session && this._sessionPassesFilter(session, f)) {
                    const weight = idfWeight(1);
                    sessionScores.set(hapax.sessionId, (sessionScores.get(hapax.sessionId) ?? 0) + weight);
                }
            }
        }

        if (sessionScores.size === 0) { return []; }

        const ranked = [...sessionScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);

        return ranked.map(([sessionId, score]) => {
            const session = this.sessions.get(sessionId)!;
            // Find the first message that contains any query token for a snippet.
            let snippet = '';
            outer: for (const msg of session.messages) {
                for (const token of tokens) {
                    const match = findFirstMatch(msg.content, token);
                    if (match !== undefined) {
                        snippet = extractSnippet(msg.content, match.offset, match.length).snippet;
                        break outer;
                    }
                }
            }
            return { sessionId, score, snippet: snippet || session.title };
        });
    }
}
