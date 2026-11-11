/**
 * src/logs/adapters/windsurfLogAdapter.ts
 *
 * Phase 3 — Windsurf (Codeium Cascade) log adapter.
 *
 * Windsurf stores its chat sessions inside each workspace's `state.vscdb`
 * SQLite database, under the `cascade.sessionData` key (the same key
 * `src/parsers/windsurf.ts` reads). The payload looks like
 *
 *   { "sessions": [ { sessionId, title, createdAt,
 *                     messages: [ { role, content, timestamp, … } ] } ] }
 *
 * Unlike Cline/Copilot, Windsurf's on-disk record is **not** an execution
 * trail: messages are plain Markdown, and Cascade's tool invocations are not
 * persisted in this payload. So the adapter has two layers:
 *
 *   1. **Structured tool calls**, when a message carries them
 *      (`toolCalls` / `tool_calls` / `toolInvocations`) → `ToolCallEvent` plus
 *      the matching `CommandEvent` / `FileOperationEvent` / `DiffEvent`.
 *      Forward-compatible: if Windsurf (or a future parser) surfaces tool data,
 *      it is normalized exactly like Cline's.
 *   2. **Fenced shell blocks** in *assistant* messages → `CommandEvent`s. This
 *      is the only signal available today, so those rows are marked in `raw` as
 *      derived (no exit code, no captured output) — they are the commands
 *      Cascade proposed for the user's terminal, not proof of execution.
 *
 * `openReadonlyDb` is async (better-sqlite3 → sql.js fallback), so the SQLite
 * read lives in `readWindsurfCascadeSessionData` and the normalization itself
 * stays a pure function over the JSON string (unit-tested without SQLite).
 */

