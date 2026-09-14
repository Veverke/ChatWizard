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

export class LogEventStore {
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