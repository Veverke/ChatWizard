// src/parsers/amazonQ.ts
// Parser for Amazon Q Developer (amazonwebservices.amazon-q-vscode) session files.
//
// Amazon Q stores conversations as JSON files. Known shapes observed in the wild:
//
//  Shape A (history/):
//    { conversationId, title, messages: [ { id, type: 'prompt'|'answer', body, time? } ] }
//
//  Shape B (newer builds):
//    { id, messages: [ { sender: 'USER'|'ASSISTANT', content: string, time?: number } ] }
//
//  Only chat-panel conversations are indexed (completions / inline suggestions are skipped).

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

// ─── Raw shape definitions ────────────────────────────────────────────────────

interface ShapeAMessage {
    id?: string;
    type?: 'prompt' | 'answer' | string;
    body?: string;
    content?: string;
    time?: number | string;
}

interface ShapeA {
    conversationId?: string;
    id?: string;
    title?: string;
    messages?: ShapeAMessage[];
    createdAt?: number | string;
    updatedAt?: number | string;
}

interface ShapeBMessage {
    sender?: 'USER' | 'ASSISTANT' | string;
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    time?: number | string;
    timestamp?: number | string;
    model?: string;
}

interface ShapeB {
    id?: string;
    sessionId?: string;
    title?: string;
    messages?: ShapeBMessage[];
    model?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toIso(ts: number | string | undefined): string | undefined {
    if (ts === undefined || ts === null) { return undefined; }
    try {
        const n = typeof ts === 'number' ? ts : Date.parse(String(ts));
        if (isNaN(n)) { return undefined; }
        return new Date(n).toISOString();
    } catch { return undefined; }
}

function extractContentText(c: string | Array<{ type: string; text?: string }> | undefined): string {
    if (!c) { return ''; }
    if (typeof c === 'string') { return c; }
    return c.filter(p => p.type === 'text' && p.text).map(p => p.text!).join('');
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseAmazonQSession(filePath: string): ParseResult {
    const errors: string[] = [];
    const stem = path.basename(filePath, path.extname(filePath));
    const fallbackId = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);

    const emptySession: Session = {
        id: fallbackId,
        title: stem,
        source: 'amazonq',
        workspaceId: fallbackId,
        messages: [],
        filePath,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        errors.push(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
        return { session: emptySession, errors };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.trim());
    } catch {
        errors.push('Invalid JSON');
        return { session: emptySession, errors };
    }

    if (!parsed || typeof parsed !== 'object') {
        errors.push('Unexpected JSON shape');
        return { session: emptySession, errors };
    }

    const obj = parsed as ShapeA & ShapeB;
    const sessionId = obj.conversationId ?? obj.id ?? obj.sessionId ?? fallbackId;
    const title = obj.title ?? stem;
    const model = (obj as ShapeB).model;
    const createdAt = toIso(obj.createdAt) ?? new Date(0).toISOString();
    const updatedAt = toIso(obj.updatedAt) ?? createdAt;

    // Normalise messages from either shape
    const rawMessages: Array<ShapeAMessage & ShapeBMessage> =
        (Array.isArray(obj.messages) ? obj.messages : []) as Array<ShapeAMessage & ShapeBMessage>;

    const messages: Message[] = [];

    for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (!m || typeof m !== 'object') { continue; }

        // Role resolution: Shape A uses 'type', Shape B uses 'sender' or 'role'
        const rawType = (m.type ?? '').toLowerCase();
        const rawSender = (m.sender ?? m.role ?? '').toLowerCase();
        let role: 'user' | 'assistant';

        if (rawType === 'prompt' || rawSender === 'user' || rawSender === 'human') {
            role = 'user';
        } else if (rawType === 'answer' || rawSender === 'assistant') {
            role = 'assistant';
        } else {
            continue; // skip unknown types (e.g. system, context)
        }

        const content = extractContentText(m.content ?? m.body);
        if (!content) { continue; }

        const timestamp = toIso(m.time ?? m.timestamp);

        messages.push({
            id: m.id ?? crypto.randomUUID(),
            role,
            content,
            codeBlocks: extractCodeBlocks(content, sessionId, i),
            timestamp,
        });
    }

    // Derive title from first user message if none provided
    const derivedTitle = title !== stem ? title : (() => {
        const firstUser = messages.find(m => m.role === 'user');
        return firstUser ? firstUser.content.slice(0, 80).replace(/\s+/g, ' ').trim() : stem;
    })();

    const session: Session = {
        id: sessionId,
        title: derivedTitle,
        source: 'amazonq',
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
