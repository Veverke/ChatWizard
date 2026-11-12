/**
 * test/unit/sqliteDb.test.ts
 *
 * Regression tests for the sql.js fallback's WASM path resolution.
 *
 * `getSqlJs()` used to resolve `sql-wasm.wasm` with a single `..` hop from
 * __dirname, which only holds for the bundled `dist/` layout. Under the
 * compiled test build that pointed at
 * `<repo>/out/src/node_modules/sql.js/dist/sql-wasm.wasm` and produced
 * "failed to asynchronously prepare wasm: ENOENT …", surfacing later as an
 * unhandled promise rejection that failed whichever test was running.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { resolveSqlJsDistDir, openReadonlyDb, openReadonlyDbSync } from '../../src/utils/sqliteDb';

interface SqlJsDatabase {
    run(sql: string): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
}

interface SqlJsStaticLike {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStaticLike>;

function loadSqlJsInit(): InitSqlJs {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sql.js') as InitSqlJs;
}

suite('sqliteDb — sql.js WASM resolution', () => {
    test('finds the sql.js dist directory from the compiled layout', () => {
        const dist = resolveSqlJsDistDir();
        assert.ok(dist, 'expected to resolve node_modules/sql.js/dist');
        assert.ok(
            fs.existsSync(path.join(dist, 'sql-wasm.wasm')),
            `sql-wasm.wasm missing from resolved dir: ${dist}`
        );
    });

    test('walks up from a nested directory to the same dist dir', () => {
        const nested = path.join(__dirname, 'deeper', 'nested');
        assert.strictEqual(resolveSqlJsDistDir(nested), resolveSqlJsDistDir());
    });

    test('returns undefined when no sql.js install is reachable', () => {
        assert.strictEqual(resolveSqlJsDistDir(os.tmpdir()), undefined);
        assert.strictEqual(resolveSqlJsDistDir(path.parse(os.tmpdir()).root), undefined);
    });

    test('a resolved locateFile can actually load the wasm and read a database', async () => {
        const dist = resolveSqlJsDistDir();
        assert.ok(dist);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sqljs-probe-'));
        try {
            // Build a real SQLite file with the native driver …
            const file = path.join(tmp, 'probe.db');
            const native = new BetterSqlite3(file);
            native.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
            native.prepare('INSERT INTO t (label) VALUES (?)').run('hello wasm');
            native.close();

            // … then read it back through sql.js, which must load the wasm payload.
            const SQL = await loadSqlJsInit()({ locateFile: (f) => path.join(dist, f) });
            const db = new SQL.Database(fs.readFileSync(file));
            try {
                const [result] = db.exec('SELECT label FROM t');
                assert.deepStrictEqual(result.values, [['hello wasm']]);
            } finally {
                db.close();
            }
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

suite('sqliteDb — read-only open helpers', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sqlitedb-test-'));
    });

    teardown(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    function makeDb(name: string, rows: string[]): string {
        const file = path.join(dir, name);
        const db = new BetterSqlite3(file);
        try {
            db.exec('CREATE TABLE labels (id INTEGER PRIMARY KEY, label TEXT)');
            const insert = db.prepare('INSERT INTO labels (label) VALUES (?)');
            for (const row of rows) { insert.run(row); }
        } finally {
            db.close();
        }
        return file;
    }

    test('openReadonlyDb reads a valid database', async () => {
        const file = makeDb('valid.db', ['alpha', 'beta']);
        const db = await openReadonlyDb(file);
        assert.ok(db, 'expected a handle for a valid database');
        try {
            assert.deepStrictEqual(db.query<{ label: string }>('SELECT label FROM labels ORDER BY id'), [
                { label: 'alpha' },
                { label: 'beta' },
            ]);
            assert.deepStrictEqual(db.get<{ label: string }>("SELECT label FROM labels WHERE label = 'beta'"), { label: 'beta' });
            assert.strictEqual(db.get('SELECT label FROM labels WHERE label = ?', ['nope']), undefined);
        } finally {
            db.close();
        }
    });

    test('openReadonlyDb rejects a file that is not a SQLite database', async () => {
        const file = path.join(dir, 'not-a-db.bin');
        fs.writeFileSync(file, 'this is definitely not sqlite', 'utf8');

        assert.strictEqual(await openReadonlyDb(file), null, 'must not hand a broken handle back to parsers');
    });

    test('openReadonlyDb returns null for a missing file', async () => {
        assert.strictEqual(await openReadonlyDb(path.join(dir, 'missing.db')), null);
    });

    test('openReadonlyDbSync reads a valid database and rejects the rest', () => {
        const file = makeDb('sync.db', ['gamma']);
        const db = openReadonlyDbSync(file);
        assert.ok(db, 'expected a handle for a valid database');
        try {
            assert.deepStrictEqual(db.query<{ label: string }>('SELECT label FROM labels'), [{ label: 'gamma' }]);
        } finally {
            db.close();
        }

        const broken = path.join(dir, 'broken.bin');
        fs.writeFileSync(broken, 'nope', 'utf8');
        assert.strictEqual(openReadonlyDbSync(broken), null);
        assert.strictEqual(openReadonlyDbSync(path.join(dir, 'absent.db')), null);
    });
});
