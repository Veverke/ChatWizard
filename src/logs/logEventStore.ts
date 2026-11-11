/**
 * src/logs/logEventStore.ts
 *
 * Phase 1 — Storage / indexing layer for normalized agent-log events.
 *
 * Appends `LogEvent`s into a dedicated SQLite database
 * (`chatwizard-log-events.db`, colocated with the session cache) and indexes
 * them by sessionId, tool, timestamp, filePath, workspaceId and eventType so
 * the future UI panels (Executed Commands, Unified Timeline, …) can query
 * efficiently.
 *
 * Conventions mirror `src/cache/cacheManager.ts`:
 *   - raw better-sqlite3 prepared statements (no ORM)
 *   - WAL mode + busy_timeout for crash recovery and multi-IDE safety
 *   - schema versioned via `PRAGMA user_version`, rebuild on mismatch
 *
 * The full normalized event is stored as JSON in the `payload` column; the
 * dedicated columns are denormalized facets used for filtering/indexing.
 */

import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
    LogEvent,
    LOG_EVENT_TYPES,
    LogEventFilter,
    LogEventType,
    LogSourceTool,
    getEventFilePath,
} from './types';

// ── Constants ────────────────────────────────────────────────────────────────

export const LOG_EVENTS_DB_FILENAME = 'chatwizard-log-events.db';

/** Bump when the agent_events schema changes in a non-backward-compatible way. */
export const LOG_SCHEMA_VERSION = 1;

/** Hard cap on rows returned by a single getEvents() query. */
export const MAX_EVENTS_PER_QUERY = 5000;

/** Default number of rows returned when the caller omits `limit`. */
export const DEFAULT_EVENTS_PER_QUERY = 200;

// ── Common store contract ────────────────────────────────────────────────────

/**
 * Storage contract implemented by both the SQLite-backed store and the
 * in-memory fallback. `LogService` picks the SQLite store when it can be
 * opened and silently degrades to the in-memory one when the native
 * `better-sqlite3` binding is unavailable (dev host without
 * `npm run rebuild:native`, non-VS Code IDE, read-only cache dir, …).
 *
 * The fallback keeps every panel functional for the current session; it just
 * does not survive a restart.
 */
export interface ILogEventStore {
    /** True once `open()` succeeded (for either backend). */
    readonly isOpen: boolean;
    /** Path the SQLite database would live at. */
    readonly dbPath: string;
    /** True when events survive a restart (SQLite), false for the memory store. */
    readonly isPersistent: boolean;
    /** Why the SQLite backend was not used, when it fell back to memory. */
    readonly degradedReason?: string;
    open(): void;
    close(): void;
    upsertEvent(event: LogEvent): void;
    upsertEvents(events: LogEvent[]): void;
    removeEventsForSession(sessionId: string): number;
    removeBySourcePath(sourcePath: string): number;
    clear(): void;
    getEvents(filter?: LogEventFilter): LogEvent[];
    getEventCount(): number;
    countBySourcePath(sourcePath: string): number;
    getStats(): LogStoreStats;
}

// ── Row type ─────────────────────────────────────────────────────────────────

interface DbLogEventRow {
    id: string;
    event_type: LogEventType;
    timestamp: string;
    tool: LogSourceTool;
    session_id: string | null;
    workspace_id: string | null;
    workspace_path: string | null;
    file_path: string | null;
    source_path: string | null;
    message_index: number | null;
    payload: string;
    raw: string | null;
}

/** Aggregate stats reported by the store. */
export interface LogStoreStats {
    totalEvents: number;
    byType: Record<LogEventType, number>;
    tools: LogSourceTool[];
    schemaVersion: number;
}
// ── Store implementation ─────────────────────────────────────────────────────

export class LogEventStore implements ILogEventStore {
    private db: BetterSqlite3.Database | null = null;
    private readonly _dbPath: string;
    private _isOpen = false;

