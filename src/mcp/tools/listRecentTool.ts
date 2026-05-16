// src/mcp/tools/listRecentTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { SessionSource } from '../../types/index';

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * MCP tool: list recently updated sessions, optionally filtered by source or date.
 */
export class ListRecentTool implements IMcpTool {
    readonly name = 'chatwizard_list_recent';
    readonly description =
        'List recently updated chat sessions, sorted newest first. ' +
        'Optionally filter by source (AI tool) or a minimum date. ' +
        'Returns lightweight summaries suitable for orientation and triage.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: `Maximum sessions to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
            },
            source: {
                type: 'string',
                description: 'Restrict to a single AI tool source (e.g. "copilot", "claude", "cursor", "cline", "windsurf", "aider").',
            },
            since: {
                type: 'string',
                description: 'Only include sessions updated at or after this ISO 8601 date string (e.g. "2025-01-01").',
            },
        },
        required: [],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const rawLimit = input['limit'];
        const limit = clamp(
            typeof rawLimit === 'number' ? Math.round(rawLimit) : DEFAULT_LIMIT,
            MIN_LIMIT,
            MAX_LIMIT,
        );

        const source = typeof input['source'] === 'string' ? input['source'] as SessionSource : undefined;
        const since = typeof input['since'] === 'string' ? input['since'] : undefined;

        let summaries = this.sessionIndex.getAllSummaries(); // already sorted updatedAt desc

        if (source) {
            summaries = summaries.filter(s => s.source === source);
        }

        if (since) {
            summaries = summaries.filter(s => s.updatedAt >= since);
        }

        summaries = summaries.slice(0, limit);

        if (summaries.length === 0) {
            return {
                content: [{ type: 'text', text: 'No sessions found matching the supplied filters.' }],
            };
        }

        const lines: string[] = [];
        for (const s of summaries) {
            lines.push(
                `[Session: ${s.title}] | Source: ${s.source} | Date: ${s.updatedAt} | Messages: ${s.messageCount}`,
                `ID: ${s.id}`,
                '',
            );
        }

        return {
            content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
        };
    }
}
