// src/parsers/copilot.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult, MessageRole } from '../types/index';
import { normalizeLanguage } from './claude';

// ---------------------------------------------------------------------------
// Security constants (SEC-7)
// ---------------------------------------------------------------------------

/** Maximum size of a single JSONL line (characters) before it is skipped. */
const MAX_LINE_CHARS = 1_000_000; // 1 MB
/** Maximum key-path depth accepted in deepSet() to prevent stack exhaustion. */
const MAX_DEEPSET_DEPTH = 64;
/** Maximum numeric array index in deepSet() to prevent sparse-array memory explosion. */
const MAX_ARRAY_INDEX = 100_000;

// ---------------------------------------------------------------------------
// Internal snapshot/patch shapes
// ---------------------------------------------------------------------------

interface SnapshotLine {
    kind: 0;
    v: Record<string, unknown>;
}

interface PatchLine {
    kind: 1 | 2;
    k: unknown[];
    v: unknown;
}

interface RequestTurn {
    requestId?: string;
    timestamp?: number;
    message?: { text?: string };
    response?: Array<Record<string, unknown>>;
    kind?: string; // null/undefined = actual conversation turn; other values = tool/thinking/etc.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msToIso(ms: number): string {
    return new Date(ms).toISOString();
}

/**
 * Applies a deep key-path update to `obj`.
 * e.g. deepSet(state, ['requests', 0, 'response'], [...])
 *
 * SEC-7: guarded against excessive key depth and sparse array explosion.
 */
function deepSet(obj: unknown, keys: unknown[], value: unknown): void {
    // SEC-7: reject implausibly deep or empty key paths
    if (keys.length === 0 || keys.length > MAX_DEEPSET_DEPTH) { return; }
    let current: unknown = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (Array.isArray(current) && typeof key === 'number') {
            // SEC-7: reject large array indices to prevent sparse-array OOM
            if (key < 0 || key > MAX_ARRAY_INDEX) { return; }
            current = (current as unknown[])[key];
        } else if (typeof current === 'object' && current !== null) {
            current = (current as Record<string, unknown>)[String(key)];
        } else {
            return;
        }
    }
    const lastKey = keys[keys.length - 1];
    if (Array.isArray(current) && typeof lastKey === 'number') {
        // SEC-7: reject large array indices to prevent sparse-array OOM
        if (lastKey < 0 || lastKey > MAX_ARRAY_INDEX) { return; }
        (current as unknown[])[lastKey] = value;
    } else if (typeof current === 'object' && current !== null) {
        (current as Record<string, unknown>)[String(lastKey)] = value;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts fenced code blocks from message text.
 */
export function extractCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const language = normalizeLanguage(match[1]);
        const blockContent = match[2].trim();
        blocks.push({ language, content: blockContent, sessionId, messageIndex, blockIndexInMessage: blocks.length });
    }

    return blocks;
}

/**
 * Parses a Copilot Chat JSONL file (snapshot + patch format) into a Session.
 *
 * Format:
 *   Line kind=0  → full state snapshot  { kind:0, v: { sessionId, creationDate, requests:[], ... } }
 *   Line kind=1  → single-key patch     { kind:1, k:[...path], v: newValue }
 *   Line kind=2  → array/value replace  { kind:2, k:[...path], v: newValue }
 *
 * After replaying all patches, state.requests contains conversation items.
 * Items with kind===null/undefined are actual user+AI exchanges.
 *   turn.message.text  → user prompt
 *   turn.response[]    → AI response parts; items with a `value` field and no `kind` = text
 */
