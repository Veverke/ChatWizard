/**
 * src/cache/cacheManager.ts
 *
 * Feature 24 — SQLite Persistent Cache
 *
 * Owns the SQLite connection and all read/write operations for the persistent
 * session cache. Uses better-sqlite3 for synchronous access.
 *
 * Architecture:
 *   Source files → Parser → CacheManager.upsertSessions() → DB (sessions, messages, code_blocks, FTS)
 *                                                         → SessionIndex.upsert() (in-memory)
 *
 * Design principles:
 * - Single Responsibility: Only manages SQLite persistence, not parsing or indexing
 * - Dependency Inversion: Exposes ICacheManager interface consumed by SessionIndex
 * - Open/Closed: New tables added via schema version bump, not schema modification
 * - No ORM: Raw better-sqlite3 prepared statements for performance
 * - WAL mode: Enabled for crash recovery + concurrent reads during watcher writes
 */

import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { Session, Message, SessionSource } from '../types/index';
import type { SessionIndex } from '../index/sessionIndex';
import { CACHE_SCHEMA_VERSION } from './schemaVersion';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface ParseState {
    filePath: string;
    source: string;
    lastMtime: number;    // epoch ms
    lastSize: number;
    lastOffset: number;   // byte offset for append-only files (JSONL)
}

export interface FtsResult {
    sessionId: string;
    title: string;
    source: string;
    updatedAt: string;
    snippet: string;
    rank: number;
}

export interface SessionNote {
    id: number;
    sessionId: string;
    note: string;
    createdAt: string;
}

export interface DbSessionRow {
    id: string;
    source: string;
    workspace_id: string;
    workspace_path: string | null;
    title: string;
    model: string | null;
    file_path: string;
    file_size_bytes: number | null;
    created_at: string;
    updated_at: string;
    parse_errors: string | null;     // JSON array
    source_notes: string | null;     // JSON array
    is_compacted: number;
    compaction_summary: string | null;
    sub_source: string | null;
    archived: number;
    user_archived: number;
}

export interface DbMessageRow {
    id: string;
    session_id: string;
    role: string;
    content: string;
    timestamp: string | null;
    message_index: number;
    skipped: number;
    interrupted: number;
}

export interface DbCodeBlockRow {
    id: number;
    session_id: string;
    message_id: string;
    message_index: number;
    block_index_in_message: number;
    language: string;
    content: string;
}

export interface DbTagRow {
    id: number;
    session_id: string;
    label: string;
    created_at: string;
}

export interface DbSessionNoteRow {
    id: number;
    session_id: string;
    note: string;
    created_at: string;
}

export interface ICacheManager {
    open(): void;
    loadAll(index: SessionIndex, workspaceIds?: string[]): Promise<void>;
    upsertSession(session: Session): void;
    upsertSessions(sessions: Session[]): void;
    removeSession(sessionId: string): void;
    getParseState(filePath: string): ParseState | undefined;
    setParseState(filePath: string, state: ParseState): void;
    searchFts(query: string, limit?: number): FtsResult[];
    addTag(sessionId: string, label: string): void;
    removeTag(sessionId: string, label: string): void;
    getTagsForSession(sessionId: string): string[];
    addNote(sessionId: string, note: string): void;
    getNotes(sessionId: string): SessionNote[];
    getSessionCount(): number;
    close(): void;
    readonly isOpen: boolean;
    readonly dbPath: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DB_FILENAME = 'chatwizard-cache.db';

// ── CacheManager Implementation ──────────────────────────────────────────────

export class CacheManager implements ICacheManager {
    private db: BetterSqlite3.Database | null = null;
    private readonly _dbPath: string;
    private _isOpen = false;

