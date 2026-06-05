// test/e2e/tabnineParser.test.ts
// Feature 42 — Tabnine Chat Source Support

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTabnineConversation } from '../../src/parsers/tabnine';
import { discoverTabnineConversationsAsync } from '../../src/readers/tabnineWorkspace';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tabnine', 'sample-chat.json');

suite('Feature 42 — Tabnine Parser', () => {
    test('parses fixture file with correct message count', () => {
        const { session, errors } = parseTabnineConversation(FIXTURE);
        assert.ok(!errors.some(e => e.includes('Failed')), `unexpected errors: ${errors.join(', ')}`);
        assert.strictEqual(session.messages.length, 4, 'should parse all 4 messages');
    });

    test('sets source to "tabnine"', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        assert.strictEqual(session.source, 'tabnine', 'source should be "tabnine"');
    });

    test('uses explicit title from JSON', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        assert.ok(session.title.includes('Async/await'), 'title should match JSON title field');
    });

    test('uses session id from JSON', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        assert.strictEqual(session.id, 'tabnine-chat-xyz789', 'id should match JSON id field');
    });

    test('maps "bot" type to assistant role', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        const asstMsgs = session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(asstMsgs.length, 2, 'should have 2 assistant (bot) messages');
    });

    test('maps "user" type to user role', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        const userMsgs = session.messages.filter(m => m.role === 'user');
        assert.strictEqual(userMsgs.length, 2, 'should have 2 user messages');
    });

    test('converts epoch ms timestamps to ISO strings', () => {
        const { session } = parseTabnineConversation(FIXTURE);
        const firstMsg = session.messages[0];
        assert.ok(firstMsg.timestamp !== undefined, 'timestamp should be set');
        assert.ok(firstMsg.timestamp!.includes('T'), 'timestamp should be ISO-8601 format');
    });

    test('handles "assistant" type as alternative to "bot"', () => {
        const tmpFile = path.join(os.tmpdir(), `tabnine-assistant-${Date.now()}.json`);
        try {
            const data = {
                id: 'alt-001',
                messages: [
                    { id: 'm0', type: 'user', text: 'Hello', timestamp: 1748764800000 },
                    { id: 'm1', type: 'assistant', text: 'Hi there!', timestamp: 1748764830000 },
                ],
            };
            fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
            const { session } = parseTabnineConversation(tmpFile);
            const asstMsgs = session.messages.filter(m => m.role === 'assistant');
            assert.strictEqual(asstMsgs.length, 1, '"assistant" type should map to assistant role');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    test('handles "role" field as alternative to "type" field', () => {
        const tmpFile = path.join(os.tmpdir(), `tabnine-role-${Date.now()}.json`);
        try {
            const data = {
                id: 'role-001',
                messages: [
                    { id: 'm0', role: 'user', text: 'Hello', timestamp: 1748764800000 },
                    { id: 'm1', role: 'bot', text: 'Hi!', timestamp: 1748764830000 },
                ],
            };
            fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
            const { session } = parseTabnineConversation(tmpFile);
            assert.strictEqual(session.messages.length, 2, 'should parse messages with "role" field');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    test('returns errors for malformed JSON', () => {
        const tmpFile = path.join(os.tmpdir(), `tabnine-malformed-${Date.now()}.json`);
        try {
            fs.writeFileSync(tmpFile, '{not valid json', 'utf8');
            const { errors } = parseTabnineConversation(tmpFile);
            assert.ok(errors.length > 0, 'should return errors for malformed JSON');
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    test('returns errors for nonexistent file', () => {
        const { errors } = parseTabnineConversation('/nonexistent/path/chat.json');
        assert.ok(errors.length > 0, 'should return errors for nonexistent file');
        assert.ok(errors[0].includes('Failed to read'), 'should mention read failure');
    });
});

suite('Feature 42 — Tabnine Workspace Discovery', () => {
    test('discovers JSON files in a given directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tabnine-disc-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'chat1.json'), '{}', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'chat2.json'), '{}', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'text', 'utf8');

            const files = await discoverTabnineConversationsAsync(tmpDir);
            assert.strictEqual(files.length, 2, 'should discover 2 JSON files');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('returns empty array for non-existent directory', async () => {
        const files = await discoverTabnineConversationsAsync('/nonexistent/tabnine/dir');
        assert.strictEqual(files.length, 0, 'should return empty array for non-existent dir');
    });
});