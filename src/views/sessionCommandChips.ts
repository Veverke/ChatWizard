/**
 * src/views/sessionCommandChips.ts
 *
 * Session reader — the per-response **Commands** chip.
 *
 * The Commands view already answers "what did the agent execute?" at the
 * session level. This module brings the same information *into the reader*:
 * after every response whose turn executed something, the transcript shows a
 * collapsed `Commands` chip that expands into a tree mirroring the Commands
 * view sections (Git / Terminal commands, LLM tool calls, file changes,
 * errors) with one row per executed action.
 *
 * Everything here is pure — no VS Code dependency — so the correlation rules
 * and the HTML can be unit-tested without a host. The webview panel supplies
 * the events (`LogService.getEvents({ sessionId })`) and splices the rendered
 * chips after the owning message.
 *
 * Correlation
 * -----------
 * Not every adapter records which chat message an action belongs to, so an
 * event is attached to a message with three rules, in order:
 *
 *   1. **Timestamps** — when (most of) the session's responses carry a
 *      timestamp, the event belongs to the latest response that started at or
 *      before it. This is exactly how the execution trail reads: the model
 *      answers, then the tools run.
 *   2. **`messageIndex` as turn index** — the Copilot adapter numbers user
 *      prompts, and the Cline / Aider adapters stamp the same convention. The
 *      action lands on the *last* response of that prompt's turn, i.e. the
 *      reply that triggered the tool loop.
 *   3. **`messageIndex` as message index** — used by adapters that store the
 *      raw transcript index (Windsurf). A user index resolves to the response
 *      that follows it; these events never take the turn interpretation
 *      because the two conventions collide numerically.
 *
 * Events that cannot be correlated at all are dropped rather than guessed at,
 * so a chip never claims a command it cannot prove belongs to that reply.
 */

import { Message } from '../types/index';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    LogSourceTool,
    ToolCallEvent,
} from '../logs/types';
import { oneLine, toolCallLabel } from '../logs/logEventSummary';
import { escapeHtml } from './sessionRenderer';

/** Hard cap on rows rendered inside one section (the count stays exact). */
export const MAX_ROWS_PER_SECTION = 50;

/** Identifier of a section inside the expanded chip. */
export type CommandChipSectionId = 'git' | 'terminal' | 'toolCalls' | 'fileChanges' | 'errors';

/** One executed action rendered as a tree row. */
export interface CommandChipRow {
    /** Stable id of the underlying `LogEvent` (used to open its details). */
    eventId: string;
    /** Icon glyph (the reader has no codicon font, so plain symbols). */
    icon: string;
    /** Primary row text (command text, tool call, file path, error). */
    label: string;
    /** Secondary badge (exit code, `+A −R`, severity, …). */
    description: string;
    /** True when the action failed — the row/badge turns red. */
    failed: boolean;
    /** Full text shown on hover. */
    tooltip: string;
}

/** A group of rows, mirroring one Commands-view section. */
export interface CommandChipSection {
    id: CommandChipSectionId;
    label: string;
    icon: string;
    rows: CommandChipRow[];
    /** Number of rows omitted because of `MAX_ROWS_PER_SECTION`. */
    truncated: number;
}

/** Aggregated counts used for the collapsed chip summary. */
export interface CommandChipCounts {
    git: number;
    terminal: number;
    toolCalls: number;
    fileChanges: number;
    errors: number;
}

/** Everything the chip needs to render, attached to one response. */
export interface CommandChip {
    /** `origIdx` of the assistant message the chip follows. */
    messageIndex: number;
    /** 0-based turn (user prompt) the actions belong to. */
    turnIndex: number;
    /** Total number of executed actions in this turn. */
    total: number;
    /** Number of failed commands / tool calls / errors. */
    failedCount: number;
    counts: CommandChipCounts;
    /** `3 tool calls · 2 git cmds · 4 terminal cmds`. */
    summary: string;
    sections: CommandChipSection[];
    /** Hover text of the collapsed chip. */
    tooltip: string;
}

// ---------------------------------------------------------------------------
// Section metadata
// ---------------------------------------------------------------------------

interface SectionMeta {
    id: CommandChipSectionId;
    label: string;
    icon: string;
}

/**
 * Section order — commands first (the reader's chip is about *executions*),
 * then tool calls, changes and failures. Only non-empty sections are rendered.
 */
