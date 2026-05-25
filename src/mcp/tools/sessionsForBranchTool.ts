// src/mcp/tools/sessionsForBranchTool.ts
// MCP tool: chatwizard_sessions_for_branch
// Returns sessions whose title or first message references a git branch name
// (or contains the branch name as a substring).
//
// Feature 11: Work-Item Grouping

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';

const MAX_RESULTS = 20;

export class SessionsForBranchTool implements IMcpTool {
    readonly name = 'chatwizard_sessions_for_branch';
    readonly description =
        'Returns sessions associated with a git branch name. ' +
        'Matches branch names against session titles and first user messages.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            branch: {
                type: 'string',
                description: 'Git branch name to search for (case-insensitive).',
            },
            limit: {
                type: 'number',
                description: `Maximum sessions to return (default: ${MAX_RESULTS}).`,
            },
        },
        required: ['branch'],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const branch = input['branch'];
        if (typeof branch !== 'string' || !branch.trim()) {
            return {
                content: [{ type: 'text', text: 'Error: "branch" must be a non-empty string.' }],
                isError: true,
            };
        }

        const needle = branch.trim().toLowerCase();
        const limit = typeof input['limit'] === 'number'
            ? Math.max(1, Math.min(input['limit'], MAX_RESULTS))
            : MAX_RESULTS;

        const matches: Array<{ id: string; title: string; date: string; source: string }> = [];

        for (const summary of this.sessionIndex.getAllSummaries()) {
            if (matches.length >= limit) { break; }
            if (summary.title.toLowerCase().includes(needle)) {
                const session = this.sessionIndex.get(summary.id);
                if (session) {
                    matches.push({ id: summary.id, title: summary.title, date: session.updatedAt, source: session.source });
                    continue;
                }
            }
            // Check first user message
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }
            const firstUser = session.messages.find(m => m.role === 'user');
            if (firstUser?.content.toLowerCase().slice(0, 500).includes(needle)) {
                matches.push({ id: summary.id, title: summary.title, date: session.updatedAt, source: session.source });
            }
        }

        if (matches.length === 0) {
            return { content: [{ type: 'text', text: `No sessions found for branch: "${branch}"` }] };
        }

        matches.sort((a, b) => b.date.localeCompare(a.date));
        const lines = [`Sessions for branch: "${branch}"`, ''];
        for (const m of matches) {
            lines.push(`[Session: ${m.title}] | Source: ${m.source} | Date: ${m.date.slice(0, 10)}`);
            lines.push(`ID: ${m.id}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
    }
}
