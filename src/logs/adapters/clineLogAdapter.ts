/**
 * src/logs/adapters/clineLogAdapter.ts
 *
 * Phase 3 — Cline / Roo Code log adapter.
 *
 * Cline (and Roo Code, which shares its exact task layout) persists every
 * agentic task as a directory under
 *
 *   <globalStorage>/saoudrizwan.claude-dev/tasks/<taskId>/
 *   <globalStorage>/rooveterinaryinc.roo-cline/tasks/<taskId>/
 *
 * containing `ui_messages.json` — the message array the Cline webview renders
 * while a task runs. Unlike `api_conversation_history.json` (the plain LLM
 * transcript the session parser reads), `ui_messages.json` *also* carries the
 * agent-execution trail Cline wrote to disk:
 *
 *   - `say: 'command'`                → a shell command Cline executed (`text`)
 *   - `say/ask: 'command_output'`     → chunks of that command's captured output
 *   - `say: 'tool'` (text = JSON)     → a tool invocation (readFile, searchFiles,
 *                                        editedExistingFile, execute_command, …)
 *   - `ask: 'tool_use'` / `ask: 'use_mcp_tool'`  → legacy tool invocations
 *   - `say: 'error'` / `say: 'error_retry'`      → tool retry / runtime errors
 *   - `ask: 'api_req_failed'` (JSON)  → LLM API failures
 *   - `say: 'task_progress'`          → the Cline todo list (plan steps)
 *
 * This adapter replays those messages and normalizes them into the Phase 1
 * `LogEvent` schema, so the Executed Commands / Unified Timeline / Diff
 * Explorer panels surface Cline agent activity exactly like they already do
 * for Copilot (Phase 2/3 of docs/work-plan-watch-logs.md).
 */

import * as fs from 'fs';
import * as path from 'path';
import { countPatchLines } from './copilotLogAdapter';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    FileOperationType,
    LogEvent,
    PlannerStepEvent,
    ToolCallEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Security / sanity limits (mirror src/parsers/cline.ts and the Copilot adapter)
// ---------------------------------------------------------------------------

/** Maximum file size (bytes) of ui_messages.json before it is skipped. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Maximum number of messages replayed before bailing out. */
const MAX_ENTRIES = 50_000;
/** Cap on the raw snippet stored on an event (`raw` column is for debugging). */
const MAX_RAW_CHARS = 2_000;
/** Cap on the stdout/stderr summary attached to a CommandEvent. */
const MAX_OUTPUT_CHARS = 4_000;
/** Cap on tool arguments preserved on a ToolCallEvent (keeps payload small). */
const MAX_ARGS_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Tool-name classification
// ---------------------------------------------------------------------------

/** Tools whose `say: 'tool'`/`tool_use` invocation means a shell command ran. */
const COMMAND_TOOLS = new Set([
    'execute_command',
    'executeCommand',
    'run_command',
    'runCommand',
    'terminal',
    'run_in_terminal',
    'runInTerminal',
    'shell',
]);

/** Mapping from tool name → normalized FileOperationType. */
const FILE_OP_TOOLS: Readonly<Record<string, FileOperationType>> = {
    write_to_file: 'patch',
    writeToFile: 'patch',
    create_new_file: 'create',
    createNewFile: 'create',
    newFileCreated: 'create',
    new_file: 'create',
    delete_file: 'delete',
    deleteFile: 'delete',
    remove_file: 'delete',
    move_file: 'move',
    moveFile: 'move',
    rename_file: 'rename',
    renameFile: 'rename',
    mkdir: 'mkdir',
    make_directory: 'mkdir',
    editedExistingFile: 'patch',
    edited_existing_file: 'patch',
    edit_file: 'patch',
    editFile: 'patch',
    apply_patch: 'patch',
    applyPatch: 'patch',
    apply_diff: 'patch',
    applyDiff: 'patch',
    patch_tool: 'patch',
};

/** Tools whose parameters contain an explicit patch/diff payload. */
const DIFF_TOOLS = new Set(['applyPatch', 'applyDiff', 'apply_patch', 'apply_diff', 'patch_tool']);

// ---------------------------------------------------------------------------
// Raw JSON shapes
// ---------------------------------------------------------------------------

interface ClineUiMessage {
    ts?: number;
    type?: string;
    say?: string;
    ask?: string;
    text?: string;
    cwd?: string;
    modelInfo?: { modelId?: string; mode?: string };
    commandString?: string;
    commandType?: string;
    toolName?: string;
    toolParam?: unknown;
    commandCompleted?: boolean;
    conversationHistoryIndex?: number;
}

