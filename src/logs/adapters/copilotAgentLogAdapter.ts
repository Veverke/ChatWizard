/**
 * src/logs/adapters/copilotAgentLogAdapter.ts
 *
 * Copilot "agent host" execution-trail adapter (VS Code 1.146+ / Copilot Chat 1.0+).
 *
 * The legacy adapter replays `chatSessions/*.jsonl`. Newer Copilot keeps chats
 * in `~/.copilot/session-state/<id>/events.jsonl`, where every agent action is
 * an event:
 *
 *   { "type": "tool.execution_start",
 *     "data": { "toolCallId": "call_…", "toolName": "run_in_terminal",
 *               "arguments": { "command": "npm test" }, "toolTitle": "Run" } }
 *   { "type": "tool.execution_complete",
 *     "data": { "toolCallId": "call_…", "success": false,
 *               "result": { "content": "…" } } }
 *   { "type": "assistant.message",
 *     "data": { "toolRequests": [{ "toolCallId": "call_…", "name": "…",
 *                                  "arguments": { … } }] } }
 *
 * Tools are classified by `agentToolMapping` (same vocabulary as Cline 4.x):
 * commands, file operations, diffs, and plain tool calls. `toolRequests` acts as
 * a fallback for calls that never emitted a matching `tool.execution_start`.
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
import { countPatchLines } from './copilotLogAdapter';

/** Maximum transcript size read in one go. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Maximum events replayed. */
const MAX_EVENTS = 50_000;
/** Cap on the raw snippet stored on an event. */
const MAX_RAW_CHARS = 2_000;
/** Cap on the stdout/stderr summary attached to a CommandEvent. */
const MAX_OUTPUT_CHARS = 4_000;

export interface CopilotAgentLogAdapterResult {
    events: LogEvent[];
    errors: string[];
}

interface AgentEvent {
    type?: string;
    data?: Record<string, unknown>;
    timestamp?: string;
}

interface ToolInvocation {
    toolCallId?: string;
    name?: string;
    arguments?: unknown;
    timestamp: string;
}

interface ParseMeta {
    sessionId: string;
    workspacePath?: string;
    sourcePath: string;
}

let sequenceCounter = 0;
function nextId(meta: ParseMeta, kind: string): string {
    sequenceCounter += 1;
    return `${meta.sessionId}:agent:${sequenceCounter}:${kind}`;
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
        tool: 'copilot' as const,
        sessionId: meta.sessionId,
        workspaceId: 'copilot-agent',
        workspacePath: meta.workspacePath,
        sourcePath: meta.sourcePath,
    } as const;
}

/**
 * Replay a Copilot agent-host session directory's `events.jsonl` into
 * normalized `LogEvent`s.
 *
 * @param sessionDir    Absolute path of `…/session-state/<sessionId>`.
 * @param workspacePath Optional workspace root (from `workspace.yaml` `cwd`).
 */
export function parseCopilotAgentLogEvents(
    sessionDir: string,
    workspacePath?: string
): CopilotAgentLogAdapterResult {
    const sessionId = path.basename(sessionDir);
    const sourcePath = path.join(sessionDir, 'events.jsonl');
    const events: LogEvent[] = [];
    const errors: string[] = [];

    let raw: string;
    try {
        const stat = fs.statSync(sourcePath);
        if (stat.size > MAX_FILE_BYTES) {
            return { events, errors: [`events.jsonl exceeds ${MAX_FILE_BYTES} bytes — skipped`] };
        }
        raw = fs.readFileSync(sourcePath, 'utf8');
    } catch (err: unknown) {
        return { events, errors: [`Cannot read events.jsonl: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const meta: ParseMeta = { sessionId, sourcePath, workspacePath };

    /** toolCallId → event ids created for that invocation (result correlation). */
    const byCallId = new Map<string, { kind: string; ids: string[]; name?: string }>();
    /** toolCallIds already materialized (execution_start wins over toolRequests). */
    const seen = new Set<string>();

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length && i < MAX_EVENTS; i++) {
        const line = lines[i].trim();
        if (line.length === 0) { continue; }

        let event: AgentEvent;
        try {
            event = JSON.parse(line) as AgentEvent;
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON`);
            continue;
        }
        if (!event || typeof event !== 'object') { continue; }

        const timestamp = typeof event.timestamp === 'string' && event.timestamp.length > 0
            ? event.timestamp
            : new Date(0).toISOString();
        const data = event.data ?? {};

        switch (event.type) {
            case 'tool.execution_start': {
                const invocation: ToolInvocation = {
                    toolCallId: typeof data['toolCallId'] === 'string' ? data['toolCallId'] : undefined,
                    name: typeof data['toolName'] === 'string' ? data['toolName'] : undefined,
                    arguments: data['arguments'],
                    timestamp,
                };
                materialize(meta, invocation, events, byCallId, seen);
                break;
            }
            case 'assistant.message': {
                // Fallback: invocations that never produced an execution_start.
                const requests = data['toolRequests'];
                if (Array.isArray(requests)) {
                    for (const request of requests as Array<Record<string, unknown>>) {
                        const invocation: ToolInvocation = {
                            toolCallId: typeof request['toolCallId'] === 'string' ? request['toolCallId'] : undefined,
                            name: typeof request['name'] === 'string' ? request['name'] : undefined,
                            arguments: request['arguments'],
                            timestamp,
                        };
                        materialize(meta, invocation, events, byCallId, seen);
                    }
                }
                break;
            }
            case 'tool.execution_complete': {
                handleCompletion(meta, data, timestamp, events, byCallId);
                break;
            }
            default:
                break;
        }
    }

    if (lines.length > MAX_EVENTS) {
        errors.push(`events.jsonl has more than ${MAX_EVENTS} events — truncated`);
    }

    return { events, errors };
}