    // Prepared statements — created once in _initDb()
    private stmt: {
        upsertSession: BetterSqlite3.Statement;
        upsertMessage: BetterSqlite3.Statement;
        upsertCodeBlock: BetterSqlite3.Statement;
        deleteSession: BetterSqlite3.Statement;
        deleteMessages: BetterSqlite3.Statement;
        deleteCodeBlocks: BetterSqlite3.Statement;
        getSession: BetterSqlite3.Statement;
        getMessages: BetterSqlite3.Statement;
        getCodeBlocks: BetterSqlite3.Statement;
        getParseState: BetterSqlite3.Statement;
        upsertParseState: BetterSqlite3.Statement;
        searchFts: BetterSqlite3.Statement;
        insertTag: BetterSqlite3.Statement;
        deleteTag: BetterSqlite3.Statement;
        getTags: BetterSqlite3.Statement;
        insertNote: BetterSqlite3.Statement;
        getNotes: BetterSqlite3.Statement;
        getSessionCount: BetterSqlite3.Statement;
        getAllSessions: BetterSqlite3.Statement;
        getAllMessages: BetterSqlite3.Statement;
        getAllCodeBlocksBySession: BetterSqlite3.Statement;
    } | null = null;

    constructor(storageDir: string) {
        this._dbPath = path.join(storageDir, DB_FILENAME);
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    get dbPath(): string {
        return this._dbPath;
    }

    // ── Initialization ───────────────────────────────────────────────────────

    /**
     * Opens (or creates) the SQLite database, ensures the schema is at the
     * current version, and prepares all statements. Must be called before
     * any other operation.
     */
    open(): void {
        if (this._isOpen) { return; }

        // Ensure the storage directory exists
        const dir = path.dirname(this._dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new BetterSqlite3(this._dbPath);

        // Enable WAL mode for crash recovery + concurrent reads
        this.db.pragma('journal_mode = WAL');
        // Multi-process safety: retry up to 3 s when another IDE holds the write lock
        this.db.pragma('busy_timeout = 3000');
        this.db.pragma('foreign_keys = ON');

        this._ensureSchema();
        this._prepareStatements();
        this._isOpen = true;
    }

    private _ensureSchema(): void {
        if (!this.db) { throw new Error('CacheManager not open'); }

        // Check current schema version in the DB
        const userVersion = this.db.pragma('user_version', { simple: true }) as number;

        if (userVersion > CACHE_SCHEMA_VERSION) {
            // DB schema is newer than what this extension version understands.
            // This can happen with a shared cache when a different IDE has a newer
            // ChatWizard. Log a clear error so the caller can fall back gracefully.
            throw new Error(
                `Cache DB schema version ${userVersion} is newer than ` +
                `this extension supports (${CACHE_SCHEMA_VERSION}). ` +
                'Please update ChatWizard to read this cache.'
            );
        }

        if (userVersion < CACHE_SCHEMA_VERSION) {
            // Build schema from scratch
            this.db.exec(SCHEMA_SQL);
            this.db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
        }
        // If userVersion === CACHE_SCHEMA_VERSION, schema is already up-to-date
    }

    private _prepareStatements(): void {
        if (!this.db) { throw new Error('CacheManager not open'); }

        this.stmt = {
            upsertSession: this.db.prepare(`
                INSERT INTO sessions (id, source, workspace_id, workspace_path, title, model,
                    file_path, file_size_bytes, created_at, updated_at, parse_errors, source_notes,
                    is_compacted, compaction_summary, sub_source, archived, user_archived)
                VALUES (@id, @source, @workspaceId, @workspacePath, @title, @model,
                    @filePath, @fileSizeBytes, @createdAt, @updatedAt, @parseErrors, @sourceNotes,
                    @isCompacted, @compactionSummary, @subSource, @archived, @userArchived)
                ON CONFLICT(id) DO UPDATE SET
                    source = excluded.source,
                    workspace_id = excluded.workspace_id,
                    workspace_path = excluded.workspace_path,
                    title = excluded.title,
                    model = excluded.model,
                    file_path = excluded.file_path,
                    file_size_bytes = excluded.file_size_bytes,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    parse_errors = excluded.parse_errors,
                    source_notes = excluded.source_notes,
                    is_compacted = excluded.is_compacted,
                    compaction_summary = excluded.compaction_summary,
                    sub_source = excluded.sub_source,
                    archived = excluded.archived,
                    user_archived = excluded.user_archived
            `),

            upsertMessage: this.db.prepare(`
                INSERT INTO messages (id, session_id, role, content, timestamp, message_index, skipped, interrupted)
                VALUES (@id, @sessionId, @role, @content, @timestamp, @messageIndex, @skipped, @interrupted)
                ON CONFLICT(id) DO UPDATE SET
                    role = excluded.role,
                    content = excluded.content,
                    timestamp = excluded.timestamp,
                    message_index = excluded.message_index,
                    skipped = excluded.skipped,
                    interrupted = excluded.interrupted
            `),

            upsertCodeBlock: this.db.prepare(`
                INSERT INTO code_blocks (session_id, message_id, message_index, block_index_in_message, language, content)
                VALUES (@sessionId, @messageId, @messageIndex, @blockIndexInMessage, @language, @content)
            `),

            deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
            deleteMessages: this.db.prepare('DELETE FROM messages WHERE session_id = ?'),
            deleteCodeBlocks: this.db.prepare('DELETE FROM code_blocks WHERE session_id = ?'),

            getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
            getMessages: this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY message_index ASC'),
            getCodeBlocks: this.db.prepare('SELECT * FROM code_blocks WHERE session_id = ? ORDER BY message_index, block_index_in_message ASC'),

            getParseState: this.db.prepare('SELECT * FROM parse_state WHERE file_path = ?'),
            upsertParseState: this.db.prepare(`
                INSERT INTO parse_state (file_path, source, last_mtime, last_size, last_offset)
                VALUES (@filePath, @source, @lastMtime, @lastSize, @lastOffset)
                ON CONFLICT(file_path) DO UPDATE SET
                    source = excluded.source,
                    last_mtime = excluded.last_mtime,
                    last_size = excluded.last_size,
                    last_offset = excluded.last_offset
            `),

            searchFts: this.db.prepare(`
                SELECT s.id AS sessionId, s.title, s.source, s.updated_at AS updatedAt,
                       snippet(messages_fts, 0, '<b>', '</b>>', '…', 20) AS snippet,
                       rank
                FROM messages_fts
                JOIN sessions s ON s.id = messages_fts.session_id
                WHERE messages_fts MATCH @query
                ORDER BY rank
                LIMIT @limit
            `),

            insertTag: this.db.prepare('INSERT OR IGNORE INTO tags (session_id, label) VALUES (@sessionId, @label)'),
            deleteTag: this.db.prepare('DELETE FROM tags WHERE session_id = ? AND label = ?'),
            getTags: this.db.prepare('SELECT label FROM tags WHERE session_id = ? ORDER BY label'),

            insertNote: this.db.prepare('INSERT INTO session_notes (session_id, note) VALUES (@sessionId, @note)'),
            getNotes: this.db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY created_at DESC'),

            getSessionCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM sessions'),

            getAllSessions: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
            getAllMessages: this.db.prepare('SELECT * FROM messages ORDER BY session_id, message_index ASC'),
            getAllCodeBlocksBySession: this.db.prepare('SELECT * FROM code_blocks WHERE session_id = ? ORDER BY message_index, block_index_in_message ASC'),
        };
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Load all sessions from the SQLite DB into the provided SessionIndex.
     * This is the startup path — avoids re-parsing source files.
     */
    async loadAll(index: SessionIndex, workspaceIds?: string[]): Promise<void> {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        // If workspaceIds is explicitly empty, load nothing
        if (workspaceIds && workspaceIds.length === 0) { return; }

        let sessionRows: DbSessionRow[];
        if (workspaceIds && workspaceIds.length > 0) {
            // Filter by workspace IDs using dynamic placeholders
            const placeholders = workspaceIds.map(() => '?').join(',');
            const stmt = this.db.prepare(
                `SELECT * FROM sessions WHERE workspace_id IN (${placeholders}) ORDER BY updated_at DESC`
            );
            sessionRows = stmt.all(...workspaceIds) as DbSessionRow[];
        } else {
            // No filter — load all sessions (backward compat)
            sessionRows = this.stmt.getAllSessions.all() as DbSessionRow[];
        }
        if (sessionRows.length === 0) { return; }

        // Load all messages in a single query and group by session_id
        const allMessages = this.stmt.getAllMessages.all() as DbMessageRow[];
        const messagesBySession = new Map<string, DbMessageRow[]>();
        for (const msg of allMessages) {
            const list = messagesBySession.get(msg.session_id);
            if (list) {
                list.push(msg);
            } else {
                messagesBySession.set(msg.session_id, [msg]);
            }
        }

        // Reconstruct Session objects
        const sessions: Session[] = [];
        for (const row of sessionRows) {
            const msgs = messagesBySession.get(row.id) ?? [];
            const session = this._rowToSession(row, msgs);
            sessions.push(session);
        }

        // Bulk-upsert into the index
        index.batchUpsert(sessions);
    }

    /**
     * Upsert a single session into the DB.
     * Writes session, messages, code_blocks, and FTS entries atomically.
     */
    upsertSession(session: Session): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        const transaction = this.db.transaction((s: Session) => {
            // Delete existing data for this session
            this.stmt!.deleteCodeBlocks.run(s.id);
            this.stmt!.deleteMessages.run(s.id);

            // Upsert session row
            this.stmt!.upsertSession.run(this._sessionToRow(s));

            // Insert messages
            for (let i = 0; i < s.messages.length; i++) {
                const msg = s.messages[i];
                this.stmt!.upsertMessage.run({
                    id: msg.id,
                    sessionId: s.id,
                    role: msg.role,
                    content: msg.content,
                    timestamp: msg.timestamp ?? null,
                    messageIndex: i,
                    skipped: msg.skipped ? 1 : 0,
                    interrupted: msg.interrupted ? 1 : 0,
                });

                // Insert code blocks for this message
                for (const block of msg.codeBlocks) {
                    this.stmt!.upsertCodeBlock.run({
                        sessionId: s.id,
                        messageId: msg.id,
                        messageIndex: i,
                        blockIndexInMessage: block.blockIndexInMessage,
                        language: block.language,
                        content: block.content,
                    });
                }
            }

            // Rebuild FTS for this session (delete + re-insert)
            this.db!.exec(`DELETE FROM messages_fts WHERE session_id = '${s.id.replace(/'/g, "''")}'`);
            for (let i = 0; i < s.messages.length; i++) {
                const msg = s.messages[i];
                this.db!.exec(`
                    INSERT INTO messages_fts (content, session_id, message_id, role)
                    VALUES ('${msg.content.replace(/'/g, "''")}', '${s.id.replace(/'/g, "''")}', '${msg.id.replace(/'/g, "''")}', '${msg.role}')
                `);
            }
        });

        transaction(session);
    }

    /**
     * Upsert multiple sessions atomically.
     */
    upsertSessions(sessions: Session[]): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        const transaction = this.db.transaction((sessionsList: Session[]) => {
            for (const session of sessionsList) {
                this._upsertSessionRaw(session);
            }
        });

        transaction(sessions);
    }

    /**
     * Remove a session and all its related data from the DB.
     */
    removeSession(sessionId: string): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        const transaction = this.db.transaction((id: string) => {
            this.db!.exec(`DELETE FROM messages_fts WHERE session_id = '${id.replace(/'/g, "''")}'`);
            this.stmt!.deleteCodeBlocks.run(id);
            this.stmt!.deleteMessages.run(id);
            this.stmt!.deleteSession.run(id);
        });

        transaction(sessionId);
    }

