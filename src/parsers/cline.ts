// src/parsers/cline.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

/** Maximum allowed file size (bytes) for api_conversation_history.json. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Maximum number of entries in the parsed conversation array. */
const MAX_ARRAY_LENGTH = 50_000;

/** Maximum characters to keep in a title derived from the first user message. */
const MAX_TITLE_CHARS = 120;

// ─── Raw JSON shapes ───────────────────────────────────────────────────────

interface ContentPart {
    type: string;
    text?: string;
}

interface ApiEntry {
    role: 'user' | 'assistant';
    content: string | ContentPart[];
}

interface UiMessage {
    ts?: number;
    type?: string;
    say?: string;
    ask?: string;
    text?: string;
    cwd?: string;
    model?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extracts plain text from a Cline content value.
 * - string → returned as-is.
 * - ContentPart[] → concatenates all parts with `type === 'text'`; skips
 *   tool_use, tool_result, image, etc.
 */
function extractContent(content: string | ContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('');
}

// ─── Public exports ────────────────────────────────────────────────────────

/**
 * Extracts fenced code blocks from a Cline message.
 * Delegates to the shared extractor used by the Claude parser.
 */
export function extractClineCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    return extractCodeBlocks(content, sessionId, messageIndex);
}

/**
 * Reads a Cline task directory and returns a `ParseResult`.
 *
 * Files read:
 *   - `api_conversation_history.json` (required) — raw LLM messages.
 *   - `ui_messages.json`              (optional) — timestamps, cwd, model.
 *
 * @param taskDir      Absolute path to the Cline task directory.
 * @param maxLineChars Not used for JSON files; kept for API symmetry with
 *                     the Claude/Copilot parsers.
 */
export async function parseClineTask(
    taskDir: string,
    _maxLineChars?: number,
    source: 'cline' | 'roocode' = 'cline'
): Promise<ParseResult> {
    const taskId = path.basename(taskDir);
    const errors: string[] = [];

    const emptySession: Session = {
        id: taskId,
        title: 'Untitled Task',
        source,
        workspaceId: taskId,
        workspacePath: undefined,
        messages: [],
        filePath: taskDir,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    // ── Read api_conversation_history.json ──────────────────────────────────
    const conversationFile = path.join(taskDir, 'api_conversation_history.json');
    let apiEntries: ApiEntry[] = [];

    try {
        const stat = await fs.promises.stat(conversationFile);
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`api_conversation_history.json exceeds 50 MB size limit (${stat.size} bytes) — skipped`);
            return { session: emptySession, errors };
        }
        const raw = await fs.promises.readFile(conversationFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            errors.push('api_conversation_history.json root value is not an array');
            return { session: emptySession, errors };
        }
        if (parsed.length > MAX_ARRAY_LENGTH) {
            errors.push(`api_conversation_history.json has ${parsed.length} entries — truncating to ${MAX_ARRAY_LENGTH}`);
            apiEntries = (parsed as ApiEntry[]).slice(0, MAX_ARRAY_LENGTH);
        } else {
            apiEntries = parsed as ApiEntry[];
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read/parse api_conversation_history.json: ${msg}`);
        return { session: emptySession, errors };
    }

    // ── Read ui_messages.json (optional) ────────────────────────────────────
    let uiMessages: UiMessage[] = [];
    const uiFile = path.join(taskDir, 'ui_messages.json');
    try {
        const stat = await fs.promises.stat(uiFile);
        if (stat.size <= MAX_FILE_BYTES) {
            const raw = await fs.promises.readFile(uiFile, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                uiMessages = parsed as UiMessage[];
            }
        }
    } catch {
        // ui_messages.json is optional — silently ignore any error.
    }

    // ── Extract metadata from ui_messages.json ──────────────────────────────
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let workspacePath: string | undefined;
    let model: string | undefined;

    for (const ui of uiMessages) {
        if (typeof ui.ts === 'number' && ui.ts > 0) {
            const iso = new Date(ui.ts).toISOString();
            if (!createdAt) { createdAt = iso; }
            updatedAt = iso;
        }
        if (!workspacePath && typeof ui.cwd === 'string' && ui.cwd) {
            workspacePath = ui.cwd;
        }
        // Model stored directly on the message (newer Cline versions)
        if (!model && typeof ui.model === 'string' && ui.model) {
            model = ui.model;
        }
        // Model stored as JSON in the text of api_req_started messages
        if (!model && ui.say === 'api_req_started' && typeof ui.text === 'string') {
            try {
                const parsed = JSON.parse(ui.text) as Record<string, unknown>;
                if (typeof parsed['model'] === 'string' && parsed['model']) {
                    model = parsed['model'] as string;
                }
            } catch {
                // not JSON — ignore
            }
        }
    }

    // ── Map api entries to Messages ──────────────────────────────────────────
    const messages: Message[] = [];

    for (const entry of apiEntries) {
        const role: 'user' | 'assistant' =
            entry.role === 'user' ? 'user' : 'assistant';
        const content = extractContent(entry.content);

        // Skip turns with no visible text (tool-only, image-only, etc.)
        if (!content.trim()) { continue; }

        const messageIndex = messages.length;
        messages.push({
            id: `${taskId}-${messageIndex}`,
            role,
            content,
            codeBlocks: extractClineCodeBlocks(content, taskId, messageIndex),
        });
    }

    // ── Derive title ─────────────────────────────────────────────────────────
    // Priority 1: ui_messages.json task entry — cleanest, no XML wrapper noise.
    // Priority 2: Parse <task>…</task> block from first API user message.
    // Priority 3: First non-empty line of first API user message (fallback).
    let title = 'Untitled Task';

    const taskUiMsg = uiMessages.find(m => m.say === 'task' && typeof m.text === 'string' && m.text?.trim());
    if (taskUiMsg) {
        const text = taskUiMsg.text!.trim();
        const firstLine = text.split('\n')[0] || text;
        title = firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS) + '…' : firstLine;
    } else {
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg) {
            // Cline wraps the user request in <task>…</task> in the API message.
            const taskMatch = firstUserMsg.content.match(/<task>\s*([\s\S]*?)\s*<\/task>/);
            const base = taskMatch
                ? taskMatch[1].split('\n')[0] || taskMatch[1]
                : (firstUserMsg.content.split('\n').find(l => l.trim() && !l.startsWith('<')) ?? firstUserMsg.content);
            title = base.length > MAX_TITLE_CHARS ? base.slice(0, MAX_TITLE_CHARS) + '…' : base;
        }
    }

    // ── File stat fallback for timestamps ────────────────────────────────────
    let fileSizeBytes: number | undefined;
    if (!createdAt || !updatedAt) {
        try {
            const stat = await fs.promises.stat(conversationFile);
            fileSizeBytes = stat.size;
            const mtime = stat.mtime.toISOString();
            if (!createdAt) { createdAt = mtime; }
            if (!updatedAt) { updatedAt = mtime; }
        } catch {
            // ignore
        }
    } else {
        try {
            fileSizeBytes = (await fs.promises.stat(conversationFile)).size;
        } catch {
            // ignore
        }
    }

    return {
        session: {
            id: taskId,
            title,
            source,
            workspaceId: taskId,
            workspacePath,
            model,
            messages,
            filePath: taskDir,
            fileSizeBytes,
            createdAt: createdAt ?? new Date(0).toISOString(),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
        },
        errors,
    };
}
