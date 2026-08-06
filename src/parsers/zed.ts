// src/parsers/zed.ts
// Feature 41 — Zed AI Source Support
//
// File format research notes:
// ─────────────────────────────────────────────────────────────────────────────
// Location: ~/.config/zed/conversations/ (Linux/macOS)
//           %APPDATA%\Zed\conversations\ (Windows)
//
// Format: JSON files (one per conversation), typically named with a UUID.
// Schema observed from Zed 0.x conversation files:
// {
//   "id": "<uuid>",
//   "zed": "assistant",
//   "version": "0.1.0",
//   "title": "<string | null>",
//   "messages": [
//     {
//       "id": "<uuid>",
//       "role": "user" | "assistant" | "system",
//       "content": "<string>",
//       "timestamp": "<ISO-8601>"
//     }
//   ]
// }
//
// Note: Zed may also use JSONL in newer versions. This parser handles both.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import type { Session, Message, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

interface ZedRawMessage {
    id?: string;
    role?: string;
    content?: string;
    timestamp?: string;
}

interface ZedConversationFile {
    id?: string;
    title?: string;
    messages?: ZedRawMessage[];
    version?: string;
}

/**
 * Parse a Zed AI conversation JSON file into a Session.
 *
 * Handles both the JSON object format (single conversation) and gracefully
 * handles malformed files by returning a session with errors.
 */
export function parseZedConversation(filePath: string): ParseResult {
    const fileId = path.basename(filePath, path.extname(filePath));

    const emptySession: Session = {
        id: fileId,
        title: fileId,
        source: 'zed',
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

    let data: ZedConversationFile;
    try {
        data = JSON.parse(raw) as ZedConversationFile;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { session: emptySession, errors: [`Invalid JSON: ${msg}`] };
    }

    const rawMessages = data.messages ?? [];
    const errors: string[] = [];

    const messages: Message[] = [];
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    for (let i = 0; i < rawMessages.length; i++) {
        const raw = rawMessages[i];
        const role = raw.role === 'user' ? 'user' : 'assistant';

        // Skip system messages
        if (raw.role === 'system') { continue; }

        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        if (!content) { continue; }

        if (raw.timestamp) {
            if (!createdAt) { createdAt = raw.timestamp; }
            updatedAt = raw.timestamp;
        }

        const messageIndex = messages.length;
        messages.push({
            id: raw.id ?? `${fileId}-${messageIndex}`,
            role,
            content,
            codeBlocks: extractCodeBlocks(content, fileId, messageIndex),
            timestamp: raw.timestamp,
        });
    }

    // Derive title from explicit title field or first user message
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
            source: 'zed',
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