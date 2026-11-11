/**
 * src/logs/logStats.ts
 *
 * Phase 4 — per-agent / per-session statistics for the watch-logs store.
 *
 * The work plan asks for "per-agent stats (commands per session, failures,
 * etc.)". This module turns the normalized `LogEvent`s into a small report:
 *
 *   - totals (events, commands, failed commands, errors, diffs, +/− lines)
 *   - command success rate (over commands that logged an exit code only)
 *   - one row **per agent** (Commands, Failed, Errors, Sessions, Diffs, …)
 *   - one row **per session** (events, commands, failures, last activity)
 *
 * Everything here is pure: `computeLogStats()` takes the events a caller pulled
 * from `LogService`, `renderLogStatsMarkdown()` formats the report for the
 * "Show Agent Log Stats" command. Both are unit-tested without a VS Code host.
 */

import {
    CommandEvent,
    DiffEvent,
    LogEvent,
    LogSourceTool,
} from './types';
import { isFailedCommand, isFailureEvent } from './logFilters';

/** How many session rows the markdown report lists before truncating. */
export const STATS_SESSION_ROW_LIMIT = 25;

/** Aggregated counters for one agent tool. */
export interface ToolLogStats {
    tool: LogSourceTool;
    events: number;
    /** Distinct chat sessions that produced events for this tool. */
    sessions: number;
    commands: number;
    /** Commands that finished with a non-zero exit code. */
    failedCommands: number;
    /** Failed commands + non-warning error events. */
    failures: number;
    diffs: number;
    fileOperations: number;
    toolCalls: number;
    errors: number;
    plannerSteps: number;
    addedLines: number;
    removedLines: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
}

/** Aggregated counters for one chat session (or one unsessioned agent bucket). */
export interface SessionLogStats {
    /** `sessionId`, or `tool:<agent>` when the events carry no session id. */
    key: string;
    sessionId?: string;
    tool: LogSourceTool;
    events: number;
    commands: number;
    failedCommands: number;
    failures: number;
    lastTimestamp?: string;
}

/** Complete report returned by `computeLogStats()`. */
export interface LogStatsReport {
    totalEvents: number;
    /** Distinct agents that produced events. */
    toolCount: number;
    /** Distinct sessions (including unsessioned agent buckets). */
    sessionCount: number;
    commands: number;
    failedCommands: number;
    failures: number;
    errors: number;
    diffs: number;
    addedLines: number;
    removedLines: number;
    /**
     * `successful / commands with a known exit code`, in the 0–1 range.
     * `null` when no command logged an exit code (Aider, Cline, Windsurf do
     * not record one) — a rate would be misleading.
     */
    successRate: number | null;
    /** Commands that carried an exit code (the denominator of `successRate`). */
    commandsWithExitCode: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
    /** Per-agent rows, most active first. */
    byTool: ToolLogStats[];
    /** Per-session rows, most recent first (capped at `STATS_SESSION_ROW_LIMIT`). */
    sessions: SessionLogStats[];
}

/** Later of two ISO timestamps (either may be missing). */
function newer(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) { return b; }
    if (!b) { return a; }
    return a >= b ? a : b;
}

/** Earlier of two ISO timestamps (either may be missing). */
function older(a: string | undefined, b: string | undefined): string | undefined {
    if (!a) { return b; }
    if (!b) { return a; }
    return a <= b ? a : b;
}

/** A zeroed per-agent counter row. */
function newToolStats(tool: LogSourceTool): ToolLogStats {
    return {
        tool,
        events: 0,
        sessions: 0,
        commands: 0,
        failedCommands: 0,
        failures: 0,
        diffs: 0,
        fileOperations: 0,
        toolCalls: 0,
        errors: 0,
        plannerSteps: 0,
        addedLines: 0,
        removedLines: 0,
    };
}

