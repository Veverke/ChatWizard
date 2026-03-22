// src/parsers/claude.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult } from '../types/index';

// SEC-7: Default maximum size of a single JSONL line (characters) before it is skipped.
// Configurable via chatwizard.maxLineLengthChars.
export const DEFAULT_MAX_LINE_CHARS = 1_000_000; // 1 MB

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
            blockIndexInMessage: blocks.length,
        });
    }

    return blocks;
}

/**
 * Parses a Claude Code JSONL conversation file into a Session.
 *
 * @param filePath      Absolute path to the .jsonl file
 * @param maxLineChars  Lines longer than this (chars) are replaced by a skipped-message
 *                      placeholder instead of being silently dropped.
 *                      Defaults to DEFAULT_MAX_LINE_CHARS.
 */
export function parseClaudeSession(filePath: string, maxLineChars = DEFAULT_MAX_LINE_CHARS): ParseResult {
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
        // SEC-7: skip oversized lines to prevent memory/CPU exhaustion in JSON.parse.
        // Instead of silently dropping the turn, push a placeholder entry so the
        // session viewer can show a notice at the correct position.
        if (line.length > maxLineChars) {
            errors.push(`Line ${i + 1}: skipped — length ${line.length} exceeds limit`);
            // Try to detect the role from the raw text so the placeholder is placed correctly.
            const typeMatch = /^[^"]*"type"\s*:\s*"(human|user)"/.exec(line);
            const placeholderRole: 'user' | 'assistant' = typeMatch ? 'user' : 'assistant';
            entries.push({
                type: placeholderRole === 'user' ? 'human' : 'assistant',
                uuid: `__skipped_line_${i + 1}__`,
                message: {
                    role: placeholderRole,
                    content: `__SKIPPED__:${line.length}:${maxLineChars}`,
                },
            });
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

        if (entry.type === 'assistant' && entry.message?.model && entry.message.model !== '<synthetic>' && !model) {
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
        const rawContentStr = Array.isArray(rawContent) ? '' : String(rawContent);

        // Check for a skipped-line placeholder injected by the oversized-line guard above.
        const skippedMatch = /^__SKIPPED__:(\d+):(\d+)$/.exec(rawContentStr);
        if (skippedMatch) {
            const lineLen  = parseInt(skippedMatch[1], 10);
            const limitLen = parseInt(skippedMatch[2], 10);
            const messageIndex = messages.length;
            messages.push({
                id: entry.uuid ?? `${resolvedId}-${messageIndex}`,
                role,
                content: '',
                codeBlocks: [],
                timestamp: entry.timestamp,
                skipped: true,
                skippedLineLength: lineLen,
                skippedLineLimit: limitLen,
            });
            continue;
        }

        const contentParts = Array.isArray(rawContent)
            ? rawContent
            : [{ type: 'text', text: rawContentStr }];
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
        const raw = firstUserMessage?.content ?? '';
        const firstLine = raw.split('\n')[0];
        title = firstUserMessage ? (firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine || raw.slice(0, 120)) : resolvedId;
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