    // Prepared statements — built once in _prepareStatements()
    private stmt: {
        upsertEvent: BetterSqlite3.Statement;
        deleteBySession: BetterSqlite3.Statement;
        deleteBySourcePath: BetterSqlite3.Statement;
        deleteAll: BetterSqlite3.Statement;
        getEventCount: BetterSqlite3.Statement;
        countBySourcePath: BetterSqlite3.Statement;
        countByType: BetterSqlite3.Statement;
        getDistinctTools: BetterSqlite3.Statement;
    } | null = null;

    constructor(storageDir: string) {
        this._dbPath = path.join(storageDir, LOG_EVENTS_DB_FILENAME);
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    get dbPath(): string {
        return this._dbPath;
    }

    /** SQLite is the durable backend — always persistent when it is used. */
    get isPersistent(): boolean {
        return true;
    }

    /** The SQLite store never degrades, so there is no reason to report. */
    readonly degradedReason?: string = undefined;

    /**
     * Open (or create) the SQLite database, ensure the schema is at the
     * current version and prepare statements. Must be called before any
     * other operation.
     */
    open(): void {
        if (this._isOpen) { return; }

        const dir = path.dirname(this._dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new BetterSqlite3(this._dbPath);
        this.db.pragma('journal_mode = WAL');
        // Multi-process safety: retry up to 3 s when another IDE holds the write lock
        this.db.pragma('busy_timeout = 3000');

        this._ensureSchema();
        this._prepareStatements();
        this._isOpen = true;
    }

    private _ensureSchema(): void {
        if (!this.db) { throw new Error('LogEventStore not open'); }

        const userVersion = this.db.pragma('user_version', { simple: true }) as number;

        if (userVersion > LOG_SCHEMA_VERSION) {
            // Shared-cache scenario: a different IDE has a newer ChatWizard.
            // Throw so the caller can fall back to running without the store.
            throw new Error(
                `Log event DB schema version ${userVersion} is newer than ` +
                `this extension supports (${LOG_SCHEMA_VERSION}). ` +
                'Please update ChatWizard to read this store.'
            );
        }

        if (userVersion < LOG_SCHEMA_VERSION) {
            // Drop any partial/older tables then build the current schema.
            // Dropping agent_events also drops its indexes.
            this.db.exec('DROP TABLE IF EXISTS agent_events');
            this.db.exec(SCHEMA_SQL);
            this.db.pragma(`user_version = ${LOG_SCHEMA_VERSION}`);
        }
        // userVersion === LOG_SCHEMA_VERSION → schema already up to date.
    }
private _prepareStatements(): void {
        if (!this.db) { throw new Error('LogEventStore not open'); }

        this.stmt = {
            upsertEvent: this.db.prepare(`
                INSERT INTO agent_events (
                    id, event_type, timestamp, tool,
                    session_id, workspace_id, workspace_path, file_path,
                    source_path, message_index, payload, raw
                )
                VALUES (
                    @id, @eventType, @timestamp, @tool,
                    @sessionId, @workspaceId, @workspacePath, @filePath,
                    @sourcePath, @messageIndex, @payload, @raw
                )
                ON CONFLICT(id) DO UPDATE SET
                    event_type     = excluded.event_type,
                    timestamp      = excluded.timestamp,
                    tool           = excluded.tool,
                    session_id     = excluded.session_id,
                    workspace_id   = excluded.workspace_id,
                    workspace_path = excluded.workspace_path,
                    file_path      = excluded.file_path,
                    source_path    = excluded.source_path,
                    message_index  = excluded.message_index,
                    payload        = excluded.payload,
                    raw            = excluded.raw
            `),

            deleteBySession: this.db.prepare('DELETE FROM agent_events WHERE session_id = ?'),
            deleteBySourcePath: this.db.prepare('DELETE FROM agent_events WHERE source_path = ?'),
            deleteAll: this.db.prepare('DELETE FROM agent_events'),

            getEventCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM agent_events'),
            countBySourcePath: this.db.prepare('SELECT COUNT(*) AS cnt FROM agent_events WHERE source_path = ?'),
            countByType: this.db.prepare(
                'SELECT event_type AS eventType, COUNT(*) AS cnt FROM agent_events GROUP BY event_type'
            ),
            getDistinctTools: this.db.prepare('SELECT DISTINCT tool FROM agent_events ORDER BY tool'),
        };
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /** Insert or replace a single normalized event. */
    upsertEvent(event: LogEvent): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('LogEventStore failed to open database');
        }
        this.stmt.upsertEvent.run(eventToRow(event));
    }

    /** Insert or replace many events in one atomic transaction. */
    upsertEvents(events: LogEvent[]): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('LogEventStore failed to open database');
        }
        if (events.length === 0) { return; }

