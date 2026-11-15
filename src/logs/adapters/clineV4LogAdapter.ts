/**
 * src/logs/adapters/clineV4LogAdapter.ts
 *
 * Cline 4.x / Roo Code 4.x ("agent host") execution-trail adapter.
 *
 * The legacy adapter reads `tasks/<id>/ui_messages.json` (`say:'command'`,
 * `say:'tool'`, …). Cline 4.x writes a different shape — the transcript in
 * `~/.cline/data/sessions/<id>/<id>.messages.json`:
 *
 *   { "messages": [ { "role": "assistant", "content": [
 *       { "type": "tool_use", "id": "call_…", "name": "run_commands",
 *         "input": { "commands": ["npm test"] } },
 *       ...
 *     ]},
 *     { "role": "user", "content": [
 *       { "type": "tool_result", "tool_use_id": "call_…",
 *         "content": [{ "query": "npm test", "result": "…", "success": true }] }
 *     ]}
 *   ]}
 *
 * Tools are classified by `agentToolMapping`:
 *   - `run_commands` / `execute_command` / `terminal` → CommandEvent (+ exit
 *     code and output from the matching `tool_result`)
 *   - `editor` / `write_to_file` / `create_file` / … → FileOperationEvent, plus
 *     a DiffEvent when the call carries a search/replace pair
 *   - `apply_patch` / `apply_diff` → DiffEvent
 *   - everything else (`read_files`, `search_codebase`, …) → ToolCallEvent
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    ToolCallEvent,
} from '../types';
import {
    capOutput,
    classifyAgentTool,
    extractCommands,
    extractFilePath,
    extractPatch,
    extractSearchReplace,
    fileOperationOf,
    resultToText,
} from './agentToolMapping';
import { buildSearchReplaceDiff, countSearchReplaceLines } from './clineLogAdapter';

/** Maximum transcript size read in one go. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Maximum messages replayed. */
const MAX_MESSAGES = 50_000;
/** Cap on the raw snippet stored on an event. */
const MAX_RAW_CHARS = 2_000;
/** Cap on the stdout/stderr summary attached to a CommandEvent. */
const MAX_OUTPUT_CHARS = 4_000;

export interface ClineV4LogAdapterResult {
    /** Normalized events extracted from the session transcript. */
    events: LogEvent[];
    /** Non-fatal issues encountered while parsing. */
    errors: string[];
}

interface ToolUsePart {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
}

interface ToolResultPart {
    type?: string;
    tool_use_id?: string;
    name?: string;
    content?: unknown;
    is_error?: boolean;
    success?: boolean;
}

interface V4Message {
    role?: string;
    content?: Array<ToolUsePart & ToolResultPart>;
    ts?: number;
}

interface V4Transcript {
    messages?: V4Message[];
}

interface ParseMeta {
    sessionId: string;
    workspacePath?: string;
    sourcePath: string;
    source: 'cline' | 'roocode';
}

let sequenceCounter = 0;
function nextId(meta: ParseMeta, kind: string): string {
    sequenceCounter += 1;
    return `${meta.sessionId}:v4:${sequenceCounter}:${kind}`;
}

function isoOf(ts: number | undefined): string {
    return typeof ts === 'number' && ts > 0 ? new Date(ts).toISOString() : new Date(0).toISOString();
}

function trimRaw(text: string | undefined): string | undefined {
    if (typeof text !== 'string') { return undefined; }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, MAX_RAW_CHARS) : undefined;
}

function base(meta: ParseMeta, id: string, timestamp: string) {
    return {
        id,
        timestamp,
        tool: meta.source,
        sessionId: meta.sessionId,
        workspaceId: meta.sessionId,
        workspacePath: meta.workspacePath,
        sourcePath: meta.sourcePath,
    } as const;
}

/**
 * Replay a Cline 4.x session directory's `<id>.messages.json` into normalized
 * `LogEvent`s.
 *
 * @param sessionDir Absolute path of the session directory.
 * @param source     Owning tool (`cline`, or `roocode` for Roo Code 4.x).
 */