/** Aggregate the given events into a per-agent / per-session report. */
export function computeLogStats(events: LogEvent[]): LogStatsReport {
    const tools = new Map<LogSourceTool, ToolLogStats & { sessionIds: Set<string> }>();
    const sessions = new Map<string, SessionLogStats>();

    let commands = 0;
    let failedCommands = 0;
    let errors = 0;
    let diffs = 0;
    let addedLines = 0;
    let removedLines = 0;
    let commandsWithExitCode = 0;
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;

    for (const event of events) {
        const sessionKey = event.sessionId ?? `tool:${event.tool}`;

        let toolRow = tools.get(event.tool);
        if (!toolRow) {
            toolRow = { ...newToolStats(event.tool), sessionIds: new Set<string>() };
            tools.set(event.tool, toolRow);
        }
        if (event.sessionId) { toolRow.sessionIds.add(event.sessionId); }

        let sessionRow = sessions.get(sessionKey);
        if (!sessionRow) {
            sessionRow = {
                key: sessionKey,
                sessionId: event.sessionId,
                tool: event.tool,
                events: 0,
                commands: 0,
                failedCommands: 0,
                failures: 0,
            };
            sessions.set(sessionKey, sessionRow);
        }

        toolRow.events += 1;
        sessionRow.events += 1;
        toolRow.firstTimestamp = older(toolRow.firstTimestamp, event.timestamp);
        toolRow.lastTimestamp = newer(toolRow.lastTimestamp, event.timestamp);
        sessionRow.lastTimestamp = newer(sessionRow.lastTimestamp, event.timestamp);
        firstTimestamp = older(firstTimestamp, event.timestamp);
        lastTimestamp = newer(lastTimestamp, event.timestamp);

        if (isFailureEvent(event)) {
            toolRow.failures += 1;
            sessionRow.failures += 1;
        }

        switch (event.type) {
            case 'command': {
                const command = event as CommandEvent;
                commands += 1;
                toolRow.commands += 1;
                sessionRow.commands += 1;
                if (command.exitCode !== undefined) { commandsWithExitCode += 1; }
                if (isFailedCommand(command)) {
                    failedCommands += 1;
                    toolRow.failedCommands += 1;
                    sessionRow.failedCommands += 1;
                }
                break;
            }
            case 'diff': {
                const diff = event as DiffEvent;
                diffs += 1;
                toolRow.diffs += 1;
                addedLines += diff.addedLines ?? 0;
                removedLines += diff.removedLines ?? 0;
                toolRow.addedLines += diff.addedLines ?? 0;
                toolRow.removedLines += diff.removedLines ?? 0;
                break;
            }
            case 'fileOperation':
                toolRow.fileOperations += 1;
                break;
            case 'toolCall':
                toolRow.toolCalls += 1;
                break;
            case 'error':
                errors += 1;
                toolRow.errors += 1;
                break;
            case 'plannerStep':
                toolRow.plannerSteps += 1;
                break;
        }
    }

    const byTool: ToolLogStats[] = Array.from(tools.values())
        .map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size }))
        .sort((a, b) => b.events - a.events || a.tool.localeCompare(b.tool));

    const sessionRows = Array.from(sessions.values())
        .sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));

    return {
        totalEvents: events.length,
        toolCount: byTool.length,
        sessionCount: sessionRows.length,
        commands,
        failedCommands,
        failures: sessionRows.reduce((total, s) => total + s.failures, 0),
        errors,
        diffs,
        addedLines,
        removedLines,
        successRate: commandsWithExitCode > 0
            ? (commandsWithExitCode - failedCommands) / commandsWithExitCode
            : null,
        commandsWithExitCode,
        firstTimestamp,
        lastTimestamp,
        byTool,
        sessions: sessionRows.slice(0, STATS_SESSION_ROW_LIMIT),
    };
}

// ---------------------------------------------------------------------------
// Markdown rendering (used by `Chat Wizard: Show Agent Log Stats`)
// ---------------------------------------------------------------------------

