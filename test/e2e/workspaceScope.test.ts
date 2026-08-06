// test/suite/workspaceScope.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScopeManager, calcWorkspaceSizeMb, calcWorkspaceSizeBytes, countWorkspaceSessions, ExtensionContextLike } from '../../src/watcher/workspaceScope';
import { ScopedWorkspace } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): { context: ExtensionContextLike; store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    const context: ExtensionContextLike = {
        globalState: {
            get<T>(key: string): T | undefined {
                return store.get(key) as T | undefined;
            },
            update(key: string, value: unknown): Thenable<void> {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    };
    return { context, store };
}

function makeWorkspace(id: string, workspacePath: string, source: 'copilot' | 'claude' = 'copilot'): ScopedWorkspace {
    return { id, source, workspacePath, storageDir: `/storage/${id}` };
}

async function writeTempFile(dir: string, name: string, sizeBytes: number): Promise<void> {
    await fs.promises.writeFile(path.join(dir, name), Buffer.alloc(sizeBytes));
}

// ---------------------------------------------------------------------------
// WorkspaceScopeManager
// ---------------------------------------------------------------------------

suite('WorkspaceScopeManager', () => {

    test('getSelectedIds() returns empty array when nothing persisted', () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
    });

    test('getSelectedIds() returns previously stored IDs', () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['a', 'b', 'c']);
        const mgr = new WorkspaceScopeManager(context);
        assert.deepStrictEqual(mgr.getSelectedIds(), ['a', 'b', 'c']);
    });

    test('setSelectedIds() persists IDs retrievable via getSelectedIds()', () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        mgr.setSelectedIds(['x', 'y']);
        assert.deepStrictEqual(mgr.getSelectedIds(), ['x', 'y']);
    });

    test('setSelectedIds() overwrites previous selection', () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        mgr.setSelectedIds(['a', 'b']);
        mgr.setSelectedIds(['c']);
        assert.deepStrictEqual(mgr.getSelectedIds(), ['c']);
    });

    test('initDefault() sets scope to empty when no VS Code workspace is open (test host)', async () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-1', '/projects/foo'),
            makeWorkspace('ws-2', '/projects/bar'),
        ];
        await mgr.initDefault(available);
        // No vscode.workspace.workspaceFolders in test host → empty scope
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
    });

    test('initDefault() preserves previously stored IDs when no folder is open (test host)', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['ws-original']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-original', '/projects/foo'),
            makeWorkspace('ws-new', '/projects/bar'),
        ];
        await mgr.initDefault(available);
        // No VS Code workspace folder in the test host → the persisted selection
        // is kept as-is so a manually configured scope is not lost.
        assert.deepStrictEqual(mgr.getSelectedIds(), ['ws-original']);
    });

    test('initDefault() with empty available list persists empty array', async () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        await mgr.initDefault([]);
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
    });

    test('second initDefault() call produces same result (idempotent in test host)', async () => {
        const { context } = makeContext();
        const mgr = new WorkspaceScopeManager(context);
        const available = [makeWorkspace('ws-1', '/projects/foo')];
        await mgr.initDefault(available);
        const firstResult = mgr.getSelectedIds().slice();

        await mgr.initDefault([makeWorkspace('ws-1', '/projects/foo')]);
        assert.deepStrictEqual(mgr.getSelectedIds(), firstResult);
    });

    test('initDefault() preserves previously stored IDs across calls when no folder is open (test host)', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['ws-old', 'ws-keep']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-keep', '/projects/keep'),
            makeWorkspace('ws-new', '/projects/new'),
        ];
        await mgr.initDefault(available);
        // No open folder in the test host → persisted selection is preserved.
        assert.deepStrictEqual(mgr.getSelectedIds(), ['ws-old', 'ws-keep']);
    });

    test('initDefault() preserves previously stored IDs even when they are stale (no folder open in test host)', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['stale-1', 'stale-2']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-a', '/projects/a'),
            makeWorkspace('ws-b', '/projects/b'),
        ];
        await mgr.initDefault(available);
        // No open folder in the test host → persisted selection is preserved.
        assert.deepStrictEqual(mgr.getSelectedIds(), ['stale-1', 'stale-2']);
    });
});

// ---------------------------------------------------------------------------
// calcWorkspaceSizeMb
// ---------------------------------------------------------------------------

