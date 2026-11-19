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
import { Session, Message, SessionSource, RemovedTurn } from '../types/index';
import type { SessionIndex } from '../index/sessionIndex';
import { CACHE_SCHEMA_VERSION } from './schemaVersion';
import { GLOBAL_WORKSPACE_IDS, PATH_SCOPED_SOURCES, filterSessionsByWorkspaceScope } from '../watcher/sessionScopeFilter';

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

/** Row shape of the `removed_turns` table (Feature 51). */
export interface DbRemovedTurnRow {
    session_id: string;
    message_id: string;
    message_index: number;
    role: string;
    content: string;
    timestamp: string | null;
    removed_at: string;
}

export interface ICacheManager {
    open(): void;
    loadAll(index: SessionIndex, workspaceIds?: string[], openFolderPaths?: string[]): Promise<void>;
    upsertSession(session: Session): void;
    upsertSessions(sessions: Session[]): void;
    removeSession(sessionId: string): void;
    /**
     * Persistently remove a single turn from a conversation (Feature 51).
     * The message payload is archived in `removed_turns` so the original
     * conversation can always be reopened. Returns the archived record.
     */
    removeTurn(sessionId: string, messageIndex: number, message: Message): RemovedTurn;
    /** All turns the user removed from a session, ordered by message index. */
    getRemovedTurns(sessionId: string): RemovedTurn[];
    /** Number of turns the user removed from a session. */
    getRemovedTurnCount(sessionId: string): number;
    /** Reconstructs a session with every removed turn put back (original view). */
    getOriginalSession(sessionId: string): Session | undefined;
    getParseState(filePath: string): ParseState | undefined;
    /** Cached chat title for a session id (works without the session being indexed). */
    getSessionTitle(sessionId: string): string | undefined;
    setParseState(filePath: string, state: ParseState): void;
    searchFts(query: string, limit?: number): FtsResult[];
    addTag(sessionId: string, label: string): void;
    removeTag(sessionId: string, label: string): void;
    clearTags(sessionId: string): void;
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
        deleteTagsForSession: BetterSqlite3.Statement;
        getTags: BetterSqlite3.Statement;
        insertNote: BetterSqlite3.Statement;
        getNotes: BetterSqlite3.Statement;
        getSessionCount: BetterSqlite3.Statement;
        getAllSessions: BetterSqlite3.Statement;
        getAllMessages: BetterSqlite3.Statement;
        getAllCodeBlocksBySession: BetterSqlite3.Statement;
        // Feature 51 — removed turns
        insertRemovedTurn: BetterSqlite3.Statement;
        getRemovedTurns: BetterSqlite3.Statement;
        getRemovedTurnIds: BetterSqlite3.Statement;
        getAllRemovedTurnIds: BetterSqlite3.Statement;
        countRemovedTurns: BetterSqlite3.Statement;
        deleteRemovedTurnsForSession: BetterSqlite3.Statement;
        deleteCodeBlocksForMessage: BetterSqlite3.Statement;
        deleteFtsForMessage: BetterSqlite3.Statement;
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
            deleteTagsForSession: this.db.prepare('DELETE FROM tags WHERE session_id = ?'),
            getTags: this.db.prepare('SELECT label FROM tags WHERE session_id = ? ORDER BY label'),

            insertNote: this.db.prepare('INSERT INTO session_notes (session_id, note) VALUES (@sessionId, @note)'),
            getNotes: this.db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY created_at DESC'),

            getSessionCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM sessions'),

            getAllSessions: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
            getAllMessages: this.db.prepare('SELECT * FROM messages ORDER BY session_id, message_index ASC'),
            getAllCodeBlocksBySession: this.db.prepare('SELECT * FROM code_blocks WHERE session_id = ? ORDER BY message_index, block_index_in_message ASC'),