export function parseClineV4LogEvents(
    sessionDir: string,
    source: 'cline' | 'roocode' = 'cline',
    workspacePath?: string
): ClineV4LogAdapterResult {
    const sessionId = path.basename(sessionDir);
    const sourcePath = path.join(sessionDir, `${sessionId}.messages.json`);
    const events: LogEvent[] = [];
    const errors: string[] = [];

    let raw: string;
    try {
        const stat = fs.statSync(sourcePath);
        if (stat.size > MAX_FILE_BYTES) {
            return { events, errors: [`${sessionId}.messages.json exceeds ${MAX_FILE_BYTES} bytes — skipped`] };
        }
        raw = fs.readFileSync(sourcePath, 'utf8');
    } catch (err: unknown) {
        return { events, errors: [`Cannot read ${sessionId}.messages.json: ${err instanceof Error ? err.message : String(err)}`] };
    }

    let transcript: V4Transcript;
    try {
        transcript = JSON.parse(raw) as V4Transcript;
    } catch (err: unknown) {
        return { events, errors: [`Cannot parse ${sessionId}.messages.json: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const messages = Array.isArray(transcript.messages) ? transcript.messages.slice(0, MAX_MESSAGES) : [];
    if (messages.length === 0) { return { events, errors }; }

    const meta: ParseMeta = { sessionId, sourcePath, source, workspacePath };

    /** tool_use id → the event ids it created (for tool_result correlation). */
    const toolUseIndex = new Map<string, { kind: string; ids: string[]; name?: string }>();

    for (const message of messages) {
        const timestamp = isoOf(message?.ts);
        const parts = Array.isArray(message?.content) ? message.content : [];

        for (const part of parts) {
            if (part?.type === 'tool_use') {
                handleToolUse(meta, part, timestamp, events, toolUseIndex);
            } else if (part?.type === 'tool_result') {
                handleToolResult(meta, part, timestamp, events, toolUseIndex);
            }
        }
    }

    return { events, errors };
}


function handleToolUse(
    meta: ParseMeta,
    part: ToolUsePart,
    timestamp: string,
    events: LogEvent[],
    index: Map<string, { kind: string; ids: string[]; name?: string }>
): void {
    const toolName = part.name ?? '';
    const kind = classifyAgentTool(toolName);
    const raw = trimRaw(typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}));

    if (kind === 'command') {
        const ids: string[] = [];
        for (const commandText of extractCommands(part.input)) {
            const event = makeCommand(meta, timestamp, commandText, raw);
            events.push(event);
            ids.push(event.id);
        }
        if (part.id) { index.set(part.id, { kind, ids, name: toolName }); }
        return;
    }

    if (kind === 'diff') {
        const filePath = extractFilePath(part.input) ?? '(unknown)';
        const diffText = extractPatch(part.input) ?? '';
        const event = makeDiff(meta, timestamp, filePath, diffText, raw);
        events.push(event);
        if (part.id) { index.set(part.id, { kind, ids: [event.id], name: toolName }); }
        return;
    }

    if (kind === 'fileOp') {
        const filePath = extractFilePath(part.input) ?? '(unknown)';
        const operationType = fileOperationOf(toolName);
        const fileEvent = makeFileOperation(meta, timestamp, operationType, filePath, raw);
        events.push(fileEvent);
        const ids = [fileEvent.id];

        // A search/replace edit also carries a diff we can show side by side.
        const searchReplace = extractSearchReplace(part.input);
        if (searchReplace && (searchReplace.search.length > 0 || searchReplace.replace.length > 0)) {
            const diffText = buildSearchReplaceDiff(filePath, searchReplace.search, searchReplace.replace);
            const counts = countSearchReplaceLines(searchReplace.search, searchReplace.replace);
            const diffEvent = makeDiff(meta, timestamp, filePath, diffText, raw, counts.added, counts.removed);
            events.push(diffEvent);
            ids.push(diffEvent.id);
        }

        if (part.id) { index.set(part.id, { kind, ids, name: toolName }); }
        return;
    }

    const event = makeToolCall(meta, timestamp, toolName, part.input, raw);
    events.push(event);
    if (part.id) { index.set(part.id, { kind, ids: [event.id], name: toolName }); }
}

function handleToolResult(
    meta: ParseMeta,
    part: ToolResultPart,
    timestamp: string,
    events: LogEvent[],
    index: Map<string, { kind: string; ids: string[]; name?: string }>
): void {
    const target = part.tool_use_id ? index.get(part.tool_use_id) : undefined;
    const text = resultToText(part.content);

    // Per-command results: [{ query, result, success }, …]
    if (target?.kind === 'command' && Array.isArray(part.content)) {
        const entries = part.content as Array<Record<string, unknown>>;
        target.ids.forEach((eventId, i) => {
            const event = events.find((e) => e.id === eventId) as CommandEvent | undefined;
            if (!event) { return; }
            const entry = entries[i] ?? entries[entries.length - 1];
            const success = entry && typeof entry['success'] === 'boolean' ? entry['success'] : undefined;
            const output = capOutput(resultToText(entry?.['result'] ?? entry?.['output']), MAX_OUTPUT_CHARS);
            if (success !== undefined) { event.exitCode = success ? 0 : 1; }
            if (success === false) { event.stderrSummary = output; } else { event.stdoutSummary = output; }
        });
        return;
    }

    const failed = part.is_error === true || part.success === false;
    if (failed) {
        events.push(makeError(meta, timestamp, capOutput(text, MAX_OUTPUT_CHARS) ?? 'Tool call failed', 'error'));
    }
}


// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function makeCommand(meta: ParseMeta, timestamp: string, commandText: string, raw: string | undefined): CommandEvent {
    return {
        ...base(meta, nextId(meta, 'cmd'), timestamp),
        type: 'command',
        commandText,
        cwd: meta.workspacePath,
        raw,
    };
}

function makeToolCall(
    meta: ParseMeta,
    timestamp: string,
    toolName: string,
    input: unknown,
    raw: string | undefined
): ToolCallEvent {
    const args = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : undefined;
    return {
        ...base(meta, nextId(meta, 'tool'), timestamp),
        type: 'toolCall',
        toolName,
        arguments: args,
        raw,
    };
}

function makeFileOperation(
    meta: ParseMeta,
    timestamp: string,
    operationType: FileOperationEvent['operationType'],
    filePath: string,
    raw: string | undefined,
    detail?: string,
    oldPath?: string
): FileOperationEvent {
    return {
        ...base(meta, nextId(meta, 'file'), timestamp),
        type: 'fileOperation',
        operationType,
        filePath,
        oldPath,
        detail,
        raw,
    };
}

function makeDiff(
    meta: ParseMeta,
    timestamp: string,
    filePath: string,
    diffText: string,
    raw: string | undefined,
    addedLines?: number,
    removedLines?: number
): DiffEvent {
    return {
        ...base(meta, nextId(meta, 'diff'), timestamp),
        type: 'diff',
        filePath,
        diffText,
        addedLines,
        removedLines,
        raw,
    };
}

function makeError(
    meta: ParseMeta,
    timestamp: string,
    message: string,
    severity: ErrorEvent['severity']
): ErrorEvent {
    return {
        ...base(meta, nextId(meta, 'err'), timestamp),
        type: 'error',
        message,
        severity,
    };
}