/** Create the normalized event(s) for one tool invocation (once per call id). */
function materialize(
    meta: ParseMeta,
    invocation: ToolInvocation,
    events: LogEvent[],
    byCallId: Map<string, { kind: string; ids: string[]; name?: string }>,
    seen: Set<string>
): void {
    const toolName = invocation.name ?? '';
    if (!toolName) { return; }
    const kind = classifyAgentTool(toolName);
    const raw = trimRaw(typeof invocation.arguments === 'string'
        ? invocation.arguments
        : JSON.stringify(invocation.arguments ?? {}));

    const callId = invocation.toolCallId;
    if (callId && seen.has(callId)) { return; }
    if (callId) { seen.add(callId); }

    let ids: string[] = [];

    if (kind === 'command') {
        for (const commandText of extractCommands(invocation.arguments)) {
            const command = makeCommand(meta, invocation.timestamp, commandText, raw);
            events.push(command);
            ids.push(command.id);
        }
    } else if (kind === 'diff') {
        const filePath = extractFilePath(invocation.arguments) ?? '(unknown)';
        const diffText = extractPatch(invocation.arguments) ?? '';
        const stats = countPatchLines(diffText);
        const diff = makeDiff(meta, invocation.timestamp, filePath, diffText, raw, stats.added, stats.removed);
        events.push(diff);
        ids.push(diff.id);
    } else if (kind === 'fileOp') {
        const filePath = extractFilePath(invocation.arguments) ?? '(unknown)';
        const fileEvent = makeFileOperation(
            meta,
            invocation.timestamp,
            fileOperationOf(toolName),
            filePath,
            raw
        );
        events.push(fileEvent);
        ids.push(fileEvent.id);

        const searchReplace = extractSearchReplace(invocation.arguments);
        if (searchReplace && (searchReplace.search.length > 0 || searchReplace.replace.length > 0)) {
            const diffText = buildSearchReplaceDiff(filePath, searchReplace.search, searchReplace.replace);
            const counts = countSearchReplaceLines(searchReplace.search, searchReplace.replace);
            const diff = makeDiff(
                meta,
                invocation.timestamp,
                filePath,
                diffText,
                raw,
                counts.added,
                counts.removed
            );
            events.push(diff);
            ids.push(diff.id);
        }
    } else {
        const toolCall = makeToolCall(meta, invocation.timestamp, toolName, invocation.arguments, raw);
        events.push(toolCall);
        ids.push(toolCall.id);
    }

    if (callId) { byCallId.set(callId, { kind, ids, name: toolName }); }
}

/** Attach the outcome (exit code / output / error) of a completed tool call. */
function handleCompletion(
    meta: ParseMeta,
    data: Record<string, unknown>,
    timestamp: string,
    events: LogEvent[],
    byCallId: Map<string, { kind: string; ids: string[]; name?: string }>
): void {
    const callId = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : undefined;
    const target = callId ? byCallId.get(callId) : undefined;
    const success = typeof data['success'] === 'boolean' ? data['success'] : undefined;
    const output = capOutput(resultToText(data['result']), MAX_OUTPUT_CHARS);

    if (target?.kind === 'command') {
        for (const eventId of target.ids) {
            const command = events.find((e) => e.id === eventId) as CommandEvent | undefined;
            if (!command) { continue; }
            if (success !== undefined) { command.exitCode = success ? 0 : 1; }
            if (success === false) {
                command.stderrSummary = output;
            } else {
                command.stdoutSummary = output;
            }
        }
        return;
    }

    if (success === false) {
        events.push(makeError(meta, timestamp, output ?? `${target?.name ?? 'Tool'} failed`, 'error'));
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
    args: unknown,
    raw: string | undefined
): ToolCallEvent {
    const arguments_ = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : undefined;
    return {
        ...base(meta, nextId(meta, 'tool'), timestamp),
        type: 'toolCall',
        toolName,
        arguments: arguments_,
        raw,
    };
}

function makeFileOperation(
    meta: ParseMeta,
    timestamp: string,
    operationType: FileOperationEvent['operationType'],
    filePath: string,
    raw: string | undefined
): FileOperationEvent {
    return {
        ...base(meta, nextId(meta, 'file'), timestamp),
        type: 'fileOperation',
        operationType,
        filePath,
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

