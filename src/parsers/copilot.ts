// src/parsers/copilot.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult, MessageRole } from '../types/index';

// ---------------------------------------------------------------------------
// Internal snapshot/patch shapes
// ---------------------------------------------------------------------------

interface SnapshotLine {
    kind: 0;
    v: Record<string, unknown>;
}

interface PatchLine {
    kind: 1 | 2;
    k: unknown[];
    v: unknown;
}

interface RequestTurn {
    requestId?: string;
    timestamp?: number;
    message?: { text?: string };
    response?: Array<Record<string, unknown>>;
    kind?: string; // null/undefined = actual conversation turn; other values = tool/thinking/etc.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msToIso(ms: number): string {
    return new Date(ms).toISOString();
}

/**
 * Applies a deep key-path update to `obj`.
 * e.g. deepSet(state, ['requests', 0, 'response'], [...])
 */
function deepSet(obj: unknown, keys: unknown[], value: unknown): void {
    let current: unknown = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (Array.isArray(current) && typeof key === 'number') {
            current = (current as unknown[])[key];
        } else if (typeof current === 'object' && current !== null) {
            current = (current as Record<string, unknown>)[String(key)];
        } else {
            return;
        }
    }
    const lastKey = keys[keys.length - 1];
    if (Array.isArray(current) && typeof lastKey === 'number') {
        (current as unknown[])[lastKey] = value;
    } else if (typeof current === 'object' && current !== null) {
        (current as Record<string, unknown>)[String(lastKey)] = value;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts fenced code blocks from message text.
 */
export function extractCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const language = match[1].trim();
        const blockContent = match[2].trim();
        blocks.push({ language, content: blockContent, sessionId, messageIndex });
    }

    return blocks;
}

/**
 * Parses a Copilot Chat JSONL file (snapshot + patch format) into a Session.
 *
 * Format:
 *   Line kind=0  → full state snapshot  { kind:0, v: { sessionId, creationDate, requests:[], ... } }
 *   Line kind=1  → single-key patch     { kind:1, k:[...path], v: newValue }
 *   Line kind=2  → array/value replace  { kind:2, k:[...path], v: newValue }
 *
 * After replaying all patches, state.requests contains conversation items.
 * Items with kind===null/undefined are actual user+AI exchanges.
 *   turn.message.text  → user prompt
 *   turn.response[]    → AI response parts; items with a `value` field and no `kind` = text
 */
export function parseCopilotSession(
    filePath: string,
    workspaceId: string,
    workspacePath?: string
): ParseResult {
    const errors: string[] = [];

    const fallbackId = path.basename(filePath, path.extname(filePath));
    const emptySession = (): Session => ({
        id: fallbackId,
        title: 'Untitled Session',
        source: 'copilot',
        workspaceId,
        workspacePath,
        messages: [],
        filePath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${msg}`);
        return { session: emptySession(), errors };
    }

    const lines = raw.split('\n');

    let state: Record<string, unknown> | undefined;
    const patches: PatchLine[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { continue; }
        try {
            const obj = JSON.parse(line) as SnapshotLine | PatchLine;
            if (obj.kind === 0) {
                state = (obj as SnapshotLine).v;
            } else if ((obj.kind === 1 || obj.kind === 2) && Array.isArray((obj as PatchLine).k)) {
                patches.push(obj as PatchLine);
            }
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON`);
        }
    }

    if (!state) {
        errors.push('No initial state snapshot (kind:0) found');
        return { session: emptySession(), errors };
    }

    // Apply patches to reconstruct final state
    for (const patch of patches) {
        try {
            deepSet(state, patch.k, patch.v);
        } catch {
            // Ignore unapplicable patches
        }
    }

    // Extract session metadata
    const sessionId = (state.sessionId as string | undefined) ?? fallbackId;
    const customTitle = state.customTitle as string | undefined;
    const creationDateMs = state.creationDate as number | undefined;
    const selectedModel = state.selectedModel as { metadata?: { name?: string } } | undefined;
    const model = selectedModel?.metadata?.name;

    // Conversation turns: null/undefined kind = actual user+AI exchange
    const allRequests = (state.requests as RequestTurn[] | undefined) ?? [];
    const turns = allRequests.filter(r => r.kind === null || r.kind === undefined);

    const messages: Message[] = [];

    for (const turn of turns) {
        const userText = turn.message?.text ?? '';
        const timestampMs = turn.timestamp;
        const timestampIso = timestampMs !== undefined ? msToIso(timestampMs) : undefined;
        const requestId = turn.requestId;

        if (userText) {
            const userMsgIndex = messages.length;
            messages.push({
                id: requestId ?? `${sessionId}-${userMsgIndex}`,
                role: 'user' as MessageRole,
                content: userText,
                codeBlocks: extractCodeBlocks(userText, sessionId, userMsgIndex),
                timestamp: timestampIso,
            });
        }

        // AI response: items with a `value` string and no `kind` field (kind present = metadata)
        const responseItems = turn.response ?? [];
        const aiTextParts = responseItems
            .filter(item => typeof item.value === 'string' && !item.kind)
            .map(item => item.value as string);
        const aiText = aiTextParts.join('\n').trim();

        if (aiText) {
            const asstMsgIndex = messages.length;
            messages.push({
                id: `${requestId ?? sessionId}-response`,
                role: 'assistant' as MessageRole,
                content: aiText,
                codeBlocks: extractCodeBlocks(aiText, sessionId, asstMsgIndex),
                timestamp: timestampIso,
            });
        }
    }

    // Title: prefer explicit customTitle, then first user message, then fallback
    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = customTitle
        ?? (firstUserMsg ? firstUserMsg.content.slice(0, 60) : 'Untitled Session');

    let fileSizeBytes: number | undefined;
    let fileBirthtime: string | undefined;
    try {
        const stat = fs.statSync(filePath);
        fileSizeBytes = stat.size;
        fileBirthtime = stat.birthtime.toISOString();
    } catch {
        // ignore — optional fields
    }

    const createdAt = creationDateMs !== undefined
        ? msToIso(creationDateMs)
        : (fileBirthtime ?? new Date().toISOString());

    const lastMsg = messages[messages.length - 1];
    const updatedAt = lastMsg?.timestamp ?? createdAt;

    return {
        session: {
            id: sessionId,
            title,
            source: 'copilot',
            workspaceId,
            workspacePath,
            model,
            messages,
            filePath,
            fileSizeBytes,
            createdAt,
            updatedAt,
        },
        errors,
    };
}
