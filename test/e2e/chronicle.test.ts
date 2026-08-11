// test/e2e/chronicle.test.ts
// Tests for parsers/chronicle.ts and readers/chronicleWorkspace.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readChronicleCheckpoints } from '../../src/parsers/chronicle';
import { discoverChronicleDbsAsync } from '../../src/readers/chronicleWorkspace';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chronicle-'));
}

function createTestDb(dir: string, name: string, withTable: boolean, rows?: Array<{
    session_id: string;
    overview: string | null;
    work_done: string | null;
    technical_details: string | null;
    next_steps: string | null;
    created_at: string | null;
}>): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const dbPath = path.join(dir, name);
    const db = new Database(dbPath);
    if (withTable) {
        db.exec(`CREATE TABLE checkpoints (
            session_id TEXT,
            overview TEXT,
            work_done TEXT,
            technical_details TEXT,
            next_steps TEXT,
            created_at TEXT
        )`);
        if (rows) {
            const insert = db.prepare(
                'INSERT INTO checkpoints VALUES (@session_id, @overview, @work_done, @technical_details, @next_steps, @created_at)'
            );
            for (const row of rows) {
                insert.run(row);
            }
        }
    }
    db.close();
    return dbPath;
}

// ---------------------------------------------------------------------------
// readChronicleCheckpoints
// ---------------------------------------------------------------------------

suite('readChronicleCheckpoints', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTmpDir();
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('non-existent file returns empty array', async () => {
        const result = await readChronicleCheckpoints(path.join(tmpDir, 'missing.db'));
        assert.deepStrictEqual(result, []);
    });

    test('non-SQLite file returns empty array', async () => {
        const badPath = path.join(tmpDir, 'bad.db');
        fs.writeFileSync(badPath, 'this is not sqlite');
        const result = await readChronicleCheckpoints(badPath);
        assert.deepStrictEqual(result, []);
    });

    test('valid SQLite file with no checkpoints table returns empty array', async () => {
        const dbPath = createTestDb(tmpDir, 'notble.db', false);
        const result = await readChronicleCheckpoints(dbPath);
        assert.deepStrictEqual(result, []);
    });

    test('valid SQLite with empty checkpoints table returns empty array', async () => {
        const dbPath = createTestDb(tmpDir, 'empty.db', true);
        const result = await readChronicleCheckpoints(dbPath);
        assert.deepStrictEqual(result, []);
    });

    test('valid SQLite with one row maps fields correctly', async () => {
        const dbPath = createTestDb(tmpDir, 'one.db', true, [{
            session_id: 'sess-1',
            overview: 'overview text',
            work_done: 'work done text',
            technical_details: 'tech details',
            next_steps: 'next steps',
            created_at: '2024-01-01T00:00:00Z',
        }]);
        const result = await readChronicleCheckpoints(dbPath);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionId, 'sess-1');
        assert.strictEqual(result[0].overview, 'overview text');
        assert.strictEqual(result[0].workDone, 'work done text');
        assert.strictEqual(result[0].technicalDetails, 'tech details');
        assert.strictEqual(result[0].nextSteps, 'next steps');
        assert.strictEqual(result[0].createdAt, '2024-01-01T00:00:00Z');
    });

    test('valid SQLite with multiple rows returns all', async () => {
        const dbPath = createTestDb(tmpDir, 'multi.db', true, [
            { session_id: 's1', overview: 'a', work_done: null, technical_details: null, next_steps: null, created_at: null },
            { session_id: 's2', overview: 'b', work_done: null, technical_details: null, next_steps: null, created_at: null },
            { session_id: 's3', overview: 'c', work_done: null, technical_details: null, next_steps: null, created_at: null },
        ]);
        const result = await readChronicleCheckpoints(dbPath);
        assert.strictEqual(result.length, 3);
    });

    test('null field values are preserved as null', async () => {
        const dbPath = createTestDb(tmpDir, 'nulls.db', true, [{
            session_id: 'sess-null',
            overview: null,
            work_done: null,
            technical_details: null,
            next_steps: null,
            created_at: null,
        }]);
        const result = await readChronicleCheckpoints(dbPath);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].overview, null);
        assert.strictEqual(result[0].workDone, null);
        assert.strictEqual(result[0].createdAt, null);
    });

    test('text field exceeding 8 KB is truncated to 8192 chars', async () => {
        const longText = 'x'.repeat(10000);
        const dbPath = createTestDb(tmpDir, 'long.db', true, [{
            session_id: 'sess-long',
            overview: longText,
            work_done: null,
            technical_details: null,
            next_steps: null,
            created_at: null,
        }]);
        const result = await readChronicleCheckpoints(dbPath);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].overview!.length, 8192);
    });

    test('text field at exactly 8 KB is not truncated', async () => {
        const exactText = 'y'.repeat(8192);
        const dbPath = createTestDb(tmpDir, 'exact.db', true, [{
            session_id: 'sess-exact',
            overview: exactText,
            work_done: null,
            technical_details: null,
            next_steps: null,
            created_at: null,
        }]);
        const result = await readChronicleCheckpoints(dbPath);
        assert.strictEqual(result[0].overview!.length, 8192);
    });
});

// ---------------------------------------------------------------------------
// discoverChronicleDbsAsync
// ---------------------------------------------------------------------------

suite('discoverChronicleDbsAsync', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = makeTmpDir();
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('non-existent root returns empty array', async () => {
        const result = await discoverChronicleDbsAsync('/nonexistent/path/xyz123');
        assert.deepStrictEqual(result, []);
    });

    test('empty root directory returns empty array', async () => {
        const result = await discoverChronicleDbsAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });

    test('root with no Chronicle DB files returns empty array', async () => {
        fs.mkdirSync(path.join(tmpDir, 'abc123'));
        const result = await discoverChronicleDbsAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });

    test('discovers a valid Chronicle DB and returns correct hash and path', async () => {
        const hash = 'abc123def456';
        const dbDir = path.join(tmpDir, hash, 'GitHub.copilot-chat', 'debug-logs');
        fs.mkdirSync(dbDir, { recursive: true });
        const dbPath = path.join(dbDir, 'session-store.db');
        // Create a minimal SQLite DB file (just needs to be a regular file that stat() accepts)
        createTestDb(dbDir, 'session-store.db', false);
        const result = await discoverChronicleDbsAsync(tmpDir);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].workspaceHash, hash);
        assert.ok(result[0].dbPath.endsWith('session-store.db'), `dbPath should end with session-store.db, got: ${result[0].dbPath}`);
        void dbPath; // suppress unused warning
    });

    test('discovers multiple Chronicle DBs across workspace hashes', async () => {
        for (const hash of ['hash1', 'hash2', 'hash3']) {
            const dbDir = path.join(tmpDir, hash, 'GitHub.copilot-chat', 'debug-logs');
            fs.mkdirSync(dbDir, { recursive: true });
            createTestDb(dbDir, 'session-store.db', false);
        }
        const result = await discoverChronicleDbsAsync(tmpDir);
        assert.strictEqual(result.length, 3);
    });

    test('non-directory entries in root are skipped', async () => {
        // Place a regular file directly in root — should not be treated as a workspace hash
        fs.writeFileSync(path.join(tmpDir, 'some-file.txt'), 'content');
        const result = await discoverChronicleDbsAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });
});