    /**
     * Get parse state for incremental parsing.
     */
    getParseState(filePath: string): ParseState | undefined {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return undefined; }

        const row = this.stmt.getParseState.get(filePath) as {
            file_path: string;
            source: string;
            last_mtime: number;
            last_size: number;
            last_offset: number;
        } | undefined;

        if (!row) { return undefined; }

        return {
            filePath: row.file_path,
            source: row.source,
            lastMtime: row.last_mtime,
            lastSize: row.last_size,
            lastOffset: row.last_offset,
        };
    }

    /**
     * Update parse state after a file has been parsed.
     */
    setParseState(filePath: string, state: ParseState): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }

        this.stmt.upsertParseState.run({
            filePath: state.filePath,
            source: state.source,
            lastMtime: state.lastMtime,
            lastSize: state.lastSize,
            lastOffset: state.lastOffset,
        });
    }

    /**
     * Full-text search using FTS5 BM25 ranking.
     * Returns ranked results with snippets.
     */
    searchFts(query: string, limit = 50): FtsResult[] {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return []; }

        // Sanitize the query for FTS5 — escape special characters and add prefix matching
        const sanitized = query
            .replace(/['"]/g, '')
            .replace(/[^\w\s-]/g, ' ')
            .trim();

        if (!sanitized) { return []; }

        // Use prefix matching for better UX: each word gets * for prefix match
        const ftsQuery = sanitized.split(/\s+/).map(w => `"${w}"*`).join(' ');

        try {
            return this.stmt.searchFts.all({ query: ftsQuery, limit }) as FtsResult[];
        } catch {
            // If FTS5 query fails (e.g. invalid syntax), fall back to simple LIKE
            try {
                const likeQuery = `%${sanitized}%`;
                const rows = this.db!.prepare(`
                    SELECT DISTINCT s.id AS sessionId, s.title, s.source, s.updated_at AS updatedAt,
                           SUBSTR(m.content, 1, 200) AS snippet,
                           0 AS rank
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE m.content LIKE ?
                    ORDER BY s.updated_at DESC
                    LIMIT ?
                `).all(likeQuery, limit) as FtsResult[];
                return rows;
            } catch {
                return [];
            }
        }
    }

    /**
     * Add a tag to a session.
     */
    addTag(sessionId: string, label: string): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }

        this.stmt.insertTag.run({ sessionId, label: label.toLowerCase().trim() });
    }

    /**
     * Remove a tag from a session.
     */
    removeTag(sessionId: string, label: string): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }

        this.stmt.deleteTag.run(sessionId, label.toLowerCase().trim());
    }

    /**
     * Get all tags for a session.
     */
    getTagsForSession(sessionId: string): string[] {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return []; }

        const rows = this.stmt.getTags.all(sessionId) as { label: string }[];
        return rows.map(r => r.label);
    }

    /**
     * Add a note to a session.
     */
    addNote(sessionId: string, note: string): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }

        this.stmt.insertNote.run({ sessionId, note });
    }

    /**
     * Get all notes for a session.
     */
    getNotes(sessionId: string): SessionNote[] {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return []; }

        return this.stmt.getNotes.all(sessionId) as SessionNote[];
    }

    /**
     * Get total session count.
     */
    getSessionCount(): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }

        const row = this.stmt.getSessionCount.get() as { cnt: number };
        return row?.cnt ?? 0;
    }

    /**
     * Close the database connection.
     */
    close(): void {
        if (this.db) {
            try {
                // Flush WAL to main file for portability
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            } catch { /* ignore */ }
            this.db.close();
            this.db = null;
            this.stmt = null;
            this._isOpen = false;
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    private _upsertSessionRaw(session: Session): void {
        if (!this.stmt) { return; }

        // Delete existing data
        this.stmt.deleteCodeBlocks.run(session.id);
        this.stmt.deleteMessages.run(session.id);

        // Upsert session
        this.stmt.upsertSession.run(this._sessionToRow(session));

        // Insert messages + codeblocks
        for (let i = 0; i < session.messages.length; i++) {
            const msg = session.messages[i];
            this.stmt.upsertMessage.run({
                id: msg.id,
                sessionId: session.id,
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp ?? null,
                messageIndex: i,
                skipped: msg.skipped ? 1 : 0,
                interrupted: msg.interrupted ? 1 : 0,
            });

            for (const block of msg.codeBlocks) {
                this.stmt.upsertCodeBlock.run({
                    sessionId: session.id,
                    messageId: msg.id,
                    messageIndex: i,
                    blockIndexInMessage: block.blockIndexInMessage,
                    language: block.language,
                    content: block.content,
                });
            }
        }

        // Rebuild FTS entries
        this.db!.exec(`DELETE FROM messages_fts WHERE session_id = '${session.id.replace(/'/g, "''")}'`);
        for (const msg of session.messages) {
            this.db!.exec(`
                INSERT INTO messages_fts (content, session_id, message_id, role)
                VALUES ('${msg.content.replace(/'/g, "''")}', '${session.id.replace(/'/g, "''")}', '${msg.id.replace(/'/g, "''")}', '${msg.role}')
            `);
        }
    }

    private _sessionToRow(session: Session): Record<string, unknown> {
        return {
            id: session.id,
            source: session.source,
            workspaceId: session.workspaceId,
            workspacePath: session.workspacePath ?? null,
            title: session.title,
            model: session.model ?? null,
            filePath: session.filePath,
            fileSizeBytes: session.fileSizeBytes ?? null,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            parseErrors: session.parseErrors ? JSON.stringify(session.parseErrors) : null,
            sourceNotes: session.sourceNotes ? JSON.stringify(session.sourceNotes) : null,
            isCompacted: session.isCompacted ? 1 : 0,
            compactionSummary: session.compactionSummary ?? null,
            subSource: session.subSource ?? null,
            archived: session.archived ? 1 : 0,
            userArchived: session.userArchived ? 1 : 0,
        };
    }

    private _rowToSession(row: DbSessionRow, msgRows: DbMessageRow[]): Session {
        const messages: Message[] = msgRows.map((m, idx) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp ?? undefined,
            codeBlocks: [], // Code blocks are loaded separately
            skipped: m.skipped === 1,
            interrupted: m.interrupted === 1,
        }));

        // Load code blocks for this session
        const cbRows = this.stmt!.getAllCodeBlocksBySession.all(row.id) as DbCodeBlockRow[];
        for (const cb of cbRows) {
            const msg = messages[cb.message_index];
            if (msg) {
                // Ensure codeBlocks array is sized appropriately
                if (!msg.codeBlocks) {
                    msg.codeBlocks = [];
                }
                // Only add if not already present (dedup by blockIndexInMessage)
                const exists = msg.codeBlocks.some(b => b.blockIndexInMessage === cb.block_index_in_message);
                if (!exists) {
                    msg.codeBlocks.push({
                        language: cb.language,
                        content: cb.content,
                        sessionId: row.id,
                        messageIndex: cb.message_index,
                        blockIndexInMessage: cb.block_index_in_message,
                    });
                }
            }
        }

        return {
            id: row.id,
            title: row.title,
            source: row.source as SessionSource,
            workspaceId: row.workspace_id,
            workspacePath: row.workspace_path ?? undefined,
            model: row.model ?? undefined,
            filePath: row.file_path,
            fileSizeBytes: row.file_size_bytes ?? undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messages,
            parseErrors: row.parse_errors ? JSON.parse(row.parse_errors) as string[] : undefined,
            sourceNotes: row.source_notes ? JSON.parse(row.source_notes) as string[] : undefined,
            isCompacted: row.is_compacted === 1 || undefined,
            compactionSummary: row.compaction_summary ?? undefined,
            subSource: row.sub_source ?? undefined,
            archived: row.archived === 1 || undefined,
            userArchived: row.user_archived === 1 || undefined,
        };
    }
}

