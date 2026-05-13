// test/suite/workspaceScope.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScopeManager, calcWorkspaceSizeMb, ExtensionContextLike } from '../../src/watcher/workspaceScope';
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

    test('initDefault() always overwrites previously stored IDs', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['ws-original']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-original', '/projects/foo'),
            makeWorkspace('ws-new', '/projects/bar'),
        ];
        await mgr.initDefault(available);
        // Always re-detects from open workspace; no workspace in test host → empty
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
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

    test('initDefault() does not preserve stale IDs across calls', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['ws-old', 'ws-keep']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-keep', '/projects/keep'),
            makeWorkspace('ws-new', '/projects/new'),
        ];
        await mgr.initDefault(available);
        // Always re-detects; no workspace open in test host → empty
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
    });

    test('initDefault() sets empty scope when previously stored IDs are all stale', async () => {
        const { context, store } = makeContext();
        store.set('chatwizard.selectedWorkspaceIds', ['stale-1', 'stale-2']);
        const mgr = new WorkspaceScopeManager(context);
        const available = [
            makeWorkspace('ws-a', '/projects/a'),
            makeWorkspace('ws-b', '/projects/b'),
        ];
        await mgr.initDefault(available);
        // Always re-detects from open workspace; no workspace open in test host → empty
        assert.deepStrictEqual(mgr.getSelectedIds(), []);
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

    teardown(async () => {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
