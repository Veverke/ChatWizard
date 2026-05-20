// src/parsers/chronicle.ts
// Reads Copilot Chronicle checkpoints from a session-store.db SQLite file.

/** Maximum characters retained from each Chronicle text field to prevent index bloat. */
const MAX_FIELD_CHARS = 8 * 1024; // 8 KB

export interface ChronicleCheckpoint {
    sessionId: string;
    overview: string | null;
    workDone: string | null;
    technicalDetails: string | null;
    nextSteps: string | null;
    createdAt: string | null; // ISO-8601
    /** File paths from checkpoints.important_files (Feature 10). May be undefined if the column is absent. */
    importantFiles?: string[];
}

export interface ChronicleSessionMeta {
    sessionId: string;
    branch: string | null;
    repository: string | null;
}

interface RawCheckpointRow {
    session_id: string;
    overview: string | null;
    work_done: string | null;
    technical_details: string | null;
    next_steps: string | null;
    created_at: string | null;
    important_files: string | null;
}

interface RawSessionRow {
    id: string;
    branch: string | null;
    repository: string | null;
}

function cap(value: string | null): string | null {
    if (value === null || value === undefined) { return null; }
    return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

/**
 * Parses the `important_files` column value from the Chronicle DB.
 * Chronicle stores this as a JSON array string (e.g. `["path/a.ts","path/b.ts"]`).
 * Falls back to newline/comma splitting for older or non-standard encodings.
 * Returns `undefined` when the value is null or empty.
 */
function parseImportantFiles(raw: string | null): string[] | undefined {
    if (!raw || raw.trim() === '') { return undefined; }
    // Try JSON array first (standard Chronicle format)
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const files = parsed.filter((f): f is string => typeof f === 'string' && f.length > 0);
            return files.length > 0 ? files : undefined;
        }
    } catch { /* fall through */ }
    // Fallback: newline or comma-separated
    const sep = raw.includes('\n') ? '\n' : ',';
    const files = raw.split(sep).map(s => s.trim()).filter(s => s.length > 0);
    return files.length > 0 ? files : undefined;
}

/**
 * Opens a Chronicle session-store.db (read-only) and returns all checkpoint rows.
 *
 * Returns `[]` when:
 *  - The file does not exist or cannot be opened (e.g. locked).
 *  - The `checkpoints` table is absent (older Chronicle versions).
 *  - Any other unexpected error.
 *
 * Never throws.
 */
export function readChronicleCheckpoints(dbPath: string): ChronicleCheckpoint[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        let db: import('better-sqlite3').Database | null = null;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
            // Enable WAL mode read (reduces lock contention with the running Copilot process)
            try { db.pragma('journal_mode = WAL'); } catch { /* ignore — already set */ }

            // Guard: check the table exists before querying (older Chronicle versions may not have it)
            const tableCheck = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'"
            ).get() as { name: string } | undefined;
            if (!tableCheck) { return []; }

            // Check for important_files column (added in newer Chronicle versions)
            const cpColumns = db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{ name: string }>;
            const hasImportantFiles = cpColumns.some(c => c.name === 'important_files');

            const query = hasImportantFiles
                ? 'SELECT session_id, overview, work_done, technical_details, next_steps, created_at, important_files FROM checkpoints'
                : 'SELECT session_id, overview, work_done, technical_details, next_steps, created_at, NULL as important_files FROM checkpoints';

            const rows = db.prepare(query).all() as RawCheckpointRow[];

            return rows.map(row => ({
                sessionId:        row.session_id,
                overview:         cap(row.overview),
                workDone:         cap(row.work_done),
                technicalDetails: cap(row.technical_details),
                nextSteps:        cap(row.next_steps),
                createdAt:        row.created_at,
                importantFiles:   parseImportantFiles(row.important_files),
            }));
        } finally {
            db?.close();
        }
    } catch {
        // SQLITE_BUSY, missing file, native module error, etc.
        return [];
    }
}

/**
 * Opens a Chronicle session-store.db (read-only) and returns session metadata
 * including the git branch and repository from the `sessions` table.
 *
 * Returns `[]` when:
 *  - The file does not exist or cannot be opened.
 *  - The `sessions` table is absent (localIndex not yet enabled).
 *  - The `branch` column is absent (schema version mismatch).
 *  - Any other unexpected error.
 *
 * Never throws.
 */
export function readChronicleSessions(dbPath: string): ChronicleSessionMeta[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        let db: import('better-sqlite3').Database | null = null;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try { db.pragma('journal_mode = WAL'); } catch { /* ignore */ }

            // Guard: check the sessions table exists
            const tableCheck = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
            ).get() as { name: string } | undefined;
            if (!tableCheck) { return []; }

            // Guard: check the branch column exists (schema may vary)
            const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
            const hasBranch = columns.some(c => c.name === 'branch');
            if (!hasBranch) { return []; }

            const hasRepository = columns.some(c => c.name === 'repository');

            const query = hasRepository
                ? 'SELECT id, branch, repository FROM sessions'
                : 'SELECT id, branch, NULL as repository FROM sessions';

            const rows = db.prepare(query).all() as RawSessionRow[];

            return rows
                .filter(row => row.id)
                .map(row => ({
                    sessionId:  row.id,
                    branch:     row.branch || null,
                    repository: row.repository || null,
                }));
        } finally {
            db?.close();
        }
    } catch {
        return [];
    }
}
