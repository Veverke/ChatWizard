// src/parsers/geminiCodeAssist.ts
// Parser for Gemini Code Assist (google.google-cloud-code) conversation files.
//
// Gemini Code Assist stores conversations as JSON files with this general shape:
//
//   { id, title?, model?, messages: [ { role: 'user'|'model'|'assistant', parts: [...] } ] }
//
// The 'model' role is Google's naming for 'assistant'. The 'parts' field mirrors the
// Google Generative AI SDK shape: [ { text: string } ] or [ { content: string } ].

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

// ─── Raw types ────────────────────────────────────────────────────────────────

interface GeminiPart {
    text?: string;
    content?: string;
    inlineData?: unknown; // binary blobs — skip
}

interface GeminiMessage {
    role?: string;
    parts?: GeminiPart[];
    // Alternate flat shapes
    content?: string | GeminiPart[];
    timestamp?: number | string;
    id?: string;
    model?: string;
}

interface GeminiConversation {
    id?: string;
    conversationId?: string;
    title?: string;
    model?: string;
    messages?: GeminiMessage[];
    history?: GeminiMessage[];
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

function extractGeminiText(msg: GeminiMessage): string {
    // parts-based (standard Gemini SDK)
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
        return msg.parts
            .filter(p => typeof p.text === 'string' || typeof p.content === 'string')
            .map(p => (p.text ?? p.content ?? '').trim())
            .join('\n');
    }
    // flat content field
    if (typeof msg.content === 'string') { return msg.content; }
    if (Array.isArray(msg.content)) {
        return (msg.content as Array<{ type?: string; text?: string; content?: string }>)
            .filter(p => (!p.type || p.type === 'text') && (p.text ?? p.content))
            .map(p => p.text ?? p.content ?? '')
            .join('');
    }
    return '';
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseGeminiCodeAssistSession(filePath: string): ParseResult {
    const errors: string[] = [];
    const stem = path.basename(filePath, path.extname(filePath));
    const fallbackId = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);

    const emptySession: Session = {
        id: fallbackId,
        title: stem,
        source: 'geminiCodeAssist',
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
        errors.push(`Failed to read: ${err instanceof Error ? err.message : String(err)}`);
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

    const obj = parsed as GeminiConversation;
    const sessionId = obj.id ?? obj.conversationId ?? fallbackId;
    const title = obj.title ?? stem;
    const model = obj.model;
    const createdAt = toIso(obj.createdAt) ?? new Date(0).toISOString();
    const updatedAt = toIso(obj.updatedAt) ?? createdAt;

    const rawMessages: GeminiMessage[] =
        Array.isArray(obj.messages) ? obj.messages :
        Array.isArray(obj.history) ? obj.history : [];

    const messages: Message[] = [];

    for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (!m || typeof m !== 'object') { continue; }

        const rawRole = (m.role ?? '').toLowerCase();
        // Gemini uses 'model' for assistant turns
        let role: 'user' | 'assistant';
        if (rawRole === 'user' || rawRole === 'human') {
            role = 'user';
        } else if (rawRole === 'model' || rawRole === 'assistant') {
            role = 'assistant';
        } else {
            continue; // skip 'system', 'context', etc.
        }

        const content = extractGeminiText(m);
        if (!content) { continue; }

        const timestamp = toIso(m.timestamp);

        messages.push({
            id: m.id ?? crypto.randomUUID(),
            role,
            content,
            codeBlocks: extractCodeBlocks(content, sessionId, i),
            timestamp,
        });
    }

    // Derive title from first user message if none given
    const derivedTitle = title !== stem ? title : (() => {
        const firstUser = messages.find(m => m.role === 'user');
        return firstUser ? firstUser.content.slice(0, 80).replace(/\s+/g, ' ').trim() : stem;
    })();

    const session: Session = {
        id: sessionId,
        title: derivedTitle,
        source: 'geminiCodeAssist',
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