/** Escape a value for a markdown table cell. */
function mdCell(value: string | number | undefined): string {
    if (value === undefined) { return '—'; }
    return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Short, locale-independent timestamp (`YYYY-MM-DD HH:MM`). */
export function formatStatsTime(timestamp: string | undefined): string {
    if (!timestamp) { return '—'; }
    const ms = Date.parse(timestamp);
    if (isNaN(ms)) { return timestamp; }
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `92.3%` (or `—` when no command logged an exit code). */
export function formatSuccessRate(rate: number | null): string {
    if (rate === null) { return '—'; }
    return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Render the report as a self-contained markdown document.
 *
 * @param toolLabel Human-readable agent name (defaults to the raw tool id) —
 *                  callers pass `friendlySourceName` inside VS Code.
 */
export function renderLogStatsMarkdown(
    report: LogStatsReport,
    toolLabel: (tool: LogSourceTool) => string = (tool) => tool
): string {
    const lines: string[] = [];
    lines.push('# Agent Log Stats');
    lines.push('');
    lines.push(
        `**${report.totalEvents}** event${report.totalEvents === 1 ? '' : 's'} from `
        + `**${report.toolCount}** agent${report.toolCount === 1 ? '' : 's'} across `
        + `**${report.sessionCount}** session${report.sessionCount === 1 ? '' : 's'}.`
    );
    if (report.firstTimestamp || report.lastTimestamp) {
        lines.push('');
        lines.push(`Activity: ${formatStatsTime(report.firstTimestamp)} → ${formatStatsTime(report.lastTimestamp)}`);
    }
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Events | ${report.totalEvents} |`);
    lines.push(`| Commands | ${report.commands} |`);
    lines.push(`| Failed commands | ${report.failedCommands} |`);
    lines.push(`| Failures (failed commands + errors) | ${report.failures} |`);
    lines.push(`| Errors | ${report.errors} |`);
    lines.push(`| Diffs | ${report.diffs} |`);
    lines.push(`| Lines added / removed | +${report.addedLines} / −${report.removedLines} |`);
    lines.push(
        `| Command success rate | ${formatSuccessRate(report.successRate)}`
        + `${report.successRate === null ? ' (no exit codes recorded)' : ` of ${report.commandsWithExitCode}`} |`
    );
    lines.push('');

    lines.push('## Per agent');
    lines.push('');
    lines.push('| Agent | Events | Sessions | Commands | Failed | Errors | Diffs | Files | Tool calls | Steps |');
    lines.push('|-------|--------|----------|----------|--------|--------|-------|-------|------------|-------|');
    for (const row of report.byTool) {
        lines.push(
            `| ${mdCell(toolLabel(row.tool))} | ${row.events} | ${row.sessions} | ${row.commands} | `
            + `${row.failedCommands} | ${row.errors} | ${row.diffs} | ${row.fileOperations} | `
            + `${row.toolCalls} | ${row.plannerSteps} |`
        );
    }
    lines.push('');

    lines.push(`## Per session (newest ${report.sessions.length})`);
    lines.push('');
    if (report.sessions.length === 0) {
        lines.push('_No sessions recorded._');
    } else {
        lines.push('| Session | Agent | Events | Commands | Failed | Failures | Last activity |');
        lines.push('|---------|-------|--------|----------|--------|----------|---------------|');
        for (const row of report.sessions) {
            const id = row.sessionId
                ? row.sessionId.length > 16 ? `${row.sessionId.slice(0, 16)}…` : row.sessionId
                : '(no session)';
            lines.push(
                `| ${mdCell(id)} | ${mdCell(toolLabel(row.tool))} | ${row.events} | ${row.commands} | `
                + `${row.failedCommands} | ${row.failures} | ${formatStatsTime(row.lastTimestamp)} |`
            );
        }
        if (report.sessionCount > report.sessions.length) {
            lines.push('');
            lines.push(`_${report.sessionCount - report.sessions.length} older session(s) omitted._`);
        }
    }
    lines.push('');
    return lines.join('\n');
}
