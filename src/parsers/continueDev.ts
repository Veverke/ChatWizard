// src/parsers/continueDev.ts
// Parser for Continue.dev (continue.dev) session files.
//
// Continue.dev stores conversations in ~/.continue/sessions/ as JSON files.
// Each file is either:
//   - A JSONL file where each line is a message: { role, content, id?, model? }
//   - A JSON file with shape: { sessionId, title, history: [...messages] }
//
// Role values observed: 'user' | 'assistant' | 'human' (mapped to 'user')

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

interface ContinueMessage {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    id?: string;
    model?: string;
    timestamp?: number | string;
    stop_reason?: string;
    contextItems?: unknown[];
}

interface ContinueJsonFile {
    sessionId?: string;
    title?: string;
    history?: ContinueMessage[];
    // Some versions use 'messages' key
    messages?: ContinueMessage[];
    model?: string;
    createdAt?: string | number;
    updatedAt?: string | number;
}

function extractMessageText(content: string | Array<{ type: string; text?: string }> | undefined): string {
    if (!content) { return ''; }
    if (typeof content === 'string') { return content; }
    return content
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('');
}

/**
 * Parses a Continue.dev session file (JSON or JSONL) into a Session.
 */
export function parseContinueSession(filePath: string): ParseResult {
    const errors: string[] = [];
    const stem = path.basename(filePath, path.extname(filePath));
    const sessionId = stem;

    const emptySession: Session = {
        id: sessionId,
        title: sessionId,
        source: 'continue',
        workspaceId: sessionId,
        workspacePath: undefined,
        messages: [],
        filePath,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
        errors.push(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
        return { session: emptySession, errors };
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        errors.push('Empty file');
        return { session: emptySession, errors };
    }

    // Try JSON object format first
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed) as ContinueJsonFile;
            return parseContinueJsonFormat(filePath, sessionId, parsed, errors);
        } catch {
            // Fall through to JSONL
        }
    }

    // Try JSONL format (array-wrapped or line-per-message)
    if (trimmed.startsWith('[')) {
        try {
            const arr = JSON.parse(trimmed) as ContinueMessage[];
            if (Array.isArray(arr)) {
                return parseContinueMessages(filePath, sessionId, arr, errors);
            }
        } catch { /* fall through */ }
    }

    // JSONL: one message per line
    const messages: ContinueMessage[] = [];
    const lines = trimmed.split('\n');
    for (const line of lines) {
        const l = line.trim();
        if (!l) { continue; }
        try {
            const msg = JSON.parse(l) as ContinueMessage;
            if (msg && typeof msg === 'object') {
                messages.push(msg);
            }
        } catch {
            errors.push(`Skipped malformed JSONL line`);
        }
    }

    return parseContinueMessages(filePath, sessionId, messages, errors);
}

function parseContinueJsonFormat(
    filePath: string,
    fallbackId: string,
    parsed: ContinueJsonFile,
    errors: string[]
): ParseResult {
    const sessionId = parsed.sessionId ?? fallbackId;
    const rawMessages = parsed.history ?? parsed.messages ?? [];
    const title = parsed.title ?? sessionId;
    const model = parsed.model;

    const result = parseContinueMessages(filePath, sessionId, rawMessages, errors);
    result.session.id = sessionId;
    result.session.title = title;
    if (model) { result.session.model = model; }

    // Parse timestamps
    const ts = parsed.createdAt ?? parsed.updatedAt;
    if (ts) {
        const date = typeof ts === 'number' ? new Date(ts).toISOString() : String(ts);
        if (result.session.createdAt === new Date(0).toISOString()) {
            result.session.createdAt = date;
        }
    }

    return result;
}

function parseContinueMessages(
    filePath: string,
    sessionId: string,
    rawMessages: ContinueMessage[],
    errors: string[]
): ParseResult {
    const messages: Message[] = [];
    let model: string | undefined;
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;

    for (let i = 0; i < rawMessages.length; i++) {
        const raw = rawMessages[i];
        if (!raw || typeof raw !== 'object') { continue; }

        const rawRole = (raw.role ?? '').toLowerCase();
        // Map Continue roles to our standard roles
        const role: 'user' | 'assistant' =
            rawRole === 'assistant' ? 'assistant' : 'user';

        const content = extractMessageText(raw.content);
        if (!content) { continue; }

        // Extract model from assistant messages
        if (role === 'assistant' && raw.model && !model) {
            model = raw.model;
        }

        let timestamp: string | undefined;
        if (raw.timestamp) {
            try {
                const ts = typeof raw.timestamp === 'number'
                    ? new Date(raw.timestamp).toISOString()
                    : String(raw.timestamp);
                timestamp = ts;
                if (!firstTimestamp) { firstTimestamp = ts; }
                lastTimestamp = ts;
            } catch { /* ignore */ }
        }

        const msgId = raw.id ?? crypto.randomUUID();
        const codeBlocks = extractCodeBlocks(content, sessionId, i);

        messages.push({
            id: msgId,
            role,
            content,
            codeBlocks,
            timestamp,
        });
    }

    // Derive title from first user message
    const firstUser = messages.find(m => m.role === 'user');
    const title = firstUser
        ? firstUser.content.slice(0, 80).replace(/\s+/g, ' ').trim()
        : sessionId;

    // Try to get mtime as fallback timestamp
    let createdAt = firstTimestamp ?? new Date(0).toISOString();
    let updatedAt = lastTimestamp ?? createdAt;
    try {
        const stat = fs.statSync(filePath);
        if (firstTimestamp === undefined) {
            createdAt = stat.birthtime.toISOString();
        }
        if (lastTimestamp === undefined) {
            updatedAt = stat.mtime.toISOString();
        }
    } catch { /* ignore */ }

    const session: Session = {
        id: sessionId,
        title,
        source: 'continue',
        workspaceId: sessionId,
        messages,
        filePath,
        model,
        createdAt,
        updatedAt,
        parseErrors: errors.length > 0 ? errors : undefined,
    };

    return { session, errors };
}