interface ParseContext {
    taskId: string;
    workspacePath?: string;
    sourcePath: string;
    source: 'cline' | 'roocode';
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ClineLogAdapterResult {
    /** Normalized events extracted from the task's ui_messages.json. */
    events: LogEvent[];
    /** Non-fatal issues encountered while parsing. */
    errors: string[];
}

// ---------------------------------------------------------------------------
// Small display/parsing helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-Z]|\u001b[=>]/g;

/** Strip common terminal ANSI escape sequences from a captured line. */
export function cleanTerminalText(text: string): string {
    return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Extract the relevant pieces from a Cline XML-style command payload, e.g.
 *
 *   <execute_command>
 *   <command>npm test</command>
 *   <requires_approval>false</requires_approval>
 *   </execute_command>
 *
 * Returns the wrapped command, optional path, optional content and the outer
 * tag name; a plain string (already a command) is returned as-is.
 */
export function parseCommandStringXml(commandString: string): {
    firstTag?: string;
    command?: string;
    path?: string;
    content?: string;
} {
    const trimmed = commandString.trim();
    const match = /^<([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*)<\/\1>\s*$/.exec(trimmed);
    if (!match) {
        return { command: trimmed };
    }
    const firstTag = match[1];
    const body = match[2];
    const grab = (name: string): string | undefined => {
        const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
        return m ? m[1].trim() : undefined;
    };
    return {
        firstTag,
        command: grab('command') ?? grab('text') ?? body.trim(),
        path: grab('path') ?? grab('file_path'),
        content: grab('content'),
    };
}

/** Parse the JSON payload Cline stores in `say: 'tool'` `text` fields. */
export function parseToolText(text: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch { /* not JSON — not a tool payload */ }
    return undefined;
}

/**
 * Normalize a legacy `toolParam` value (stringified JSON or raw object) into
 * a record, falling back to `{ toolParam: <raw> }` so data is never lost.
 */
export function parseToolParam(param: unknown): Record<string, unknown> | undefined {
    if (param === null || param === undefined) { return undefined; }
    if (typeof param === 'object') { return param as Record<string, unknown>; }
    if (typeof param === 'string') {
        const trimmed = param.trim();
        if (!trimmed) { return undefined; }
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch { /* not JSON */ }
        return { toolParam: trimmed };
    }
    return undefined;
}

/** First non-empty string found under any of the given argument keys. */
function firstString(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
    if (!args) { return undefined; }
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.trim().length > 0) { return value.trim(); }
    }
    return undefined;
}

const SEARCH_REPLACE_RE = /^\s*-------\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?\s*=======\s*\r?\n([\s\S]*?)\r?\n?\s*\+{3,}\s*REPLACE\s*$/;

/**
 * Split a Cline `editedExistingFile` content block
 * (`------- SEARCH\n<old>\n=======\n<new>\n+++++++ REPLACE`) into its two
 * halves. Returns undefined when the block shape is not recognized.
 */
export function extractSearchReplace(content: string): { search: string; replace: string } | undefined {
    const match = SEARCH_REPLACE_RE.exec(content);
    if (!match) { return undefined; }
    return { search: match[1], replace: match[2] };
}

/** Build a small unified-diff text from search/replace halves. */
export function buildSearchReplaceDiff(filePath: string, search: string, replace: string): string {
    const searchLines = (search + '\n').split('\n');
    // Drop a single trailing empty element introduced by the joined newline.
    if (searchLines[searchLines.length - 1] === '') { searchLines.pop(); }
    const replaceLines = (replace + '\n').split('\n');
    if (replaceLines[replaceLines.length - 1] === '') { replaceLines.pop(); }

    const lines: string[] = [];
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);
    lines.push(`@@ -${searchLines.length} +${replaceLines.length} @@`);
    for (const line of searchLines) { lines.push(`-${line}`); }
    for (const line of replaceLines) { lines.push(`+${line}`); }
    return lines.join('\n');
}

/** Coarse +/- line counts for a search/replace edit. */
export function countSearchReplaceLines(search: string, replace: string): { added: number; removed: number } {
    const removed = search.split('\n').filter((l) => l.trim().length > 0).length;
    const added = replace.split('\n').filter((l) => l.trim().length > 0).length;
    return { added, removed };
}

/**
 * Best-effort human message out of an `api_req_failed` payload: those carry a
 * JSON body with a `message` field. Falls back to the raw text.
 */
