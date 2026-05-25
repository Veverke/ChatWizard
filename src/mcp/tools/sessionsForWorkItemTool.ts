// src/mcp/tools/sessionsForWorkItemTool.ts
// MCP tool: chatwizard_sessions_for_work_item
// Returns sessions referencing a specific work item ID (JIRA, GitHub Issue, etc.)
//
// Feature 11: Work-Item Grouping

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { extractWorkItemsFromSession } from '../../utils/workItemExtractor';
import * as vscode from 'vscode';

const MAX_RESULTS = 20;

export class SessionsForWorkItemTool implements IMcpTool {
    readonly name = 'chatwizard_sessions_for_work_item';
    readonly description =
        'Returns sessions associated with a work-item ID such as a JIRA ticket (ABC-123), ' +
        'GitHub issue (#123), or Azure DevOps item (AB#12345). ' +
        'Matches against session titles and first user messages.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            workItemId: {
                type: 'string',
                description: 'Work item identifier, e.g. "ABC-123", "#456", "AB#789".',
            },
            limit: {
                type: 'number',
                description: `Maximum sessions to return (default: ${MAX_RESULTS}).`,
            },
        },
        required: ['workItemId'],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const workItemId = input['workItemId'];
        if (typeof workItemId !== 'string' || !workItemId.trim()) {
            return {
                content: [{ type: 'text', text: 'Error: "workItemId" must be a non-empty string.' }],
                isError: true,
            };
        }

        const pattern = vscode.workspace
            .getConfiguration('chatwizard')
            .get<string>('workItemPattern', '');

        const needle = workItemId.trim().toUpperCase();
        const limit = typeof input['limit'] === 'number'
            ? Math.max(1, Math.min(input['limit'], MAX_RESULTS))
            : MAX_RESULTS;

        const matches: Array<{ id: string; title: string; date: string; source: string }> = [];

        for (const summary of this.sessionIndex.getAllSummaries()) {
            if (matches.length >= limit) { break; }
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }

            const items = extractWorkItemsFromSession(session.title, session.messages, pattern || undefined);
            if (items.includes(needle)) {
                matches.push({
                    id: summary.id,
                    title: summary.title,
                    date: session.updatedAt,
                    source: session.source,
                });
            }
        }

        if (matches.length === 0) {
            return { content: [{ type: 'text', text: `No sessions found for work item: "${workItemId}"` }] };
        }

        matches.sort((a, b) => b.date.localeCompare(a.date));
        const lines = [`Sessions for work item: "${workItemId}"`, ''];
        for (const m of matches) {
            lines.push(`[Session: ${m.title}] | Source: ${m.source} | Date: ${m.date.slice(0, 10)}`);
            lines.push(`ID: ${m.id}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
    }
}
