/**
 * src/logs/logService.ts
 *
 * Phase 1 — Facade over the logs subsystem.
 *
 * This is the deliverable API from the work plan:
 *
 *   logService.getEvents({ sessionId, type })
 *
 * It owns the SqlLogEventStore (storage/indexing) and the LogSourceRegistry
 * (source config), exposing a single entry point for the rest of ChatWizard.
 * Phase 2 adapters will call `ingestEvents()` after parsing tool logs; until
 * then the service is fully functional as a store + query layer.
 */

import * as path from 'path';
import { LogEvent, LogEventFilter } from './types';
import { ILogEventStore, LogEventStore, LogStoreStats, InMemoryLogEventStore } from './logEventStore';
import { LogSourceRegistry, LogSourceConfig } from './logSourceRegistry';
import { parseCopilotLogEvents } from './adapters/copilotLogAdapter';
import { parseClineLogEvents } from './adapters/clineLogAdapter';

export interface ILogService {
    /** Query normalized agent log events (the Phase 1 deliverable). */
    getEvents(filter?: LogEventFilter): LogEvent[];
    /** Persist one normalized event. */
    ingestEvent(event: LogEvent): void;
    /** Persist many normalized events in a single transaction. */
    ingestEvents(events: LogEvent[]): void;
    /** Remove all events attached to a chat session. */
    removeEventsForSession(sessionId: string): number;
    /** Remove events parsed from a given source log file. */
    removeBySourcePath(sourcePath: string): number;
    /** Number of stored events that were parsed from a given source file. */
    getEventCountForSource(sourcePath: string): number;
    /**
     * Phase 2 — Parse a Copilot session JSONL and (re)index its normalized
     * agent-execution events. Events previously parsed from the same file are
     * removed first, so live rewrites never leave stale rows.
     */
    ingestCopilotSessionFile(
        filePath: string,
        workspaceId: string,
        workspacePath?: string
    ): { ingested: number; errors: string[] };
    /**
     * Phase 3 — Parse a Cline / Roo Code task dir's ui_messages.json and
     * (re)index its normalized agent-execution events. Events previously
     * parsed from the same ui_messages.json are removed first.
     */
    ingestClineTaskFile(
        taskDir: string,
        source?: 'cline' | 'roocode'
    ): { ingested: number; errors: string[] };
    /** Drop every stored event. */
    clear(): void;
    /** Registered log source configs (optionally only enabled ones). */
    getSources(enabledOnly?: boolean): LogSourceConfig[];
    /** Aggregate storage statistics. */
    getStats(): LogStoreStats;
    /** The wrapped store (for callers that need raw access). */
    readonly store: ILogEventStore;
    /** The wrapped source registry. */
    readonly registry: LogSourceRegistry;
    /** True when events are persisted to SQLite (false = in-memory fallback). */
    readonly isPersistent: boolean;
    /**
     * Why the SQLite store could not be used, when the service fell back to
     * the in-memory store. `undefined` for a healthy persistent store.
     */
    readonly storeError?: Error;
    dispose(): void;
}

/**
 * LogService — owns storage + registry.
 *
 * `storeDir` is the directory where `chatwizard-log-events.db` is created.
 * Pass the same shared cache directory used by the session cache so events
 * survive across IDEs.
 */
export class LogService implements ILogService {
    public readonly store: ILogEventStore;
    public readonly registry: LogSourceRegistry;
    /** Set when the SQLite store could not be opened and memory was used. */
    public readonly storeError?: Error;

    /**
     * @param storeDir Directory that would hold `chatwizard-log-events.db`.
     *
     * The SQLite backend is preferred; if it cannot be opened (missing native
     * binding in the extension dev host / non-VS Code IDE, unwritable cache
     * dir, newer shared schema, …) the service degrades to an in-memory store
     * instead of throwing. Throwing here used to abort the whole watch-logs
     * UI registration (empty panels + "command not found" on refresh).
     */
    constructor(storeDir: string, registry?: LogSourceRegistry) {
        this.registry = registry ?? new LogSourceRegistry();

        const sqliteStore = new LogEventStore(storeDir);
        try {
            sqliteStore.open();
            this.store = sqliteStore;
        } catch (err) {
            try { sqliteStore.close(); } catch { /* ignore partial open */ }
            const reason = err instanceof Error ? err.message : String(err);
            this.storeError = err instanceof Error ? err : new Error(reason);
            const memoryStore = new InMemoryLogEventStore(storeDir, reason);
            memoryStore.open();
            this.store = memoryStore;
        }
    }

    /** True when events survive a restart (SQLite backend in use). */
    get isPersistent(): boolean {
        return this.store.isPersistent;
    }

    getEvents(filter?: LogEventFilter): LogEvent[] {
        return this.store.getEvents(filter);
    }

    ingestEvent(event: LogEvent): void {
        this.store.upsertEvent(event);
    }

    ingestEvents(events: LogEvent[]): void {
        this.store.upsertEvents(events);
    }

    removeEventsForSession(sessionId: string): number {
        return this.store.removeEventsForSession(sessionId);
    }

    removeBySourcePath(sourcePath: string): number {
        return this.store.removeBySourcePath(sourcePath);
    }

    getEventCountForSource(sourcePath: string): number {
        return this.store.countBySourcePath(sourcePath);
    }

    ingestCopilotSessionFile(
        filePath: string,
        workspaceId: string,
        workspacePath?: string
    ): { ingested: number; errors: string[] } {
        const result = parseCopilotLogEvents(filePath, workspaceId, workspacePath);
        if (result.events.length > 0 || this.store.countBySourcePath(filePath) > 0) {
            this.store.removeBySourcePath(filePath);
        }
        if (result.events.length > 0) {
            this.store.upsertEvents(result.events);
        }
        return { ingested: result.events.length, errors: result.errors };
    }

    ingestClineTaskFile(
        taskDir: string,
        source: 'cline' | 'roocode' = 'cline'
    ): { ingested: number; errors: string[] } {
        const result = parseClineLogEvents(taskDir, source);
        const sourcePath = path.join(taskDir, 'ui_messages.json');
        if (result.events.length > 0 || this.store.countBySourcePath(sourcePath) > 0) {
            this.store.removeBySourcePath(sourcePath);
        }
        if (result.events.length > 0) {
            this.store.upsertEvents(result.events);
        }
        return { ingested: result.events.length, errors: result.errors };
    }

    clear(): void {
        this.store.clear();
    }

    getSources(enabledOnly = false): LogSourceConfig[] {
        return enabledOnly ? this.registry.enabled() : this.registry.all();
    }

    getStats(): LogStoreStats {
        return this.store.getStats();
    }

    dispose(): void {
        this.store.close();
    }
}

// Re-export the source-side shapes so callers can import everything from here.
export type { LogSourceConfig, LogFileFormat } from './logSourceRegistry';