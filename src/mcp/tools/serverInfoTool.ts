// src/mcp/tools/serverInfoTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { ISemanticIndexer } from '../../search/semanticContracts';

/**
 * MCP tool: server metadata and health check.
 * Returns extension version, session count, indexed sources, semantic search status,
 * and server uptime. Useful for clients to verify connectivity and capabilities.
 */
export class ServerInfoTool implements IMcpTool {
    readonly name = 'chatwizard_server_info';
    readonly description =
        'Return ChatWizard MCP server metadata and health information. ' +
        'Includes extension version, total session count, indexed AI tool sources, ' +
        'semantic search availability, and server uptime. ' +
        'Use this to verify connectivity and understand current index state.';

    readonly inputSchema = {
        type: 'object',
        properties: {},
        required: [],
    };

    constructor(
        private readonly sessionIndex: SessionIndex,
        private readonly semanticIndexer: ISemanticIndexer,
        private readonly extensionVersion: string,
        private readonly serverStartTime: Date,
    ) {}

    async execute(_input: McpToolInput): Promise<McpToolResult> {
        const summaries = this.sessionIndex.getAllSummaries();
        const totalSessions = summaries.length;

        // Unique sources.
        const sources = Array.from(new Set(summaries.map(s => s.source))).sort();

        // Uptime.
        const uptimeMs = Date.now() - this.serverStartTime.getTime();
        const uptimeSecs = Math.floor(uptimeMs / 1000);
        const uptimeStr = uptimeSecs < 60
            ? `${uptimeSecs}s`
            : uptimeSecs < 3600
                ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
                : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;

        const semanticStatus = this.semanticIndexer.isReady
            ? `enabled (${this.semanticIndexer.indexedCount} sessions indexed${this.semanticIndexer.isIndexing ? ', indexing in progress' : ''})`
            : 'not ready (model not loaded or user declined download)';

        const lines = [
            `ChatWizard MCP Server`,
            `Version: ${this.extensionVersion}`,
            `Uptime: ${uptimeStr}`,
            `Total sessions: ${totalSessions}`,
            `Indexed sources: ${sources.length > 0 ? sources.join(', ') : 'none'}`,
            `Semantic search: ${semanticStatus}`,
        ];

        return {
            content: [{ type: 'text', text: lines.join('\n') }],
        };
    }
}
