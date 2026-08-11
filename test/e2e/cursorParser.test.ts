// test/suite/cursorParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseCursorWorkspace, parseCursorGlobalDb, extractCursorCodeBlocks, stripCursorSystemContext } from '../../src/parsers/cursor';

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

function sampleComposerData() {
    return JSON.stringify({
        allComposers: [
            {
                composerId: 'composer-chat-1',
                name: 'My Chat Session',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { type: 1, text: 'Hello, help me refactor this code', unixMs: 1700000001000 },
                    {
                        type: 2,
                        text: 'Sure! Here is a cleaner version:\n\n```typescript\nfunction greet(name: string) {\n  return `Hello, ${name}!`;\n}\n```',
                        unixMs: 1700000002000,
                    },
                    { type: 1, text: 'Thanks!', unixMs: 1700000003000 },
                ],
            },
            {
                composerId: 'composer-agent-2',
                name: '',
                createdAt: 1700000010000,
                type: 2,
                conversation: [
                    { type: 1, text: 'Write a Python function', unixMs: 1700000011000 },
                    { type: 2, text: 'Here it is', unixMs: 1700000012000 },
                    { type: 99, text: 'unknown type — should be skipped', unixMs: 1700000013000 },
                    { type: 1, text: '', unixMs: 1700000014000 },  // empty — skipped
                ],
            },
        ],
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Cursor Parser', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cursor-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Happy path ────────────────────────────────────────────────────────────

    test('happy path: returns correct session count and source', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results.length, 2);
        assert.ok(results.every(r => r.session.source === 'cursor'));
    });

    test('happy path: first session has correct title (named)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results[0].session.title, 'My Chat Session');
        assert.strictEqual(results[0].session.id, 'composer-chat-1');
    });

    test('happy path: second session title derived from first user message', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(results[1].session.title, 'Write a Python function');
    });

    test('happy path: message roles mapped correctly', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        const msgs = results[0].session.messages;

        assert.strictEqual(msgs[0].role, 'user');
        assert.strictEqual(msgs[1].role, 'assistant');
        assert.strictEqual(msgs[2].role, 'user');
    });

    test('happy path: unknown type and empty text are skipped', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        // Second composer: 4 items but type-99 skipped, empty text skipped → 2 messages
        assert.strictEqual(results[1].session.messages.length, 2);
    });

    test('happy path: code blocks extracted from assistant messages', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');
        const assistantMsg = results[0].session.messages[1];

        assert.strictEqual(assistantMsg.codeBlocks.length, 1);
        assert.strictEqual(assistantMsg.codeBlocks[0].language, 'typescript');
    });

    test('happy path: workspacePath forwarded to each session', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.ok(results.every(r => r.session.workspacePath === '/projects/foo'));
    });

    test('happy path: createdAt uses composer.createdAt', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(
            results[0].session.createdAt,
            new Date(1700000000000).toISOString()
        );
    });

    test('happy path: updatedAt = last message timestamp', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1', '/projects/foo');

        assert.strictEqual(
            results[0].session.updatedAt,
            new Date(1700000003000).toISOString()
        );
    });

    test('happy path: no errors on clean data', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: sampleComposerData() }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-1');

        assert.ok(results.every(r => r.errors.length === 0));
    });

    // ── Empty allComposers ────────────────────────────────────────────────────

    test('empty allComposers returns empty array (not error)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'composer.composerData',
            value: JSON.stringify({ allComposers: [] }),
        }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-empty');

        assert.strictEqual(results.length, 0);
    });

    // ── Missing key ───────────────────────────────────────────────────────────

    test('missing composer.composerData key: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{ key: 'some.other.key', value: '{}' }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-nokey');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.ok(results[0].errors[0].includes('composer') || results[0].errors[0].includes('Missing usable'));
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── Malformed JSON ────────────────────────────────────────────────────────

    test('malformed JSON value: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'composer.composerData',
            value: 'NOT VALID JSON {{{',
        }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-malformed');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── Composer with only empty messages ─────────────────────────────────────

    test('composer with only empty/unsupported messages yields no parse results (no aiService fallback)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'composer.composerData',
            value: JSON.stringify({
                allComposers: [{
                    composerId: 'composer-empty',
                    name: 'Empty',
                    createdAt: 1700000000000,
                    conversation: [
                        { type: 1, text: '', unixMs: 1700000001000 },   // empty
                        { type: 2, text: '   ', unixMs: 1700000002000 }, // whitespace only
                    ],
                }],
            }),
        }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-empty-msgs');

        assert.strictEqual(results.length, 0);
    });

    test('new Cursor shape: metadata-only composers + aiService.prompts → one session (user prompts)', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        const composerOnlyMeta = JSON.stringify({
            allComposers: [{
                composerId: 'c1',
                name: 'Tab title',
                createdAt: 1700000000000,
                branches: [{ branchName: 'main', lastInteractionAt: 1 }],
                activeBranch: { branchName: 'main', lastInteractionAt: 1 },
            }],
        });
        const prompts = JSON.stringify([
            { text: 'First user question', commandType: 4 },
            { text: 'Second prompt line', commandType: 4 },
        ]);
        const generations = JSON.stringify([
            { unixMs: 1700000001000, generationUUID: 'u1', type: 'composer', textDescription: 'ignored dup' },
            { unixMs: 1700000002000, generationUUID: 'u2', type: 'composer', textDescription: 'ignored' },
        ]);
        createDb(dbPath, [
            { key: 'composer.composerData', value: composerOnlyMeta },
            { key: 'aiService.prompts', value: prompts },
            { key: 'aiService.generations', value: generations },
        ]);

        const results = await parseCursorWorkspace(dbPath, 'ws-hash', '/repo');

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.id, 'c1');
        assert.strictEqual(results[0].session.messages.length, 2);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[0].content, 'First user question');
        assert.ok(results[0].session.sourceNotes?.length);
    });

    test('metadata-only: three composers + three prompts (no per-prompt composerId) → three sessions via even split', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        const composerOnlyMeta = JSON.stringify({
            allComposers: [
                {
                    composerId: 'a',
                    name: 'Recommendations For VSIX IDE',
                    createdAt: 1700000000000,
                    lastUpdatedAt: 1700000001000,
                },
                {
                    composerId: 'b',
                    name: 'Missing extension in marketplace',
                    createdAt: 1700000002000,
                    lastUpdatedAt: 1700000003000,
                },
                {
                    composerId: 'c',
                    name: 'Chat Wizard extension testing issues',
                    createdAt: 1700000004000,
                    lastUpdatedAt: 1700000005000,
                },
            ],
        });
        const prompts = JSON.stringify([
            { text: 'First chat first prompt', commandType: 4 },
            { text: 'Second chat first prompt', commandType: 4 },
            { text: 'Third chat first prompt', commandType: 4 },
        ]);
        createDb(dbPath, [
            { key: 'composer.composerData', value: composerOnlyMeta },
            { key: 'aiService.prompts', value: prompts },
        ]);

        const results = await parseCursorWorkspace(dbPath, 'ws3', '/repo');

        assert.strictEqual(results.length, 3);
        const titles = results.map(r => r.session.title).sort();
        assert.deepStrictEqual(
            titles,
            [
                'Chat Wizard extension testing issues',
                'Missing extension in marketplace',
                'Recommendations For VSIX IDE',
            ]
        );
        assert.ok(results.every(r => r.session.sourceNotes?.length));
    });

    test('metadata-only: prompts carry composerId → grouped into matching composer sessions', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        const composerOnlyMeta = JSON.stringify({
            allComposers: [
                { composerId: 'id-a', name: 'Alpha', createdAt: 1, lastUpdatedAt: 10 },
                { composerId: 'id-b', name: 'Beta', createdAt: 2, lastUpdatedAt: 20 },
            ],
        });
        const prompts = JSON.stringify([
            { text: 'only a', composerId: 'id-a' },
            { text: 'only b1', composerId: 'id-b' },
            { text: 'only b2', composerId: 'id-b' },
        ]);
        createDb(dbPath, [
            { key: 'composer.composerData', value: composerOnlyMeta },
            { key: 'aiService.prompts', value: prompts },
        ]);

        const results = await parseCursorWorkspace(dbPath, 'ws2', '/repo');

        assert.strictEqual(results.length, 2);
        const byId = new Map(results.map(r => [r.session.id, r.session]));
        assert.strictEqual(byId.get('id-a')?.messages.length, 1);
        assert.strictEqual(byId.get('id-b')?.messages.length, 2);
    });

    // ── Non-SQLite file ───────────────────────────────────────────────────────

    test('non-SQLite file: returns one error result', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        fs.writeFileSync(dbPath, 'this is not a sqlite database');

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-bad-db');

        assert.strictEqual(results.length, 1);
        assert.ok(results[0].errors.length > 0);
        assert.strictEqual(results[0].session.messages.length, 0);
    });

    // ── richText fallback ─────────────────────────────────────────────────────

    test('richText used as fallback when text is absent', async () => {
        const dbPath = path.join(tmpDir, 'state.vscdb');
        createDb(dbPath, [{
            key: 'composer.composerData',
            value: JSON.stringify({
                allComposers: [{
                    composerId: 'composer-richtext',
                    createdAt: 1700000000000,
                    conversation: [
                        { type: 1, richText: 'User via richText', unixMs: 1700000001000 },
                    ],
                }],
            }),
        }]);

        const results = await parseCursorWorkspace(dbPath, 'workspace-hash-richtext');

        assert.strictEqual(results[0].session.messages[0].content, 'User via richText');
    });

    // ── extractCursorCodeBlocks ───────────────────────────────────────────────

    test('extractCursorCodeBlocks: detects language and propagates IDs', () => {
        const content = '```python\nprint("hello")\n```';
        const blocks = extractCursorCodeBlocks(content, 'session-x', 3);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, 'python');
        assert.strictEqual(blocks[0].sessionId, 'session-x');
        assert.strictEqual(blocks[0].messageIndex, 3);
    });

    test('extractCursorCodeBlocks: no blocks returns empty array', () => {
        const blocks = extractCursorCodeBlocks('No code here.', 'session-y', 0);
        assert.strictEqual(blocks.length, 0);
    });
});

