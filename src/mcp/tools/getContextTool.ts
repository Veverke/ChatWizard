// src/mcp/tools/getContextTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { FindSimilarTool } from './findSimilarTool';
import { SearchTool } from './searchTool';
import { SessionIndex } from '../../index/sessionIndex';

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;
const PASSAGE_MAX_CHARS = 500;

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

        // Collect session IDs in order of relevance; deduplicate.
        const seenIds = new Set<string>();
        const orderedIds: string[] = [];

        // 1. Semantic search (primary, if available).
        const semanticResult = await this.findSimilarTool.execute({ query: topic, limit: limit * 2 });
        if (!semanticResult.isError) {
            for (const id of extractIds(semanticResult.content[0]?.text ?? '')) {
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    orderedIds.push(id);
                }
            }
        }

        // 2. Keyword search (supplement / fallback).
        const keywordResult = await this.searchTool.execute({ query: topic, limit: limit * 2 });
        if (!keywordResult.isError) {
            for (const id of extractIds(keywordResult.content[0]?.text ?? '')) {
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    orderedIds.push(id);
                }
            }
        }

        const topIds = orderedIds.slice(0, limit);

        if (topIds.length === 0) {
            return {
                content: [{ type: 'text', text: `No relevant context found for topic: "${topic}".` }],
            };
        }

        const lines: string[] = [`Context for: "${topic}"`, ''];

        for (const sessionId of topIds) {
            const session = this.sessionIndex.get(sessionId);
            if (!session) { continue; }

            const firstUserMsg = session.messages.find(m => m.role === 'user');
            const passage = (firstUserMsg?.content ?? '').slice(0, PASSAGE_MAX_CHARS);

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
