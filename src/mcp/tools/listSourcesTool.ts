// src/mcp/tools/listSourcesTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { SessionSource } from '../../types/index';

/**
 * MCP tool: list which AI tools are indexed, with session counts and most recent date.
 */
export class ListSourcesTool implements IMcpTool {
    readonly name = 'chatwizard_list_sources';
    readonly description =
        'List which AI coding tools are indexed by ChatWizard, along with session counts ' +
        'and the most recent session date per source. ' +
        'Use this to understand what data is available before issuing other queries.';

    readonly inputSchema = {
        type: 'object',
        properties: {},
        required: [],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(_input: McpToolInput): Promise<McpToolResult> {
        const summaries = this.sessionIndex.getAllSummaries();

        if (summaries.length === 0) {
            return {
                content: [{ type: 'text', text: 'No sessions are currently indexed.' }],
            };
        }

        // Aggregate by source.
        const bySource = new Map<SessionSource, { count: number; latestDate: string }>();
        for (const s of summaries) {
            const existing = bySource.get(s.source);
            if (!existing) {
                bySource.set(s.source, { count: 1, latestDate: s.updatedAt });
            } else {
                existing.count++;
                if (s.updatedAt > existing.latestDate) {
                    existing.latestDate = s.updatedAt;
                }
            }
        }

        // Sort sources by session count descending.
        const sorted = Array.from(bySource.entries())
            .sort(([, a], [, b]) => b.count - a.count);

        const lines: string[] = [
            `Indexed sources (${summaries.length} total sessions):`,
            '',
        ];

        for (const [source, { count, latestDate }] of sorted) {
            lines.push(`${source}: ${count} session${count === 1 ? '' : 's'} | Most recent: ${latestDate}`);
        }

        return {
            content: [{ type: 'text', text: lines.join('\n') }],
        };
    }
}
