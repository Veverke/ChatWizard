/**
 * src/logs/adapters/copilotLogAdapter.ts
 *
 * Phase 2 — First tool integration: GitHub Copilot (VS Code).
 *
 * Copilot does not write a dedicated "agent execution" log. Instead, the
 * VS Code Copilot Chat extension persists every conversation as a snapshot +
 * patch JSONL file under
 *
 *   <workspaceStorage>/<hash>/chatSessions/<sessionId>.jsonl
 *
 * That file *already contains* the agent's execution trail: response items
 * like `toolInvocationSerialized` (runCommand / run_in_terminal / read_file…),
 * `textEditGroup` (inline file edits) and terminal-notification turns that
 * carry exit codes. This adapter replays those lines and normalizes them into
 * the Phase 1 `LogEvent` schema, giving users the full "Executed Commands"
 * history even for commands the model never mentioned in chat text.
 *
 * The replay logic deliberately mirrors `src/parsers/copilot.ts` (snapshot
 * kind=0 + patch kinds 1/2, `requests` append semantics) while keeping the
 * raw response items the session parser discards.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CommandEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    ToolCallEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Security limits (mirror src/parsers/copilot.ts — SEC-7)
// ---------------------------------------------------------------------------

/** Maximum size of a single JSONL line (characters) before it is skipped. */
const MAX_LINE_CHARS = 1_000_000; // 1 MB
/** Maximum key-path depth accepted in replayDeepSet() to prevent stack exhaustion. */
const MAX_DEEPSET_DEPTH = 64;
/** Maximum numeric array index in replayDeepSet() to prevent sparse-array memory explosion. */
const MAX_ARRAY_INDEX = 100_000;
/** Cap on the raw snippet stored on an event (`raw` column is for debugging). */
const MAX_RAW_CHARS = 2_000;

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

interface ResponseItem {
    kind?: string;
    value?: unknown;
    uri?: { fsPath?: string; path?: string };
}

