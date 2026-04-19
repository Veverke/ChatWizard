// src/parsers/aider.ts

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Session, Message, CodeBlock, ParseResult } from '../types/index';
import { AiderHistoryInfo } from '../types/index';
import { extractCodeBlocks } from './claude';

/** Maximum characters per line before the line is skipped. */
const DEFAULT_MAX_LINE_CHARS = 1_000_000;

/** Cap assembled message content at 1 MB; truncate with warning. */
const MAX_MESSAGE_BYTES = 1_024 * 1_024;

/** Maximum characters in a derived title. */
const MAX_TITLE_CHARS = 120;

/** Regex for the session-start header: `# aider chat started at YYYY-MM-DD HH:mm:ss` */
const RE_SESSION_START = /^#\s+aider chat started at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i;

/** User-message line prefix. */
const USER_PREFIX = '#### ';

/** Aider command line prefix (interactive commands like `/add`, `/run`, etc.). */
const CMD_PREFIX = '> ';

// ─── Public exports ────────────────────────────────────────────────────────────

/**
 * Extracts fenced code blocks from an Aider message.
 * Delegates to the shared extractor used by the Claude/Windsurf parsers.
 */
export function extractAiderCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    return extractCodeBlocks(content, sessionId, messageIndex);
}

/**
 * Parses an Aider `.aider.chat.history.md` file and returns a `ParseResult`.
 *
 * One history file = one `Session`.  The session ID is a stable SHA-1 of the
 * absolute file path so that repeated parses of the same growing file produce
 * the same ID.
 *
 * @param info           Discovered file info from `discoverAiderHistoryFilesAsync`.
 * @param maxLineChars   Lines longer than this are skipped (default 1 MB).
 */
