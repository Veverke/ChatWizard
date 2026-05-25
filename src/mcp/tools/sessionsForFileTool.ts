// src/mcp/tools/sessionsForFileTool.ts
// MCP tool: chatwizard_sessions_for_file
// Returns all sessions that touched a specific file path, via importantFiles
// (populated from Chronicle checkpoints and entity extraction).
//
// Feature 10: File-Centric History

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { normalisePath, sessionTouchesFile } from '../../utils/pathNormaliser';

const MAX_RESULTS = 20;

export class SessionsForFileTool implements IMcpTool {
    readonly name = 'chatwizard_sessions_for_file';
    readonly description =
        'Returns sessions that referenced or modified a specific source file. ' +
        'Uses Chronicle checkpoint data (important_files) and extracted entity file paths. ' +
        'Provide either an absolute path or a workspace-relative path.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'Absolute or workspace-relative path to the file.',
            },
            limit: {
                type: 'number',
                description: `Maximum number of sessions to return (default: ${MAX_RESULTS}).`,
            },
        },
        required: ['filePath'],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const rawPath = input['filePath'];
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            return {
                content: [{ type: 'text', text: 'Error: "filePath" must be a non-empty string.' }],
                isError: true,
            };
        }

        const normQuery = normalisePath(rawPath.trim());
        const limit = typeof input['limit'] === 'number'
            ? Math.max(1, Math.min(input['limit'], MAX_RESULTS))
            : MAX_RESULTS;

        const matches: Array<{ id: string; title: string; updatedAt: string; source: string }> = [];

        for (const summary of this.sessionIndex.getAllSummaries()) {
            if (matches.length >= limit) { break; }
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }

            // Check importantFiles on session (from Chronicle or merged entity extraction)
            if (sessionTouchesFile(session.importantFiles, normQuery)) {
                matches.push({
                    id: summary.id,
                    title: summary.title,
                    updatedAt: session.updatedAt,
                    source: session.source,
                });
                continue;
            }

            // Also check chronicleData.importantFiles
            if (sessionTouchesFile(session.chronicleData?.importantFiles, normQuery)) {
                matches.push({
                    id: summary.id,
                    title: summary.title,
                    updatedAt: session.updatedAt,
                    source: session.source,
                });
            }
        }

        if (matches.length === 0) {
            return {
                content: [{ type: 'text', text: `No sessions found that reference file: "${rawPath}"` }],
            };
        }

        // Sort by most recent first
        matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        const lines = [`Sessions referencing: "${rawPath}"`, ''];
        for (const m of matches) {
            lines.push(`[Session: ${m.title}] | Source: ${m.source} | Date: ${m.updatedAt.slice(0, 10)}`);
            lines.push(`ID: ${m.id}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
    }
}
