// src/parsers/claude.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult } from '../types/index';

// SEC-7: Maximum size of a single JSONL line (characters) before it is skipped.
const MAX_LINE_CHARS = 1_000_000; // 1 MB

/**
 * Returns true if the entire text of a content part is a system-injected
 * XML context block (e.g. <ide_opened_file>…</ide_opened_file>).
 * These are injected by Claude Code automatically and are not user content.
 */
function isInjectedContext(text: string): boolean {
    return /^\s*<[\w-]+>[\s\S]*?<\/[\w-]+>\s*$/.test(text);
}

/**
 * Concatenates text parts from a Claude message content array.
 * Skips non-text parts (tool_use, tool_result, thinking, etc.) and
 * skips parts whose entire text is a system-injected context block.
 */
export function extractTextContent(
    contentParts: Array<{ type: string; text?: string }>
): string {
    return contentParts
        .filter((part) => part.type === 'text' && typeof part.text === 'string' && !isInjectedContext(part.text))
        .map((part) => part.text as string)
        .join('');
}

/**
 * Extracts fenced code blocks from message text.
 * Matches ``` optionalLanguage\ncontent\n``` patterns.
 */
export function extractCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(content)) !== null) {
        blocks.push({
            language: match[1] ?? '',
            content: match[2].trim(),
            sessionId,
            messageIndex,
        });
    }

    return blocks;
}

/**
 * Parses a Claude Code JSONL conversation file into a Session.
 *
 * @param filePath Absolute path to the .jsonl file
 */
export function parseClaudeSession(filePath: string): ParseResult {
    const errors: string[] = [];

    const filenameId = path.basename(filePath, path.extname(filePath));
    const emptySession: Session = {
        id: filenameId,
        title: filenameId,
        source: 'claude',
        workspaceId: filenameId,
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
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${message}`);
        return { session: emptySession, errors };
    }

    const lines = raw.split('\n');

    interface RawEntry {
        type: string;
        summary?: string;
        uuid?: string;
        sessionId?: string;
        cwd?: string;
        timestamp?: string;
        message?: {
            role: string;
            model?: string;
            content: Array<{ type: string; text?: string }> | string;
        };
    }

    const entries: RawEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { continue; }
        // SEC-7: skip oversized lines to prevent memory/CPU exhaustion in JSON.parse
        if (line.length > MAX_LINE_CHARS) {
            errors.push(`Line ${i + 1}: skipped — length ${line.length} exceeds limit`);
            continue;
        }
        try {
            entries.push(JSON.parse(line) as RawEntry);
        } catch {
            errors.push(`Line ${i + 1}: Invalid JSON — ${line.slice(0, 80)}`);
        }
    }

    let summaryText: string | undefined;
    let sessionId: string | undefined;
    let workspacePath: string | undefined;
    let model: string | undefined;
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    for (const entry of entries) {
        if (entry.type === 'summary' && entry.summary) {
            summaryText = entry.summary;
        }

        if (
            (entry.type === 'human' || entry.type === 'user' || entry.type === 'assistant') &&
            entry.sessionId && !sessionId
        ) {
            sessionId = entry.sessionId;
        }

        if ((entry.type === 'human' || entry.type === 'user') && entry.cwd && !workspacePath) {
            workspacePath = entry.cwd;
        }

        if (entry.type === 'assistant' && entry.message?.model && !model) {
            model = entry.message.model;
        }

        if (entry.timestamp) {
            if (!createdAt) { createdAt = entry.timestamp; }
            updatedAt = entry.timestamp;
        }
    }

    const resolvedId = sessionId ?? filenameId;

    const messages: Message[] = [];

    for (const entry of entries) {
        if (entry.type !== 'human' && entry.type !== 'user' && entry.type !== 'assistant') {
            continue;
        }

        const role = (entry.type === 'human' || entry.type === 'user') ? 'user' : 'assistant';
        const rawContent = entry.message?.content ?? [];
        const contentParts = Array.isArray(rawContent)
            ? rawContent
            : [{ type: 'text', text: String(rawContent) }];
        const content = extractTextContent(contentParts);

        // Skip messages with no visible text (e.g. tool-only or thinking-only turns)
        if (!content.trim()) { continue; }

        const messageIndex = messages.length;
        messages.push({
            id: entry.uuid ?? `${resolvedId}-${messageIndex}`,
            role,
            content,
            codeBlocks: extractCodeBlocks(content, resolvedId, messageIndex),
            timestamp: entry.timestamp,
        });
    }

    let title: string;
    if (summaryText) {
        title = summaryText;
    } else {
        const firstUserMessage = messages.find((m) => m.role === 'user');
        title = firstUserMessage ? firstUserMessage.content.slice(0, 60) : resolvedId;
    }

    let fallbackTime: string | undefined;
    let fileSizeBytes: number | undefined;
    try {
        const stat = fs.statSync(filePath);
        fileSizeBytes = stat.size;
        if (!createdAt || !updatedAt) { fallbackTime = stat.mtime.toISOString(); }
    } catch {
        // ignore — optional fields
    }

    return {
        session: {
            id: resolvedId,
            title,
            source: 'claude',
            workspaceId: resolvedId,
            workspacePath,
            model,
            messages,
            filePath,
            fileSizeBytes,
            createdAt: createdAt ?? fallbackTime ?? new Date(0).toISOString(),
            updatedAt: updatedAt ?? fallbackTime ?? new Date(0).toISOString(),
        },
        errors,
    };
}