export function parseAiderHistory(
    info: AiderHistoryInfo,
    maxLineChars: number = DEFAULT_MAX_LINE_CHARS
): ParseResult {
    const sessionId = crypto.createHash('sha1').update(info.historyFile).digest('hex');
    const errors: string[] = [];

    // ── Read file ────────────────────────────────────────────────────────────
    let rawContent: string;
    try {
        rawContent = fs.readFileSync(info.historyFile, 'utf8');
    } catch (err) {
        const msg = `Failed to read ${info.historyFile}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        return {
            session: _emptySession(sessionId, info, errors),
            errors,
        };
    }

    // ── Read model from .aider.conf.yml (optional) ───────────────────────────
    const model = _readModel(info.configFile);

    // ── Derive file mtime for updatedAt fallback ─────────────────────────────
    let mtimeIso: string;
    try {
        const st = fs.statSync(info.historyFile);
        mtimeIso = st.mtime.toISOString();
    } catch {
        mtimeIso = new Date(0).toISOString();
    }

    if (rawContent.trim() === '') {
        return {
            session: {
                ..._emptySession(sessionId, info, errors),
                model,
                updatedAt: mtimeIso,
            },
            errors,
        };
    }

    // ── Parse lines via state machine ────────────────────────────────────────
    const lines = rawContent.split('\n');

    let createdAt: string | undefined;
    const messages: Message[] = [];

    /** Lines being accumulated for the current assistant turn. */
    let assistantLines: string[] = [];
    let assistantByteCount = 0;
    let assistantTruncated = false;

    function flushAssistant(): void {
        if (assistantLines.length === 0) { return; }
        let content = assistantLines.join('\n').trim();
        if (!content) {
            assistantLines = [];
            assistantByteCount = 0;
            assistantTruncated = false;
            return;
        }
        if (assistantTruncated) {
            content += '\n[...truncated — exceeded 1 MB limit]';
            errors.push(`Assistant message truncated at 1 MB in ${info.historyFile}`);
        }
        const messageIndex = messages.length;
        messages.push({
            id: `${sessionId}-${messageIndex}`,
            role: 'assistant',
            content,
            codeBlocks: extractAiderCodeBlocks(content, sessionId, messageIndex),
        });
        assistantLines = [];
        assistantByteCount = 0;
        assistantTruncated = false;
    }

    for (const rawLine of lines) {
        // Skip oversized lines
        if (rawLine.length > maxLineChars) {
            errors.push(`Line skipped — length ${rawLine.length} exceeds limit ${maxLineChars} in ${info.historyFile}`);
            continue;
        }

        // Session start header
        const startMatch = RE_SESSION_START.exec(rawLine);
        if (startMatch) {
            createdAt = new Date(startMatch[1].replace(' ', 'T')).toISOString();
            continue;
        }

        // User message
        if (rawLine.startsWith(USER_PREFIX)) {
            flushAssistant();
            const userText = rawLine.slice(USER_PREFIX.length).trim();
            if (userText) {
                const messageIndex = messages.length;
                messages.push({
                    id: `${sessionId}-${messageIndex}`,
                    role: 'user',
                    content: userText,
                    codeBlocks: extractAiderCodeBlocks(userText, sessionId, messageIndex),
                });
            }
            continue;
        }

        // Aider command line — skip
        if (rawLine.startsWith(CMD_PREFIX)) {
            continue;
        }

        // Blank line — skip (don't flush; assistant message may span multiple paragraphs)
        if (rawLine.trim() === '') {
            // Preserve paragraph breaks in assistant output by adding a blank line
            // only when we already have content in the buffer.
            if (assistantLines.length > 0) {
                assistantLines.push('');
            }
            continue;
        }

        // Non-blank, non-command, non-user line → assistant content
        if (!assistantTruncated) {
            const lineBytes = Buffer.byteLength(rawLine, 'utf8');
            if (assistantByteCount + lineBytes > MAX_MESSAGE_BYTES) {
                assistantTruncated = true;
            } else {
                assistantLines.push(rawLine);
                assistantByteCount += lineBytes;
            }
        }
    }

    // Flush any remaining assistant content at EOF
    flushAssistant();

    // ── Derive timestamps ─────────────────────────────────────────────────────
    const finalCreatedAt = createdAt ?? mtimeIso;
    const finalUpdatedAt = mtimeIso;

    // ── Derive title ──────────────────────────────────────────────────────────
    const firstUserMsg = messages.find(m => m.role === 'user');
    let title: string;
    if (firstUserMsg) {
        const firstLine = firstUserMsg.content.split('\n')[0];
        const base = firstLine || firstUserMsg.content;
        title = base.length > MAX_TITLE_CHARS ? base.slice(0, MAX_TITLE_CHARS) + '…' : base;
    } else {
        title = 'Untitled Aider Session';
    }

    return {
        session: {
            id: sessionId,
            title,
            source: 'aider',
            workspaceId: sessionId,
            workspacePath: info.workspacePath,
            model,
            messages,
            filePath: info.historyFile,
            createdAt: finalCreatedAt,
            updatedAt: finalUpdatedAt,
        },
        errors,
    };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _emptySession(sessionId: string, info: AiderHistoryInfo, errors: string[]): Session {
    return {
        id: sessionId,
        title: 'Untitled Aider Session',
        source: 'aider',
        workspaceId: sessionId,
        workspacePath: info.workspacePath,
        messages: [],
        filePath: info.historyFile,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        parseErrors: errors.length > 0 ? errors : undefined,
    };
}

/**
 * Reads the `model:` value from `.aider.conf.yml`.
 * Returns `undefined` if the file is absent or `model:` is not set.
 */
function _readModel(configFile?: string): string | undefined {
    if (!configFile) { return undefined; }
    try {
        const raw = fs.readFileSync(configFile, 'utf8');
        for (const line of raw.split('\n')) {
            const match = /^model:\s*(.+)/.exec(line.trim());
            if (match) {
                return match[1].trim().replace(/^["']|["']$/g, '');
            }
        }
    } catch {
        // Config file absent or unreadable — fine
    }
    return undefined;
}
