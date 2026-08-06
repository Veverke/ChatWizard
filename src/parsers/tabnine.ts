// src/parsers/tabnine.ts
// Feature 42 — Tabnine Chat Source Support
//
// File format research notes:
// ─────────────────────────────────────────────────────────────────────────────
// Tabnine stores chat history in VS Code extension storage.
// Location: %APPDATA%\Code\User\globalStorage\TabNine.tabnine-vscode\chat\ (Windows)
//           ~/.config/Code/User/globalStorage/TabNine.tabnine-vscode/chat/ (Linux)
//           ~/Library/Application Support/Code/User/globalStorage/TabNine.tabnine-vscode/chat/ (macOS)
//
// Format: JSON files (one per conversation session), typically named with a UUID or timestamp.
// Schema observed from Tabnine chat history files:
// {
//   "id": "<string>",
//   "title": "<string | null>",
//   "messages": [
//     {
//       "id": "<string>",
//       "type": "user" | "bot" | "assistant",
//       "text": "<string>",
//       "timestamp": <epoch ms> | "<ISO-8601>"
//     }
//   ],
//   "createdAt": <epoch ms> | "<ISO-8601>"
// }
//
// Note: Tabnine may use 'bot' or 'assistant' for AI role. This parser handles both.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import type { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

interface TabnineRawMessage {
    id?: string;
    type?: string;
    role?: string;
    text?: string;
    content?: string;
    timestamp?: number | string;
}

interface TabnineChatFile {
    id?: string;
    title?: string;
    messages?: TabnineRawMessage[];
    createdAt?: number | string;
}

/**
 * Convert a Tabnine timestamp (epoch ms or ISO string) to an ISO string.
 */
function toIsoString(ts: number | string | undefined): string | undefined {
    if (ts === undefined || ts === null) { return undefined; }
    if (typeof ts === 'number') {
        return new Date(ts).toISOString();
    }
    if (typeof ts === 'string' && ts.length > 0) {
        return ts;
    }
    return undefined;
}

/**
 * Parse a Tabnine chat JSON file into a Session.
 *
 * Handles both 'type' and 'role' fields for message role identification,
 * and both 'text' and 'content' fields for message body.
 */
export function parseTabnineConversation(filePath: string): ParseResult {
    const fileId = path.basename(filePath, path.extname(filePath));

    const emptySession: Session = {
        id: fileId,
        title: fileId,
        source: 'tabnine',
        workspaceId: fileId,
        messages: [],
        filePath,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { session: emptySession, errors: [`Failed to read file: ${msg}`] };
    }

    let data: TabnineChatFile;
    try {
        data = JSON.parse(raw) as TabnineChatFile;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { session: emptySession, errors: [`Invalid JSON: ${msg}`] };
    }

    const rawMessages = data.messages ?? [];
    const errors: string[] = [];
    const messages: Message[] = [];

    // Parse session creation time
    const sessionCreatedAt = toIsoString(data.createdAt);

    let createdAt: string | undefined = sessionCreatedAt;
    let updatedAt: string | undefined = sessionCreatedAt;

    for (let i = 0; i < rawMessages.length; i++) {
        const rawMsg = rawMessages[i];

        // Determine role: support both 'type' and 'role' fields
        const rawRole = rawMsg.type ?? rawMsg.role ?? '';
        const isUser = rawRole === 'user';
        const isBot = rawRole === 'bot' || rawRole === 'assistant';
        if (!isUser && !isBot) { continue; }

        const role: 'user' | 'assistant' = isUser ? 'user' : 'assistant';

        // Support both 'text' and 'content' for message body
        const content = (typeof rawMsg.text === 'string' ? rawMsg.text : (rawMsg.content ?? '')).trim();
        if (!content) { continue; }

        const timestamp = toIsoString(rawMsg.timestamp);
        if (timestamp) {
            if (!createdAt) { createdAt = timestamp; }
            updatedAt = timestamp;
        }

        const messageIndex = messages.length;
        messages.push({
            id: rawMsg.id ?? `${fileId}-${messageIndex}`,
            role,
            content,
            codeBlocks: extractCodeBlocks(content, fileId, messageIndex),
            timestamp,
        });
    }

    // Derive title
    let title = data.title;
    if (!title || title.trim() === '') {
        const firstUser = messages.find(m => m.role === 'user');
        if (firstUser?.content) {
            const firstLine = firstUser.content.split('\n')[0];
            title = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
        } else {
            title = fileId;
        }
    }

    let fileSizeBytes: number | undefined;
    let fallbackTime: string | undefined;
    try {
        const stat = fs.statSync(filePath);
        fileSizeBytes = stat.size;
        if (!createdAt || !updatedAt) { fallbackTime = stat.mtime.toISOString(); }
    } catch { /* ignore */ }

    return {
        session: {
            id: data.id ?? fileId,
            title,
            source: 'tabnine',
            workspaceId: fileId,
            messages,
            filePath,
            fileSizeBytes,
            parseErrors: errors.length > 0 ? errors : undefined,
            createdAt: createdAt ?? fallbackTime ?? new Date(0).toISOString(),
            updatedAt: updatedAt ?? fallbackTime ?? new Date(0).toISOString(),
        },
        errors,
    };
}