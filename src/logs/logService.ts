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

import { LogEvent, LogEventFilter } from './types';
import { LogEventStore, LogStoreStats } from './logEventStore';
import { LogSourceRegistry, LogSourceConfig } from './logSourceRegistry';

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
    /** Drop every stored event. */
    clear(): void;
    /** Registered log source configs (optionally only enabled ones). */
    getSources(enabledOnly?: boolean): LogSourceConfig[];
    /** Aggregate storage statistics. */
    getStats(): LogStoreStats;
    /** The wrapped store (for callers that need raw access). */
    readonly store: LogEventStore;
    /** The wrapped source registry. */
    readonly registry: LogSourceRegistry;
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
    public readonly store: LogEventStore;
    public readonly registry: LogSourceRegistry;

    constructor(storeDir: string, registry?: LogSourceRegistry) {
        this.store = new LogEventStore(storeDir);
        this.registry = registry ?? new LogSourceRegistry();
        this.store.open();
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