const SECTION_META: readonly SectionMeta[] = [
    { id: 'git', label: 'Git Commands', icon: '\u2387' },
    { id: 'terminal', label: 'Terminal Commands', icon: '\u276f' },
    { id: 'toolCalls', label: 'LLM Tool Calls', icon: '\u2699' },
    { id: 'fileChanges', label: 'File Changes', icon: '\u00b1' },
    { id: 'errors', label: 'Errors', icon: '\u26a0' },
];

// ---------------------------------------------------------------------------
// Small helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/** True for timestamps that carry real information (not the 1970 epoch). */
export function isUsableTimestamp(timestamp: string | undefined): boolean {
    if (!timestamp) { return false; }
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) { return false; }
    return new Date(ms).getUTCFullYear() >= 2000;
}

/**
 * Whether a command is a Git invocation.
 *
 * Covers a plain `git …` as well as a Git step chained into a larger shell
 * line (`cd repo && git status`, `npm test; git diff`), which is how agents
 * frequently batch their work.
 */
export function isGitCommand(commandText: string): boolean {
    const line = (commandText ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    if (/^git(?:\s|$)/i.test(line)) { return true; }
    return /(?:&&|\|\||[;&|])\s*git(?:\s|$)/i.test(line);
}

/**
 * Adapters whose `messageIndex` is the **raw transcript index** of the message
 * that produced the event, not a user-prompt turn number.
 *
 * Windsurf records tool calls inside the assistant message, so the value can
 * point at any message. Interpreting it as a turn number would move the action
 * to a later turn whenever both numbers happen to exist (raw index 1 vs.
 * turn 1), so these events never take the turn interpretation.
 */
const RAW_MESSAGE_INDEX_TOOLS: ReadonlySet<LogSourceTool> = new Set<LogSourceTool>(['windsurf']);

/** `1 git cmd` / `2 git cmds`. */
function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Collapsed-chip summary, e.g. `3 tool calls · 2 git cmds · 4 terminal cmds`.
 * Returns an empty string when nothing was executed (never rendered).
 */
export function formatCommandChipSummary(counts: CommandChipCounts): string {
    const parts: string[] = [];
    if (counts.git > 0) { parts.push(countLabel(counts.git, 'git cmd', 'git cmds')); }
    if (counts.terminal > 0) { parts.push(countLabel(counts.terminal, 'terminal cmd', 'terminal cmds')); }
    if (counts.toolCalls > 0) { parts.push(countLabel(counts.toolCalls, 'tool call', 'tool calls')); }
    if (counts.fileChanges > 0) { parts.push(countLabel(counts.fileChanges, 'file change', 'file changes')); }
    if (counts.errors > 0) { parts.push(countLabel(counts.errors, 'error', 'errors')); }
    return parts.join(' \u00b7 ');
}

function rowIcon(event: LogEvent): string {
    switch (event.type) {
        case 'command': {
            const exit = (event as CommandEvent).exitCode;
            if (exit === undefined) { return '\u203a'; }
            return exit === 0 ? '\u2713' : '\u2717';
        }
        case 'toolCall': return '\u2699';
        case 'diff': return '\u00b1';
        case 'fileOperation': return '\u270e';
        case 'error': return '\u26a0';
        case 'plannerStep': return '\u2022';
    }
}

/** Turn the event into its tree row. */
function describeRow(event: LogEvent): CommandChipRow {
    switch (event.type) {
        case 'command': {
            const command = event as CommandEvent;
            const exit = command.exitCode;
            return {
                eventId: command.id,
                icon: rowIcon(command),
                label: oneLine(command.commandText, 120),
                description: exit === undefined ? 'exit ?' : `exit ${exit}`,
                failed: exit !== undefined && exit !== 0,
                tooltip: command.commandText,
            };
        }
        case 'toolCall': {
            const call = event as ToolCallEvent;
            return {
                eventId: call.id,
                icon: rowIcon(call),
                label: toolCallLabel(call, 120),
                description: call.success === false ? 'failed' : call.success === true ? 'ok' : '',
                failed: call.success === false,
                tooltip: call.toolName ?? 'Tool call',
            };
        }
        case 'diff': {
            const diff = event as DiffEvent;
            return {
                eventId: diff.id,
                icon: rowIcon(diff),
                label: diff.filePath,
                description: `+${diff.addedLines ?? 0} \u2212${diff.removedLines ?? 0}`,
                failed: false,
                tooltip: diff.filePath,
            };
        }
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            return {
                eventId: op.id,
                icon: rowIcon(op),
                label: `${op.operationType} ${op.filePath}`,
                description: op.detail ?? '',
                failed: false,
                tooltip: `${op.operationType} ${op.filePath}`,
            };
        }
        case 'error': {
            const error = event as ErrorEvent;
            return {
                eventId: error.id,
                icon: rowIcon(error),
                label: oneLine(error.message, 120),
                description: error.severity ?? 'error',
                // Warnings are surfaced but not counted as failures.
                failed: error.severity !== 'warning',
                tooltip: error.message,
            };
        }
        case 'plannerStep':
            return {
                eventId: event.id,
                icon: rowIcon(event),
                label: oneLine((event as { description?: string }).description, 120),
                description: '',
                failed: false,
                tooltip: '',
            };
    }
}