suite('calcWorkspaceSizeMb', () => {

    let tmpDir: string;

    setup(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cw-size-test-'));
    });

    teardown(async function () {
        this.timeout(15000);
        await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    });

    test('returns 0 when storageDir does not exist', async () => {
        const result = await calcWorkspaceSizeMb(path.join(tmpDir, 'nonexistent'), 'copilot');
        assert.strictEqual(result, 0);
    });

    test('returns 0 for empty copilot chatSessions directory', async () => {
        const chatSessionsDir = path.join(tmpDir, 'chatSessions');
        await fs.promises.mkdir(chatSessionsDir);
        const result = await calcWorkspaceSizeMb(tmpDir, 'copilot');
        assert.strictEqual(result, 0);
    });

    test('returns 0 for empty claude storageDir', async () => {
        const result = await calcWorkspaceSizeMb(tmpDir, 'claude');
        assert.strictEqual(result, 0);
    });

    test('copilot: sums .jsonl files inside chatSessions/', async () => {
        const chatSessionsDir = path.join(tmpDir, 'chatSessions');
        await fs.promises.mkdir(chatSessionsDir);
        // 512 KB + 512 KB = 1 MB
        await writeTempFile(chatSessionsDir, 'a.jsonl', 512 * 1024);
        await writeTempFile(chatSessionsDir, 'b.jsonl', 512 * 1024);
        const result = await calcWorkspaceSizeMb(tmpDir, 'copilot');
        assert.strictEqual(result, 1);
    });

    test('claude: sums .jsonl files directly in storageDir', async () => {
        // 1 MB exactly
        await writeTempFile(tmpDir, 'session.jsonl', 1024 * 1024);
        const result = await calcWorkspaceSizeMb(tmpDir, 'claude');
        assert.strictEqual(result, 1);
    });

    test('ignores non-.jsonl files', async () => {
        await writeTempFile(tmpDir, 'session.jsonl', 1024 * 1024);
        await writeTempFile(tmpDir, 'readme.txt', 500 * 1024);
        await writeTempFile(tmpDir, 'data.json', 500 * 1024);
        const result = await calcWorkspaceSizeMb(tmpDir, 'claude');
        assert.strictEqual(result, 1); // only the .jsonl file
    });

    test('copilot: ignores .jsonl files outside chatSessions/', async () => {
        // Place a .jsonl directly in storageDir — should NOT be counted for copilot
        await writeTempFile(tmpDir, 'stray.jsonl', 1024 * 1024);
        const chatSessionsDir = path.join(tmpDir, 'chatSessions');
        await fs.promises.mkdir(chatSessionsDir);
        await writeTempFile(chatSessionsDir, 'real.jsonl', 512 * 1024);
        const result = await calcWorkspaceSizeMb(tmpDir, 'copilot');
        assert.strictEqual(result, 0.5);
    });

    test('result is rounded to two decimal places', async () => {
        // Write 1.5 MB + a few extra bytes to force a fraction beyond 2 dp
        await writeTempFile(tmpDir, 'a.jsonl', 1024 * 1024 + 100);
        const raw = await calcWorkspaceSizeMb(tmpDir, 'claude');
        // Verify it has at most 2 decimal places
        const str = raw.toString();
        const dotIndex = str.indexOf('.');
        if (dotIndex !== -1) {
            assert.ok(str.length - dotIndex - 1 <= 2, `Expected ≤2 decimal places, got: ${str}`);
        }
    });

    test('returns 0 when copilot chatSessions directory is missing', async () => {
        // storageDir exists but has no chatSessions/ subdirectory
        const result = await calcWorkspaceSizeMb(tmpDir, 'copilot');
        assert.strictEqual(result, 0);
    });
});

// ------------------------------------------------------------------ //
// countWorkspaceSessions
// ------------------------------------------------------------------ //

