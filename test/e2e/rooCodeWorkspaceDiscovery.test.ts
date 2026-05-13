import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRooCodeStorageRoot, discoverRooCodeTasksAsync } from '../../src/readers/clineWorkspace';
import { parseClineTask } from '../../src/parsers/cline';

suite('rooCodeWorkspaceDiscovery', () => {

    // ------------------------------------------------------------------ //
    // getRooCodeStorageRoot
    // ------------------------------------------------------------------ //

    test('getRooCodeStorageRoot returns a non-empty string on current OS', () => {
        const root = getRooCodeStorageRoot();
        assert.strictEqual(typeof root, 'string');
        assert.ok(root.length > 0);
    });

    test('getRooCodeStorageRoot path contains rooveterinaryinc.roo-cline/tasks', () => {
        const root = getRooCodeStorageRoot();
        const normalized = root.replace(/\\/g, '/');
        assert.ok(
            normalized.includes('rooveterinaryinc.roo-cline/tasks'),
            `Expected path to contain 'rooveterinaryinc.roo-cline/tasks', got: ${root}`
        );
    });

    // ------------------------------------------------------------------ //
    // discoverRooCodeTasksAsync
    // ------------------------------------------------------------------ //

    test('empty directory → returns empty array', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-disc-'));
        try {
            const result = await discoverRooCodeTasksAsync(tmpDir);
            assert.deepStrictEqual(result, []);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('valid task dir with both JSON files → returned in result', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-disc-'));
        try {
            const taskDir = path.join(tmpDir, 'task-roo-123');
            fs.mkdirSync(taskDir);
            fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), '[]');
            fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), '[]');

            const result = await discoverRooCodeTasksAsync(tmpDir);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].taskId, 'task-roo-123');
            assert.strictEqual(result[0].storageDir, taskDir);
            assert.ok(result[0].conversationFile.endsWith('api_conversation_history.json'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('dir missing api_conversation_history.json is excluded', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-disc-'));
        try {
            const taskDir = path.join(tmpDir, 'task-no-conv');
            fs.mkdirSync(taskDir);
            fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), '[]');

            const result = await discoverRooCodeTasksAsync(tmpDir);
            assert.strictEqual(result.length, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('file-not-directory entries are excluded', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-disc-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'random-file.json'), '{}');

            const result = await discoverRooCodeTasksAsync(tmpDir);
            assert.strictEqual(result.length, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('multiple valid task dirs are all returned', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-disc-'));
        try {
            for (const name of ['task-1', 'task-2', 'task-3']) {
                const taskDir = path.join(tmpDir, name);
                fs.mkdirSync(taskDir);
                fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), '[]');
            }

            const result = await discoverRooCodeTasksAsync(tmpDir);
            assert.strictEqual(result.length, 3);
            const ids = result.map(r => r.taskId).sort();
            assert.deepStrictEqual(ids, ['task-1', 'task-2', 'task-3']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('non-existent root directory → returns empty array (no throw)', async () => {
        const result = await discoverRooCodeTasksAsync('/nonexistent/path/roocode-tasks-99999');
        assert.deepStrictEqual(result, []);
    });

    // ------------------------------------------------------------------ //
    // Parser reuse: parseClineTask with source='roocode'
    // ------------------------------------------------------------------ //

    test('parseClineTask on Roo Code fixture produces source === roocode', async () => {
        const fixtureDir = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'roocode', 'sample-task');
        const result = await parseClineTask(fixtureDir, undefined, 'roocode');
        assert.strictEqual(result.session.source, 'roocode');
    });

    test('parseClineTask on Roo Code fixture extracts correct messages', async () => {
        const fixtureDir = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'roocode', 'sample-task');
        const result = await parseClineTask(fixtureDir, undefined, 'roocode');
        // 3 entries: user, assistant (with text+tool_use — tool_use excluded), user
        // assistant content has text so it is included; 3 messages total
        assert.strictEqual(result.session.messages.length, 3);
        assert.strictEqual(result.session.messages[0].role, 'user');
        assert.strictEqual(result.session.messages[1].role, 'assistant');
        assert.strictEqual(result.session.messages[2].role, 'user');
    });

    test('parseClineTask on Roo Code fixture extracts code blocks', async () => {
        const fixtureDir = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'roocode', 'sample-task');
        const result = await parseClineTask(fixtureDir, undefined, 'roocode');
        const assistantMsg = result.session.messages.find(m => m.role === 'assistant');
        assert.ok(assistantMsg, 'Expected an assistant message');
        assert.ok(assistantMsg.codeBlocks.length > 0, 'Expected at least one code block');
        assert.strictEqual(assistantMsg.codeBlocks[0].language, 'typescript');
    });

    test('parseClineTask with default source produces source === cline', async () => {
        const fixtureDir = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'roocode', 'sample-task');
        const result = await parseClineTask(fixtureDir);
        assert.strictEqual(result.session.source, 'cline');
    });
});
