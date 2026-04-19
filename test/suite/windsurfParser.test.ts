// test/suite/windsurfParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseWindsurfWorkspace, extractWindsurfCodeBlocks } from '../../src/parsers/windsurf';

// ---------------------------------------------------------------------------
// Helpers to create minimal SQLite fixtures in a temp directory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

function createDb(dbPath: string, rows: Array<{ key: string; value: string }>): void {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const stmt = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const row of rows) {
        stmt.run(row.key, row.value);
    }
    db.close();
}

function sampleCascadeData() {
    return JSON.stringify({
        sessions: [
            {
                sessionId: 'cascade-session-1',
                title: 'My Cascade Session',
                createdAt: 1700000000000,
                messages: [
                    { role: 'user', content: 'Help me refactor this code', timestamp: 1700000001000 },
                    {
                        role: 'assistant',
                        content: 'Sure! Here is a cleaner version:\n\n```typescript\nfunction greet(name: string) {\n  return `Hello, ${name}!`;\n}\n```',
                        timestamp: 1700000002000,
                    },
                    { role: 'user', content: 'Thanks!', timestamp: 1700000003000 },
                ],
            },
            {
                sessionId: 'cascade-session-2',
                title: '',
                createdAt: 1700000010000,
                messages: [
                    { role: 'user', content: 'Write a Python function', timestamp: 1700000011000 },
                    { role: 'assistant', content: 'Here it is', timestamp: 1700000012000 },
                    { role: 'unknown-role', content: 'should be skipped', timestamp: 1700000013000 },
                    { role: 'user', content: '', timestamp: 1700000014000 },  // empty — skipped
                ],
            },
        ],
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Windsurf Parser', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-windsurf-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Happy path ────────────────────────────────────────────────────────────

    test('happy path: returns correct session count and source', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results.length, 2);
        assert.ok(results.every(r => r.session.source === 'windsurf'));
    });

    test('happy path: first session has correct title (named)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results[0].session.title, 'My Cascade Session');
        assert.strictEqual(results[0].session.id, 'cascade-session-1');
    });

    test('happy path: second session title derived from first user message', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results[1].session.title, 'Write a Python function');
    });

    test('happy path: message roles mapped correctly', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        const msgs = results[0].session.messages;

        assert.strictEqual(msgs[0].role, 'user');
        assert.strictEqual(msgs[1].role, 'assistant');
        assert.strictEqual(msgs[2].role, 'user');
    });

    test('happy path: unknown role and empty content are skipped', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        // Second session: 4 items but unknown-role skipped, empty content skipped → 2 messages
        assert.strictEqual(results[1].session.messages.length, 2);
    });

    test('happy path: code blocks extracted from assistant messages', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        const assistantMsg = results[0].session.messages[1];

        assert.strictEqual(assistantMsg.codeBlocks.length, 1);
        assert.strictEqual(assistantMsg.codeBlocks[0].language, 'typescript');
    });

    test('happy path: workspacePath forwarded to each session', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.ok(results.every(r => r.session.workspacePath === '/projects/foo'));
    });

    test('happy path: createdAt uses session.createdAt', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(
            results[0].session.createdAt,
            new Date(1700000000000).toISOString()
        );
    });

    test('happy path: updatedAt = last message timestamp', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(
            results[0].session.updatedAt,
            new Date(1700000003000).toISOString()
        );
    });

    test('happy path: no errors on clean data', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'cascade.sessionData', value: sampleCascadeData() }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-1');

        assert.ok(results.every(r => r.errors.length === 0));
    });

    // ── Empty sessions ────────────────────────────────────────────────────────

    test('empty sessions array returns empty array (not error)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'cascade.sessionData',
            value: JSON.stringify({ sessions: [] }),
        }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-empty');

        assert.strictEqual(results.length, 0);
    });

    // ── Missing key ───────────────────────────────────────────────────────────

    test('missing cascade.sessionData key: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'some.other.key', value: '{}' }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-nokey');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.ok(results[0].errors[0].includes('cascade.sessionData'));
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── Malformed JSON ────────────────────────────────────────────────────────

    test('malformed JSON value: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'cascade.sessionData',
            value: 'NOT VALID JSON {{{',
        }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-malformed');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── Session with only empty messages ──────────────────────────────────────

    test('session with only empty/invalid messages produces empty messages array', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'cascade.sessionData',
            value: JSON.stringify({
                sessions: [{
                    sessionId: 'cascade-empty',
                    title: 'Empty',
                    createdAt: 1700000000000,
                    messages: [
                        { role: 'user', content: '', timestamp: 1700000001000 },
                        { role: 'assistant', content: '   ', timestamp: 1700000002000 },
                    ],
                }],
            }),
        }]);

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-empty-msgs');

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.messages.length, 0);
        assert.strictEqual(results[0].errors.length, 0);
    });

    // ── Non-SQLite file ───────────────────────────────────────────────────────

    test('non-SQLite file: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        fs.writeFileSync(dbPath, 'this is not a sqlite database');

        const results = await parseWindsurfWorkspace(dbPath, 'workspace-hash-bad-db');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── extractWindsurfCodeBlocks ─────────────────────────────────────────────

    test('extractWindsurfCodeBlocks: detects language and propagates IDs', () => {
        const content = '```python\nprint("hello")\n```';
        const blocks = extractWindsurfCodeBlocks(content, 'session-x', 3);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, 'python');
        assert.strictEqual(blocks[0].sessionId, 'session-x');
        assert.strictEqual(blocks[0].messageIndex, 3);
    });

    test('extractWindsurfCodeBlocks: no blocks returns empty array', () => {
        const blocks = extractWindsurfCodeBlocks('No code here.', 'session-y', 0);
        assert.strictEqual(blocks.length, 0);
    });
});
