import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseClineTask, extractClineCodeBlocks } from '../../src/parsers/cline';

const FIXTURES = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'cline');

suite('clineParser', () => {

    // ------------------------------------------------------------------ //
    // parseClineTask — happy path
    // ------------------------------------------------------------------ //

    test('happy path: correct source, messages, roles, title', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(result.session.source, 'cline');
        assert.strictEqual(result.session.messages.length, 3);
        assert.strictEqual(result.session.messages[0].role, 'user');
        assert.strictEqual(result.session.messages[1].role, 'assistant');
        assert.strictEqual(result.session.messages[2].role, 'user');
    });

    test('happy path: title derived from first user message (≤120 chars)', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(
            result.session.title,
            'Help me refactor this function to be more readable'
        );
    });

    test('happy path: createdAt and updatedAt populated from ui_messages.json', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(result.session.createdAt, new Date(1700000000000).toISOString());
        assert.strictEqual(result.session.updatedAt, new Date(1700000120000).toISOString());
    });

    test('happy path: workspacePath read from ui_messages.json cwd', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(result.session.workspacePath, '/home/user/projects/my-app');
    });

    test('happy path: model read from ui_messages.json', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(result.session.model, 'claude-sonnet-4-5');
    });

    test('happy path: code block extracted from assistant message', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        const assistantMsg = result.session.messages[1];
        assert.ok(assistantMsg.codeBlocks.length > 0, 'Expected at least one code block');
        assert.strictEqual(assistantMsg.codeBlocks[0].language, 'typescript');
        assert.ok(assistantMsg.codeBlocks[0].content.includes('greet'));
    });

    test('happy path: session id equals task directory name', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        assert.strictEqual(result.session.id, 'sample-task');
        assert.strictEqual(result.session.workspaceId, 'sample-task');
    });

    // ------------------------------------------------------------------ //
    // parseClineTask — mixed content parts
    // ------------------------------------------------------------------ //

    test('mixed content parts: only type=text parts included; tool_use excluded', async () => {
        const taskDir = path.join(FIXTURES, 'sample-task');
        const result = await parseClineTask(taskDir);

        // The assistant message has text + tool_use; only the text portion appears.
        const assistantMsg = result.session.messages[1];
        assert.ok(assistantMsg.content.includes('cleaner version'), 'Expected text content');
        assert.ok(!assistantMsg.content.includes('read_file'), 'tool_use content should be excluded');
    });

    test('empty turns (tool-only entries) are excluded from messages', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));
        try {
            const conv = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'run', input: {} }] },
                { role: 'user', content: 'Still there?' },
            ];
            fs.writeFileSync(
                path.join(tmpDir, 'api_conversation_history.json'),
                JSON.stringify(conv)
            );
            const result = await parseClineTask(tmpDir);
            // The tool-only assistant turn has no text content → excluded.
            assert.strictEqual(result.session.messages.length, 2);
            assert.strictEqual(result.session.messages[0].role, 'user');
            assert.strictEqual(result.session.messages[1].role, 'user');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ------------------------------------------------------------------ //
    // parseClineTask — error cases
    // ------------------------------------------------------------------ //

    test('missing api_conversation_history.json → errors.length > 0, messages.length === 0', async () => {
        const taskDir = path.join(FIXTURES, 'missing-conversation');
        const result = await parseClineTask(taskDir);

        assert.ok(result.errors.length > 0, 'Expected parse errors');
        assert.strictEqual(result.session.messages.length, 0);
    });

    test('malformed JSON → errors.length > 0, messages.length === 0', async () => {
        const taskDir = path.join(FIXTURES, 'malformed');
        const result = await parseClineTask(taskDir);

        assert.ok(result.errors.length > 0, 'Expected parse errors');
        assert.strictEqual(result.session.messages.length, 0);
    });

    test('non-existent directory → errors.length > 0', async () => {
        const result = await parseClineTask('/nonexistent/path/does-not-exist-12345');
        assert.ok(result.errors.length > 0, 'Expected parse errors for missing directory');
    });

    test('non-array root value → errors.length > 0', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));
        try {
            fs.writeFileSync(
                path.join(tmpDir, 'api_conversation_history.json'),
                JSON.stringify({ notAnArray: true })
            );
            const result = await parseClineTask(tmpDir);
            assert.ok(result.errors.length > 0, 'Expected error for non-array root');
            assert.strictEqual(result.session.messages.length, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ------------------------------------------------------------------ //
    // parseClineTask — fallback behaviour
    // ------------------------------------------------------------------ //

    test('missing ui_messages.json → no errors, timestamps from file mtime', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));
        try {
            const conv = [{ role: 'user', content: 'Test without ui_messages' }];
            fs.writeFileSync(
                path.join(tmpDir, 'api_conversation_history.json'),
                JSON.stringify(conv)
            );
            const result = await parseClineTask(tmpDir);
            assert.ok(result.errors.length === 0, 'Should have no errors when ui_messages.json is absent');
            assert.ok(result.session.messages.length === 1);
            // Timestamps should fall back to file mtime (not epoch).
            assert.ok(
                result.session.createdAt !== new Date(0).toISOString(),
                'createdAt should not be epoch when mtime fallback is used'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('long first user message → title truncated to 120 chars + ellipsis', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));
        try {
            const longText = 'A'.repeat(200);
            const conv = [{ role: 'user', content: longText }];
            fs.writeFileSync(
                path.join(tmpDir, 'api_conversation_history.json'),
                JSON.stringify(conv)
            );
            const result = await parseClineTask(tmpDir);
            assert.ok(result.session.title.endsWith('…'), 'Title should end with ellipsis');
            assert.ok(result.session.title.length <= 124, 'Title should be ≤120 chars + ellipsis');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ------------------------------------------------------------------ //
    // extractClineCodeBlocks
    // ------------------------------------------------------------------ //

    test('extractClineCodeBlocks: detects language and propagates sessionId/messageIndex', () => {
        const content = '```python\nprint("hello")\n```';
        const blocks = extractClineCodeBlocks(content, 'session-1', 3);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, 'python');
        assert.strictEqual(blocks[0].sessionId, 'session-1');
        assert.strictEqual(blocks[0].messageIndex, 3);
        assert.ok(blocks[0].content.includes('print'));
    });

    test('extractClineCodeBlocks: no language label gives empty string', () => {
        const content = '```\nraw content\n```';
        const blocks = extractClineCodeBlocks(content, 's', 0);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, '');
    });

    test('extractClineCodeBlocks: multiple blocks get distinct blockIndexInMessage', () => {
        const content = '```ts\nfoo()\n```\n\n```js\nbar()\n```';
        const blocks = extractClineCodeBlocks(content, 's', 0);

        assert.strictEqual(blocks.length, 2);
        assert.strictEqual(blocks[0].blockIndexInMessage, 0);
        assert.strictEqual(blocks[1].blockIndexInMessage, 1);
    });

    test('extractClineCodeBlocks: no fences → empty array', () => {
        const blocks = extractClineCodeBlocks('plain text, no fences', 's', 0);
        assert.strictEqual(blocks.length, 0);
    });
});
