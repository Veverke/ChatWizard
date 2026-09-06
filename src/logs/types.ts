/**
 * src/logs/types.ts
 *
 * Phase 1 — Unified agent-log schema.
 *
 * Every AI coding tool (Cursor, Cline, Windsurf, Aider, Antigravity, …) writes
 * agent-execution logs in its own format. Adapters (Phase 2) normalize those
 * heterogeneous logs into the single discriminated union `LogEvent` defined
 * here. Storage (logEventStore), correlation (future) and the future UI panels
 * only ever see this normalized shape.
 *
 * Event kinds map 1:1 to the plan's core entities:
 *   - CommandEvent        → executed shell/git/build/test commands
 *   - FileOperationEvent  → create/delete/move/rename/mkdir/patch
 *   - DiffEvent           → unified diffs / patch sets
 *   - ToolCallEvent       → structured agent tool invocations
 *   - ErrorEvent          → command failures, stack traces, tool exceptions
 *   - PlannerStepEvent    → safe high-level agent planning steps (not CoT)
 */

import { SessionSource } from '../types/index';

/** Tool that produced the log — matches `Session.source` for easy correlation. */
export type LogSourceTool = SessionSource;

/** Discriminator for the six normalized log event kinds. */
export type LogEventType =
    | 'command'
    | 'fileOperation'
    | 'diff'
    | 'toolCall'
    | 'error'
    | 'plannerStep';

/** Fields common to every normalized log event. */
export interface LogEventBase {
    /** Stable unique id (assigned by the tool adapter when parsing logs). */
    id: string;
    /** ISO-8601 timestamp of the underlying log entry. */
    timestamp: string;
    /** Which AI tool produced the log (matches the owning session's `source`). */
    tool: LogSourceTool;
    /**
     * ChatWizard session id this event belongs to.
     * Populated by the correlation layer (Phase 2+); until then it mirrors the
     * tool's own session/thread identifier where available.
     */
    sessionId?: string;
    /** Opaque workspace identifier (hash or path), when known. */
    workspaceId?: string;
    /** Resolved workspace root path, when known. */
    workspacePath?: string;
    /** Absolute path to the raw log file this event was parsed from. */
    sourcePath?: string;
    /** 0-based chat-message index this event is attached to, when known. */
    messageIndex?: number;
    /** Trimmed raw log line/snippet — for debugging and support. */
    raw?: string;
}

/** An executed shell / git / build / test command. */
export interface CommandEvent extends LogEventBase {
    type: 'command';
    /** The command text exactly as executed. */
    commandText: string;
    /** Working directory the command ran in, when logged. */
    cwd?: string;
    /** Process exit code — absent when still running or unknown (0 = success). */
    exitCode?: number;
    /** Short summary of stdout captured by the tool, when logged. */
    stdoutSummary?: string;
    /** Short summary of stderr captured by the tool, when logged. */
    stderrSummary?: string;
    /** Shell that ran the command, when logged (bash, pwsh, cmd, zsh…). */
    shell?: string;
}

/** Kinds of file-system mutations recorded by agent tools. */
export type FileOperationType = 'create' | 'delete' | 'move' | 'rename' | 'mkdir' | 'patch';

/** A file creation / deletion / move / rename / mkdir / patch operation. */
export interface FileOperationEvent extends LogEventBase {
    type: 'fileOperation';
    operationType: FileOperationType;
    /** Absolute (or repo-relative per tool) path of the affected file/dir. */
    filePath: string;
    /** For move/rename: the previous path. */
    oldPath?: string;
    /** Optional free-form detail (e.g. byte counts, operation size). */
    detail?: string;
}

/** An exact code change — unified diff / patch applied by the agent. */
export interface DiffEvent extends LogEventBase {
    type: 'diff';
    filePath: string;
    /** Content hashes before/after, when logged by the tool. */
    beforeHash?: string;
    afterHash?: string;
    /** Unified diff / patch text. */
    diffText: string;
    /** Id of the CommandEvent (if any) that triggered this diff. */
    commandId?: string;
}

/** A structured agent tool invocation (runCommand, applyDiff, searchFiles, …). */
export interface ToolCallEvent extends LogEventBase {
    type: 'toolCall';
    toolName: string;
    /** JSON-serializable arguments passed to the tool. */
    arguments?: Record<string, unknown>;
    /** Short human-readable summary of the tool's result. */
    resultSummary?: string;
    success?: boolean;
    durationMs?: number;
}

/** Severity of an error event. */
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

/** A command failure, stack trace, build/test error, or tool exception. */
export interface ErrorEvent extends LogEventBase {
    type: 'error';
    message: string;
    stackTrace?: string;
    /** Id of the CommandEvent this error is associated with, when known. */
    commandId?: string;
    severity?: ErrorSeverity;
}

/** Step kinds used by planner/executor agents. */
export type PlannerStepType = 'plan' | 'execute' | 'verify' | 'complete' | 'subtask';

/** A safe, high-level agent planning step (never chain-of-thought). */
export interface PlannerStepEvent extends LogEventBase {
    type: 'plannerStep';
    description: string;
    stepType?: PlannerStepType;
    /** Free-form status passed through from the tool, when available. */
    status?: string;
}

/** Discriminated union of every normalized agent-log event. */
export type LogEvent =
    | CommandEvent
    | FileOperationEvent
    | DiffEvent
    | ToolCallEvent
    | ErrorEvent
    | PlannerStepEvent;
/** All valid event type discriminator values. */
export const LOG_EVENT_TYPES: readonly LogEventType[] = [
    'command',
    'fileOperation',
    'diff',
    'toolCall',
    'error',
    'plannerStep',
];

/**
 * Query filter accepted by `LogEventStore.getEvents` / `LogService.getEvents`.
 * Every field is optional; intersecting filters are AND-ed.
 */
export interface LogEventFilter {
    /** Restrict to events of a single chat session. */
    sessionId?: string;
    /** Singular convenience form — equivalent to `types: [type]`. */
    type?: LogEventType;
    /** Restrict to any of the given event kinds. */
    types?: LogEventType[];
    /** Restrict to a single tool, or any of a set of tools. */
    tool?: LogSourceTool | LogSourceTool[];
    /** Restrict to events touching this file path (fileOperation/diff events). */
    filePath?: string;
    /** Restrict to a single workspace. */
    workspaceId?: string;
    /** Inclusive lower timestamp bound (ISO-8601). */
    from?: string;
    /** Inclusive upper timestamp bound (ISO-8601). */
    to?: string;
    /** Maximum number of rows to return (default: 200, max: 5000). */
    limit?: number;
    /** Number of rows to skip (for paging). */
    offset?: number;
    /** Sort order. Default: 'desc' (newest first). */
    order?: 'asc' | 'desc';
}

/**
 * Extract the file-path facet of an event for indexing purposes.
 * Only file-operation and diff events carry a meaningful file path.
 */
export function getEventFilePath(event: LogEvent): string | undefined {
    switch (event.type) {
        case 'fileOperation':
        case 'diff':
            return event.filePath;
        case 'command':
        case 'toolCall':
        case 'error':
        case 'plannerStep':
            return undefined;
    }
}

/** Human-readable label for an event kind (used by future UI + diagnostics). */
export function logEventTypeLabel(type: LogEventType): string {
    switch (type) {
        case 'command': return 'Executed Command';
        case 'fileOperation': return 'File Operation';
        case 'diff': return 'Diff / Patch';
        case 'toolCall': return 'Tool Call';
        case 'error': return 'Error / Failure';
        case 'plannerStep': return 'Planner Step';
    }
}