// ── Schema SQL ───────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core tables
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    workspace_id  TEXT NOT NULL,
    workspace_path TEXT,
    title         TEXT NOT NULL,
    model         TEXT,
    file_path     TEXT NOT NULL,
    file_size_bytes INTEGER,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    parse_errors  TEXT,
    source_notes  TEXT,
    is_compacted  INTEGER NOT NULL DEFAULT 0,
    compaction_summary TEXT,
    sub_source    TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    user_archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content       TEXT NOT NULL,
    timestamp     TEXT,
    message_index INTEGER NOT NULL,
    skipped       INTEGER NOT NULL DEFAULT 0,
    interrupted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS code_blocks (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    message_index        INTEGER NOT NULL,
    block_index_in_message INTEGER NOT NULL DEFAULT 0,
    language             TEXT NOT NULL DEFAULT '',
    content              TEXT NOT NULL
);

-- User-owned metadata (survives source file changes)
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, label)
);

CREATE TABLE IF NOT EXISTS session_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File-level parse state (incremental parsing)
CREATE TABLE IF NOT EXISTS parse_state (
    file_path    TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    last_mtime   INTEGER NOT NULL,
    last_size    INTEGER NOT NULL,
    last_offset  INTEGER NOT NULL DEFAULT 0
);

-- FTS5 virtual table — full-text search over message content
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    session_id UNINDEXED,
    message_id UNINDEXED,
    role       UNINDEXED,
    tokenize='porter unicode61'
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_sessions_source       ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace    ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at   ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id   ON messages(session_id, message_index);
CREATE INDEX IF NOT EXISTS idx_code_blocks_session   ON code_blocks(session_id);
CREATE INDEX IF NOT EXISTS idx_tags_session          ON tags(session_id);
`;