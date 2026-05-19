// src/parsers/antigravity.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';
import { AntigravityConversationInfo, AntigravityJsonConversationInfo } from '../types/index';

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
        return stripTruncationMarker(match[1].trim());
    }
    return stripTruncationMarker(content.trim());
}

/**
 * Removes the `<truncated N bytes>` suffix that Antigravity appends to content
 * fields when the stored text was cut off in overview.txt.
 */
function stripTruncationMarker(text: string): string {
    return text.replace(/<truncated \d+ bytes>\s*$/, '').trimEnd();
}

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
            // Skip re-injected user messages (Antigravity re-feeds the original
            // request after each internal tool-call planning phase; the extracted
            // text is identical to the message already in the list).
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === 'user' && lastMsg.content === text) { continue; }

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
            const text = stripTruncationMarker(content.trim());
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

    const createdAt = (() => {
        if (sessionCreatedAt) {
            try {
                const date = new Date(sessionCreatedAt);
                if (!isNaN(date.getTime())) {
                    return date.toISOString();
                }
                throw new Error('Invalid date');
            } catch {
                errors.push('Invalid sessionCreatedAt, falling back to epoch');
            }
        }
        return new Date(0).toISOString();
    })();

    const updatedAt = (() => {
        if (sessionUpdatedAt) {
            try {
                const date = new Date(sessionUpdatedAt);
                if (!isNaN(date.getTime())) {
                    return date.toISOString();
                }
                throw new Error('Invalid date');
            } catch {
                errors.push('Invalid sessionUpdatedAt, falling back to createdAt');
            }
        }
        return createdAt;
    })();

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
        sourceNotes: [
            'Antigravity — prompts only. AI responses are not available from disk: ' +
            'Antigravity stores conversation content in an encrypted format that requires ' +
            'the running Language Server to decode. Only your prompts are shown here. ' +
            'Prompt Library, search, analytics, and timeline work fully.',
        ],
    };

    return { session, errors };
}

// ─── JSON conversation parser ─────────────────────────────────────────────────

export interface AntigravityJsonMessage {
    role: 'user' | 'model';
    parts: Array<{ text?: string }>;
    createTime?: string; // ISO-8601
}

export interface AntigravityJsonConversation {
    conversationId?: string;
    messages?: AntigravityJsonMessage[];
    createTime?: string;
    updateTime?: string;
}

/**
 * Parses an Antigravity conversations/*.json file into a `ParseResult`.
 * Maps `role: 'model'` → `role: 'assistant'`.
 * Never throws; populates `errors[]` on malformed JSON.
 */
export function parseAntigravityJsonConversation(
    info: AntigravityJsonConversationInfo
): ParseResult {
    const { conversationId, jsonFile } = info;
    const errors: string[] = [];

    const emptySession: Session = {
        id: conversationId,
        title: conversationId,
        source: 'antigravity',
        subSource: 'conversations',
        workspaceId: conversationId,
        workspacePath: undefined,
        messages: [],
        filePath: jsonFile,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(jsonFile, 'utf-8');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${message}`);
        return { session: emptySession, errors };
    }

    let parsed: AntigravityJsonConversation;
    try {
        parsed = JSON.parse(raw) as AntigravityJsonConversation;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to parse JSON: ${message}`);
        return { session: emptySession, errors };
    }

    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const messages: Message[] = [];

    for (let i = 0; i < rawMessages.length; i++) {
        const raw = rawMessages[i];
        const rawRole = raw.role ?? '';
        let role: 'user' | 'assistant';
        if (rawRole === 'user') {
            role = 'user';
        } else if (rawRole === 'model') {
            role = 'assistant';
        } else {
            // Skip unknown roles
            continue;
        }

        const text = (raw.parts ?? [])
            .map(p => p.text ?? '')
            .join('')
            .trim();
        if (!text) { continue; }

        const timestamp = raw.createTime ?? undefined;
        const codeBlocks = extractCodeBlocks(text, conversationId, i);
        messages.push({
            id: `${conversationId}-${i}`,
            role,
            content: text,
            codeBlocks,
            timestamp,
        });
    }

    // Derive title from first user message
    const firstUser = messages.find(m => m.role === 'user');
    const title = firstUser
        ? firstUser.content.slice(0, MAX_TITLE_CHARS).replace(/\s+/g, ' ').trim()
        : conversationId;

    const createdAt = (() => {
        if (parsed.createTime) {
            try {
                const d = new Date(parsed.createTime);
                if (!isNaN(d.getTime())) { return d.toISOString(); }
            } catch { /* fall through */ }
        }
        if (messages[0]?.timestamp) {
            try {
                const d = new Date(messages[0].timestamp);
                if (!isNaN(d.getTime())) { return d.toISOString(); }
            } catch { /* fall through */ }
        }
        return new Date(0).toISOString();
    })();

    const updatedAt = (() => {
        if (parsed.updateTime) {
            try {
                const d = new Date(parsed.updateTime);
                if (!isNaN(d.getTime())) { return d.toISOString(); }
            } catch { /* fall through */ }
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.timestamp) {
            try {
                const d = new Date(lastMsg.timestamp);
                if (!isNaN(d.getTime())) { return d.toISOString(); }
            } catch { /* fall through */ }
        }
        return createdAt;
    })();

    const fileSizeBytes = (() => {
        try { return fs.statSync(jsonFile).size; } catch { return undefined; }
    })();

    const session: Session = {
        id: conversationId,
        title,
        source: 'antigravity',
        subSource: 'conversations',
        workspaceId: conversationId,
        workspacePath: undefined,
        messages,
        filePath: jsonFile,
        fileSizeBytes,
        createdAt,
        updatedAt,
        parseErrors: errors.length > 0 ? errors : undefined,
    };

    return { session, errors };
}
