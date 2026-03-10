// src/search/types.ts

import { SessionSource } from '../types/index';

/** Filters that narrow a search to a subset of sessions/messages */
export interface SearchFilter {
    /** Restrict to a single AI source */
    source?: SessionSource;
    /** Restrict to a single workspace by opaque ID */
    workspaceId?: string;
    /** Only sessions updated on or after this ISO date string */
    dateFrom?: string;
    /** Only sessions updated on or before this ISO date string */
    dateTo?: string;
    /** Include user-turn messages in search (default: true) */
    searchPrompts?: boolean;
    /** Include assistant-turn messages in search (default: true) */
    searchResponses?: boolean;
}

/** A search query issued by the caller */
export interface SearchQuery {
    /** The search term or regex pattern */
    text: string;
    /** Treat text as a regex pattern (default: false) */
    isRegex?: boolean;
    /** Optional filters */
    filter?: SearchFilter;
}

/** A single search hit: one message within one session that matched */
export interface SearchResult {
    /** ID of the session containing the match */
    sessionId: string;
    /** Zero-based index of the matching message within session.messages */
    messageIndex: number;
    /** Role of the matching message */
    messageRole: 'user' | 'assistant';
    /** Short excerpt of message content surrounding the match */
    snippet: string;
    /** Byte offset within snippet where the match starts */
    matchStart: number;
    /** Byte offset within snippet where the match ends (exclusive) */
    matchEnd: number;
    /** Relevance score; higher = more relevant */
    score: number;
}