        const transaction = this.db.transaction((evts: LogEvent[]) => {
            for (const event of evts) {
                this.stmt!.upsertEvent.run(eventToRow(event));
            }
        });
        transaction(events);
    }

    /** Remove all events attached to a chat session. Returns rows removed. */
    removeEventsForSession(sessionId: string): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }
        const result = this.stmt.deleteBySession.run(sessionId);
        return Number(result.changes ?? 0);
    }

    /** Remove events parsed from a given source log file. Returns rows removed. */
    removeBySourcePath(sourcePath: string): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }
        const result = this.stmt.deleteBySourcePath.run(sourcePath);
        return Number(result.changes ?? 0);
    }

    /** Remove every stored event (keeps schema). */
    clear(): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }
        this.stmt.deleteAll.run();
    }
// ── Reads / queries ──────────────────────────────────────────────────────

    /**
     * Query normalized events, intersecting every provided filter field (AND).
     * Returns the matching events ordered by timestamp (default: newest first)
     * and capped at `MAX_EVENTS_PER_QUERY`.
     */
    getEvents(filter: LogEventFilter = {}): LogEvent[] {
        if (!this.db) { this.open(); }
        if (!this.db || !this.stmt) { return []; }

        const where: string[] = [];
        const params: unknown[] = [];

        if (filter.sessionId) {
            where.push('session_id = ?');
            params.push(filter.sessionId);
        }

        const types = filter.type
            ? [filter.type]
            : filter.types;
        if (types && types.length > 0) {
            where.push(`event_type IN (${types.map(() => '?').join(', ')})`);
            params.push(...types);
        }

        if (filter.tool) {
            const tools = Array.isArray(filter.tool) ? filter.tool : [filter.tool];
            where.push(`tool IN (${tools.map(() => '?').join(', ')})`);
            params.push(...tools);
        }

        if (filter.filePath) {
            where.push('file_path = ?');
            params.push(filter.filePath);
        }

        if (filter.workspaceId) {
            where.push('workspace_id = ?');
            params.push(filter.workspaceId);
        }

        if (filter.from) {
            where.push('timestamp >= ?');
            params.push(filter.from);
        }

        if (filter.to) {
            where.push('timestamp <= ?');
            params.push(filter.to);
        }

        // Pagination — clamped so a stray caller cannot OOM the host.
        const limit = Math.min(
            Math.max(1, filter.limit ?? DEFAULT_EVENTS_PER_QUERY),
            MAX_EVENTS_PER_QUERY
        );
        const offset = Math.max(0, filter.offset ?? 0);
        const order = filter.order === 'asc' ? 'ASC' : 'DESC';

        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const sql = `SELECT * FROM agent_events ${whereSql} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const rows = this.db.prepare(sql).all(...params) as DbLogEventRow[];
        return rows.map(rowToEvent);
    }

    /** Total number of stored events. */
    getEventCount(): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }
        const row = this.stmt.getEventCount.get() as { cnt: number };
        return row?.cnt ?? 0;
    }

    /** Number of stored events parsed from a given source log file. */
    countBySourcePath(sourcePath: string): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }
        const row = this.stmt.countBySourcePath.get(sourcePath) as { cnt: number };
        return row?.cnt ?? 0;
    }

    /** Aggregate stats — totals, per-type counts, and distinct tools. */
    getStats(): LogStoreStats {
        const total = this.getEventCount();

        const byType = {} as Record<LogEventType, number>;
        for (const t of LOG_EVENT_TYPES) { byType[t] = 0; }
        if (this.db && this.stmt) {
            const counts = this.stmt.countByType.all() as { eventType: LogEventType; cnt: number }[];
            for (const { eventType, cnt } of counts) {
                byType[eventType] = cnt;
            }
        }

        const tools = this.db && this.stmt
            ? (this.stmt.getDistinctTools.all() as { tool: LogSourceTool }[]).map((r) => r.tool)
            : [];

        return { totalEvents: total, byType, tools, schemaVersion: LOG_SCHEMA_VERSION };
    }

    /**
     * Close the database connection. Safe to call multiple times.
     * Flushes WAL so the file is portable across IDEs.
     */
    close(): void {
        if (this.db) {
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            } catch { /* ignore */ }
            this.db.close();
            this.db = null;
            this.stmt = null;
            this._isOpen = false;
        }
    }
}

// ── In-memory fallback ───────────────────────────────────────────────────────

/**
 * Non-persistent `ILogEventStore` fallback.
 *
 * Used when the SQLite backend cannot be opened (missing/incompatible native
 * `better-sqlite3` binding, unwritable cache directory, newer shared schema…).
 * Keeping the panels wired to this store means the watch-logs UI still shows
 * everything harvested during the current session instead of failing to
 * activate — the root cause of the "empty left side panels + command not
 * found" regression when the native binding was absent.
 */
export class InMemoryLogEventStore implements ILogEventStore {
    private readonly _dbPath: string;
    private readonly _events = new Map<string, LogEvent>();
    private _isOpen = false;

    /** Human-readable reason the SQLite backend was skipped. */
    readonly degradedReason?: string;

    constructor(storageDir: string, degradedReason?: string) {
        // Keep the same path shape so diagnostics point at the intended DB.
        this._dbPath = path.join(storageDir, LOG_EVENTS_DB_FILENAME);
        this.degradedReason = degradedReason;
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    get dbPath(): string {
        return this._dbPath;
    }

    get isPersistent(): boolean {
        return false;
    }

    open(): void {
        this._isOpen = true;
    }

    close(): void {
        this._events.clear();
        this._isOpen = false;
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    upsertEvent(event: LogEvent): void {
        this._events.set(event.id, event);
    }

    upsertEvents(events: LogEvent[]): void {
        for (const event of events) {
            this._events.set(event.id, event);
        }
    }

    removeEventsForSession(sessionId: string): number {
        let removed = 0;
        for (const [id, event] of this._events) {
            if (event.sessionId === sessionId) {
                this._events.delete(id);
                removed++;
            }
        }
        return removed;
    }

    removeBySourcePath(sourcePath: string): number {
        let removed = 0;
        for (const [id, event] of this._events) {
            if (event.sourcePath === sourcePath) {
                this._events.delete(id);
                removed++;
            }
        }
        return removed;
    }

    clear(): void {
        this._events.clear();
    }

    // ── Reads / queries (mirror the SQL store's filter semantics) ────────────

    getEvents(filter: LogEventFilter = {}): LogEvent[] {
        const limit = Math.min(
            Math.max(1, filter.limit ?? DEFAULT_EVENTS_PER_QUERY),
            MAX_EVENTS_PER_QUERY
        );
        const offset = Math.max(0, filter.offset ?? 0);
        const direction = filter.order === 'asc' ? 1 : -1;

        return Array.from(this._events.values())
            .filter((event) => matchesFilter(event, filter))
            .sort((a, b) => {
                const cmp = a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
                return cmp * direction;
            })
            .slice(offset, offset + limit);
    }

    getEventCount(): number {
        return this._events.size;
    }

    countBySourcePath(sourcePath: string): number {
        let count = 0;
        for (const event of this._events.values()) {
            if (event.sourcePath === sourcePath) { count++; }
        }
        return count;
    }

    getStats(): LogStoreStats {
        const byType = {} as Record<LogEventType, number>;
        for (const t of LOG_EVENT_TYPES) { byType[t] = 0; }

        const tools = new Set<LogSourceTool>();
        for (const event of this._events.values()) {
            byType[event.type] = (byType[event.type] ?? 0) + 1;
            tools.add(event.tool);
        }

        return {
            totalEvents: this._events.size,
            byType,
            tools: Array.from(tools).sort(),
            schemaVersion: LOG_SCHEMA_VERSION,
        };
    }
}

/** Shared predicate used by the in-memory store (AND-combines all filters). */
function matchesFilter(event: LogEvent, filter: LogEventFilter): boolean {
    if (filter.sessionId && event.sessionId !== filter.sessionId) { return false; }

    const types = filter.type ? [filter.type] : filter.types;
    if (types && types.length > 0 && !types.includes(event.type)) { return false; }

    if (filter.tool) {
        const tools = Array.isArray(filter.tool) ? filter.tool : [filter.tool];
        if (!tools.includes(event.tool)) { return false; }
    }

    if (filter.filePath && getEventFilePath(event) !== filter.filePath) { return false; }
    if (filter.workspaceId && event.workspaceId !== filter.workspaceId) { return false; }
    if (filter.from && event.timestamp < filter.from) { return false; }
    if (filter.to && event.timestamp > filter.to) { return false; }

    return true;
}

// ── Row mapping helpers ──────────────────────────────────────────────────────

/**
 * Flatten a normalized `LogEvent` into a DB row.
 * The full event is persisted verbatim as JSON in `payload`; the extra columns
 * are denormalized facets used for filtering and indexing.
 */
function eventToRow(event: LogEvent): Record<string, unknown> {
    const filePath = getEventFilePath(event);
    return {
        id: event.id,
        eventType: event.type,
        timestamp: event.timestamp,
        tool: event.tool,
        sessionId: event.sessionId ?? null,
        workspaceId: event.workspaceId ?? null,
        workspacePath: event.workspacePath ?? null,
        filePath: filePath ?? null,
        sourcePath: event.sourcePath ?? null,
        messageIndex: event.messageIndex ?? null,
        payload: JSON.stringify(event),
        raw: event.raw ?? null,
    };
}

/**
 * Rehydrate a normalized `LogEvent` from a DB row.
 * Falls back to a minimal best-effort event if the stored payload cannot be
 * parsed, so a single corrupt row never breaks an entire listing.
 */
function rowToEvent(row: DbLogEventRow): LogEvent {
    try {
        const parsed = JSON.parse(row.payload) as LogEvent;
        // Guard against drift between schema and payload — never trust blindly.
        if (parsed && typeof parsed.id === 'string' && typeof parsed.type === 'string') {
            return parsed;
        }
    } catch { /* fall through to reconstruction */ }

    return {
        id: row.id,
        type: row.event_type,
        timestamp: row.timestamp,
        tool: row.tool,
        sessionId: row.session_id ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        workspacePath: row.workspace_path ?? undefined,
        sourcePath: row.source_path ?? undefined,
        messageIndex: row.message_index ?? undefined,
        raw: row.raw ?? undefined,
    } as LogEvent;
}

// ── Schema SQL ───────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Phase 1: normalized agent-execution log events.
-- One row per normalized event; the payload column carries the full event
-- object, the other columns are denormalized facets for filtering/indexing.
CREATE TABLE IF NOT EXISTS agent_events (
    id             TEXT PRIMARY KEY,
    event_type     TEXT NOT NULL CHECK(event_type IN ('command','fileOperation','diff','toolCall','error','plannerStep')),
    timestamp      TEXT NOT NULL,
    tool           TEXT NOT NULL,
    session_id     TEXT,
    workspace_id   TEXT,
    workspace_path TEXT,
    file_path      TEXT,
    source_path    TEXT,
    message_index  INTEGER,
    payload        TEXT NOT NULL,
    raw            TEXT
);

-- Indexes aligned with the Phase 1 plan: sessionId, tool, timestamp, filePath,
-- workspaceId and eventType.
CREATE INDEX IF NOT EXISTS idx_agent_events_session   ON agent_events(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_tool      ON agent_events(tool);
CREATE INDEX IF NOT EXISTS idx_agent_events_timestamp ON agent_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_type      ON agent_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_events_file      ON agent_events(file_path);
CREATE INDEX IF NOT EXISTS idx_agent_events_workspace ON agent_events(workspace_id);
`;