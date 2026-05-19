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
}

interface RawCheckpointRow {
    session_id: string;
    overview: string | null;
    work_done: string | null;
    technical_details: string | null;
    next_steps: string | null;
    created_at: string | null;
}

function cap(value: string | null): string | null {
    if (value === null || value === undefined) { return null; }
    return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
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

            const rows = db.prepare(`
                SELECT session_id, overview, work_done, technical_details, next_steps, created_at
                FROM checkpoints
            `).all() as RawCheckpointRow[];

            return rows.map(row => ({
                sessionId:        row.session_id,
                overview:         cap(row.overview),
                workDone:         cap(row.work_done),
                technicalDetails: cap(row.technical_details),
                nextSteps:        cap(row.next_steps),
                createdAt:        row.created_at,
            }));
        } finally {
            db?.close();
        }
    } catch {
        // SQLITE_BUSY, missing file, native module error, etc.
        return [];
    }
}
