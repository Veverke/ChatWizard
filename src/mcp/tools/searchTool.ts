// src/mcp/tools/searchTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { FullTextSearchEngine } from '../../search/fullTextEngine';
import { SessionIndex } from '../../index/sessionIndex';
import { SessionSource } from '../../types/index';

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SNIPPET_MAX_CHARS = 300;

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * MCP tool: full-text keyword search across all indexed sessions.
 * Delegates to FullTextSearchEngine and enriches results with session metadata
 * from SessionIndex.
 */
export class SearchTool implements IMcpTool {
    readonly name = 'chatwizard_search';
    readonly description =
        'Full-text keyword search across all indexed chat sessions. ' +
        'Returns sessions whose messages contain all supplied keywords, ' +
        'with a snippet of the matching content. ' +
        'Optionally filter by source (e.g. "copilot", "claude", "cursor") ' +
        'or workspaceId.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Keywords to search for. All tokens must be present in the matching message.',
            },
            limit: {
                type: 'number',
                description: `Maximum number of sessions to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
            },
            source: {
                type: 'string',
                description: 'Restrict results to a single AI tool source (e.g. "copilot", "claude", "cursor", "cline", "windsurf", "aider").',
            },
            workspaceId: {
                type: 'string',
                description: 'Restrict results to a specific workspace (opaque ID).',
            },
        },
        required: ['query'],
    };

    constructor(
        private readonly ftse: FullTextSearchEngine,
        private readonly sessionIndex: SessionIndex,
    ) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const query = input['query'];
        if (typeof query !== 'string' || query.trim() === '') {
            return {
                content: [{ type: 'text', text: 'Error: "query" must be a non-empty string.' }],
                isError: true,
            };
        }

        const rawLimit = input['limit'];
        const limit = clamp(
            typeof rawLimit === 'number' ? Math.round(rawLimit) : DEFAULT_LIMIT,
            MIN_LIMIT,
            MAX_LIMIT,
        );

        const source = typeof input['source'] === 'string' ? input['source'] : undefined;
        const workspaceId = typeof input['workspaceId'] === 'string' ? input['workspaceId'] : undefined;

        const { results } = this.ftse.search({
            text: query,
            filter: {
                source: source as SessionSource | undefined,
                workspaceId,
            },
        });

        if (results.length === 0) {
            // Relaxed OR fallback: when the strict AND search finds nothing and no
            // scope filters are active, retry with OR semantics so that hapax tokens
            // (appearing in only one session, not yet promoted to the main index) are
            // also considered. This prevents unique error messages and niche topics
            // from silently returning zero results across ALL callers of this tool.
            // Scoped searches (source / workspaceId) are intentionally excluded from
            // the fallback to avoid silently expanding user-specified filters.
            if (!source && !workspaceId) {
                return this.executeRelaxed(query, limit);
            }
            return {
                content: [{ type: 'text', text: `No sessions found matching "${query}".` }],
            };
        }

        // Group by sessionId, picking the highest-score result per session.
        const bestBySession = new Map<string, typeof results[number]>();
        for (const result of results) {
            const existing = bestBySession.get(result.sessionId);
            if (!existing || result.score > existing.score) {
                bestBySession.set(result.sessionId, result);
            }
        }

        // Sort by score descending, then apply limit.
        const ranked = Array.from(bestBySession.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        const lines: string[] = [];
        for (const result of ranked) {
            const session = this.sessionIndex.get(result.sessionId);
            const title = session?.title ?? result.sessionId;
            const sessionSource = session?.source ?? 'unknown';
            const updatedAt = session?.updatedAt ?? '';
            const snippet = result.snippet.slice(0, SNIPPET_MAX_CHARS);

            lines.push(
                `[Session: ${title}] | Source: ${sessionSource} | Date: ${updatedAt}`,
                `Snippet: ${snippet}`,
                `ID: ${result.sessionId}`,
                '',
            );
        }

        return {
            content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
        };
    }

    /**
     * Relaxed OR search — used as a fallback by GetContextTool when the strict
     * AND keyword search yields no results. Searches both the main inverted index
     * and the hapax store, returning sessions that contain ANY query token, ranked
     * by how many tokens they match. Returns the same `ID: <id>` line format as
     * `execute()` so callers can use the shared `extractIds()` helper.
     */
    executeRelaxed(topic: string, limit: number): McpToolResult {
        const results = this.ftse.searchRelaxedBySession(topic, limit);
        if (results.length === 0) {
            return {
                content: [{ type: 'text', text: `No sessions found matching "${topic}".` }],
            };
        }

        const lines: string[] = [];
        for (const { sessionId, snippet } of results) {
            const session = this.sessionIndex.get(sessionId);
            const title = session?.title ?? sessionId;
            const source = session?.source ?? 'unknown';
            const updatedAt = session?.updatedAt ?? '';

            lines.push(
                `[Session: ${title}] | Source: ${source} | Date: ${updatedAt}`,
                `Snippet: ${snippet.slice(0, SNIPPET_MAX_CHARS)}`,
                `ID: ${sessionId}`,
                '',
            );
        }

        return {
            content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
        };
    }
}