interface RequestTurn {
    requestId?: string;
    timestamp?: number;
    message?: { text?: string };
    response?: ResponseItem[];
    kind?: string; // null/undefined = actual conversation turn; other values = tool/thinking/etc.
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CopilotLogAdapterResult {
    /** Normalized events extracted from the session file. */
    events: LogEvent[];
    /** Non-fatal issues encountered while parsing (malformed lines, …). */
    errors: string[];
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/**
 * Tool names whose invocation means "a shell / build / test command was run".
 * The user-facing win is exactly these: commands executed behind the scenes.
 */
const COMMAND_TOOLS = new Set([
    'runCommand', 'run_in_terminal', 'runInTerminal', 'applyShellCommand',
    'shell', 'shell_command', 'shellCommand', 'bash', 'sh', 'zsh',
    'exec', 'execCommand', 'executeCommand', 'command', 'terminal',
    'executeTerminalCommand', 'runTerminalCommand',
]);

/** UUID-shaped terminal/session correlation id (matches `[Terminal <uuid> …]`). */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function msToIso(ms: number): string {
    return new Date(ms).toISOString();
}
// ---------------------------------------------------------------------------
// Terminal notification parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

export type TerminalNotificationState = 'completed' | 'failed' | 'running' | 'unknown';

export interface ParsedTerminalNotification {
    /** Terminal uuid referenced by the notification. */
    terminalId: string;
    state: TerminalNotificationState;
    /** Numeric process exit code, when the body carries one. */
    exitCode?: number;
}

/**
 * Parses a Copilot "terminal notification" user-turn message such as
 *
 *   [Terminal 7b3a4f9e-…-ef0123456789 notification: command completed with exit code 0]
 *
 * Returns undefined for text that is not a terminal notification.
 * Exported so unit tests can lock the regex contracts.
 */
export function parseTerminalNotification(text: string | undefined): ParsedTerminalNotification | undefined {
    if (!text) { return undefined; }
    const match = /^\[Terminal\s+([0-9a-fA-F-]+)\s+notification:\s*(.+?)\s*\]$/i.exec(text.trim());
    if (!match) { return undefined; }

    const body = match[2] ?? '';
    const exitMatch = /\bexit code\s+(-?\d+)\b/i.exec(body);
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;

    let state: TerminalNotificationState;
    // A nonzero exit code is the authoritative "failed" signal, even when the
    // body says "command completed with exit code N".
    if (exitCode !== undefined && exitCode !== 0) {
        state = 'failed';
    } else if (/command completed/i.test(body) || /command finished/i.test(body)) {
        state = 'completed';
    } else if (/command failed/i.test(body)) {
        state = 'failed';
    } else if (/command started/i.test(body) || /still running/i.test(body) || /command running/i.test(body)) {
        state = 'running';
    } else {
        state = 'unknown';
    }

    return { terminalId: match[1], state, exitCode };
}

/**
 * Returns true when a turn's message is a terminal notification (housekeeping
 * rather than a real user prompt). Mirrors the session parser's suppression.
 */
export function isTerminalNotification(text: string | undefined): boolean {
    return /^\[Terminal\s+[0-9a-fA-F-]+\s+notification:/i.test(text ?? '');
}
// ---------------------------------------------------------------------------
// Tool-argument extraction helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Extract the executed command text from a tool call's arguments object. */
export function extractCommandText(args: Record<string, unknown>): string | undefined {
    if (!args) { return undefined; }

    for (const key of ['command', 'commandText', 'cmd', 'script', 'shellCommand']) {
        const candidate = args[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            const text = candidate.trim();
            // `command` may be a program that is combined with an args array.
            const extra = args['args'];
            if (Array.isArray(extra)) {
                const parts = extra.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
                if (parts.length > 0) {
                    return [text, ...parts].join(' ');
                }
            }
            return text;
        }
    }

    const program = typeof args['executable'] === 'string' ? args['executable']
        : typeof args['program'] === 'string' ? args['program']
        : typeof args['shell'] === 'string' ? args['shell']
        : undefined;
    if (program) {
        const rest = args['args'];
        if (Array.isArray(rest)) {
            const parts = rest.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
            return parts.length > 0 ? [program, ...parts].join(' ') : program;
        }
        return program;
    }

    return undefined;
}

/** Extract the working directory a tool call ran in, when logged. */
export function extractCwd(args: Record<string, unknown>): string | undefined {
    for (const key of ['cwd', 'workingDirectory', 'workdir', 'directory']) {
        const candidate = args[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return undefined;
}

/** Extract the shell that ran a command, when logged. */
export function extractShell(args: Record<string, unknown>): string | undefined {
    const shell = args['shell'];
    if (typeof shell === 'string' && shell.trim().length > 0) {
        return shell.trim();
    }
    return undefined;
}

/**
 * Extract a correlation key that links a tool call to its later terminal
 * notification. VS Code Copilot uses a UUID as the terminal id and references
 * that same UUID in `[Terminal <uuid> notification: …]` turns.
 */
export function extractCorrelationId(args: Record<string, unknown>): string | undefined {
    for (const key of ['terminalId', 'shellId', 'executionId', 'commandId', 'id', 'terminal']) {
        const candidate = args[key];
        if (typeof candidate === 'string') {
            const id = candidate.trim();
            if (id.length > 0 && RE_UUID.test(id)) {
                return id;
            }
        }
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

interface TurnContext {
    sessionId: string;
    workspaceId?: string;
    workspacePath?: string;
    sourcePath: string;
    /** Stable absolute index of the turn inside the requests array. */
    requestIndex: number;
    /** ISO timestamp of the turn (creationDate fallback included). */
    timestamp: string;
    /** Assigned 0-based chat-message index (best-effort, mirrors parser). */
    messageIndex?: number;
}

function newToolCallEvent(ctx: TurnContext, itemIndex: number, toolName: string, args: Record<string, unknown>, raw: string): ToolCallEvent {
    return {
        id: `${ctx.sessionId}:t${ctx.requestIndex}:i${itemIndex}:tool`,
        type: 'toolCall',
        timestamp: ctx.timestamp,
        tool: 'copilot',
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        messageIndex: ctx.messageIndex,
        raw,
        toolName,
        arguments: args,
    };
}

function newCommandEvent(ctx: TurnContext, itemIndex: number, toolName: string, args: Record<string, unknown>, raw: string): CommandEvent {
    return {
        id: `${ctx.sessionId}:t${ctx.requestIndex}:i${itemIndex}:cmd`,
        type: 'command',
        timestamp: ctx.timestamp,
        tool: 'copilot',
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        messageIndex: ctx.messageIndex,
        raw,
        commandText: extractCommandText(args) ?? '(command text unavailable)',
        cwd: extractCwd(args),
        shell: extractShell(args),
    };
}

function newFileOperationEvent(ctx: TurnContext, itemIndex: number, fileIndex: number, filePath: string, raw: string): FileOperationEvent {
    return {
        id: `${ctx.sessionId}:t${ctx.requestIndex}:i${itemIndex}:file${fileIndex}`,
        type: 'fileOperation',
        timestamp: ctx.timestamp,
        tool: 'copilot',
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        messageIndex: ctx.messageIndex,
        raw,
        operationType: 'patch',
        filePath,
        detail: 'inline text edit group',
    };
}

function newErrorEvent(ctx: TurnContext, itemIndex: number, message: string, commandId: string | undefined, raw: string): ErrorEvent {
    return {
        id: `${ctx.sessionId}:t${ctx.requestIndex}:i${itemIndex}:err`,
        type: 'error',
        timestamp: ctx.timestamp,
        tool: 'copilot',
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        messageIndex: ctx.messageIndex,
        raw,
        message,
        commandId,
        severity: 'error',
    };
}
// ---------------------------------------------------------------------------
// Snapshot + patch replay (kept local to the adapter — the session parser
// drops the raw response items this stage needs)
// ---------------------------------------------------------------------------

function replayDeepSet(obj: unknown, keys: unknown[], value: unknown): void {
    if (keys.length === 0 || keys.length > MAX_DEEPSET_DEPTH) { return; }
    let current: unknown = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (Array.isArray(current) && typeof key === 'number') {
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
        if (lastKey < 0 || lastKey > MAX_ARRAY_INDEX) { return; }
        (current as unknown[])[lastKey] = value;
    } else if (typeof current === 'object' && current !== null) {
        (current as Record<string, unknown>)[String(lastKey)] = value;
    }
}

function replayRequests(state: Record<string, unknown>, rawLines: string[], errors: string[]): RequestTurn[] {
    const patches: PatchLine[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i].trim();
        if (!line) { continue; }
        if (line.length > MAX_LINE_CHARS) {
            errors.push(`Line ${i + 1}: skipped — length ${line.length} exceeds limit`);
            continue;
        }
        try {
            const obj = JSON.parse(line) as SnapshotLine | PatchLine;
            if (obj.kind === 0) {
                // A snapshot line resets the baseline; subsequent patches apply on top.
                patches.length = 0;
            } else if ((obj.kind === 1 || obj.kind === 2) && Array.isArray((obj as PatchLine).k)) {
                patches.push(obj as PatchLine);
            }
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON`);
        }
    }

    for (const patch of patches) {
        try {
            if (
                patch.kind === 2 &&
                patch.k.length === 1 &&
                String(patch.k[0]) === 'requests' &&
                Array.isArray(patch.v)
            ) {
                const existing = Array.isArray(state['requests']) ? (state['requests'] as unknown[]) : [];
                state['requests'] = [...existing, ...(patch.v as unknown[])];
            } else {
                replayDeepSet(state, patch.k, patch.v);
            }
        } catch {
            // Ignore unapplicable patches.
        }
    }

    return Array.isArray(state['requests']) ? (state['requests'] as RequestTurn[]) : [];
}
// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a Copilot Chat session JSONL file and normalize its embedded
 * agent-execution trail into `LogEvent`s.
 *
 * @param filePath      Absolute path to `<workspaceStorage>/<hash>/chatSessions/<id>.jsonl`
 * @param workspaceId   Workspace storage hash (matches the owning Session.workspaceId)
 * @param workspacePath Optional workspace root path (matches Session.workspacePath)
 */
export function parseCopilotLogEvents(
    filePath: string,
    workspaceId: string,
    workspacePath?: string
): CopilotLogAdapterResult {
    const errors: string[] = [];
    const events: LogEvent[] = [];

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read file: ${msg}`);
        return { events, errors };
    }

    const sessionId = path.basename(filePath, path.extname(filePath));
    const rawLines = raw.split('\n');

    // State reconstruction: the snapshot line carries sessionId/creationDate.
    let state: Record<string, unknown> | undefined;
    for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        if (trimmed.length > MAX_LINE_CHARS) { continue; }
        try {
            const obj = JSON.parse(trimmed) as SnapshotLine;
            if (obj.kind === 0 && obj.v && typeof obj.v === 'object') {
                state = obj.v;
                break;
            }
        } catch { /* keep scanning */ }
    }
    if (!state) {
        // No snapshot (e.g. empty file): nothing to normalize.
        return { events, errors };
    }

    const realSessionId = typeof state['sessionId'] === 'string' && state['sessionId']
        ? (state['sessionId'] as string)
        : sessionId;
    const creationDateMs = typeof state['creationDate'] === 'number' ? state['creationDate'] as number : undefined;
    const fallbackTimestamp = msToIso(creationDateMs ?? 0);

    const requests = replayRequests(state, rawLines, errors);
    const turns = requests.filter((r) => r.kind === null || r.kind === undefined);

    // Pending commands keyed by the terminal uuid they will be correlated with.
    const pendingByTerminal = new Map<string, CommandEvent>();

    // Track the message index the way the session parser builds `messages[]`
    // (user messages for real prompts, assistant messages for non-empty AI text).
    let nextMessageIndex = 0;

    for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
        const turn = requests[requestIndex];
        if (turn.kind !== null && turn.kind !== undefined) { continue; }

        const userText = turn.message?.text ?? '';
        const hasUserMessage = userText.trim().length > 0 && !isTerminalNotification(userText);
        const userMessageIndex = hasUserMessage ? nextMessageIndex++ : undefined;
        const baseMessageIndex = userMessageIndex ?? (nextMessageIndex - 1 >= 0 ? nextMessageIndex - 1 : undefined);
        const timestamp = turn.timestamp !== undefined ? msToIso(turn.timestamp) : fallbackTimestamp;

        const ctx: TurnContext = {
            sessionId: realSessionId,
            workspaceId,
            workspacePath,
            sourcePath: filePath,
            requestIndex,
            timestamp,
            messageIndex: baseMessageIndex,
        };

        // Terminal-notification turns carry execution results for earlier tool calls.
        if (isTerminalNotification(userText)) {
            const notification = parseTerminalNotification(userText);
            if (notification) {
                const pending = pendingByTerminal.get(notification.terminalId);
                if (pending) {
                    pending.exitCode = notification.exitCode;
                    if (notification.exitCode !== undefined && notification.exitCode !== 0) {
                        events.push(newErrorEvent(ctx, 0, `command failed with exit code ${notification.exitCode}`, pending.id, userText));
                    }
                } else if (notification.state === 'failed' || (notification.exitCode !== undefined && notification.exitCode !== 0)) {
                    events.push(newErrorEvent(ctx, 0, notification.exitCode !== undefined
                        ? `command failed with exit code ${notification.exitCode}`
                        : 'command failed',
                    undefined, userText));
                }
            }
        }
// Assistant response items → normalized events.
        const responseItems = Array.isArray(turn.response) ? turn.response : [];
        let fileOperationCounter = 0;
        for (let itemIndex = 0; itemIndex < responseItems.length; itemIndex++) {
            const item = responseItems[itemIndex];
            if (!item || typeof item !== 'object') { continue; }
            const rawSnippet = JSON.stringify(item);
            const rawShort = rawSnippet.length > MAX_RAW_CHARS ? rawSnippet.slice(0, MAX_RAW_CHARS) : rawSnippet;

            if (item.kind === 'toolInvocationSerialized') {
                const serialized = typeof item.value === 'string' ? item.value : undefined;
                if (serialized) {
                    try {
                        const call = JSON.parse(serialized) as { tool?: unknown; name?: unknown; arguments?: unknown };
                        const toolName = typeof call.tool === 'string' && call.tool
                            ? call.tool
                            : typeof call.name === 'string' && call.name ? call.name
                            : '(unknown tool)';
                        const args = (call.arguments !== undefined && typeof call.arguments === 'object' && !Array.isArray(call.arguments))
                            ? (call.arguments as Record<string, unknown>)
                            : {};

                        events.push(newToolCallEvent(ctx, itemIndex, toolName, args, rawShort));

                        if (COMMAND_TOOLS.has(toolName)) {
                            const command = newCommandEvent(ctx, itemIndex, toolName, args, rawShort);
                            events.push(command);
                            const corrId = extractCorrelationId(args);
                            if (corrId) {
                                pendingByTerminal.set(corrId, command);
                            }
                        }
                    } catch {
                        errors.push(`Turn ${requestIndex + 1} item ${itemIndex + 1}: invalid toolInvocationSerialized JSON`);
                    }
                }
            } else if (item.kind === 'textEditGroup') {
                const uri = item.uri;
                const fsPath = typeof uri?.fsPath === 'string' ? uri.fsPath
                    : typeof uri?.path === 'string' ? uri.path
                    : undefined;
                if (fsPath && fsPath.length > 0) {
                    events.push(newFileOperationEvent(
                        ctx, itemIndex, fileOperationCounter++, fsPath, rawShort
                    ));
                }
            }
            // All other kinds (thinking, undoStop, inlineReference, …) carry no
            // execution signal and are ignored — consistent with the session parser.
        }

        // Mirror the parser: an assistant message is appended when the turn's
        // rendered AI text is non-empty. Approximate: any plain text value item.
        const hasAssistantText = responseItems.some((it) =>
            it.kind === undefined && typeof it.value === 'string' && (it.value as string).trim().length > 0
        );
        if (hasAssistantText) {
            nextMessageIndex++;
        }
    }

    return { events, errors };
}