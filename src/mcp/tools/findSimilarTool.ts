// src/mcp/tools/findSimilarTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { ISemanticIndexer } from '../../search/semanticContracts';
import { SessionIndex } from '../../index/sessionIndex';

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const SNIPPET_MAX_CHARS = 300;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * MCP tool: semantic similarity search across all indexed sessions.
 * Delegates to SemanticIndexer. Returns an error message (not a thrown exception)
 * when semantic search is not enabled or the indexer is not ready.
 */
export class FindSimilarTool implements IMcpTool {
    readonly name = 'chatwizard_find_similar';
    readonly description =
        'Semantic similarity search across all indexed chat sessions. ' +
        'Returns sessions whose content is semantically related to the supplied topic or question. ' +
        'More powerful than keyword search for conceptual queries. ' +
        'Requires semantic search to be enabled and the model to be initialized.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Topic, question, or description to find semantically similar sessions for.',
            },
            limit: {
                type: 'number',
                description: `Maximum number of results to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
            },
            minScore: {
                type: 'number',
                description: 'Minimum similarity score threshold (0–1). Defaults to 0.35.',
            },
        },
        required: ['query'],
    };

    constructor(
        private readonly semanticIndexer: ISemanticIndexer,
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

        if (!this.semanticIndexer.isReady) {
            return {
                content: [{
                    type: 'text',
                    text: 'Semantic search is not available. Enable it in ChatWizard settings and allow the AI model to download.',
                }],
                isError: true,
            };
        }

        const rawLimit = input['limit'];
        const limit = clamp(
            typeof rawLimit === 'number' ? Math.round(rawLimit) : DEFAULT_LIMIT,
            MIN_LIMIT,
            MAX_LIMIT,
        );

        const rawMinScore = input['minScore'];
        const minScore = typeof rawMinScore === 'number' ? rawMinScore : undefined;

        let semanticResults;
        try {
            semanticResults = await this.semanticIndexer.search(query, limit, minScore);
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Semantic search error: ${String(err)}` }],
                isError: true,
            };
        }

        if (semanticResults.length === 0) {
            return {
                content: [{ type: 'text', text: `No semantically similar sessions found for "${query}".` }],
            };
        }

        const lines: string[] = [];
        for (const result of semanticResults) {
            const session = this.sessionIndex.get(result.sessionId);
            const title = session?.title ?? result.sessionId;
            const sessionSource = session?.source ?? 'unknown';
            const updatedAt = session?.updatedAt ?? '';
            const scoreStr = result.score.toFixed(3);

            // Use first user message as snippet
            const firstUserMsg = session?.messages.find(m => m.role === 'user');
            const snippet = (firstUserMsg?.content ?? '').slice(0, SNIPPET_MAX_CHARS);

            lines.push(
                `[Session: ${title}] | Source: ${sessionSource} | Date: ${updatedAt}`,
                `Snippet: ${snippet}`,
                `Similarity: ${scoreStr}`,
                `ID: ${result.sessionId}`,
                '',
            );
        }

        return {
            content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
        };
    }
}