suite('countWorkspaceSessions', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-count-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('copilot — counts .jsonl files in chatSessions/', async () => {
        const chatDir = path.join(tmpDir, 'chatSessions');
        fs.mkdirSync(chatDir);
        fs.writeFileSync(path.join(chatDir, 'a.jsonl'), '');
        fs.writeFileSync(path.join(chatDir, 'b.jsonl'), '');
        fs.writeFileSync(path.join(chatDir, 'other.txt'), '');
        const result = await countWorkspaceSessions(tmpDir, 'copilot');
        assert.strictEqual(result, 2);
    });

    test('copilot — returns 0 when chatSessions/ is missing', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'copilot');
        assert.strictEqual(result, 0);
    });

    test('claude — counts .jsonl files directly in storageDir', async () => {
        fs.writeFileSync(path.join(tmpDir, 'session1.jsonl'), '');
        fs.writeFileSync(path.join(tmpDir, 'session2.jsonl'), '');
        fs.writeFileSync(path.join(tmpDir, 'ignore.json'), '');
        const result = await countWorkspaceSessions(tmpDir, 'claude');
        assert.strictEqual(result, 2);
    });

    test('claude — returns 0 for empty dir', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'claude');
        assert.strictEqual(result, 0);
    });

    test('cline — counts subdirs that contain api_conversation_history.json', async () => {
        const t1 = path.join(tmpDir, 'task1');
        const t2 = path.join(tmpDir, 'task2');
        const t3 = path.join(tmpDir, 'task3');
        fs.mkdirSync(t1); fs.mkdirSync(t2); fs.mkdirSync(t3);
        fs.writeFileSync(path.join(t1, 'api_conversation_history.json'), '[]');
        fs.writeFileSync(path.join(t2, 'api_conversation_history.json'), '[]');
        // t3 has no conversation file → should not be counted
        const result = await countWorkspaceSessions(tmpDir, 'cline');
        assert.strictEqual(result, 2);
    });

    test('roocode — same counting logic as cline', async () => {
        const t1 = path.join(tmpDir, 'task1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'api_conversation_history.json'), '[]');
        const result = await countWorkspaceSessions(tmpDir, 'roocode');
        assert.strictEqual(result, 1);
    });

    test('cursor — returns 1 when state.vscdb exists', async () => {
        fs.writeFileSync(path.join(tmpDir, 'state.vscdb'), '');
        const result = await countWorkspaceSessions(tmpDir, 'cursor');
        assert.strictEqual(result, 1);
    });

    test('cursor — returns 0 when state.vscdb is missing', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'cursor');
        assert.strictEqual(result, 0);
    });

    test('windsurf — returns 1 when state.vscdb exists', async () => {
        fs.writeFileSync(path.join(tmpDir, 'state.vscdb'), '');
        const result = await countWorkspaceSessions(tmpDir, 'windsurf');
        assert.strictEqual(result, 1);
    });

    test('windsurf — returns 0 when state.vscdb is missing', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'windsurf');
        assert.strictEqual(result, 0);
    });

    test('aider — returns 1 when .aider.chat.history.md exists', async () => {
        fs.writeFileSync(path.join(tmpDir, '.aider.chat.history.md'), '');
        const result = await countWorkspaceSessions(tmpDir, 'aider');
        assert.strictEqual(result, 1);
    });

    test('aider — returns 0 when history file is missing', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'aider');
        assert.strictEqual(result, 0);
    });

    test('antigravity — always returns 0', async () => {
        const result = await countWorkspaceSessions(tmpDir, 'antigravity');
        assert.strictEqual(result, 0);
    });

    test('returns 0 when storageDir does not exist', async () => {
        const result = await countWorkspaceSessions('/nonexistent/path/xyz', 'copilot');
        assert.strictEqual(result, 0);
    });
});

// ------------------------------------------------------------------ //
// calcWorkspaceSizeBytes — sources not yet covered
// ------------------------------------------------------------------ //

suite('calcWorkspaceSizeBytes — additional sources', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bytes-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('cline — sums bytes in api_conversation_history.json files across task subdirs', async () => {
        const t1 = path.join(tmpDir, 'task1');
        const t2 = path.join(tmpDir, 'task2');
        fs.mkdirSync(t1); fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t1, 'api_conversation_history.json'), 'abc');       // 3 bytes
        fs.writeFileSync(path.join(t2, 'api_conversation_history.json'), 'defgh');     // 5 bytes
        const result = await calcWorkspaceSizeBytes(tmpDir, 'cline');
        assert.strictEqual(result, 8);
    });

    test('roocode — same logic as cline', async () => {
        const t1 = path.join(tmpDir, 'task1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'api_conversation_history.json'), 'hello');   // 5 bytes
        const result = await calcWorkspaceSizeBytes(tmpDir, 'roocode');
        assert.strictEqual(result, 5);
    });

    test('cursor — returns state.vscdb size when it exists', async () => {
        const content = Buffer.alloc(100);
        fs.writeFileSync(path.join(tmpDir, 'state.vscdb'), content);
        const result = await calcWorkspaceSizeBytes(tmpDir, 'cursor');
        assert.strictEqual(result, 100);
    });

    test('cursor — returns 0 when state.vscdb is missing', async () => {
        const result = await calcWorkspaceSizeBytes(tmpDir, 'cursor');
        assert.strictEqual(result, 0);
    });

    test('windsurf — returns state.vscdb size when it exists', async () => {
        const content = Buffer.alloc(50);
        fs.writeFileSync(path.join(tmpDir, 'state.vscdb'), content);
        const result = await calcWorkspaceSizeBytes(tmpDir, 'windsurf');
        assert.strictEqual(result, 50);
    });

    test('aider — returns history file size when it exists', async () => {
        const text = 'hello aider';
        fs.writeFileSync(path.join(tmpDir, '.aider.chat.history.md'), text);
        const result = await calcWorkspaceSizeBytes(tmpDir, 'aider');
        assert.strictEqual(result, Buffer.byteLength(text));
    });

    test('aider — returns 0 when history file is missing', async () => {
        const result = await calcWorkspaceSizeBytes(tmpDir, 'aider');
        assert.strictEqual(result, 0);
    });

    test('antigravity — always returns 0', async () => {
        const result = await calcWorkspaceSizeBytes(tmpDir, 'antigravity');
        assert.strictEqual(result, 0);
    });

    test('returns 0 when storageDir does not exist', async () => {
        const result = await calcWorkspaceSizeBytes('/nonexistent/xyz', 'cline');
        assert.strictEqual(result, 0);
    });
});
