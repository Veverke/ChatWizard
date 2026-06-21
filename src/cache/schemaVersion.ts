/**
 * src/cache/schemaVersion.ts
 *
 * Single integer schema version for the ChatWizard SQLite cache database.
 * On activation, if the DB schema version is lower than this constant,
 * the database is dropped and rebuilt (full re-parse triggered).
 *
 * Increment this constant whenever the schema in cacheManager.ts changes
 * in a way that is not backward-compatible.
 */

/** Current schema version. */
export const CACHE_SCHEMA_VERSION = 1;