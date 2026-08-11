/**
 * src/utils/sqliteDb.ts
 *
 * Universal SQLite reader that tries `better-sqlite3` first (fast native path)
 * and falls back to `sql.js` (WASM) when the native module fails with a
 * NODE_MODULE_VERSION mismatch.
 *
 * WHY: VS Code and Cursor use different Electron versions, each with a
 * different NODE_MODULE_VERSION ABI.  `better-sqlite3` compiled for one
 * Electron cannot load in another.  `sql.js` is pure WebAssembly and works
 * everywhere, but is ~5× slower for bulk reads.
 *
 * Usage:
 *   import { openReadonlyDb, SqliteDb } from './sqliteDb';
 *   const db = await openReadonlyDb('/path/to/db.sqlite');
 *   if (!db) { /* fallback or skip *\/ }
 *   const rows = db.query('SELECT * FROM t WHERE k = ?', ['v']);
 *   db.close();
 */

import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SqliteDb {
    /** Execute a read-only query and return all rows as an array of objects. */
    query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
    ): T[];
    /** Execute a query and return the first row, or undefined. */
    get<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
    ): T | undefined;
    /** Close the database. */
    close(): void;
}

// ─── Lazy sql.js initialiser (singleton) ─────────────────────────────────────

let _sqlJsReady: Promise<SqlJsStatic> | null = null;

type SqlJsStatic = {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
};

type SqlJsDatabase = {
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): SqlJsStatement | false;
    close(): void;
};

type SqlJsStatement = {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
};

async function getSqlJs(): Promise<SqlJsStatic> {
    if (!_sqlJsReady) {
        _sqlJsReady = (async () => {
            // sql.js is externalized in esbuild — loaded from node_modules at runtime.
            // The WASM file is resolved via locateFile relative to the extension root.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const initSqlJs = require('sql.js') as (config?: {
                locateFile?: (file: string) => string;
            }) => Promise<SqlJsStatic>;
            return initSqlJs({
                locateFile: (file: string) => {
                    // When running from VSIX: node_modules/sql.js/dist/<file>
                    // When running from dev:   node_modules/sql.js/dist/<file>
                    // __dirname is the extension's dist/ folder
                    const sqlJsDir = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
                    return path.join(sqlJsDir, file);
                },
            });
        })();
    }
    return _sqlJsReady;
}

// ─── Native better-sqlite3 wrapper ───────────────────────────────────────────

interface NativeDb {
    prepare(sql: string): {
        all(params?: unknown[]): unknown[];
        get(params?: unknown[]): unknown;
    };
    close(): void;
    pragma(sql: string): unknown;
}

function tryNative(dbPath: string): NativeDb | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as unknown as (
            new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => NativeDb
        );
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try { db.pragma('journal_mode = WAL'); } catch { /* ignore */ }
        // Validate the database is readable by running a quick query.
        // Without this, better-sqlite3 only throws on the first prepare() for
        // non-SQLite files, which bypasses the fallback to sql.js.
        try { db.prepare('SELECT 1').get(); } catch { db.close(); return null; }
        return db;
    } catch {
        return null;
    }
}

// ─── sql.js wrapper ──────────────────────────────────────────────────────────

async function trySqlJs(dbPath: string): Promise<SqlJsDatabase | null> {
    try {
        const fs = require('fs') as typeof import('fs');
        if (!fs.existsSync(dbPath)) { return null; }
        const buffer = fs.readFileSync(dbPath);
        const SQL = await getSqlJs();
        return new SQL.Database(buffer);
    } catch {
        return null;
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a SQLite database in read-only mode.
 *
 * Tries `better-sqlite3` first (synchronous, fast).  If the native module
 * fails (e.g. NODE_MODULE_VERSION mismatch when running inside Cursor),
 * falls back to `sql.js` (WASM, async, slower).
 *
 * Returns `null` when the file doesn't exist or cannot be opened.
 */
export async function openReadonlyDb(dbPath: string): Promise<SqliteDb | null> {
    // 1. Try native (sync, fast)
    const native = tryNative(dbPath);
    if (native) {
        return {
            query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
                return params ? native.prepare(sql).all(params) as T[] : native.prepare(sql).all() as T[];
            },
            get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
                return params ? native.prepare(sql).get(params) as T | undefined : native.prepare(sql).get() as T | undefined;
            },
            close(): void {
                native.close();
            },
        };
    }

    // 2. Fall back to sql.js (async, WASM)
    const sqlJs = await trySqlJs(dbPath);
    if (!sqlJs) { return null; }

    const sqlJsWrapper: SqliteDb = {
        query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
            const stmt = sqlJs.prepare(sql);
            if (!stmt) { return []; }
            if (params) {
                stmt.bind(params);
            }
            const rows: T[] = [];
            while (stmt.step()) {
                rows.push(stmt.getAsObject() as T);
            }
            stmt.free();
            return rows;
        },
        get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
            const rows = sqlJsWrapper.query<T>(sql, params);
            return rows.length > 0 ? rows[0] : undefined;
        },
        close(): void {
            sqlJs.close();
        },
    };
    return sqlJsWrapper;
}

/**
 * Synchronous version for use in contexts where async is not available.
 * Only works with `better-sqlite3` — returns null if native module fails.
 */
export function openReadonlyDbSync(dbPath: string): SqliteDb | null {
    const native = tryNative(dbPath);
    if (!native) { return null; }

    return {
        query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
            return native.prepare(sql).all(params) as T[];
        },
        get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
            return native.prepare(sql).get(params) as T | undefined;
        },
        close(): void {
            native.close();
        },
    };
}