            // ── Feature 51 — removed turns ────────────────────────────────────
            insertRemovedTurn: this.db.prepare(`
                INSERT INTO removed_turns (session_id, message_id, message_index, role, content, timestamp, removed_at)
                VALUES (@sessionId, @messageId, @messageIndex, @role, @content, @timestamp, @removedAt)
                ON CONFLICT(session_id, message_id) DO UPDATE SET
                    message_index = excluded.message_index,
                    role = excluded.role,
                    content = excluded.content,
                    timestamp = excluded.timestamp,
                    removed_at = excluded.removed_at
            `),
            getRemovedTurns: this.db.prepare(
                'SELECT * FROM removed_turns WHERE session_id = ? ORDER BY message_index ASC'
            ),
            getRemovedTurnIds: this.db.prepare('SELECT message_id FROM removed_turns WHERE session_id = ?'),
            getAllRemovedTurnIds: this.db.prepare('SELECT session_id, message_id FROM removed_turns'),
            countRemovedTurns: this.db.prepare('SELECT COUNT(*) AS cnt FROM removed_turns WHERE session_id = ?'),
            deleteRemovedTurnsForSession: this.db.prepare('DELETE FROM removed_turns WHERE session_id = ?'),
            deleteCodeBlocksForMessage: this.db.prepare('DELETE FROM code_blocks WHERE session_id = ? AND message_id = ?'),
            deleteFtsForMessage: this.db.prepare('DELETE FROM messages_fts WHERE session_id = ? AND message_id = ?'),
        };
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Load all sessions from the SQLite DB into the provided SessionIndex.
     * This is the startup path — avoids re-parsing source files.
     */
    async loadAll(index: SessionIndex, workspaceIds?: string[], openFolderPaths?: string[]): Promise<void> {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        // If workspaceIds is explicitly empty, load nothing
        if (workspaceIds && workspaceIds.length === 0) { return; }

        let sessionRows: DbSessionRow[];
        if (workspaceIds && workspaceIds.length > 0) {
            // Always include global workspace IDs (cursor-global, windsurf-global,
            // copilot-agent) so that sessions from AI tools with their own global
            // storage are loaded from cache even when the workspace scope filter
            // excludes them. Without this, those sessions would be silently
            // dropped on startup, and because the index is already populated,
            // buildInitialIndex() would be skipped — meaning they'd never be
            // re-parsed.
            //
            // Being *loaded* is not the same as being *in scope*: the filter
            // below drops what does not belong to this window. Copilot agent-host
            // chats share the global `copilot-agent` id, so they are scoped by
            // their `cwd` (`workspacePath`) — otherwise the chats of every other
            // repository would be restored on each start.
            //
            // Path-scoped sources (Cline / Roo Code / Aider) are NOT filtered by
            // workspace id at all: they are collected regardless of `selectedIds`
            // and scoped by `workspacePath` afterwards (see the filter below).
            // Leaving them out of the cache query used to make every Cline 4.x
            // chat (and every cached Cline/Roo/Aider session) disappear on the
            // second start, because its id is not a VS Code workspace hash.
            const allIds = [...workspaceIds];
            for (const globalId of GLOBAL_WORKSPACE_IDS) {
                if (!allIds.includes(globalId)) { allIds.push(globalId); }
            }
            const placeholders = allIds.map(() => '?').join(',');
            const pathScoped = [...PATH_SCOPED_SOURCES].map(() => '?').join(',');
            // `file_path LIKE '%events.jsonl'` also picks up Copilot agent chats
            // that an older build cached under their cwd as the workspace id —
            // without it those chats stay invisible until a full re-parse.
            const stmt = this.db.prepare(
                `SELECT * FROM sessions
                 WHERE workspace_id IN (${placeholders})
                    OR source IN (${pathScoped})
                    OR (source = 'copilot' AND file_path LIKE '%events.jsonl')
                 ORDER BY updated_at DESC`
            );
            sessionRows = stmt.all(...allIds, ...PATH_SCOPED_SOURCES) as DbSessionRow[];
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

        // Feature 51 — turns the user removed. Loaded in one query so the
        // in-memory session carries the flags (and therefore renders without them).
        const removedBySession = new Map<string, Set<string>>();
        for (const row of this.stmt.getAllRemovedTurnIds.all() as { session_id: string; message_id: string }[]) {
            const set = removedBySession.get(row.session_id);
            if (set) {
                set.add(row.message_id);
            } else {
                removedBySession.set(row.session_id, new Set([row.message_id]));
            }
        }

        // Reconstruct Session objects
        const sessions: Session[] = [];
        for (const row of sessionRows) {
            const msgs = messagesBySession.get(row.id) ?? [];
            const session = this._rowToSession(row, msgs, removedBySession.get(row.id));
            sessions.push(session);
        }

        // Apply the same workspace-scope rule a fresh parse uses, so restoring
        // from cache and re-parsing agree on what belongs to this workspace
        // (Cline / Roo Code / Aider are scoped by path, not by workspace id).
        const scoped = openFolderPaths && openFolderPaths.length > 0
            ? filterSessionsByWorkspaceScope(sessions, workspaceIds ?? [], openFolderPaths)
            : sessions;
        if (scoped.length === 0) { return; }

        // Bulk-upsert into the index
        index.batchUpsert(scoped);
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
            this._upsertSessionRaw(s);
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
            this.stmt!.deleteRemovedTurnsForSession.run(id);
            this.stmt!.deleteCodeBlocks.run(id);
            this.stmt!.deleteMessages.run(id);
            this.stmt!.deleteSession.run(id);
        });

        transaction(sessionId);
    }

    // ── Feature 51 — removed turns ───────────────────────────────────────────

    /**
     * Persistently remove a single turn from a conversation.
     *
     * The turn's full payload is archived in `removed_turns` (so the original
     * conversation can always be rebuilt) and it is dropped from the FTS index
     * and from the code-block listing. The `messages` row itself is kept — the
     * conversation keeps its message indices, which is what bookmarks,
     * annotations and action items point at.
     */
    removeTurn(sessionId: string, messageIndex: number, message: Message): RemovedTurn {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) {
            throw new Error('CacheManager failed to open database');
        }

        const removedAt = new Date().toISOString();
        const transaction = this.db.transaction(() => {
            this.stmt!.insertRemovedTurn.run({
                sessionId,
                messageId: message.id,
                messageIndex,
                role: message.role,
                content: message.content,
                timestamp: message.timestamp ?? null,
                removedAt,
            });
            this.stmt!.deleteFtsForMessage.run(sessionId, message.id);
            this.stmt!.deleteCodeBlocksForMessage.run(sessionId, message.id);
        });
        transaction();

        return {
            messageId: message.id,
            messageIndex,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            removedAt,
        };
    }

    /** All turns the user removed from a session, ordered by message index. */
    getRemovedTurns(sessionId: string): RemovedTurn[] {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return []; }

        const rows = this.stmt.getRemovedTurns.all(sessionId) as DbRemovedTurnRow[];
        return rows.map(row => ({
            messageId: row.message_id,
            messageIndex: row.message_index,
            role: row.role as 'user' | 'assistant',
            content: row.content,
            timestamp: row.timestamp ?? undefined,
            removedAt: row.removed_at,
        }));
    }

    /** Number of turns the user removed from a session. */
    getRemovedTurnCount(sessionId: string): number {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return 0; }

        const row = this.stmt.countRemovedTurns.get(sessionId) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    /**
     * Reconstructs a session exactly as it was before any turn was removed.
     *
     * Used by the reader's "Original full conversation" link: the result is
     * serialized to Markdown and opened in a text editor. Rows still present in
     * `messages` (the normal case) are merged with any archived payload from
     * `removed_turns` that the source file no longer provides, ordered by the
     * original message index.
     */
    getOriginalSession(sessionId: string): Session | undefined {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return undefined; }

        const row = this.stmt.getSession.get(sessionId) as DbSessionRow | undefined;
        if (!row) { return undefined; }

        const msgRows = this.stmt.getMessages.all(sessionId) as DbMessageRow[];
        const session = this._rowToSession(row, msgRows);

        const present = new Set(session.messages.map(m => m.id));
        const archived = this.getRemovedTurns(sessionId).filter(t => !present.has(t.messageId));
        if (archived.length === 0) {
            // Everything is still in `messages` — just clear the removal flags.
            for (const msg of session.messages) { delete msg.removed; }
            return session;
        }

        type Entry = { index: number; msg: Message };
        const entries: Entry[] = msgRows.map((m, i) => ({ index: m.message_index, msg: session.messages[i] }));
        for (const turn of archived) {
            entries.push({
                index: turn.messageIndex,
                msg: {
                    id: turn.messageId,
                    role: turn.role,
                    content: turn.content,
                    codeBlocks: [],
                    timestamp: turn.timestamp,
                },
            });
        }
        entries.sort((a, b) => a.index - b.index);
        session.messages = entries.map(e => e.msg);
        for (const msg of session.messages) { delete msg.removed; }
        return session;
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
     * Cached chat title for a session id.
     *
     * Used by the Commands view to label its session groups with the same title
     * the Sessions view shows, even when the session is outside the current
     * workspace scope (and therefore not loaded into the in-memory index).
     * Returns `undefined` when the session is unknown or has no usable title.
     */
    getSessionTitle(sessionId: string): string | undefined {
        // Read-only helper: never re-open a closed DB just to resolve a label.
        if (!this.db || !this.stmt) { return undefined; }
        try {
            const row = this.stmt.getSession.get(sessionId) as { title?: string } | undefined;
            const title = row?.title;
            return typeof title === 'string' && title.trim().length > 0 ? title : undefined;
        } catch {
            // A degraded cache must never break the Commands view.
            return undefined;
        }
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
     * Remove all tags from a session.
     */
    clearTags(sessionId: string): void {
        if (!this.db || !this.stmt) { this.open(); }
        if (!this.db || !this.stmt) { return; }

        this.stmt.deleteTagsForSession.run(sessionId);
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

        // Feature 51 — turns the user removed from this conversation. The
        // registry survives re-parses, so a removed turn never comes back: its
        // message row is re-written with `removed: true` (payload retained for
        // the original view) but it is kept out of the FTS index and of the
        // code-block listing.
        const removedIds = new Set<string>(
            (this.stmt.getRemovedTurnIds.all(session.id) as { message_id: string }[])
                .map(r => r.message_id)
        );
        for (const msg of session.messages) {
            if (removedIds.has(msg.id)) { msg.removed = true; }
        }

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

            // Code blocks of a removed turn must not resurface in the
            // Code Blocks view — skip them (any stale rows were deleted by
            // removeTurn()).
            if (msg.removed) { continue; }

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

        // Rebuild FTS entries (removed turns excluded)
        this.db!.exec(`DELETE FROM messages_fts WHERE session_id = '${session.id.replace(/'/g, "''")}'`);
        for (const msg of session.messages) {
            if (msg.removed) { continue; }
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

    private _rowToSession(row: DbSessionRow, msgRows: DbMessageRow[], removedIds?: Set<string>): Session {
        const messages: Message[] = msgRows.map((m, idx) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp ?? undefined,
            codeBlocks: [], // Code blocks are loaded separately
            skipped: m.skipped === 1,
            interrupted: m.interrupted === 1,
            removed: removedIds?.has(m.id) || undefined,
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

-- Feature 51 — turns the user removed from a conversation.
-- The full payload is archived so the original conversation can always be
-- reopened; the messages table keeps the row (and therefore all message indices).
CREATE TABLE IF NOT EXISTS removed_turns (
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id    TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content       TEXT NOT NULL,
    timestamp     TEXT,
    removed_at    TEXT NOT NULL,
    PRIMARY KEY (session_id, message_id)
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_sessions_source       ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace    ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at   ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id   ON messages(session_id, message_index);
CREATE INDEX IF NOT EXISTS idx_code_blocks_session   ON code_blocks(session_id);
CREATE INDEX IF NOT EXISTS idx_tags_session          ON tags(session_id);
CREATE INDEX IF NOT EXISTS idx_removed_turns_session ON removed_turns(session_id);
`;