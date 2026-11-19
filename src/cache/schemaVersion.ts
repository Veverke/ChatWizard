/**
 * src/cache/schemaVersion.ts
 *
 * Single integer schema version for the ChatWizard SQLite cache database.
 * On activation, if the DB schema version is lower than this constant,
 * the database is dropped and rebuilt (full re-parse triggered).
 *
 * Increment this constant whenever the schema in cacheManager.ts changes
 * in a way that is not backward-compatible.
 *
 * History:
 *   1 — initial schema (sessions, messages, code_blocks, tags, session_notes,
 *       parse_state, messages_fts).
 *   2 — Feature 51: `removed_turns` table. The upgrade is purely additive —
 *       `_ensureSchema()` re-runs the `CREATE TABLE IF NOT EXISTS` script, so no
 *       cached session data is lost.
 */

/** Current schema version. */
export const CACHE_SCHEMA_VERSION = 2;