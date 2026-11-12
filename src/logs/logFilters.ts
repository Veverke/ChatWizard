/**
 * src/logs/logFilters.ts
 *
 * Phase 4 — filters + search for the watch-logs **Commands** view.
 *
 * Phase 3 gave the Unified Timeline a single "event kind" filter. Phase 4 adds
 * the two dimensions the work plan asks for on top of it:
 *
 *   - **search**  — free-text query matched against the human-readable parts of
 *                   every event (command text, file path, diff text, tool name,
 *                   error message, planner step, workspace path, agent name).
 *                   Multiple words are AND-ed, matching is case-insensitive.
 *   - **agent**   — restrict to the events one AI tool produced (`LogSourceTool`).
 *   - **failures**— only failed commands (`exitCode !== 0`) and non-warning
 *                   `error` events.
 *
 * The predicates are pure so both the tree providers (which post-filter the
 * rows they pull from the store) and the unit tests can share them without a
 * VS Code host.
 */

import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    LogEventType,
    LogSourceTool,
    PlannerStepEvent,
    ToolCallEvent,
    logEventTypeLabel,
} from './types';

/**
 * Filters applied on top of a watch-logs query.
 * Every field is optional; intersecting filters are AND-ed.
 */
export interface LogViewFilters {
    /** Free-text query (case-insensitive, words are AND-ed). */
    search?: string;
    /** Restrict to a single agent tool. */
    tool?: LogSourceTool;
    /** Show only failed commands and non-warning errors. */
    failuresOnly?: boolean;
    /** Restrict to the given event kinds (Unified Timeline kind filter). */
    types?: LogEventType[];
}

/** A filter set that shows everything. */
export function emptyLogFilters(): LogViewFilters {
    return {};
}

/** Trim a search box value; blank input means "no search". */
export function normalizeSearchQuery(query: string | undefined): string | undefined {
    const trimmed = (query ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** Split a query into lower-cased words (all of which must match). */
export function searchTokens(query: string | undefined): string[] {
    const normalized = normalizeSearchQuery(query);
    if (!normalized) { return []; }
    return normalized.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The text facets of an event that a search query is matched against.
 * Kept intentionally narrow: only human-meaningful content, never ids or JSON
 * keys, so searching for "command" does not match every stack trace.
 */
export function eventSearchText(event: LogEvent): string {
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            return [c.commandText, c.cwd, c.shell, c.stdoutSummary, c.stderrSummary]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            return [op.operationType, op.filePath, op.oldPath, op.detail]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
        case 'diff': {
            const d = event as DiffEvent;
            return [d.filePath, d.diffText]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
        case 'toolCall': {
            const t = event as ToolCallEvent;
            return [t.toolName, t.resultSummary, t.arguments ? safeStringify(t.arguments) : undefined]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
        case 'error': {
            const e = event as ErrorEvent;
            return [e.message, e.stackTrace]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
        case 'plannerStep': {
            const p = event as PlannerStepEvent;
            return [p.description, p.status, p.stepType]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('\n');
        }
    }
}

/** JSON.stringify that never throws (circular tool arguments, BigInt, …). */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}


/**
 * Whether an event matches the free-text query. The agent name and workspace
 * path are searchable too, so "npm copilot" finds Copilot's npm commands.
 */
export function matchesSearch(event: LogEvent, query: string | undefined): boolean {
    const tokens = searchTokens(query);
    if (tokens.length === 0) { return true; }

    const haystack = [
        eventSearchText(event),
        event.tool,
        event.workspacePath ?? '',
    ].join('\n').toLowerCase();

    return tokens.every((token) => haystack.includes(token));
}

/** True when a command finished with a non-zero exit code. */
export function isFailedCommand(event: LogEvent): boolean {
    if (event.type !== 'command') { return false; }
    const exitCode = (event as CommandEvent).exitCode;
    return exitCode !== undefined && exitCode !== 0;
}

/**
 * True when an event represents a failure: a failed command or an `error`
 * event. `warning`-severity errors are deliberately excluded so "failures
 * only" stays actionable.
 */
export function isFailureEvent(event: LogEvent): boolean {
    if (event.type === 'error') {
        return (event as ErrorEvent).severity !== 'warning';
    }
    return isFailedCommand(event);
}

/** AND-combined predicate for every filter dimension. */
export function matchesLogFilters(event: LogEvent, filters: LogViewFilters): boolean {
    if (filters.types && filters.types.length > 0 && !filters.types.includes(event.type)) {
        return false;
    }
    if (filters.tool && event.tool !== filters.tool) {
        return false;
    }
    if (filters.failuresOnly && !isFailureEvent(event)) {
        return false;
    }
    if (filters.search && !matchesSearch(event, filters.search)) {
        return false;
    }
    return true;
}

/** Convenience wrapper — filters a list of events (order preserved). */
export function filterEvents(events: LogEvent[], filters: LogViewFilters): LogEvent[] {
    if (!hasActiveFilters(filters)) { return events; }
    return events.filter((event) => matchesLogFilters(event, filters));
}

/** True when at least one filter dimension is set. */
export function hasActiveFilters(filters: LogViewFilters): boolean {
    return Boolean(
        normalizeSearchQuery(filters.search)
        || filters.tool
        || filters.failuresOnly
        || (filters.types && filters.types.length > 0)
    );
}

/**
 * Human-readable summary of the active filters, e.g.
 * `"npm test" · GitHub Copilot · failures only · kind: Error / Failure`.
 * Returns an empty string when nothing is filtered.
 */
export function describeLogFilters(
    filters: LogViewFilters,
    toolLabel: (tool: LogSourceTool) => string = (tool) => tool
): string {
    const parts: string[] = [];
    const search = normalizeSearchQuery(filters.search);
    if (search) { parts.push(`"${search}"`); }
    if (filters.tool) { parts.push(toolLabel(filters.tool)); }
    if (filters.failuresOnly) { parts.push('failures only'); }
    if (filters.types && filters.types.length > 0) {
        parts.push(`kind: ${filters.types.map((t) => logEventTypeLabel(t)).join(', ')}`);
    }
    return parts.join(' · ');
}
