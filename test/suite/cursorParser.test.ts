// test/suite/cursorParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseCursorWorkspace, extractCursorCodeBlocks } from '../../src/parsers/cursor';

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
