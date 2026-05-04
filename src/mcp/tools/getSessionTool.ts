// src/mcp/tools/getSessionTool.ts

import { IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { Session } from '../../types/index';

const DEFAULT_MAX_CHARS = 4000;
const TRUNCATION_NOTE = '\n[truncated — use chatwizard_get_session_full for complete content]';

/**
 * Format a session as a readable conversation transcript.
 * Truncates to maxChars if provided (undefined = no truncation).
 */
export function formatSessionTranscript(session: Session, maxChars?: number): string {
    const header = [
        `Session: ${session.title}`,
        `Source: ${session.source}`,
        `Date: ${session.updatedAt}`,
        `Messages: ${session.messages.length}`,
        '---',
    ].join('\n');

    const messageParts: string[] = [];
    for (const msg of session.messages) {
        const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
        const ts = msg.timestamp ? ` [${msg.timestamp}]` : '';
        messageParts.push(`${roleLabel}${ts}:\n${msg.content}`);
    }

    const body = messageParts.join('\n\n');
    const full = `${header}\n\n${body}`;

    if (maxChars === undefined) {
        return full;
    }

    if (full.length <= maxChars) {
        return full;
    }

    return full.slice(0, maxChars) + TRUNCATION_NOTE;
}

/**
 * MCP tool: retrieve session content, truncated at maxChars.
 */
export class GetSessionTool implements IMcpTool {
    readonly name = 'chatwizard_get_session';
    readonly description =
        'Retrieve the content of a specific chat session by ID, truncated to avoid context overflow. ' +
        `Defaults to ${DEFAULT_MAX_CHARS} characters. ` +
        'Use chatwizard_get_session_full for the complete untruncated content.';

    readonly inputSchema = {
        type: 'object',
        properties: {
            sessionId: {
                type: 'string',
                description: 'The unique session ID (returned by other chatwizard tools as "ID: ...").',
            },
            maxChars: {
                type: 'number',
                description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).`,
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

        const rawMax = input['maxChars'];
        const maxChars = typeof rawMax === 'number' && rawMax > 0
            ? Math.round(rawMax)
            : DEFAULT_MAX_CHARS;

        return {
            content: [{ type: 'text', text: formatSessionTranscript(session, maxChars) }],
        };
    }
}