export function extractApiFailureMessage(text: string): string {
    try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed?.message === 'string' && parsed.message.trim().length > 0) {
            return parsed.message.trim();
        }
    } catch { /* not JSON → fall back to raw text */ }
    return text.trim();
}

const CWD_RE = /# Current Working Directory \(([^)\r\n]+)\)/;

/**
 * Derive the task workspace path: prefers the first message carrying a `cwd`,
 * then falls back to the `# Current Working Directory (<path>)` marker Cline
 * embeds in its system prompts.
 */
export function deriveClineWorkspace(entries: ClineUiMessage[]): string | undefined {
    for (const msg of entries) {
        if (typeof msg.cwd === 'string' && msg.cwd.trim().length > 0) { return msg.cwd.trim(); }
    }
    for (const msg of entries) {
        if (typeof msg.text === 'string') {
            const match = CWD_RE.exec(msg.text);
            if (match) { return match[1].trim(); }
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function isoTime(msg: ClineUiMessage): string {
    if (typeof msg.ts === 'number' && msg.ts > 0) { return new Date(msg.ts).toISOString(); }
    return new Date(0).toISOString();
}

function trimRaw(text: string | undefined): string | undefined {
    if (typeof text !== 'string') { return undefined; }
    return text.trim().length > 0 ? text.slice(0, MAX_RAW_CHARS) : undefined;
}

function baseOf(ctx: ParseContext, index: number, suffix: string): string {
    return `${ctx.taskId}:m${index}:${suffix}`;
}

function makeCommand(
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    commandText: string,
    stdoutSummary?: string
): CommandEvent {
    return {
        id: baseOf(ctx, index, 'cmd'),
        type: 'command',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        commandText,
        cwd: typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd.trim() : ctx.workspacePath,
        stdoutSummary,
        raw: trimRaw(commandText),
    };
}

function makeToolCall(
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    toolName: string,
    arguments_: Record<string, unknown> | undefined
): ToolCallEvent {
    return {
        id: baseOf(ctx, index, 'tool'),
        type: 'toolCall',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        toolName,
        arguments: arguments_,
        raw: trimRaw(msg.text),
    };
}

function makeFileOperation(
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    operationType: FileOperationType,
    filePath: string,
    detail?: string,
    oldPath?: string
): FileOperationEvent {
    return {
        id: baseOf(ctx, index, 'file'),
        type: 'fileOperation',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        operationType,
        filePath,
        oldPath,
        detail,
        raw: trimRaw(msg.text),
    };
}

function makeDiff(
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    filePath: string,
    diffText: string,
    addedLines?: number,
    removedLines?: number
): DiffEvent {
    return {
        id: baseOf(ctx, index, 'diff'),
        type: 'diff',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        filePath,
        diffText,
        addedLines,
        removedLines,
        raw: trimRaw(msg.text),
    };
}

function makeError(
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    message: string,
    severity: 'fatal' | 'error' | 'warning' = 'error'
): ErrorEvent {
    return {
        id: baseOf(ctx, index, 'err'),
        type: 'error',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        message,
        severity,
        raw: trimRaw(msg.text),
    };
}

function makePlannerStep(ctx: ParseContext, index: number, msg: ClineUiMessage, description: string): PlannerStepEvent {
    return {
        id: baseOf(ctx, index, 'plan'),
        type: 'plannerStep',
        timestamp: isoTime(msg),
        tool: ctx.source,
        sessionId: ctx.taskId,
        workspaceId: ctx.taskId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
        description,
        stepType: 'plan',
        status: 'task_progress',
        raw: trimRaw(msg.text),
    };
}

// ---------------------------------------------------------------------------
// Per-message handling
// ---------------------------------------------------------------------------

/** Handle one raw Cline UI message, pushing normalized events. */
function handleMessage(
    events: LogEvent[],
    errors: string[],
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    pendingCommand: { event: CommandEvent } | undefined
): void {
    const say = msg.say ?? '';
    const ask = msg.ask ?? '';

    // ── Executed commands ────────────────────────────────────────────────
    if (say === 'command') {
        const text = (msg.text ?? '').trim();
        if (text.length > 0) {
            const commandText = cleanTerminalText(text).trim();
            if (commandText.length > 0) {
                events.push(makeCommand(ctx, index, msg, commandText, undefined));
            }
        }
        return;
    }

    // Legacy: `ask: 'command'` with commandType 'terminal' (or absent).
    if (ask === 'command') {
        const commandType = msg.commandType ?? 'terminal';
        const fileType = FILE_OP_TOOLS[commandType];
        if (typeof msg.commandString === 'string' && msg.commandString.trim().length > 0) {
            if (fileType) {
                handleLegacyFileCommand(events, ctx, index, msg, commandType, fileType);
            } else {
                const parsed = parseCommandStringXml(msg.commandString);
                const commandText = cleanTerminalText(parsed.command ?? msg.commandString).trim();
                if (commandText.length > 0) {
                    events.push(makeCommand(ctx, index, msg, commandText, undefined));
                }
            }
        }
        return;
    }

    // ── Command output correlation ───────────────────────────────────────
    if (ask === 'command_output' || say === 'command_output') {
        if (pendingCommand && typeof msg.text === 'string' && msg.text.trim().length > 0) {
            const current = pendingCommand.event.stdoutSummary ?? '';
            const addition = cleanTerminalText(msg.text).trim();
            const combined = current.length > 0 ? `${current}\n${addition}` : addition;
            pendingCommand.event.stdoutSummary = combined.length > MAX_OUTPUT_CHARS
                ? combined.slice(0, MAX_OUTPUT_CHARS)
                : combined;
        }
        return;
    }

    // ── Modern tool payloads: `say: 'tool'` with JSON text ───────────────
    if (say === 'tool' && typeof msg.text === 'string' && msg.text.trim().length > 0) {
        const args = parseToolText(msg.text);
        if (args === undefined) {
            errors.push(`Message ${index + 1}: 'say: tool' text is not a JSON object — skipped`);
            return;
        }
        const toolName = firstString(args, 'tool', 'name') ?? '(unknown tool)';
        events.push(makeToolCall(ctx, index, msg, toolName, args));

        if (COMMAND_TOOLS.has(toolName)) {
            const commandText = firstString(args, 'command', 'commandText', 'text', 'script');
            if (commandText) {
                const cwdMsg = { ...msg, cwd: firstString(args, 'cwd', 'workingDirectory') ?? msg.cwd };
                events.push(makeCommand(ctx, index, cwdMsg, cleanTerminalText(commandText).trim(), undefined));
            }
        } else {
            handleFileToolEvent(events, ctx, index, msg, toolName, args);
        }
        return;
    }

    // ── Legacy tool payloads: `ask: 'tool_use'` / `ask: 'use_mcp_tool'` ──
    if (ask === 'tool_use' || ask === 'use_mcp_tool') {
        const toolName = msg.toolName ?? 'mcp_tool';
        const args = parseToolParam(msg.toolParam);
        events.push(makeToolCall(ctx, index, msg, toolName, slimArgs(args)));

        if (COMMAND_TOOLS.has(toolName)) {
            const commandText = firstString(args, 'command', 'commandText', 'text', 'script', 'commandString');
            if (commandText) {
                const cwdMsg = { ...msg, cwd: firstString(args, 'cwd', 'workingDirectory') ?? msg.cwd };
                events.push(makeCommand(ctx, index, cwdMsg, cleanTerminalText(commandText).trim(), undefined));
            }
        } else {
            handleFileToolEvent(events, ctx, index, msg, toolName, args);
        }
        return;
    }

    // ── Errors ───────────────────────────────────────────────────────────
    if (say === 'error' || say === 'error_retry') {
        const text = (msg.text ?? '').trim();
        if (text.length > 0) {
            events.push(makeError(ctx, index, msg, text, say === 'error' ? 'error' : 'warning'));
        }
        return;
    }
    if (ask === 'api_req_failed') {
        const text = (msg.text ?? '').trim();
        if (text.length > 0) {
            events.push(makeError(ctx, index, msg, extractApiFailureMessage(text), 'error'));
        }
        return;
    }

    // ── Planner steps: Cline's rendered todo list ────────────────────────
    if (say === 'task_progress') {
        const text = (msg.text ?? '').trim();
        if (text.length > 0) {
            const description = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? text;
            events.push(makePlannerStep(ctx, index, msg, description));
        }
        return;
    }

    // Everything else (text, reasoning, api_req_started, checkpoint_created,
    // completion_result, user_feedback, followup, …) carries no execution signal.
}

/** Legacy `ask: 'command'` file-type commands (writeToFile, applyPatch, …). */
function handleLegacyFileCommand(
    events: LogEvent[],
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    commandType: string,
    operationType: FileOperationType
): void {
    if (typeof msg.commandString !== 'string') { return; }
    const parsed = parseCommandStringXml(msg.commandString);
    const filePath = parsed.path;
    if (!filePath) { return; }

    events.push(makeFileOperation(ctx, index, msg, operationType, filePath, `Cline ${commandType} command`, undefined));

    if (DIFF_TOOLS.has(commandType) || operationType === 'patch') {
        const patchText = parsed.content;
        if (patchText && patchText.trim().length > 0) {
            const stats = countPatchLines(patchText);
            events.push(makeDiff(ctx, index, msg, filePath, patchText, stats.added, stats.removed));
        }
    }
}

/** Handle a file-mutating tool from either modern tool JSON or legacy toolParam. */
function handleFileToolEvent(
    events: LogEvent[],
    ctx: ParseContext,
    index: number,
    msg: ClineUiMessage,
    toolName: string,
    args: Record<string, unknown> | undefined
): void {
    const operationType = FILE_OP_TOOLS[toolName];
    if (!operationType) { return; }

    const filePath = firstString(args, 'path', 'file_path', 'fileName', 'file', 'newPath', 'destination');
    if (!filePath) { return; }

    const oldPath = firstString(args, 'oldPath', 'previousPath', 'from', 'source');
    const detail = operationType === 'patch' ? `Cline ${toolName}` : undefined;
    events.push(makeFileOperation(ctx, index, msg, operationType, filePath, detail, oldPath));

    // Pair every patch-type edit with a DiffEvent so the Diff Explorer can
    // show the change just like it does for Copilot inline edit groups.
    if (operationType === 'patch') {
        const patchText = firstString(args, 'patch', 'diff', 'content');
        if (patchText && patchText.trim().length > 0) {
            if (toolName === 'editedExistingFile' || toolName === 'edited_existing_file') {
                const split = extractSearchReplace(patchText);
                if (split) {
                    const diffText = buildSearchReplaceDiff(filePath, split.search, split.replace);
                    const stats = countSearchReplaceLines(split.search, split.replace);
                    events.push(makeDiff(ctx, index, msg, filePath, diffText, stats.added, stats.removed));
                    return;
                }
                // Search/Replace shape not recognized — fall through to raw.
            }
            const stats = countPatchLines(patchText);
            events.push(makeDiff(ctx, index, msg, filePath, patchText, stats.added, stats.removed));
        }
    }
}

/** Keep tool arguments reasonably small in the stored payload. */
function slimArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!args) { return undefined; }
    const serialized = JSON.stringify(args);
    if (serialized.length <= MAX_ARGS_CHARS) { return args; }
    const trimmed: Record<string, unknown> = {};
    const entries = Object.entries(args);
    for (const [key, value] of entries) {
        const json = JSON.stringify(value);
        if (json.length > MAX_ARGS_CHARS) {
            trimmed[key] = `[truncated: ${json.length} chars]`;
        } else {
            trimmed[key] = value;
        }
    }
    return trimmed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Replay a Cline / Roo Code task directory's `ui_messages.json` and normalize
 * its agent-execution trail into `LogEvent`s.
 *
 * @param taskDir Absolute path to the task directory (contains ui_messages.json).
 * @param source  'cline' or 'roocode' (they share the storage layout).
 */
export function parseClineLogEvents(taskDir: string, source: 'cline' | 'roocode' = 'cline'): ClineLogAdapterResult {
    const events: LogEvent[] = [];
    const errors: string[] = [];
    const taskId = path.basename(taskDir);
    const sourcePath = path.join(taskDir, 'ui_messages.json');

    let entries: ClineUiMessage[] = [];
    try {
        const stat = fs.statSync(sourcePath);
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`ui_messages.json exceeds ${MAX_FILE_BYTES} bytes — skipped`);
            return { events, errors };
        }
        const raw = fs.readFileSync(sourcePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            entries = parsed.slice(0, MAX_ENTRIES) as ClineUiMessage[];
        } else {
            errors.push('ui_messages.json root is not an array');
            return { events, errors };
        }
    } catch (err) {
        errors.push(`Cannot read/parse ui_messages.json: ${err}`);
        return { events, errors };
    }

    const ctx: ParseContext = {
        taskId,
        workspacePath: deriveClineWorkspace(entries),
        sourcePath,
        source,
    };

    // Output-chunk correlation: `command_output` messages attach to the most
    // recently emitted command (Cline writes them immediately after the
    // command message, so this is unambiguous in practice).
    let pendingCommand: { event: CommandEvent } | undefined;

    for (let i = 0; i < entries.length; i++) {
        const msg = entries[i];
        if (!msg || typeof msg !== 'object') { continue; }
        handleMessage(events, errors, ctx, i, msg, pendingCommand);
        const last = events[events.length - 1];
        if (last && last.type === 'command') {
            pendingCommand = { event: last as CommandEvent };
        }
    }

    return { events, errors };
}