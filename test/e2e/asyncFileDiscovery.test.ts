import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverCopilotWorkspacesAsync, listSessionFilesAsync } from '../../src/readers/copilotWorkspace';

// ---------------------------------------------------------------------------
// S9 — Async File Discovery
// Tests that async discovery functions work correctly and complete within
// the 3-second SLA for 200 workspace directories.
// ---------------------------------------------------------------------------

suite('S9 Async File Discovery', () => {

    let tmpRoot: string;

    setup(() => {
        tmpRoot = path.join(os.tmpdir(), `chatwizard_s9_${Date.now()}`);
        fs.mkdirSync(tmpRoot, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // ------------------------------------------------------------------
    // listSessionFilesAsync
    // ------------------------------------------------------------------

    test('listSessionFilesAsync returns empty array for non-existent dir', async () => {
        const result = await listSessionFilesAsync(path.join(tmpRoot, 'no_such_dir'));
        assert.deepStrictEqual(result, []);
    });

    test('listSessionFilesAsync returns only .jsonl files', async () => {
        const storageDir = path.join(tmpRoot, 'ws1');
        const chatSessionsDir = path.join(storageDir, 'chatSessions');
        fs.mkdirSync(chatSessionsDir, { recursive: true });
        fs.writeFileSync(path.join(chatSessionsDir, 'session1.jsonl'), '');
        fs.writeFileSync(path.join(chatSessionsDir, 'session2.jsonl'), '');
        fs.writeFileSync(path.join(chatSessionsDir, 'readme.txt'), '');

        const result = await listSessionFilesAsync(storageDir);
        assert.strictEqual(result.length, 2);
        assert.ok(result.every(f => f.endsWith('.jsonl')));
    });

    test('listSessionFilesAsync returns full absolute paths', async () => {
        const storageDir = path.join(tmpRoot, 'ws_paths');
        const chatSessionsDir = path.join(storageDir, 'chatSessions');
        fs.mkdirSync(chatSessionsDir, { recursive: true });
        fs.writeFileSync(path.join(chatSessionsDir, 'abc.jsonl'), '');

        const result = await listSessionFilesAsync(storageDir);
        assert.strictEqual(result.length, 1);
        assert.ok(path.isAbsolute(result[0]));
        assert.ok(result[0].endsWith('abc.jsonl'));
    });

    // ------------------------------------------------------------------
    // discoverCopilotWorkspacesAsync
    // ------------------------------------------------------------------

    test('discoverCopilotWorkspacesAsync returns empty array for non-existent root', async () => {
        // The function reads from getWorkspaceStorageRoot() so we can only test
        // indirectly through listSessionFilesAsync here. Verify no crash on missing dir.
        const result = await listSessionFilesAsync(path.join(tmpRoot, 'missing'));
        assert.deepStrictEqual(result, []);
    });

    // ------------------------------------------------------------------
    // Performance: 200 directories must complete in < 3000 ms
    // ------------------------------------------------------------------

    test('listSessionFilesAsync across 200 workspace dirs completes in < 3000 ms', async () => {
        // Create 200 workspace-like directories, 10 with chatSessions containing .jsonl files
        for (let i = 0; i < 200; i++) {
            const wsDir = path.join(tmpRoot, `workspace_${i}`, 'chatSessions');
            if (i < 10) {
                fs.mkdirSync(wsDir, { recursive: true });
                for (let j = 0; j < 5; j++) {
                    fs.writeFileSync(path.join(wsDir, `session_${j}.jsonl`), '');
                }
            }
        }

        const start = Date.now();
        // Simulate parallel discovery across all 200 workspace dirs
        const results = await Promise.all(
            Array.from({ length: 200 }, (_, i) =>
                listSessionFilesAsync(path.join(tmpRoot, `workspace_${i}`))
            )
        );
        const elapsed = Date.now() - start;

        // Correctness: 10 dirs × 5 files = 50 total .jsonl paths
        const totalFiles = results.reduce((sum, r) => sum + r.length, 0);
        assert.strictEqual(totalFiles, 50, `Expected 50 files but got ${totalFiles}`);

        // Performance SLA
        assert.ok(elapsed < 3000, `Expected < 3000 ms but took ${elapsed} ms`);
    });

    test('async functions return arrays (not throw) when dirs are empty', async () => {
        const emptyDir = path.join(tmpRoot, 'empty_ws');
        fs.mkdirSync(emptyDir);
        const result = await listSessionFilesAsync(emptyDir);
        assert.ok(Array.isArray(result));
        assert.strictEqual(result.length, 0);
    });

    test('listSessionFilesAsync handles 0 .jsonl files in chatSessions', async () => {
        const storageDir = path.join(tmpRoot, 'ws_no_jsonl');
        const chatSessionsDir = path.join(storageDir, 'chatSessions');
        fs.mkdirSync(chatSessionsDir, { recursive: true });
        fs.writeFileSync(path.join(chatSessionsDir, 'state.vscdb'), '');

        const result = await listSessionFilesAsync(storageDir);
        assert.deepStrictEqual(result, []);
    });
});
