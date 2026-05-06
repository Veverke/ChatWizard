// src/mcp/tools/getSessionFullTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { formatSessionTranscript } from './getSessionTool';

/**
 * MCP tool: retrieve complete session content without any truncation.
 * Use when full fidelity is needed and token cost is acceptable.
 */
export class GetSessionFullTool implements IMcpTool {
    readonly name = 'chatwizard_get_session_full';
    readonly description =
        'Retrieve the complete, untruncated content of a specific chat session by ID. ' +
        'Prefer chatwizard_get_session for large sessions to avoid context window overflow.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            sessionId: {
                type: 'string',
                description: 'The unique session ID (returned by other chatwizard tools as "ID: ...").',
            },
        },
        required: ['sessionId'],
    };

    constructor(private readonly sessionIndex: SessionIndex) {}

    async execute(input: McpToolInput): Promise<McpToolResult> {
        const sessionId = input['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
            return {
                content: [{ type: 'text', text: 'Error: "sessionId" must be a non-empty string.' }],
                isError: true,
            };
        }

        const session = this.sessionIndex.get(sessionId.trim());
        if (!session) {
            return {
                content: [{ type: 'text', text: `Session not found: "${sessionId}". Use chatwizard_list_recent or chatwizard_search to discover session IDs.` }],
                isError: true,
            };
        }

        return {
            content: [{ type: 'text', text: formatSessionTranscript(session) }],
        };
    }
}
