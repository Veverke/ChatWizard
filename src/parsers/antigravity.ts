// src/parsers/antigravity.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';
import { AntigravityConversationInfo } from '../types/index';

/** Maximum characters to keep in a title derived from the first user message. */
const MAX_TITLE_CHARS = 120;

// ─── Raw JSONL step shape (brain/.system_generated/logs/overview.txt) ─────────

interface OverviewStep {
    step_index?: number;
    source?: 'USER_EXPLICIT' | 'MODEL' | string;
    type?: 'USER_INPUT' | 'PLANNER_RESPONSE' | string;
    status?: string;
    created_at?: string;   // ISO-8601, e.g. "2026-04-22T19:23:56Z"
    content?: string;
    tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the user-visible request text from an Antigravity USER_INPUT content block.
 *
 * The content field wraps the actual message in an XML-like envelope:
 *   <USER_REQUEST>
 *   actual user message here
 *   </USER_REQUEST>
 *   <ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>
 *   ...
 *
 * If no <USER_REQUEST> block is present, returns the raw content trimmed.
 */
function extractUserRequestText(content: string): string {
    const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
    if (match) {
        return match[1].trim();
    }
    return content.trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses a single Antigravity conversation from its `overview.txt` JSONL log.
 *
 * @param info  Descriptor returned by `discoverAntigravityConversationsAsync`.
 */
export function parseAntigravityConversation(info: AntigravityConversationInfo): ParseResult {
    const errors: string[] = [];
    const { conversationId, overviewFile } = info;

    const emptySession: Session = {
        id: conversationId,
        title: conversationId,
        source: 'antigravity',
        workspaceId: conversationId,
        workspacePath: undefined,
        messages: [],
        filePath: overviewFile,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(overviewFile, 'utf-8');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${message}`);
        return { session: emptySession, errors };
    }

    const lines = raw.split('\n');
    const messages: Message[] = [];
    let sessionCreatedAt: string | undefined;
    let sessionUpdatedAt: string | undefined;
    let title: string | undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { continue; }

        let step: OverviewStep;
        try {
            step = JSON.parse(line) as OverviewStep;
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON — skipped`);
            continue;
        }

        const { source, type, content, created_at } = step;

        // Track session time bounds from ISO timestamps in steps.
        if (created_at) {
            if (!sessionCreatedAt) { sessionCreatedAt = created_at; }
            sessionUpdatedAt = created_at;
        }

        const msgIndex = messages.length;

        if (source === 'USER_EXPLICIT' && type === 'USER_INPUT' && content) {
            const text = extractUserRequestText(content);
            if (!text) { continue; }

            const codeBlocks = extractCodeBlocks(text, conversationId, msgIndex);
            messages.push({
                id: `${conversationId}-${msgIndex}`,
                role: 'user',
                content: text,
                codeBlocks,
                timestamp: created_at,
            });

            if (!title) {
                title = text.slice(0, MAX_TITLE_CHARS).replace(/\s+/g, ' ').trim();
            }
        } else if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content) {
            // Only include model steps that carry narrative text; tool-only steps are skipped.
            const text = content.trim();
            if (!text) { continue; }

            const codeBlocks = extractCodeBlocks(text, conversationId, msgIndex);
            messages.push({
                id: `${conversationId}-${msgIndex}`,
                role: 'assistant',
                content: text,
                codeBlocks,
                timestamp: created_at,
            });
        }
    }

    if (messages.length === 0) {
        return { session: emptySession, errors };
    }

    const createdAt  = sessionCreatedAt  ? new Date(sessionCreatedAt).toISOString()  : new Date(0).toISOString();
    const updatedAt  = sessionUpdatedAt  ? new Date(sessionUpdatedAt).toISOString()  : createdAt;

    const fileSizeBytes = (() => {
        try { return fs.statSync(overviewFile).size; } catch { return undefined; }
    })();

    const session: Session = {
        id: conversationId,
        title: title ?? conversationId,
        source: 'antigravity',
        workspaceId: conversationId,
        workspacePath: undefined,
        messages,
        filePath: overviewFile,
        fileSizeBytes,
        createdAt,
        updatedAt,
        parseErrors: errors.length > 0 ? errors : undefined,
    };

    return { session, errors };
}

/**
 * Extracts fenced code blocks from an Antigravity message.
 * Delegates to the shared extractor used by other parsers.
 */
export function extractAntigravityCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
) {
    return extractCodeBlocks(content, sessionId, messageIndex);
}

/** Re-export the overview file path helper for use in file-watching. */
export function overviewFilePath(brainDir: string, conversationId: string): string {
    return path.join(brainDir, conversationId, '.system_generated', 'logs', 'overview.txt');
}