// ---------------------------------------------------------------------------
// parseCursorGlobalDb — tests for the Cursor 0.43+ global cursorDiskKV DB
// ---------------------------------------------------------------------------

function createGlobalDb(
    dbPath: string,
    rows: Array<{ key: string; value: string }>,
    createTable = true,
    blobRows: Array<{ key: string; value: Buffer }> = []
): void {
    const db = new Database(dbPath);
    if (createTable) {
        db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
        const stmt = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
        for (const row of rows) {
            stmt.run(row.key, row.value);
        }
        // BLOB values need a separate insert since the type matters
        const blobStmt = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
        for (const brow of blobRows) {
            blobStmt.run(brow.key, brow.value);
        }
    } else {
        // Create a different table so cursorDiskKV is missing
        db.exec('CREATE TABLE SomeOtherTable (key TEXT PRIMARY KEY, value TEXT)');
    }
    db.close();
}

suite('parseCursorGlobalDb', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cursor-global-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('non-existent file returns empty array', async () => {
        const results = await parseCursorGlobalDb(path.join(tmpDir, 'does-not-exist.db'));
        assert.deepStrictEqual(results, []);
    });

    test('non-SQLite file returns empty array', async () => {
        const dbPath = path.join(tmpDir, 'not-sqlite.db');
        fs.writeFileSync(dbPath, 'not a sqlite database');
        const results = await parseCursorGlobalDb(dbPath);
        assert.deepStrictEqual(results, []);
    });

    test('SQLite DB without cursorDiskKV table returns empty array', async () => {
        const dbPath = path.join(tmpDir, 'no-table.db');
        createGlobalDb(dbPath, [], false);
        const results = await parseCursorGlobalDb(dbPath);
        assert.deepStrictEqual(results, []);
    });

    test('empty cursorDiskKV table returns empty array', async () => {
        const dbPath = path.join(tmpDir, 'empty.db');
        createGlobalDb(dbPath, []);
        const results = await parseCursorGlobalDb(dbPath);
        assert.deepStrictEqual(results, []);
    });

    test('composerData row with no matching bubbles is skipped', async () => {
        const dbPath = path.join(tmpDir, 'no-bubbles.db');
        createGlobalDb(dbPath, [
            { key: 'composerData:composer-abc', value: JSON.stringify({ name: 'My Chat', createdAt: 1700000000000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.deepStrictEqual(results, []);
    });

    test('happy path: returns session with user and assistant messages', async () => {
        const composerId = 'composer-happy-1';
        const dbPath = path.join(tmpDir, 'happy.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'Auth Refactor', createdAt: 1700000000000, model: 'claude-3-opus' }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: 'How do I fix JWT?', unixMs: 1700000001000 }) },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 2, text: 'You should use a proper signing key.', unixMs: 1700000002000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.source, 'cursor');
        assert.strictEqual(results[0].session.title, 'Auth Refactor');
        assert.strictEqual(results[0].session.messages.length, 2);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[1].role, 'assistant');
        assert.strictEqual(results[0].session.model, 'claude-3-opus');
    });

    test('title derived from first user message when name is empty', async () => {
        const composerId = 'composer-notitle';
        const dbPath = path.join(tmpDir, 'notitle.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: '', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: 'Help me refactor this function', unixMs: 1700000001000 }) },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 2, text: 'Sure!', unixMs: 1700000002000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.ok(results[0].session.title.includes('Help me refactor'));
    });

    test('title is Untitled when no user messages', async () => {
        const composerId = 'composer-nouser';
        const dbPath = path.join(tmpDir, 'nouser.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: '', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 2, text: 'Assistant message only', unixMs: 1700000001000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.title, 'Untitled');
    });

    test('createdAt falls back to first message timestamp when composerMeta.createdAt is missing', async () => {
        const composerId = 'composer-notimestamp';
        const dbPath = path.join(tmpDir, 'notimestamp.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'No Timestamp' }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: 'Hello', unixMs: 1700000005000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.ok(results[0].session.createdAt);
    });

    test('bubbles with empty text are skipped', async () => {
        const composerId = 'composer-empty-text';
        const dbPath = path.join(tmpDir, 'empty-text.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'Chat', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: '', unixMs: 1700000001000 }) },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 1, text: 'Real message', unixMs: 1700000002000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.messages.length, 1);
        assert.strictEqual(results[0].session.messages[0].content, 'Real message');
    });

    test('bubbles with unsupported type (not 1 or 2) are skipped', async () => {
        const composerId = 'composer-bad-type';
        const dbPath = path.join(tmpDir, 'bad-type.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'Chat', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 99, text: 'Unknown type', unixMs: 1700000001000 }) },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 1, text: 'Valid user', unixMs: 1700000002000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.messages.length, 1);
    });

    test('bubbles ordered by fullConversationHeadersOnly when present', async () => {
        const composerId = 'composer-ordered';
        const dbPath = path.join(tmpDir, 'ordered.db');
        // Bubble 2 has earlier timestamp but appears second in headers
        createGlobalDb(dbPath, [
            {
                key: `composerData:${composerId}`,
                value: JSON.stringify({
                    name: 'Ordered Chat',
                    createdAt: 1700000000000,
                    fullConversationHeadersOnly: [
                        { bubbleId: 'bubble-002' },
                        { bubbleId: 'bubble-001' },
                    ],
                }),
            },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 2, text: 'Assistant last', unixMs: 1700000002000 }) },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 1, text: 'User first', unixMs: 1700000001000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[1].role, 'assistant');
    });

    test('user bubbles with Cursor system context are stripped', async () => {
        const composerId = 'composer-bubble-context';
        const dbPath = path.join(tmpDir, 'bubble-context.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'Chat', createdAt: 1700000000000 }) },
            {
                key: `bubbleId:${composerId}:bubble-001`,
                value: JSON.stringify({
                    type: 1,
                    text: `<user_info>OS: Windows</user_info>\n<user_query>\nFix the bug in auth\n</user_query>`,
                    unixMs: 1700000001000,
                }),
            },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 2, text: 'Done.', unixMs: 1700000002000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.messages.length, 2);
        assert.strictEqual(results[0].session.messages[0].content, 'Fix the bug in auth');
    });

    test('returns multiple sessions for multiple composer rows', async () => {
        const c1 = 'composer-multi-1';
        const c2 = 'composer-multi-2';
        const dbPath = path.join(tmpDir, 'multi.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${c1}`, value: JSON.stringify({ name: 'Chat 1', createdAt: 1700000000000 }) },
            { key: `bubbleId:${c1}:bubble-001`, value: JSON.stringify({ type: 1, text: 'Q1', unixMs: 1700000001000 }) },
            { key: `composerData:${c2}`, value: JSON.stringify({ name: 'Chat 2', createdAt: 1700000010000 }) },
            { key: `bubbleId:${c2}:bubble-001`, value: JSON.stringify({ type: 1, text: 'Q2', unixMs: 1700000011000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 2);
    });

    test('malformed JSON bubble value is skipped', async () => {
        const composerId = 'composer-bad-json';
        const dbPath = path.join(tmpDir, 'bad-bubble-json.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: 'Chat', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: 'NOT JSON' },
            { key: `bubbleId:${composerId}:bubble-002`, value: JSON.stringify({ type: 1, text: 'Valid', unixMs: 1700000001000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results[0].session.messages.length, 1);
    });

    test('malformed JSON composerData value is skipped', async () => {
        const composerId = 'composer-bad-meta';
        const dbPath = path.join(tmpDir, 'bad-meta-json.db');
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: 'NOT JSON' },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: 'Hello', unixMs: 1700000001000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.deepStrictEqual(results, []);
    });

    test('title truncated to MAX_TITLE_CHARS when first user message is very long', async () => {
        const composerId = 'composer-longtitle';
        const dbPath = path.join(tmpDir, 'longtitle.db');
        const longMsg = 'A'.repeat(300);
        createGlobalDb(dbPath, [
            { key: `composerData:${composerId}`, value: JSON.stringify({ name: '', createdAt: 1700000000000 }) },
            { key: `bubbleId:${composerId}:bubble-001`, value: JSON.stringify({ type: 1, text: longMsg, unixMs: 1700000001000 }) },
        ]);
        const results = await parseCursorGlobalDb(dbPath);
        assert.ok(results[0].session.title.length <= 130, 'title should be truncated');
    });

    // ── conversationState / agentKv blob recovery ────────────────────────────

    /** Build a protobuf conversationState from a list of 32-byte hash buffers. */
    function buildConversationState(hashes: Buffer[]): string {
        const parts: Buffer[] = [];
        for (const h of hashes) {
            parts.push(Buffer.from([0x0a, h.length])); // field 1, wire type 2, len
            parts.push(h);
        }
        return Buffer.concat(parts).toString('base64');
    }

    test('recovers messages from agentKv blobs when bubbles have empty text', async () => {
        const composerId = 'composer-blobs';
        const dbPath = path.join(tmpDir, 'blobs.db');

        // Two blobs: user + assistant
        const userHash = Buffer.alloc(32, 0x01);
        const asstHash = Buffer.alloc(32, 0x02);
        const hoverHash = Buffer.alloc(32, 0x03); // not referenced

        const conversationState = buildConversationState([userHash, asstHash]);

        createGlobalDb(
            dbPath,
            [
                {
                    key: `composerData:${composerId}`,
                    // bubbles are stubs (empty text) like Cursor 0.46+
                    value: JSON.stringify({
                        name: 'Knowledge Base issue',
                        createdAt: 1700000000000,
                        conversationState,
                    }),
                },
                { key: `bubbleId:${composerId}:b1`, value: JSON.stringify({ type: 1, text: '', unixMs: 1700000001000 }) },
                { key: `bubbleId:${composerId}:b2`, value: JSON.stringify({ type: 2, text: '', unixMs: 1700000002000 }) },
            ],
            true,
            [
                { key: `agentKv:blob:${userHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'user', content: 'What is the Knowledge Base feature?' })) },
                { key: `agentKv:blob:${asstHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'assistant', content: 'It handles free model triggering.' })) },
                { key: `agentKv:blob:${hoverHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'tool', content: 'ignored' })) },
            ]
        );

        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.title, 'Knowledge Base issue');
        assert.strictEqual(results[0].session.messages.length, 2);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[0].content, 'What is the Knowledge Base feature?');
        assert.strictEqual(results[0].session.messages[1].role, 'assistant');
        assert.strictEqual(results[0].session.messages[1].content, 'It handles free model triggering.');
    });

    test('recovers multi-part content and skips system/tool blobs', async () => {
        const composerId = 'composer-multipart';
        const dbPath = path.join(tmpDir, 'multipart.db');

        const sysHash = Buffer.alloc(32, 0x11);
        const userHash = Buffer.alloc(32, 0x12);
        const conversationState = buildConversationState([sysHash, userHash]);

        createGlobalDb(
            dbPath,
            [
                {
                    key: `composerData:${composerId}`,
                    value: JSON.stringify({ name: 'Multi', createdAt: 1700000000000, conversationState }),
                },
            ],
            true,
            [
                { key: `agentKv:blob:${sysHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'system', content: 'You are an AI.' })) },
                { key: `agentKv:blob:${userHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Part one' }, { type: 'text', text: 'Part two' }] })) },
            ]
        );

        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.messages.length, 1);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[0].content, 'Part one\nPart two');
    });

    test('falls back to bubble text when blob recovery yields no user/assistant messages', async () => {
        const composerId = 'composer-blob-fallback';
        const dbPath = path.join(tmpDir, 'blob-fallback.db');

        const toolHash = Buffer.alloc(32, 0x21);
        const conversationState = buildConversationState([toolHash]);

        createGlobalDb(
            dbPath,
            [
                {
                    key: `composerData:${composerId}`,
                    value: JSON.stringify({ name: 'Fallback', createdAt: 1700000000000, conversationState }),
                },
                { key: `bubbleId:${composerId}:b-001`, value: JSON.stringify({ type: 1, text: 'Real bubble text', unixMs: 1700000001000 }) },
            ],
            true,
            [
                { key: `agentKv:blob:${toolHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'tool', content: 'tool result' })) },
            ]
        );

        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.messages.length, 1);
        assert.strictEqual(results[0].session.messages[0].content, 'Real bubble text');
    });

    test('blob recovery strips Cursor agent-mode system context from user messages', async () => {
        const composerId = 'composer-context-strip';
        const dbPath = path.join(tmpDir, 'context-strip.db');

        const userHash = Buffer.alloc(32, 0xaa);
        const asstHash = Buffer.alloc(32, 0xbb);
        const conversationState = buildConversationState([userHash, asstHash]);

        const noisyUser = `<user_info>OS Version: win32 10.0.26200</user_info>
<git_status>M src/foo.ts</git_status>
<rules>
<user_rule>Some rule here</user_rule>
</rules>
<available_skills>
<agent_skill>skill1</agent_skill>
</available_skills>
<open_and_recently_viewed_files>src/foo.ts</open_and_recently_viewed_files>
<timestamp>Monday, Aug 10, 2026</timestamp>
<user_query>
Please refactor the UserService class to use dependency injection
</user_query>`;

        createGlobalDb(
            dbPath,
            [
                {
                    key: `composerData:${composerId}`,
                    value: JSON.stringify({ name: 'Refactor DI', createdAt: 1700000000000, conversationState }),
                },
            ],
            true,
            [
                { key: `agentKv:blob:${userHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'user', content: noisyUser })) },
                { key: `agentKv:blob:${asstHash.toString('hex')}`, value: Buffer.from(JSON.stringify({ role: 'assistant', content: 'Here is the refactored code.' })) },
            ]
        );

        const results = await parseCursorGlobalDb(dbPath);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].session.messages.length, 2);
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        // The system context should be stripped, leaving only the <user_query> content
        assert.strictEqual(
            results[0].session.messages[0].content,
            'Please refactor the UserService class to use dependency injection'
        );
        // Assistant message should be preserved as-is
        assert.strictEqual(results[0].session.messages[1].content, 'Here is the refactored code.');
    });
});

// ---------------------------------------------------------------------------
// stripCursorSystemContext — Cursor agent-mode noise stripping
// ---------------------------------------------------------------------------

suite('stripCursorSystemContext', () => {

    test('extracts content from <user_query> tags', () => {
        const input = `<user_info>OS: Windows</user_info>
<user_query>
how do I fix the JWT signing?
</user_query>
<git_status>modified: src/auth.ts</git_status>`;
        assert.strictEqual(
            stripCursorSystemContext(input),
            'how do I fix the JWT signing?'
        );
    });

    test('extracts content from <user_query> with surrounding system context', () => {
        const input = `<user_info>...</user_info>
<git_status>...</git_status>
<agent_transcripts>...</agent_transcripts>
<rules>
<user_rule>rule1</user_rule>
</rules>
<available_skills>...</available_skills>
<open_and_recently_viewed_files>src/foo.ts</open_and_recently_viewed_files>
<timestamp>Monday, Aug 10, 2026</timestamp>
<user_query>
Please refactor the UserService class
</user_query>`;
        assert.strictEqual(
            stripCursorSystemContext(input),
            'Please refactor the UserService class'
        );
    });

    test('returns original text unchanged when no context tags or user_query present', () => {
        const input = 'Hello, can you help me?';
        assert.strictEqual(stripCursorSystemContext(input), 'Hello, can you help me?');
    });

    test('strips Cursor prompt markers', () => {
        const input = `Some context here
Cursor
★
📝
⧉
<user_query>
What is the actual question?
</user_query>`;
        assert.strictEqual(
            stripCursorSystemContext(input),
            'What is the actual question?'
        );
    });

    test('strips <!-- HTML comments --> added by Cursor', () => {
        const input = `<!-- This is a conversation summary -->
<user_query>How do I use async/await?</user_query>`;
        assert.strictEqual(
            stripCursorSystemContext(input),
            'How do I use async/await?'
        );
    });

    test('handles empty input gracefully', () => {
        assert.strictEqual(stripCursorSystemContext(''), '');
    });

    test('handles input with only whitespace', () => {
        assert.strictEqual(stripCursorSystemContext('   \n  \n  '), '   \n  \n  ');
    });

    test('preserves assistant messages (non-user content) unchanged', () => {
        // This function is only called on user messages, but test defensive handling
        const input = 'Here is the refactored code:\n\n```typescript\nconst x = 1;\n```';
        assert.strictEqual(stripCursorSystemContext(input), input);
    });

    test('strips git_status when present without user_query', () => {
        const input = `<user_info>Windows</user_info>
<git_status>M src/foo.ts</git_status>

What is the actual question?`;
        assert.strictEqual(
            stripCursorSystemContext(input),
            'What is the actual question?'
        );
    });
});

// ---------------------------------------------------------------------------
// extractItemRole and extractItemText — branch coverage via parseCursorWorkspace
// ---------------------------------------------------------------------------
suite('Cursor Parser — extractItemRole and extractItemText branch coverage', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cursor-branch-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('isUser:true is treated as user role', async () => {
        const composerData = JSON.stringify({
            allComposers: [{
                composerId: 'c-isuser',
                name: 'isUser test',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { isUser: true, text: 'Hello from isUser', unixMs: 1700000001000 },
                    { isUser: false, text: 'Assistant response', unixMs: 1700000002000 },
                ],
            }],
        });
        const dbPath = path.join(tmpDir, 'isuser.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: composerData }]);
        const results = await parseCursorWorkspace(dbPath, 'ws1', '/proj');
        assert.strictEqual(results[0].session.messages[0].role, 'user');
        assert.strictEqual(results[0].session.messages[1].role, 'assistant');
    });

    test('role string field is used for role detection', async () => {
        const composerData = JSON.stringify({
            allComposers: [{
                composerId: 'c-rolestring',
                name: 'role string test',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { role: 'user', text: 'User message via role string', unixMs: 1700000001000 },
                    { role: 'ai', text: 'AI response via role=ai', unixMs: 1700000002000 },
                    { role: 'model', text: 'Model response', unixMs: 1700000003000 },
                    { role: 'assistant', text: 'Assistant via role string', unixMs: 1700000004000 },
                ],
            }],
        });
        const dbPath = path.join(tmpDir, 'rolestring.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: composerData }]);
        const results = await parseCursorWorkspace(dbPath, 'ws1', '/proj');
        const roles = results[0].session.messages.map(m => m.role);
        assert.ok(roles.includes('user'));
        assert.ok(roles.includes('assistant'));
    });

    test('content field used when text/richText absent', async () => {
        const composerData = JSON.stringify({
            allComposers: [{
                composerId: 'c-content',
                name: 'content field test',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { type: 1, content: 'Via content field', unixMs: 1700000001000 },
                    { type: 2, message: 'Via message field', unixMs: 1700000002000 },
                ],
            }],
        });
        const dbPath = path.join(tmpDir, 'content.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: composerData }]);
        const results = await parseCursorWorkspace(dbPath, 'ws1', '/proj');
        assert.ok(results[0].session.messages.length >= 1);
        assert.ok(results[0].session.messages.some(m => m.content.includes('content field') || m.content.includes('message field')));
    });

    test('parts field used when text/richText/content/message absent', async () => {
        const composerData = JSON.stringify({
            allComposers: [{
                composerId: 'c-parts',
                name: 'parts field test',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { type: 1, parts: [{ text: 'From parts text' }, { content: 'From parts content' }], unixMs: 1700000001000 },
                    { type: 2, text: 'Normal response', unixMs: 1700000002000 },
                ],
            }],
        });
        const dbPath = path.join(tmpDir, 'parts.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: composerData }]);
        const results = await parseCursorWorkspace(dbPath, 'ws1', '/proj');
        assert.ok(results[0].session.messages.some(m => m.content.includes('From parts')));
    });

    test('markdown field used as last text fallback', async () => {
        const composerData = JSON.stringify({
            allComposers: [{
                composerId: 'c-markdown',
                name: 'markdown field test',
                createdAt: 1700000000000,
                type: 1,
                conversation: [
                    { type: 1, text: 'User question', unixMs: 1700000001000 },
                    { type: 2, markdown: '## Markdown Response', unixMs: 1700000002000 },
                ],
            }],
        });
        const dbPath = path.join(tmpDir, 'markdown.vscdb');
        createDb(dbPath, [{ key: 'composer.composerData', value: composerData }]);
        const results = await parseCursorWorkspace(dbPath, 'ws1', '/proj');
        assert.ok(results[0].session.messages.some(m => m.content.includes('Markdown Response')));
    });
});
