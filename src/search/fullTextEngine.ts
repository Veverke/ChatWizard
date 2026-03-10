// src/search/fullTextEngine.ts

import { Session } from '../types/index';
import { SearchQuery, SearchResult } from './types';
import { extractSnippet, findFirstMatch } from './snippetExtractor';

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/\W+/)
        .filter(t => t.length >= 2);
}

export class FullTextSearchEngine {
    /** sessionId → Session */
    private readonly sessions = new Map<string, Session>();

    /** token → Set of "sessionId:messageIndex" strings */
    private readonly invertedIndex = new Map<string, Set<string>>();

    get size(): number {
        return this.sessions.size;
    }

    index(session: Session): void {
        // Idempotency: remove previous entries for this session first.
        if (this.sessions.has(session.id)) {
            this._removeFromInvertedIndex(session.id);
        }

        this.sessions.set(session.id, session);

        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
            const message = session.messages[msgIdx];
            const tokens = tokenize(message.content);
            const entry = `${session.id}:${msgIdx}`;

            for (const token of tokens) {
                let postings = this.invertedIndex.get(token);
                if (postings === undefined) {
                    postings = new Set<string>();
                    this.invertedIndex.set(token, postings);
                }
                postings.add(entry);
            }
        }
    }

    remove(sessionId: string): void {
        this._removeFromInvertedIndex(sessionId);
        this.sessions.delete(sessionId);
    }

    search(query: SearchQuery): SearchResult[] {
        if (query.text === '') {
            return [];
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
                return [];
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
                return [];
            }

            // Find candidate entries that contain ALL query tokens.
            let candidateSet: Set<string> | undefined;

            for (const token of queryTokens) {
                const postings = this.invertedIndex.get(token);
                if (postings === undefined || postings.size === 0) {
                    // No session contains this token → no matches possible.
                    return [];
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
                    return [];
                }
            }

            if (candidateSet === undefined || candidateSet.size === 0) {
                return [];
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

        // Sort: score descending, then updatedAt descending.
        results.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            const aUpdated = this.sessions.get(a.sessionId)?.updatedAt ?? '';
            const bUpdated = this.sessions.get(b.sessionId)?.updatedAt ?? '';
            return bUpdated < aUpdated ? -1 : bUpdated > aUpdated ? 1 : 0;
        });

        return results;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _removeFromInvertedIndex(sessionId: string): void {
        const prefix = `${sessionId}:`;
        for (const [token, postings] of this.invertedIndex) {
            for (const entry of postings) {
                if (entry.startsWith(prefix)) {
                    postings.delete(entry);
                }
            }
            if (postings.size === 0) {
                this.invertedIndex.delete(token);
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