import * as fs from 'fs';
import { openReadonlyDb } from '../../utils/sqliteDb';
import { countPatchLines } from './copilotLogAdapter';
import { buildSearchReplaceDiff, extractSearchReplace } from './clineLogAdapter';
import {
    CommandEvent,
    DiffEvent,
    FileOperationEvent,
    FileOperationType,
    LogEvent,
    ToolCallEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Security / sanity limits (mirror the Cline and Copilot adapters)
// ---------------------------------------------------------------------------

/** Maximum number of sessions normalized out of one database. */
const MAX_SESSIONS = 5_000;
/** Maximum number of messages replayed per session. */
const MAX_MESSAGES_PER_SESSION = 20_000;
/** Cap on the tool arguments preserved on a ToolCallEvent. */
const MAX_ARGS_CHARS = 8_000;
/** Cap on the `raw` snippet stored for debugging. */
const MAX_RAW_CHARS = 2_000;
/** Commands longer than this are skipped (a multi-page script is not a command). */
const MAX_COMMAND_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Tool-name classification (shared shape with the Cline adapter)
// ---------------------------------------------------------------------------

/** Tools whose invocation means a shell command ran. */
const COMMAND_TOOLS = new Set([
    'run_command',
    'runCommand',
    'run_terminal_cmd',
    'runTerminalCommand',
    'run_in_terminal',
    'runInTerminal',
    'execute_command',
    'executeCommand',
    'terminal',
    'shell',
    'bash',
]);

/** Mapping from tool name → normalized FileOperationType. */
const FILE_OP_TOOLS: Readonly<Record<string, FileOperationType>> = {
    write_to_file: 'patch',
    writeToFile: 'patch',
    create_file: 'create',
    createFile: 'create',
    new_file: 'create',
    delete_file: 'delete',
    deleteFile: 'delete',
    remove_file: 'delete',
    move_file: 'move',
    rename_file: 'rename',
    mkdir: 'mkdir',
    edit_file: 'patch',
    editFile: 'patch',
    apply_patch: 'patch',
    applyPatch: 'patch',
    search_replace: 'patch',
};

/** Languages of fenced blocks that contain shell commands. */
const SHELL_LANGUAGES: Readonly<Record<string, string>> = {
    bash: 'bash',
    sh: 'sh',
    shell: 'shell',
    shellscript: 'shell',
    shellsession: 'shell',
    zsh: 'zsh',
    fish: 'fish',
    console: 'console',
    terminal: 'shell',
    powershell: 'powershell',
    ps1: 'powershell',
    pwsh: 'pwsh',
    cmd: 'cmd',
    bat: 'cmd',
    batch: 'cmd',
};

// ---------------------------------------------------------------------------
// Raw shapes (defensive — Windsurf's payload is loosely typed)
// ---------------------------------------------------------------------------

export interface CascadeMessage {
    role?: string;
    content?: string;
    timestamp?: number;
    /** Structured tool calls, when the payload carries them. */
    toolCalls?: unknown;
    tool_calls?: unknown;
    toolInvocations?: unknown;
}

export interface CascadeSession {
    sessionId?: string;
    title?: string;
    createdAt?: number;
    messages?: CascadeMessage[];
}

export interface WindsurfLogAdapterContext {
    /** Storage hash directory name (the workspace id the session index uses). */
    workspaceId: string;
    /** Resolved workspace root, when known. */
    workspacePath?: string;
    /** Absolute path of the `state.vscdb` file. */
    sourcePath: string;
}

export interface WindsurfLogAdapterResult {
    /** Normalized events extracted from the Cascade payload. */
    events: LogEvent[];
    /** Non-fatal issues encountered while parsing. */
    errors: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** One fenced shell block found in a message. */
export interface ShellFence {
    /** Fence info string (already normalized to a shell name). */
    language: string;
    /** The fenced body — the command text. */
    commandText: string;
}

/**
 * Extract every fenced block whose language is a shell dialect.
 * Fences without a language, or with a non-shell language (json, sql, yaml…),
 * are ignored.
 */
export function extractShellFences(content: string): ShellFence[] {
    const fences: ShellFence[] = [];
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const open = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(lines[i]);
        if (!open) { continue; }
        const info = open[1].toLowerCase();
        const body: string[] = [];
        let closed = false;
        for (i = i + 1; i < lines.length; i++) {
            if (/^\s*```\s*$/.test(lines[i])) { closed = true; break; }
            body.push(lines[i]);
        }
        if (!closed || body.length === 0) { continue; }
        const language = SHELL_LANGUAGES[info];
        if (!language) { continue; }
        const commandText = body.join('\n').trim();
        if (commandText.length === 0 || commandText.length > MAX_COMMAND_CHARS) { continue; }
        fences.push({ language, commandText });
    }
    return fences;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/** First non-empty string value among `keys`. */
function stringField(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!source) { return undefined; }
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim().length > 0) { return value.trim(); }
    }
    return undefined;
}

/** Structured tool calls carried by a message (any of the known field names). */
export function messageToolCalls(msg: CascadeMessage): unknown[] {
    for (const field of [msg.toolCalls, msg.tool_calls, msg.toolInvocations]) {
        if (Array.isArray(field)) { return field; }
    }
    return [];
}

/** Tool name + parsed arguments of one structured tool call. */
export function toolCallInfo(call: unknown): { name: string; args?: Record<string, unknown> } | undefined {
    const record = asRecord(call);
    if (!record) { return undefined; }
    const name = stringField(record, ['name', 'toolName', 'tool', 'type']);
    if (!name) { return undefined; }
    for (const key of ['arguments', 'args', 'params', 'input', 'parameters']) {
        const value = record[key];
        const asObject = asRecord(value);
        if (asObject) { return { name, args: asObject }; }
        if (typeof value === 'string' && value.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(value) as unknown;
                const parsedRecord = asRecord(parsed);
                if (parsedRecord) { return { name, args: parsedRecord }; }
            } catch {
                // Not JSON — keep the tool call without arguments.
            }
        }
    }
    return { name };
}

/** Keep tool arguments reasonably small in the stored payload. */
function slimArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!args) { return undefined; }
    const serialized = JSON.stringify(args);
    if (serialized.length <= MAX_ARGS_CHARS) { return args; }
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        const json = JSON.stringify(value);
        trimmed[key] = json.length > MAX_ARGS_CHARS ? `[truncated: ${json.length} chars]` : value;
    }
    return trimmed;
}

/** Keep the raw snippet small (the `raw` column is for debugging only). */
function trimRaw(text: string | undefined): string | undefined {
    if (typeof text !== 'string') { return undefined; }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, MAX_RAW_CHARS) : undefined;
}

// ---------------------------------------------------------------------------
// Payload parser (pure)
// ---------------------------------------------------------------------------

/** Unified diff payload carried by a file-write tool call, when present. */
function buildDiffFromToolArgs(
    filePath: string,
    args: Record<string, unknown> | undefined
): { text: string; added: number; removed: number } | undefined {
    const payload = stringField(args, [
        'patch', 'diff', 'patchText', 'diffText', 'content',
        'code_edit', 'codeEdit', 'search_replace', 'searchReplace',
    ]);
    if (!payload) { return undefined; }
    const searchReplace = extractSearchReplace(payload);
    if (searchReplace) {
        const text = buildSearchReplaceDiff(filePath, searchReplace.search, searchReplace.replace);
        const stats = countPatchLines(text);
        return { text, added: stats.added, removed: stats.removed };
    }
    const stats = countPatchLines(payload);
    return { text: payload, added: stats.added, removed: stats.removed };
}

/**
 * Normalize a `cascade.sessionData` JSON string into `LogEvent`s.
 * Pure: no SQLite / file access, so it is unit-tested directly.
 */
export function parseWindsurfCascadeJson(
    rawValue: string,
    ctx: WindsurfLogAdapterContext
): WindsurfLogAdapterResult {
    const events: LogEvent[] = [];
    const errors: string[] = [];

    let payload: unknown;
    try {
        payload = JSON.parse(rawValue);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to parse cascade.sessionData JSON: ${message}`);
        return { events, errors };
    }

    const sessions = asRecord(payload)?.['sessions'];
    if (!Array.isArray(sessions)) {
        errors.push('cascade.sessionData.sessions is not an array');
        return { events, errors };
    }

    for (const rawSession of (sessions as unknown[]).slice(0, MAX_SESSIONS)) {
        const session = asRecord(rawSession) as CascadeSession | undefined;
        if (!session) { continue; }

        const sessionId = typeof session.sessionId === 'string' && session.sessionId.length > 0
            ? session.sessionId
            : `${ctx.workspaceId}-windsurf-unknown`;
        const createdAt = typeof session.createdAt === 'number' && session.createdAt > 0
            ? new Date(session.createdAt).toISOString()
            : undefined;
        const rawMessages = Array.isArray(session.messages)
            ? session.messages.slice(0, MAX_MESSAGES_PER_SESSION)
            : [];

        for (let m = 0; m < rawMessages.length; m++) {
            const msg = asRecord(rawMessages[m]) as CascadeMessage | undefined;
            if (!msg) { continue; }
            const role = typeof msg.role === 'string' ? msg.role : 'unknown';
            const timestamp = (typeof msg.timestamp === 'number' && msg.timestamp > 0)
                ? new Date(msg.timestamp).toISOString()
                : (createdAt ?? new Date(0).toISOString());
            const base = {
                tool: 'windsurf' as const,
                sessionId,
                workspaceId: ctx.workspaceId,
                workspacePath: ctx.workspacePath,
                sourcePath: ctx.sourcePath,
                messageIndex: m,
                timestamp,
            };

            // ── 1. Structured tool calls (when the payload carries them) ────
            const calls = messageToolCalls(msg);
            for (let c = 0; c < calls.length; c++) {
                const info = toolCallInfo(calls[c]);
                if (!info) { continue; }
                const { name, args } = info;
                const idBase = `${sessionId}:m${m}:i${c}`;
                const raw = trimRaw(JSON.stringify({ tool: name, args }));

                events.push({
                    ...base,
                    id: `${idBase}:tool`,
                    type: 'toolCall',
                    toolName: name,
                    arguments: slimArgs(args),
                    raw,
                } satisfies ToolCallEvent);

                if (COMMAND_TOOLS.has(name)) {
                    const commandText = stringField(args, [
                        'command', 'cmd', 'commandLine', 'command_line', 'script', 'terminalCommand',
                    ]);
                    if (commandText) {
                        events.push({
                            ...base,
                            id: `${idBase}:cmd`,
                            type: 'command',
                            commandText,
                            cwd: stringField(args, ['cwd', 'workingDirectory', 'working_directory', 'workdir'])
                                ?? ctx.workspacePath,
                            shell: stringField(args, ['shell', 'shellType']),
                            raw,
                        } satisfies CommandEvent);
                    }
                    continue;
                }

                const operationType = FILE_OP_TOOLS[name];
                if (!operationType) { continue; }
                const filePath = stringField(args, [
                    'path', 'file_path', 'filePath', 'file', 'target_file', 'targetFile', 'filename',
                ]);
                if (!filePath) { continue; }
                events.push({
                    ...base,
                    id: `${idBase}:file`,
                    type: 'fileOperation',
                    operationType,
                    filePath,
                    oldPath: stringField(args, ['old_path', 'oldPath', 'from', 'source']),
                    detail: `tool: ${name}`,
                    raw,
                } satisfies FileOperationEvent);

                const diff = buildDiffFromToolArgs(filePath, args);
                if (diff) {
                    events.push({
                        ...base,
                        id: `${idBase}:diff`,
                        type: 'diff',
                        filePath,
                        diffText: diff.text,
                        addedLines: diff.added,
                        removedLines: diff.removed,
                        raw,
                    } satisfies DiffEvent);
                }
            }

            // ── 2. Fenced shell blocks in assistant messages ────────────────
            if (role === 'assistant' && typeof msg.content === 'string') {
                const fences = extractShellFences(msg.content);
                for (let f = 0; f < fences.length; f++) {
                    const fence = fences[f];
                    events.push({
                        ...base,
                        id: `${sessionId}:m${m}:f${f}:cmd`,
                        type: 'command',
                        commandText: fence.commandText,
                        cwd: ctx.workspacePath,
                        shell: fence.language,
                        raw: `derived from a fenced ${fence.language} block in an assistant message ` +
                            '(Windsurf does not persist tool executions in cascade.sessionData)',
                    } satisfies CommandEvent);
                }
            }
        }
    }

    return { events, errors };
}

// ---------------------------------------------------------------------------
// Entry point (SQLite wrapper)
// ---------------------------------------------------------------------------

/**
 * Read the raw `cascade.sessionData` JSON from a Windsurf `state.vscdb`.
 * Returns `undefined` when the database cannot be opened or the key is absent.
 */
export async function readWindsurfCascadeSessionData(vscdbPath: string): Promise<string | undefined> {
    try {
        if (!fs.existsSync(vscdbPath)) { return undefined; }
        const db = await openReadonlyDb(vscdbPath);
        if (!db) { return undefined; }
        try {
            const row = db.get<{ value: string }>(
                "SELECT value FROM ItemTable WHERE key = 'cascade.sessionData'"
            );
            const value = row?.value;
            return typeof value === 'string' ? value : undefined;
        } finally {
            db.close();
        }
    } catch {
        return undefined;
    }
}

/**
 * Parse one Windsurf workspace database into normalized `LogEvent`s.
 *
 * @param vscdbPath     Absolute path to the workspace's `state.vscdb`.
 * @param workspaceId   Storage hash directory name (workspace id in the index).
 * @param workspacePath Resolved workspace root, when known.
 */
export async function parseWindsurfLogEvents(
    vscdbPath: string,
    workspaceId: string,
    workspacePath?: string
): Promise<WindsurfLogAdapterResult> {
    const raw = await readWindsurfCascadeSessionData(vscdbPath);
    if (raw === undefined) {
        return {
            events: [],
            errors: [`Cannot read cascade.sessionData from ${vscdbPath}`],
        };
    }
    return parseWindsurfCascadeJson(raw, { workspaceId, workspacePath, sourcePath: vscdbPath });
}





