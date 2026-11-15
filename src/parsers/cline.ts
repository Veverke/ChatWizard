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
    modelInfo?: { modelId?: string; providerId?: string; mode?: string };
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

/**
 * Strips the Cline <task>…</task> wrapper from a user message.
 * Cline wraps the user's real prompt in <task> tags in the API conversation,
 * so we remove it before displaying or searching content.
 */
function stripTaskWrapper(text: string): string {
    return text.replace(/<task>\s*([\s\S]*?)\s*<\/task>/g, '$1').trim();
}

// ─── Cline 4.x session shapes ──────────────────────────────────────────────

/** `<sessionId>.json` — Cline 4.x session metadata. */
interface ClineV4Meta {
    version?: number;
    session_id?: string;
    source?: string;
    started_at?: string;
    ended_at?: string;
    status?: string;
    provider?: string;
    model?: string;
    cwd?: string;
    workspace_root?: string;
    prompt?: string;
    metadata?: {
        title?: string;
        modelId?: string;
        isFavorited?: boolean;
    };
}

/** One content part inside a Cline 4.x message. */
interface ClineV4ContentPart {
    type?: string;
    /** `type: 'text'` */
    text?: string;
    /** `type: 'tool_use'` */
    name?: string;
    input?: unknown;
}

/** One message inside `<sessionId>.messages.json`. */
interface ClineV4Message {
    id?: string;
    role?: string;
    content?: string | ClineV4ContentPart[];
    ts?: number;
    modelInfo?: { id?: string; provider?: string };
}

/** `<sessionId>.messages.json` — Cline 4.x transcript. */
interface ClineV4Transcript {
    version?: number;
    updated_at?: string;
    agent?: string;
    sessionId?: string;
    messages?: ClineV4Message[];
}

// ─── Cline 4.x parsing ─────────────────────────────────────────────────────

/**
 * Strips the Cline 4.x `<user_input mode="act">…</user_input>` wrapper so the
 * displayed/searchable content is the user's actual prompt.
 */
function stripUserInputWrapper(text: string): string {
    return text
        .replace(/<user_input\b[^>]*>\s*([\s\S]*?)\s*<\/user_input>/g, '$1')
        .trim();
}

/**
 * Extracts plain text from a Cline 4.x message content value.
 * - string → returned as-is.
 * - ContentPart[] → concatenates `type === 'text'` parts; skips `thinking`,
 *   `tool_use`, `tool_result` and images (same policy as the Claude parser).
 */
function extractV4Content(content: string | ClineV4ContentPart[] | undefined): string {
    if (typeof content === 'string') { return content; }
    if (!Array.isArray(content)) { return ''; }
    return content
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('');
}

/**
 * Reads a Cline 4.x session directory (`~/.cline/data/sessions/<id>/`) and
 * returns a `ParseResult`.
 *
 * Files read:
 *   - `<sessionId>.json`           (required) — title, workspace, model, timing.
 *   - `<sessionId>.messages.json`  (optional) — the conversation transcript.
 *
 * The returned session's `filePath` is the session *directory*, mirroring the
 * legacy Cline task layout so downstream consumers keep working unchanged.
 *
 * @param sessionDir Absolute path to the session directory.
 * @param maxLineChars Not used for JSON files; kept for API symmetry with the
 *                     Claude/Copilot parsers.
 */
