// test/e2e/zedParser.test.ts
// Feature 41 — Zed AI Source Support

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseZedConversation } from '../../src/parsers/zed';
import { discoverZedConversationsAsync } from '../../src/readers/zedWorkspace';

const FIXTURE = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'zed', 'sample-conversation.json');

suite('Feature 41 — Zed Parser', () => {
    test('parses fixture file with correct message count', () => {
        const { session, errors } = parseZedConversation(FIXTURE);
        assert.ok(!errors.some(e => e.includes('Failed')), `unexpected errors: ${errors.join(', ')}`);
        // 4 messages total: 2 user + 2 assistant (no system messages)
        assert.strictEqual(session.messages.length, 4, 'should parse all 4 messages');
    });

    test('sets source to "zed"', () => {
        const { session } = parseZedConversation(FIXTURE);
        assert.strictEqual(session.source, 'zed', 'source should be "zed"');
    });

    test('uses explicit title from JSON', () => {
        const { session } = parseZedConversation(FIXTURE);
        assert.strictEqual(session.title, 'Implementing a binary search tree', 'title should match JSON title field');
    });

    test('uses session id from JSON', () => {
        const { session } = parseZedConversation(FIXTURE);
        assert.strictEqual(session.id, 'zed-conv-abc123', 'id should match JSON id field');
    });

    test('correctly identifies user and assistant messages', () => {
        const { session } = parseZedConversation(FIXTURE);
        const userMsgs = session.messages.filter(m => m.role === 'user');
        const asstMsgs = session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(userMsgs.length, 2, 'should have 2 user messages');
        assert.strictEqual(asstMsgs.length, 2, 'should have 2 assistant messages');
    });

    test('returns errors for malformed JSON', () => {
        const tmpFile = path.join(os.tmpdir(), `zed-malformed-${Date.now()}.json`);
        try {
            fs.writeFileSync(tmpFile, '{not valid json', 'utf8');
            const { errors } = parseZedConversation(tmpFile);
            assert.ok(errors.length > 0, 'should return errors for malformed JSON');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    test('returns errors for nonexistent file', () => {
        const { errors } = parseZedConversation('/nonexistent/path/conversation.json');
        assert.ok(errors.length > 0, 'should return errors for nonexistent file');
        assert.ok(errors[0].includes('Failed to read'), 'should mention read failure');
    });

    test('handles a session without explicit title (derives from first user message)', () => {
        const tmpFile = path.join(os.tmpdir(), `zed-no-title-${Date.now()}.json`);
        try {
            const noTitle = {
                id: 'notitle-001',
                messages: [
                    { id: 'm0', role: 'user', content: 'What is the answer to life?', timestamp: '2026-06-01T10:00:00Z' },
                    { id: 'm1', role: 'assistant', content: '42.', timestamp: '2026-06-01T10:00:30Z' },
                ],
            };
            fs.writeFileSync(tmpFile, JSON.stringify(noTitle), 'utf8');
            const { session } = parseZedConversation(tmpFile);
            assert.ok(session.title.includes('What is the answer'), 'title should be derived from first user message');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });
});

suite('Feature 41 — Zed Workspace Discovery', () => {
    test('discovers JSON files in a given directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-zed-discovery-'));
        try {
            // Create two JSON files and one non-JSON file
            fs.writeFileSync(path.join(tmpDir, 'conv1.json'), '{}', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'conv2.json'), '{}', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'text', 'utf8');

            const files = await discoverZedConversationsAsync(tmpDir);
            assert.strictEqual(files.length, 2, 'should discover 2 JSON files');
            assert.ok(files.every(f => f.endsWith('.json')), 'all discovered files should be JSON');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('returns empty array for non-existent directory', async () => {
        const files = await discoverZedConversationsAsync('/nonexistent/zed/dir');
        assert.strictEqual(files.length, 0, 'should return empty array for non-existent dir');
    });
});