import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getClineStorageRoot, discoverClineTasksAsync } from '../../src/readers/clineWorkspace';
import { removeTempDir } from '../helpers/fsCleanup';

suite('clineWorkspaceDiscovery', () => {

    // ------------------------------------------------------------------ //
    // getClineStorageRoot
    // ------------------------------------------------------------------ //

    test('getClineStorageRoot returns a non-empty string on current OS', () => {
        const root = getClineStorageRoot();
        assert.strictEqual(typeof root, 'string');
        assert.ok(root.length > 0);
    });

    test('getClineStorageRoot path contains saoudrizwan.claude-dev/tasks', () => {
        const root = getClineStorageRoot();
        const normalized = root.replace(/\\/g, '/');
        assert.ok(
            normalized.includes('saoudrizwan.claude-dev/tasks'),
            `Expected path to contain 'saoudrizwan.claude-dev/tasks', got: ${root}`
        );
    });

    // ------------------------------------------------------------------ //
    // discoverClineTasksAsync
    // ------------------------------------------------------------------ //

    test('empty directory → returns empty array', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            const result = await discoverClineTasksAsync(tmpDir);
            assert.deepStrictEqual(result, []);
        } finally {
            removeTempDir(tmpDir);
        }
    });

    test('valid task dir with both JSON files → returned in result', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            const taskDir = path.join(tmpDir, 'task-abc-123');
            fs.mkdirSync(taskDir);
            fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), '[]');
            fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), '[]');

            const result = await discoverClineTasksAsync(tmpDir);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].taskId, 'task-abc-123');
            assert.strictEqual(result[0].storageDir, taskDir);
            assert.ok(result[0].conversationFile.endsWith('api_conversation_history.json'));
        } finally {
            removeTempDir(tmpDir);
        }
    });

    test('dir missing api_conversation_history.json is excluded', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            const taskDir = path.join(tmpDir, 'task-no-conv');
            fs.mkdirSync(taskDir);
            fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), '[]');
            // No api_conversation_history.json

            const result = await discoverClineTasksAsync(tmpDir);
            assert.strictEqual(result.length, 0);
        } finally {
            removeTempDir(tmpDir);
        }
    });

    test('file-not-directory entries are excluded', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            // Place a file at the root level (not a directory)
            fs.writeFileSync(path.join(tmpDir, 'random-file.json'), '{}');

            const result = await discoverClineTasksAsync(tmpDir);
            assert.strictEqual(result.length, 0);
        } finally {
            removeTempDir(tmpDir);
        }
    });

    test('multiple valid task dirs are all returned', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            for (const name of ['task-1', 'task-2', 'task-3']) {
                const taskDir = path.join(tmpDir, name);
                fs.mkdirSync(taskDir);
                fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), '[]');
            }

            const result = await discoverClineTasksAsync(tmpDir);
            assert.strictEqual(result.length, 3);
            const ids = result.map(r => r.taskId).sort();
            assert.deepStrictEqual(ids, ['task-1', 'task-2', 'task-3']);
        } finally {
            removeTempDir(tmpDir);
        }
    });

    test('non-existent root directory → returns empty array (no throw)', async () => {
        const result = await discoverClineTasksAsync('/nonexistent/path/cline-tasks-99999');
        assert.deepStrictEqual(result, []);
    });

    test('mix of valid and invalid entries → only valid tasks returned', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-disc-'));
        try {
            // Valid
            const validDir = path.join(tmpDir, 'valid-task');
            fs.mkdirSync(validDir);
            fs.writeFileSync(path.join(validDir, 'api_conversation_history.json'), '[]');

            // Missing conversation file
            const noConvDir = path.join(tmpDir, 'no-conv-task');
            fs.mkdirSync(noConvDir);
            fs.writeFileSync(path.join(noConvDir, 'ui_messages.json'), '[]');

            // Loose file (not a directory)
            fs.writeFileSync(path.join(tmpDir, 'loose-file.txt'), 'hello');

            const result = await discoverClineTasksAsync(tmpDir);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].taskId, 'valid-task');
        } finally {
            removeTempDir(tmpDir);
        }
    });
});