export async function parseClineV4Session(
    sessionDir: string,
    _maxLineChars?: number,
    source: 'cline' | 'roocode' = 'cline'
): Promise<ParseResult> {
    const sessionId = path.basename(sessionDir);
    const errors: string[] = [];

    const emptySession: Session = {
        id: sessionId,
        title: 'Untitled Task',
        source,
        workspaceId: sessionId,
        workspacePath: undefined,
        messages: [],
        filePath: sessionDir,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    // ── Read <sessionId>.json (metadata) ─────────────────────────────────────
    const metaFile = path.join(sessionDir, `${sessionId}.json`);
    let meta: ClineV4Meta = {};
    try {
        const stat = await fs.promises.stat(metaFile);
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`${sessionId}.json exceeds 50 MB size limit (${stat.size} bytes) — skipped`);
            return { session: emptySession, errors };
        }
        const parsed = JSON.parse(await fs.promises.readFile(metaFile, 'utf-8')) as ClineV4Meta;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            meta = parsed;
        } else {
            errors.push(`${sessionId}.json root value is not an object`);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read/parse ${sessionId}.json: ${msg}`);
        return { session: emptySession, errors };
    }

    // ── Read <sessionId>.messages.json (transcript, optional) ────────────────
    const messagesFile = path.join(sessionDir, `${sessionId}.messages.json`);
    let transcript: ClineV4Transcript = {};
    let transcriptSize: number | undefined;
    try {
        const stat = await fs.promises.stat(messagesFile);
        transcriptSize = stat.size;
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`${sessionId}.messages.json exceeds 50 MB size limit (${stat.size} bytes) — skipped`);
        } else {
            const parsed = JSON.parse(await fs.promises.readFile(messagesFile, 'utf-8')) as ClineV4Transcript;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                transcript = parsed;
            } else {
                errors.push(`${sessionId}.messages.json root value is not an object`);
            }
        }
    } catch {
        // The transcript is optional — a freshly created session may not have one.
    }

    const rawMessages = Array.isArray(transcript.messages) ? transcript.messages : [];
    if (rawMessages.length > MAX_ARRAY_LENGTH) {
        errors.push(`${sessionId}.messages.json has ${rawMessages.length} messages — truncating to ${MAX_ARRAY_LENGTH}`);
    }
    const v4Messages = rawMessages.slice(0, MAX_ARRAY_LENGTH);

    // ── Map transcript messages to ChatWizard Messages ───────────────────────
    const messages: Message[] = [];
    let firstTs: number | undefined;
    let lastTs: number | undefined;
    let model: string | undefined;

    for (const entry of v4Messages) {
        if (typeof entry?.ts === 'number' && entry.ts > 0) {
            if (firstTs === undefined) { firstTs = entry.ts; }
            lastTs = entry.ts;
        }
        if (!model && typeof entry?.modelInfo?.id === 'string' && entry.modelInfo.id) {
            model = entry.modelInfo.id;
        }

        const role: 'user' | 'assistant' = entry?.role === 'user' ? 'user' : 'assistant';
        let content = extractV4Content(entry?.content);

        // Skip turns with no visible text (thinking-only, tool-only, …).
        if (!content.trim()) { continue; }

        if (role === 'user') {
            content = stripUserInputWrapper(stripTaskWrapper(content));
            if (!content.trim()) { continue; }
        }

        const messageIndex = messages.length;
        messages.push({
            id: `${sessionId}-${messageIndex}`,
            role,
            content,
            codeBlocks: extractClineCodeBlocks(content, sessionId, messageIndex),
            timestamp: typeof entry?.ts === 'number' && entry.ts > 0
                ? new Date(entry.ts).toISOString()
                : undefined,
        });
    }

    // ── Title ────────────────────────────────────────────────────────────────
    // Priority: metadata.title → prompt → first user message → placeholder.
    const titleSource = [
        meta.metadata?.title,
        meta.prompt,
        messages.find(m => m.role === 'user')?.content,
    ].find(t => typeof t === 'string' && t.trim().length > 0) ?? '';

    const titleFirstLine = titleSource.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
    const title = titleFirstLine.length > MAX_TITLE_CHARS
        ? titleFirstLine.slice(0, MAX_TITLE_CHARS) + '…'
        : (titleFirstLine || 'Untitled Task');

    // ── Workspace + model + timestamps ───────────────────────────────────────
    const workspacePath = meta.workspace_root || meta.cwd || undefined;
    if (!model) {
        model = meta.metadata?.modelId || meta.model || undefined;
    }

    let createdAt = meta.started_at
        || (firstTs !== undefined ? new Date(firstTs).toISOString() : undefined);
    let updatedAt = meta.ended_at
        || (typeof transcript.updated_at === 'string' && transcript.updated_at)
        || (lastTs !== undefined ? new Date(lastTs).toISOString() : undefined);

    let fileSizeBytes = transcriptSize;
    if (!createdAt || !updatedAt || fileSizeBytes === undefined) {
        // Fall back to the transcript's mtime/size, then the metadata file's.
        for (const candidate of [messagesFile, metaFile]) {
            try {
                const stat = await fs.promises.stat(candidate);
                const mtime = stat.mtime.toISOString();
                if (!createdAt) { createdAt = mtime; }
                if (!updatedAt) { updatedAt = mtime; }
                if (fileSizeBytes === undefined) { fileSizeBytes = stat.size; }
                break;
            } catch {
                // Try the next candidate.
            }
        }
    }

    return {
        session: {
            id: sessionId,
            title,
            source,
            workspaceId: sessionId,
            workspacePath,
            model,
            messages,
            filePath: sessionDir,
            fileSizeBytes,
            createdAt: createdAt ?? new Date(0).toISOString(),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
        },
        errors,
    };
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
        // Model stored in modelInfo.modelId (current Cline versions)
        if (!model && typeof ui.modelInfo?.modelId === 'string' && ui.modelInfo.modelId) {
            model = ui.modelInfo.modelId;
        }
        // Model stored directly on the message (older Cline versions)
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

    // ── Fallback: extract workspace from first API message system prompt ─────
    // Newer Cline versions omit cwd from ui_messages.json. The system prompt
    // injected into the first user API message contains:
    //   "# Current Working Directory (PATH) Files"
    if (!workspacePath) {
        const RE_CWD = /# Current Working Directory \(([^)]+)\)/;
        for (const entry of apiEntries) {
            if (entry.role === 'user') {
                const text = extractContent(entry.content);
                const m = text.match(RE_CWD);
                if (m) { workspacePath = m[1]; }
                break; // only check first user message
            }
        }
    }

    // ── Map api entries to Messages ──────────────────────────────────────────
    const messages: Message[] = [];

    for (const entry of apiEntries) {
        const role: 'user' | 'assistant' =
            entry.role === 'user' ? 'user' : 'assistant';
        let content = extractContent(entry.content);

        // Skip turns with no visible text (tool-only, image-only, etc.)
        if (!content.trim()) { continue; }

        // Cline wraps the user's real prompt in <task>…</task> in the API
        // conversation history. Strip it so the displayed/searchable content
        // is just the actual user request without XML noise.
        if (role === 'user') {
            content = stripTaskWrapper(content);
            if (!content.trim()) { continue; }
        }

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
    // Priority 2: First line of the first user message (already stripped of <task> wrapper).
    let title = 'Untitled Task';

    const taskUiMsg = uiMessages.find(m => m.say === 'task' && typeof m.text === 'string' && m.text?.trim());
    if (taskUiMsg) {
        const text = taskUiMsg.text!.trim();
        const firstLine = text.split('\n')[0] || text;
        title = firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS) + '…' : firstLine;
    } else {
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg) {
            // Find first non-empty line that doesn't start with < (XML metadata).
            // The <task> wrapper is already stripped from message content so
            // remaining <tag> lines (e.g. <environment_details>) are skipped.
            const firstLine = firstUserMsg.content.split('\n').find(l => l.trim() && !l.startsWith('<'))
                ?? firstUserMsg.content;
            title = firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS) + '…' : firstLine;
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