/** Which chip section an event belongs to (`undefined` = not shown). */
function sectionOf(event: LogEvent): CommandChipSectionId | undefined {
    switch (event.type) {
        case 'command':
            return isGitCommand((event as CommandEvent).commandText) ? 'git' : 'terminal';
        case 'toolCall': return 'toolCalls';
        case 'diff': return 'fileChanges';
        case 'fileOperation': return 'fileChanges';
        case 'error': return 'errors';
        // Planning steps are not executions — the Commands view keeps them in
        // the Unified Timeline only, and so does the chip.
        case 'plannerStep': return undefined;
    }
}

// ---------------------------------------------------------------------------
// Message / turn model
// ---------------------------------------------------------------------------

interface Turn {
    /** `origIdx` of every assistant message in the turn, in transcript order. */
    assistantIndexes: number[];
}

interface SessionTurns {
    turns: Turn[];
    /** For every message index, the turn it belongs to (-1 when none). */
    turnOfMessage: number[];
}

/**
 * Group the session's messages into turns (one per user prompt).
 *
 * A leading assistant message (some sources store a preamble) forms turn 0
 * before any prompt, exactly like the Commands view's session grouping.
 */
function buildTurns(messages: readonly Message[]): SessionTurns {
    const turns: Turn[] = [];
    const turnOfMessage: number[] = new Array(messages.length).fill(-1);
    let current: Turn | undefined;

    messages.forEach((message, index) => {
        if (message.role === 'user') {
            current = { assistantIndexes: [] };
            turns.push(current);
        } else if (!current) {
            current = { assistantIndexes: [] };
            turns.push(current);
        }
        turnOfMessage[index] = turns.length - 1;
        if (message.role === 'assistant') {
            current.assistantIndexes.push(index);
        }
    });

    return { turns, turnOfMessage };
}

/** Timestamped assistant message, used by the timestamp rule. */
interface AssistantTimestamp {
    messageIndex: number;
    ms: number;
}

function assistantTimestamps(messages: readonly Message[]): AssistantTimestamp[] {
    const result: AssistantTimestamp[] = [];
    messages.forEach((message, index) => {
        if (message.role !== 'assistant' || !isUsableTimestamp(message.timestamp)) { return; }
        result.push({ messageIndex: index, ms: Date.parse(message.timestamp as string) });
    });
    return result;
}

/**
 * Decide whether timestamp correlation may be trusted.
 *
 * A handful of timestamped replies among many undated ones (Copilot stores no
 * timestamp for a turn that never reached the API) would make "latest reply
 * before the event" meaningless, so timestamps are only used when they cover
 * at least half of the responses.
 */
function trustTimestamps(messages: readonly Message[], timestamps: AssistantTimestamp[]): boolean {
    if (timestamps.length === 0) { return false; }
    const assistantCount = messages.filter((message) => message.role === 'assistant').length;
    return timestamps.length * 2 >= assistantCount;
}

/** Latest response that started at or before the event. */
function resolveByTimestamp(
    event: LogEvent,
    timestamps: readonly AssistantTimestamp[]
): number | undefined {
    if (!isUsableTimestamp(event.timestamp)) { return undefined; }
    const eventMs = Date.parse(event.timestamp);

    let best: AssistantTimestamp | undefined;
    for (const candidate of timestamps) {
        if (candidate.ms > eventMs) { continue; }
        if (!best || candidate.ms >= best.ms) { best = candidate; }
    }
    return best?.messageIndex;
}