export function parseCopilotSession(
    filePath: string,
    workspaceId: string,
    workspacePath?: string
): ParseResult {
    const errors: string[] = [];

    const fallbackId = path.basename(filePath, path.extname(filePath));
    const emptySession = (): Session => ({
        id: fallbackId,
        title: 'Untitled Session',
        source: 'copilot',
        workspaceId,
        workspacePath,
        messages: [],
        filePath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${msg}`);
        return { session: emptySession(), errors };
    }

    const lines = raw.split('\n');

    let state: Record<string, unknown> | undefined;
    const patches: PatchLine[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { continue; }
        // SEC-7: skip oversized lines to prevent memory/CPU exhaustion in JSON.parse
        if (line.length > MAX_LINE_CHARS) {
            errors.push(`Line ${i + 1}: skipped — length ${line.length} exceeds limit`);
            continue;
        }
        try {
            const obj = JSON.parse(line) as SnapshotLine | PatchLine;
            if (obj.kind === 0) {
                state = (obj as SnapshotLine).v;
            } else if ((obj.kind === 1 || obj.kind === 2) && Array.isArray((obj as PatchLine).k)) {
                patches.push(obj as PatchLine);
            }
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON`);
        }
    }

    if (!state) {
        errors.push('No initial state snapshot (kind:0) found');
        return { session: emptySession(), errors };
    }

    // Apply patches to reconstruct final state
    for (const patch of patches) {
        try {
            // kind=2 on k=['requests'] is an append operation, not a full replacement.
            // VS Code writes each new conversation turn as a 1-element array rather
            // than the entire accumulated array, so we must extend rather than overwrite.
            if (
                patch.kind === 2 &&
                patch.k.length === 1 &&
                String(patch.k[0]) === 'requests' &&
                Array.isArray(patch.v)
            ) {
                const existing = Array.isArray(state['requests']) ? (state['requests'] as unknown[]) : [];
                state['requests'] = [...existing, ...(patch.v as unknown[])];
            } else {
                deepSet(state, patch.k, patch.v);
            }
        } catch {
            // Ignore unapplicable patches
        }
    }

    // Extract session metadata
    const sessionId = (state.sessionId as string | undefined) ?? fallbackId;
    const customTitle = state.customTitle as string | undefined;
    const creationDateMs = state.creationDate as number | undefined;
    // Model is stored under inputState.selectedModel in current Copilot Chat versions;
    // fall back to top-level selectedModel for older file formats.
    type SelectedModelShape = { metadata?: { name?: string } } | undefined;
    const inputState = state.inputState as { selectedModel?: SelectedModelShape } | undefined;
    const model = (inputState?.selectedModel as SelectedModelShape)?.metadata?.name
        ?? (state.selectedModel as SelectedModelShape)?.metadata?.name;

    // Conversation turns: null/undefined kind = actual user+AI exchange
    const allRequests = (state.requests as RequestTurn[] | undefined) ?? [];
    const turns = allRequests.filter(r => r.kind === null || r.kind === undefined);

    const messages: Message[] = [];
    // Copilot agent stores tool callback notifications as turns with messages like:
    // "[Terminal {uuid} notification: command completed…]"
    // These are internal housekeeping, NOT real user prompts. Suppress their user-message
    // but retain their AI response so it correctly follows the preceding real user turn.
    const RE_TERMINAL_NOTIFICATION = /^\[Terminal [0-9a-f-]+ notification:/i;

    for (const turn of turns) {
        const userText = turn.message?.text ?? '';
        const timestampMs = turn.timestamp;
        const timestampIso = timestampMs !== undefined ? msToIso(timestampMs) : undefined;
        const requestId = turn.requestId;

        if (userText && !RE_TERMINAL_NOTIFICATION.test(userText)) {
            const userMsgIndex = messages.length;
            messages.push({
                id: requestId ?? `${sessionId}-${userMsgIndex}`,
                role: 'user' as MessageRole,
                content: userText,
                codeBlocks: extractCodeBlocks(userText, sessionId, userMsgIndex),
                timestamp: timestampIso,
            });
        }

        // AI response: items with a `value` string and no `kind` field (kind present = metadata).
        // Special case: textEditGroup items hold the actual code for inline code-edit placeholders.
        // The pattern is: (null)" ``` " → undoStop → codeblockUri → textEditGroup → (null)" ``` "
        // We detect textEditGroup and splice in the real code, replacing the empty fence pair.
        const responseItems = turn.response ?? [];
        const aiTextParts: string[] = [];
        for (let ri = 0; ri < responseItems.length; ri++) {
            const item = responseItems[ri];
            if (typeof item.value === 'string' && !item.kind) {
                aiTextParts.push(item.value as string);
                continue;
            }
            if (item.kind === 'textEditGroup') {
                // Extract code content from edits.
                // edits is Array<Array<Edit>> — each group is itself an array of edit objects.
                const tegItem = item as Record<string, unknown>;
                const editsRaw = (tegItem.edits as Array<unknown> | undefined) ?? [];
                const edits = editsRaw.flatMap(g => Array.isArray(g) ? g : [g]) as Array<Record<string, unknown>>;
                const content = edits
                    .map(e => (typeof e.text === 'string' ? e.text : ''))
                    .join('')
                    .trim();
                if (content) {
                    // Determine language from the textEditGroup's uri (file extension).
                    const uriObj = tegItem.uri as Record<string, unknown> | undefined;
                    const fsPath = (uriObj?.fsPath as string | undefined) ?? (uriObj?.path as string | undefined) ?? '';
                    const ext = fsPath.split('.').pop()?.toLowerCase() ?? '';
                    const LANG: Record<string, string> = {
                        ts: 'typescript', js: 'javascript', tsx: 'typescript',
                        jsx: 'javascript', py: 'python', rs: 'rust', go: 'go',
                        java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c',
                        md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
                        html: 'html', css: 'css', sh: 'bash', ps1: 'powershell',
                        mjs: 'javascript', cjs: 'javascript',
                    };
                    const lang = LANG[ext] ?? ext;
                    // Pop the preceding empty fence placeholder (if present).
                    if (aiTextParts.length > 0 && /^\s*```\s*$/.test(aiTextParts[aiTextParts.length - 1])) {
                        aiTextParts.pop();
                    }
                    aiTextParts.push(`\`\`\`${lang}\n${content}\n\`\`\``);
                    // Skip the following closing fence placeholder.
                    if (ri + 1 < responseItems.length) {
                        const next = responseItems[ri + 1];
                        if (!next.kind && typeof next.value === 'string' && /^\s*```\s*$/.test(next.value as string)) {
                            ri++;
                        }
                    }
                }
                continue;
            }
            if (item.kind === 'inlineReference') {
                // File or symbol reference inserted inline by Copilot.
                // Replace with the display name so surrounding punctuation remains meaningful.
                const refItem = item as Record<string, unknown>;
                // Type B (file): top-level `name` field, e.g. "src/mcp/chatParticipant.ts"
                let displayName = refItem.name as string | undefined;
                if (!displayName) {
                    // Type A (symbol): `inlineReference.name`, e.g. "chatContext.history"
                    const inner = refItem.inlineReference as Record<string, unknown> | undefined;
                    displayName = inner?.name as string | undefined;
                    if (!displayName) {
                        // Fallback: basename of the URI path (fsPath is a runtime getter, not in JSON)
                        const loc = (inner?.location as Record<string, unknown> | undefined) ?? inner;
                        const uriObj = (loc?.uri as Record<string, unknown> | undefined) ?? loc;
                        const fsPath = (uriObj?.fsPath as string | undefined) ?? (uriObj?.path as string | undefined);
                        if (fsPath) {
                            displayName = fsPath.split(/[\\/]/).pop();
                        }
                    }
                }
                if (displayName) {
                    aiTextParts.push(`\`${displayName}\``);
                }
                continue;
            }
            // All other non-text items (thinking, toolInvocationSerialized, etc.) are skipped.
        }
        const aiText = aiTextParts.join('\n').trim();

        // If AI produced no text but was using tools, the user likely sent this prompt while
        // the AI was still processing a prior request.  Flag the preceding user message so
        // the renderer can show a more accurate notice than the generic "cancelled" label.
        if (!aiText && responseItems.some(r => (r as Record<string, unknown>).kind === 'toolInvocationSerialized')) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'user') {
                lastMsg.interrupted = true;
            }
        }

        if (aiText) {
            const asstMsgIndex = messages.length;
            messages.push({
                id: `${requestId ?? sessionId}-response`,
                role: 'assistant' as MessageRole,
                content: aiText,
                codeBlocks: extractCodeBlocks(aiText, sessionId, asstMsgIndex),
                timestamp: timestampIso,
            });
        }
    }

    // Title: prefer explicit customTitle, then first user message, then fallback
    const firstUserMsg = messages.find(m => m.role === 'user');
    let title: string;
    if (customTitle) {
        title = customTitle;
    } else if (firstUserMsg) {
        const fl = firstUserMsg.content.split('\n')[0];
        title = fl.length > 120 ? fl.slice(0, 120) + '…' : fl || firstUserMsg.content.slice(0, 120);
    } else {
        title = 'Untitled Session';
    }

    let fileSizeBytes: number | undefined;
    let fileBirthtime: string | undefined;
    let fileMtime: string | undefined;
    try {
        const stat = fs.statSync(filePath);
        fileSizeBytes = stat.size;
        fileBirthtime = stat.birthtime.toISOString();
        fileMtime = stat.mtime.toISOString();
    } catch {
        // ignore — optional fields
    }

    const createdAt = creationDateMs !== undefined
        ? msToIso(creationDateMs)
        : (fileBirthtime ?? new Date().toISOString());

    // Use the timestamp of the last message that actually carries one.
    // Assistant replies share their turn's timestamp with the preceding user message;
    // if a turn has no timestamp the messages get `undefined`, so we scan backwards
    // to find the most-recent timestamped message rather than only checking the tail.
    // Final fallback: file mtime (= last write = last turn appended), then createdAt.
    let updatedAt = fileMtime ?? createdAt;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].timestamp !== undefined) {
            updatedAt = messages[i].timestamp!;
            break;
        }
    }

    return {
        session: {
            id: sessionId,
            title,
            source: 'copilot',
            workspaceId,
            workspacePath,
            model,
            messages,
            filePath,
            fileSizeBytes,
            createdAt,
            updatedAt,
        },
        errors,
    };
}
