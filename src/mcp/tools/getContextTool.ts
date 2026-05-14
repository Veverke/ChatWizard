// src/mcp/tools/getContextTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { FindSimilarTool } from './findSimilarTool';
import { SearchTool } from './searchTool';
import { SessionIndex } from '../../index/sessionIndex';
import { tokenizeQuery } from '../../search/fullTextEngine';

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;
const PASSAGE_MAX_CHARS = 500;

/**
 * Returns the message content that best matches the query keywords.
 * Falls back to the first user message when no keyword match is found.
 */
function bestMatchingPassage(
    messages: Array<{ role: string; content: string }>,
    keywordTokens: string[],
    maxChars: number,
): string {
    if (keywordTokens.length > 0) {
        let bestScore = 0;
        let bestContent = '';
        for (const msg of messages) {
            const lower = msg.content.toLowerCase();
            const score = keywordTokens.filter(kw => lower.includes(kw)).length;
            if (score > bestScore) {
                bestScore = score;
                bestContent = msg.content;
            }
        }
        if (bestScore > 0) {
            return bestContent.slice(0, maxChars);
        }
    }
    const firstUserMsg = messages.find(m => m.role === 'user');
    return (firstUserMsg?.content ?? '').slice(0, maxChars);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Parse a line like "ID: <sessionId>" from formatted tool output.
 */
function extractIds(text: string): string[] {
    const ids: string[] = [];
    for (const line of text.split('\n')) {
        const match = line.match(/^ID:\s*(.+)$/);
        if (match) {
            ids.push(match[1].trim());
        }
    }
    return ids;
}

/**
 * MCP tool: "smart context" — merges semantic and keyword results and returns
 * the most relevant passages for a topic across all indexed sessions.
 * This is the preferred single-call tool for agents that want maximum relevance.
 */
export class GetContextTool implements IMcpTool {
    readonly name = 'chatwizard_get_context';
    readonly description =
        'Smart context retrieval: finds the most relevant past sessions for a topic by combining ' +
        'semantic similarity search (when available) with keyword search. ' +
        'Deduplicates results and returns top passages with full session attribution. ' +
        'Preferred over individual search tools when you want the best relevant context in one call.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            topic: {
                type: 'string',
                description: 'The topic, question, or concept to find context for.',
            },
            limit: {
                type: 'number',
                description: `Maximum sessions to include (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
            },
        },
        required: ['topic'],
    };

    constructor(
        private readonly findSimilarTool: FindSimilarTool,
        private readonly searchTool: SearchTool,
        private readonly sessionIndex: SessionIndex,
    ) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const topic = input['topic'];
        if (typeof topic !== 'string' || topic.trim() === '') {
            return {
                content: [{ type: 'text', text: 'Error: "topic" must be a non-empty string.' }],
                isError: true,
            };
        }

        const rawLimit = input['limit'];
        const limit = clamp(
            typeof rawLimit === 'number' ? Math.round(rawLimit) : DEFAULT_LIMIT,
            MIN_LIMIT,
            MAX_LIMIT,
        );

        const keywordTokens = tokenizeQuery(topic);
        const keywordQuery = keywordTokens.join(' ');

        // 1. Semantic search (primary, if available).
        const semanticIds: string[] = [];
        const semanticResult = await this.findSimilarTool.execute({ query: topic, limit: limit * 2 });
        if (!semanticResult.isError) {
            semanticIds.push(...extractIds(semanticResult.content[0]?.text ?? ''));
        }

        // 2. Keyword search (supplement / fallback).
        // Strip stop words from the topic before AND search: natural-language
        // queries contain words like "not", "and", "does" that are unlikely to
        // appear together in every session message, causing AND intersection to
        // fail immediately. Using only content-bearing tokens gives the AND
        // search a realistic chance of matching. SearchTool.execute() will
        // automatically apply a relaxed OR fallback (including hapax tokens) when
        // the strict AND search yields no results.
        const keywordIds: string[] = [];
        const keywordResult = await this.searchTool.execute({ query: keywordQuery || topic, limit: limit * 2 });
        if (!keywordResult.isError) {
            keywordIds.push(...extractIds(keywordResult.content[0]?.text ?? ''));
        }

        // 3. Title keyword search — catches sessions whose title contains query
        // tokens but were missed by message-level search (e.g. "Preparing Extension
        // for Marketplace Release" when querying "publish vs code extension").
        // Tokens ≥ 3 chars are used as signals. Stop words have already been
        // stripped by tokenizeQuery(), so short but meaningful acronyms like
        // "PAT", "MCP", "SQL" are now correctly included as title signals.
        const titleIds: string[] = [];
        const titleSignalTokens = new Set(keywordTokens.filter(t => t.length >= 3));
        if (titleSignalTokens.size > 0) {
            for (const summary of this.sessionIndex.getAllSummaries()) {
                const titleTokens = new Set(tokenizeQuery(summary.title));
                const hasOverlap = [...titleSignalTokens].some(t => titleTokens.has(t));
                if (hasOverlap) {
                    titleIds.push(summary.id);
                }
            }
        }

        // Merge with tiered ranking: sessions confirmed by more signals rank higher.
        // Tier 1: semantic + keyword + title (triple confirmation)
        // Tier 2: semantic + keyword
        // Tier 3: semantic + title
        // Tier 4: semantic only
        // Tier 5: keyword + title
        // Tier 6: keyword only
        // Tier 7: title only
        const keywordSet = new Set(keywordIds);
        const titleSet = new Set(titleIds);
        const seenIds = new Set<string>();
        const orderedIds: string[] = [];

        const addId = (id: string): void => {
            if (!seenIds.has(id)) { seenIds.add(id); orderedIds.push(id); }
        };

        for (const id of semanticIds) { if (keywordSet.has(id) && titleSet.has(id)) { addId(id); } }
        for (const id of semanticIds) { if (keywordSet.has(id)) { addId(id); } }
        for (const id of semanticIds) { if (titleSet.has(id)) { addId(id); } }
        for (const id of semanticIds) { addId(id); }
        for (const id of keywordIds) { if (titleSet.has(id)) { addId(id); } }
        for (const id of keywordIds) { addId(id); }
        for (const id of titleIds) { addId(id); }

        const topIds = orderedIds.slice(0, limit);

        // Rarest-token filter: identify the query token that appears in the fewest
        // sessions across the entire corpus (most semantically specific / highest IDF).
        // Require each candidate to contain that token as a whole word.
        //
        // This correctly handles all three cases:
        //   - Session with only "pat" (no "generate"/"repo") → passes (has the rare token) ✓
        //   - Session with "generate"+"repo" but no "pat" → filtered out ✓
        //   - All candidate sessions have all tokens → all have the rare token, all pass ✓
        //
        // The index is fully in-memory so the corpus scan is cheap.
        // Compute per-token corpus frequency and sort ascending (rarest first).
        // Requiring the TWO rarest tokens (not just one) prevents a session from
        // passing on a single incidental word (e.g. "failing" in a log line) when
        // the query has multiple meaningful terms.
        const tokenFreqs: Array<{ token: string; freq: number }> = [];
        for (const kw of keywordTokens) {
            let freq = 0;
            for (const summary of this.sessionIndex.getAllSummaries()) {
                const s = this.sessionIndex.get(summary.id);
                if (!s) { continue; }
                const words = new Set(s.messages.map(m => m.content.toLowerCase()).join(' ').split(/\W+/));
                if (words.has(kw)) { freq++; }
            }
            tokenFreqs.push({ token: kw, freq });
        }
        tokenFreqs.sort((a, b) => a.freq - b.freq); // rarest first

        // Adaptive required-token count:
        //   - If the rarest token is truly rare (< 15% of corpus) → top-2 is discriminating enough.
        //   - If all tokens are common (all ≥ 15%) → require ALL of them; no single word is
        //     distinctive so every word must be present to avoid incidental log-noise matches.
        const totalSessions = Math.max(1, this.sessionIndex.getAllSummaries().length);
        const RARITY_THRESHOLD = 0.15;
        const hasRareToken = tokenFreqs.length > 0 && tokenFreqs[0].freq / totalSessions < RARITY_THRESHOLD;
        const requiredCount = hasRareToken ? Math.min(2, tokenFreqs.length) : tokenFreqs.length;
        const requiredTokens = new Set<string>(
            tokenFreqs.slice(0, requiredCount).map(t => t.token)
        );

        // Pre-build a summary map so the filter loop doesn't call getAllSummaries() repeatedly.
        const summaryMap = new Map(this.sessionIndex.getAllSummaries().map(s => [s.id, s]));

        const filteredIds = topIds.filter(id => {
            if (titleSet.has(id)) {
                // Only bypass the content check when the title contains a *required*
                // (high-IDF) token.  A generic verb like "add" or "fix" matching a
                // title should not exempt a session from the full relevance check —
                // that would surface unrelated sessions that happened to start with
                // a common word.
                if (requiredTokens.size === 0) { return true; }
                const titleToks = new Set(tokenizeQuery(summaryMap.get(id)?.title ?? ''));
                if ([...requiredTokens].some(t => titleToks.has(t))) { return true; }
                // Title matched on a non-required (common) token — fall through to
                // the content check below.
            }
            const session = this.sessionIndex.get(id);
            if (!session) { return false; }
            if (requiredTokens.size === 0) { return true; }
            const contentTokenSet = new Set(
                session.messages.map(m => m.content.toLowerCase()).join(' ').split(/\W+/)
            );
            return [...requiredTokens].every(t => contentTokenSet.has(t));
        });

        if (filteredIds.length === 0) {
            return {
                content: [{ type: 'text', text: `No relevant context found for topic: "${topic}".` }],
            };
        }

        const lines: string[] = [`Context for: "${topic}"`, ''];

        for (const sessionId of filteredIds) {
            const session = this.sessionIndex.get(sessionId);
            if (!session) { continue; }

            const passage = bestMatchingPassage(session.messages, keywordTokens, PASSAGE_MAX_CHARS);

            lines.push(
                `[Session: ${session.title}] | Source: ${session.source} | Date: ${session.updatedAt}`,
                `Passage: ${passage}`,
                `ID: ${session.id}`,
                '',
            );
        }

        return {
            content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
        };
    }
}