/**
 * Resolve `event.messageIndex`: turn-number adapters (Copilot, Cline / Roo
 * Code, Aider) use it as the user-prompt turn, raw-index adapters (Windsurf)
 * as the transcript position of the message that produced the event.
 */
function resolveByMessageIndex(
    event: LogEvent,
    messages: readonly Message[],
    sessionTurns: SessionTurns
): number | undefined {
    const index = event.messageIndex;
    if (index === undefined || !Number.isFinite(index) || index < 0) { return undefined; }
    const truncated = Math.trunc(index);

    // Turn-number adapters (Copilot, Cline / Roo Code, Aider) store the prompt
    // turn; raw-index adapters (Windsurf) store the transcript position and
    // must not be interpreted as turns — the two collide numerically.
    if (!RAW_MESSAGE_INDEX_TOOLS.has(event.tool)) {
        const turn = sessionTurns.turns[truncated];
        if (turn && turn.assistantIndexes.length > 0) {
            // The reply that triggered the turn's tool loop is its last response.
            return turn.assistantIndexes[turn.assistantIndexes.length - 1];
        }
    }

    const message = messages[truncated];
    if (!message) { return undefined; }
    if (message.role === 'assistant') { return truncated; }

    // A raw index pointing at the user prompt: use the response that follows.
    const owningTurn = sessionTurns.turnOfMessage[truncated];
    if (owningTurn < 0) { return undefined; }
    const owningAssistants = sessionTurns.turns[owningTurn].assistantIndexes;
    return owningAssistants.length > 0 ? owningAssistants[owningAssistants.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// Chip building
// ---------------------------------------------------------------------------

/** Chronological order, only when every event has a usable timestamp. */
function orderEvents(events: readonly LogEvent[]): LogEvent[] {
    const ordered = [...events];
    if (!events.every((event) => isUsableTimestamp(event.timestamp))) { return ordered; }
    // Array.prototype.sort is stable, so equal timestamps keep adapter order.
    ordered.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return ordered;
}

function buildChip(
    messageIndex: number,
    turnIndex: number,
    events: readonly LogEvent[]
): CommandChip {
    const counts: CommandChipCounts = {
        git: 0,
        terminal: 0,
        toolCalls: 0,
        fileChanges: 0,
        errors: 0,
    };

    // A `patch` file operation and its paired diff describe the same edit —
    // only the diff (with its ± line counts) is shown, like the Diff Explorer.
    const diffPaths = new Set(
        events
            .filter((event): event is DiffEvent => event.type === 'diff')
            .map((event) => event.filePath)
    );

    const buckets = new Map<CommandChipSectionId, CommandChipRow[]>();
    for (const meta of SECTION_META) { buckets.set(meta.id, []); }

    let failedCount = 0;
    for (const event of events) {
        if (
            event.type === 'fileOperation'
            && (event as FileOperationEvent).operationType === 'patch'
            && diffPaths.has((event as FileOperationEvent).filePath)
        ) {
            continue;
        }

        const sectionId = sectionOf(event);
        if (!sectionId) { continue; }

        const row = describeRow(event);
        buckets.get(sectionId)?.push(row);
        counts[sectionId] += 1;
        if (row.failed) { failedCount += 1; }
    }

    const sections: CommandChipSection[] = [];
    for (const meta of SECTION_META) {
        const rows = buckets.get(meta.id) ?? [];
        if (rows.length === 0) { continue; }
        sections.push({
            id: meta.id,
            label: meta.label,
            icon: meta.icon,
            rows: rows.slice(0, MAX_ROWS_PER_SECTION),
            truncated: Math.max(0, rows.length - MAX_ROWS_PER_SECTION),
        });
    }

    const total = sections.reduce((sum, section) => sum + counts[section.id], 0);
    return {
        messageIndex,
        turnIndex,
        total,
        failedCount,
        counts,
        summary: formatCommandChipSummary(counts),
        sections,
        tooltip: `${total} agent action${total === 1 ? '' : 's'} executed after this response`,
    };
}

/**
 * Correlate the session's log events with its responses.
 *
 * @param events   Normalized events of one session (`LogService.getEvents`).
 * @param messages The session's messages (removed turns included — indexes
 *                 must match `origIdx`).
 * @returns A map keyed by the assistant message's `origIdx`. Messages without
 *          executed actions are absent.
 */
export function buildCommandChips(
    events: readonly LogEvent[],
    messages: readonly Message[]
): Map<number, CommandChip> {
    const chips = new Map<number, CommandChip>();
    if (events.length === 0 || messages.length === 0) { return chips; }

    const sessionTurns = buildTurns(messages);
    const timestamps = assistantTimestamps(messages);
    const useTimestamps = trustTimestamps(messages, timestamps);

    const byMessage = new Map<number, LogEvent[]>();
    for (const event of orderEvents(events)) {
        const target = useTimestamps
            ? resolveByTimestamp(event, timestamps) ?? resolveByMessageIndex(event, messages, sessionTurns)
            : resolveByMessageIndex(event, messages, sessionTurns);
        if (target === undefined) { continue; }

        const bucket = byMessage.get(target);
        if (bucket) {
            bucket.push(event);
        } else {
            byMessage.set(target, [event]);
        }
    }

    for (const [messageIndex, messageEvents] of byMessage) {
        const turnIndex = sessionTurns.turnOfMessage[messageIndex] ?? 0;
        chips.set(messageIndex, buildChip(messageIndex, turnIndex, messageEvents));
    }
    return chips;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderRow(row: CommandChipRow): string {
    const badge = row.description
        ? `<span class="cw-cmd-row-badge">${escapeHtml(row.description)}</span>`
        : '';
    return `<li class="cw-cmd-row${row.failed ? ' cw-failed' : ''}" data-event-id="${escapeHtml(row.eventId)}" tabindex="0" title="${escapeHtml(row.tooltip)}">`
        + `<span class="cw-cmd-row-icon" aria-hidden="true">${row.icon}</span>`
        + `<span class="cw-cmd-row-label">${escapeHtml(row.label)}</span>${badge}</li>`;
}

function renderSection(section: CommandChipSection): string {
    const rows = section.rows.map(renderRow).join('');
    const more = section.truncated > 0
        ? `<li class="cw-cmd-row cw-cmd-more">\u2026 ${section.truncated} more</li>`
        : '';
    return `<details class="cw-cmd-section" open>`
        + `<summary class="cw-cmd-section-summary">`
        + `<span class="cw-cmd-section-icon" aria-hidden="true">${section.icon}</span>`
        + `<span class="cw-cmd-section-title">${escapeHtml(section.label)}</span>`
        + `<span class="cw-cmd-section-count">${section.rows.length + section.truncated}</span>`
        + `</summary><ul class="cw-cmd-rows">${rows}${more}</ul></details>`;
}

/**
 * Render one chip. The outer `<details>` has no `open` attribute, so the chip
 * is **collapsed by default** exactly as requested; the sections inside are
 * open so a single click reveals the executed actions.
 */
export function renderCommandChip(chip: CommandChip): string {
    const failed = chip.failedCount > 0
        ? `<span class="cw-cmd-chip-failed">${chip.failedCount} failed</span>`
        : '';
    const sections = chip.sections.map(renderSection).join('');
    return `<details class="cw-cmd-chip" data-cmd-turn="${chip.turnIndex}">`
        + `<summary class="cw-cmd-chip-summary" title="${escapeHtml(chip.tooltip)}">`
        + `<span class="cw-cmd-chip-title">Commands</span>`
        + `<span class="cw-cmd-chip-total">${chip.total}</span>`
        + `<span class="cw-cmd-chip-stats">${escapeHtml(chip.summary)}</span>${failed}`
        + `</summary><div class="cw-cmd-chip-body">${sections}</div></details>`;
}

/**
 * Build the rendered HTML of every response chip of a session.
 *
 * @returns `origIdx → chip HTML`, ready to be appended after the message.
 */
export function buildCommandChipHtml(
    events: readonly LogEvent[],
    messages: readonly Message[]
): Map<number, string> {
    const html = new Map<number, string>();
    for (const [messageIndex, chip] of buildCommandChips(events, messages)) {
        html.set(messageIndex, renderCommandChip(chip));
    }
    return html;
}

