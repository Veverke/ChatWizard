// test/suite/antigravityParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseAntigravityConversation, parseAntigravityJsonConversation } from '../../src/parsers/antigravity';
import { AntigravityConversationInfo } from '../../src/types/index';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'antigravity');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInfo(conversationId: string, brainRoot: string): AntigravityConversationInfo {
    return {
        conversationId,
        overviewFile: path.join(brainRoot, conversationId, '.system_generated', 'logs', 'overview.txt'),
    };
}

function writeOverview(dir: string, lines: object[]): string {
    const logDir = path.join(dir, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, 'overview.txt');
    fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Antigravity Parser', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-antigravity-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Happy path (fixture file) ─────────────────────────────────────────────

    test('happy path: source is antigravity', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.session.source, 'antigravity');
    });

    test('happy path: correct number of messages (2 user + 2 assistant)', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        const userMsgs = result.session.messages.filter(m => m.role === 'user');
        const asstMsgs = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(userMsgs.length, 2, 'expected 2 user messages');
        assert.strictEqual(asstMsgs.length, 2, 'expected 2 assistant messages');
    });

    test('happy path: first user message strips USER_REQUEST wrapper', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        const firstUser = result.session.messages.find(m => m.role === 'user');
        assert.ok(firstUser, 'expected at least one user message');
        assert.strictEqual(firstUser.content, 'Help me refactor this TypeScript function to be more readable');
    });

    test('happy path: title derived from first user message', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.session.title, 'Help me refactor this TypeScript function to be more readable');
    });

    test('happy path: createdAt parsed from first step timestamp', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.session.createdAt, new Date('2026-01-15T10:00:00Z').toISOString());
    });

    test('happy path: updatedAt reflects last step timestamp', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.session.updatedAt, new Date('2026-01-15T10:01:05Z').toISOString());
    });

    test('happy path: session id equals conversationId', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.session.id, 'a1b2c3d4-0000-0000-0000-000000000001');
    });

    test('happy path: code block extracted from assistant message', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        const asstMsgs = result.session.messages.filter(m => m.role === 'assistant');
        const allBlocks = asstMsgs.flatMap(m => m.codeBlocks);
        assert.ok(allBlocks.length >= 1, 'expected at least one code block');
        assert.strictEqual(allBlocks[0].language, 'typescript');
    });

    test('happy path: no parse errors', () => {
        const info = makeInfo('a1b2c3d4-0000-0000-0000-000000000001', path.join(FIXTURES_DIR, 'brain'));
        const result = parseAntigravityConversation(info);

        assert.strictEqual(result.errors.length, 0);
    });

    // ── Tool-only MODEL steps are skipped ─────────────────────────────────────

    test('tool-only MODEL steps produce no assistant messages', () => {
        const convDir = path.join(tmpDir, 'tool-only-conv');
        writeOverview(convDir, [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-01T08:00:00Z', content: '<USER_REQUEST>\nWhat files are in my project?\n</USER_REQUEST>' },
            { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-02-01T08:00:01Z', tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '"c:\\\\Repos"' } }] },
            { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-02-01T08:00:02Z', tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '"c:\\\\Repos\\\\src"' } }] },
        ]);

        const result = parseAntigravityConversation({ conversationId: 'tool-only-conv', overviewFile: path.join(convDir, '.system_generated', 'logs', 'overview.txt') });

        const asstMsgs = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(asstMsgs.length, 0, 'tool-only steps should produce no assistant messages');
        assert.strictEqual(result.session.messages.filter(m => m.role === 'user').length, 1);
    });

    // ── Mixed content+tool_calls MODEL steps are included ────────────────────

    test('MODEL step with both content and tool_calls produces an assistant message', () => {
        const convDir = path.join(tmpDir, 'mixed-conv');
        writeOverview(convDir, [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-01T09:00:00Z', content: '<USER_REQUEST>\nExplain this\n</USER_REQUEST>' },
            { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-02-01T09:00:05Z', content: 'Let me look at the code first.', tool_calls: [{ name: 'view_file', args: {} }] },
        ]);

        const result = parseAntigravityConversation({ conversationId: 'mixed-conv', overviewFile: path.join(convDir, '.system_generated', 'logs', 'overview.txt') });

        const asstMsgs = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(asstMsgs.length, 1);
        assert.strictEqual(asstMsgs[0].content, 'Let me look at the code first.');
    });

    // ── Error handling ────────────────────────────────────────────────────────

    test('missing file returns empty session with error', () => {
        const result = parseAntigravityConversation({
            conversationId: 'missing-uuid',
            overviewFile: path.join(tmpDir, 'does-not-exist', 'overview.txt'),
        });

        assert.ok(result.errors.length > 0, 'expected at least one error for missing file');
        assert.ok(
            result.errors[0].toLowerCase().includes('does-not-exist') ||
            result.errors[0].toLowerCase().includes('no such file') ||
            result.errors[0].toLowerCase().includes('not found') ||
            result.errors[0].toLowerCase().includes('enoent'),
            `error message should reference the missing file, got: "${result.errors[0]}"`,
        );
        assert.strictEqual(result.session.messages.length, 0);
        assert.strictEqual(result.session.id, 'missing-uuid');
    });

    test('invalid JSON lines are skipped with error recorded', () => {
        const convDir = path.join(tmpDir, 'bad-json-conv');
        const logDir = path.join(convDir, '.system_generated', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const filePath = path.join(logDir, 'overview.txt');
        fs.writeFileSync(filePath, [
            JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-01T10:00:00Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' }),
            'THIS IS NOT JSON',
            JSON.stringify({ step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-02-01T10:00:05Z', content: 'Hello there!' }),
        ].join('\n'), 'utf-8');

        const result = parseAntigravityConversation({ conversationId: 'bad-json-conv', overviewFile: filePath });

        assert.strictEqual(result.errors.length, 1, 'expected one error for invalid JSON line');
        assert.strictEqual(result.session.messages.filter(m => m.role === 'user').length, 1);
        assert.strictEqual(result.session.messages.filter(m => m.role === 'assistant').length, 1);
    });

    test('USER_INPUT without USER_REQUEST wrapper falls back to raw content', () => {
        const convDir = path.join(tmpDir, 'no-wrapper-conv');
        writeOverview(convDir, [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-03-01T12:00:00Z', content: 'Direct message without wrapper' },
        ]);

        const result = parseAntigravityConversation({ conversationId: 'no-wrapper-conv', overviewFile: path.join(convDir, '.system_generated', 'logs', 'overview.txt') });

        const firstUser = result.session.messages.find(m => m.role === 'user');
        assert.ok(firstUser);
        assert.strictEqual(firstUser.content, 'Direct message without wrapper');
    });

    test('title truncated to 120 characters', () => {
        const longMsg = 'A'.repeat(200);
        const convDir = path.join(tmpDir, 'long-title-conv');
        writeOverview(convDir, [
            { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-03-01T12:00:00Z', content: `<USER_REQUEST>\n${longMsg}\n</USER_REQUEST>` },
        ]);

        const result = parseAntigravityConversation({ conversationId: 'long-title-conv', overviewFile: path.join(convDir, '.system_generated', 'logs', 'overview.txt') });

        assert.ok(result.session.title.length <= 120);
    });
});

// ---------------------------------------------------------------------------
// parseAntigravityJsonConversation
// ---------------------------------------------------------------------------

suite('parseAntigravityJsonConversation', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ag-json-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeConv(name: string, data: object): { conversationId: string; jsonFile: string } {
        const jsonFile = path.join(tmpDir, `${name}.json`);
        fs.writeFileSync(jsonFile, JSON.stringify(data), 'utf-8');
        return { conversationId: name, jsonFile };
    }

    test('happy path: source is antigravity', () => {
        const info = writeConv('conv1', {
            conversationId: 'conv1',
            messages: [
                { role: 'user', parts: [{ text: 'hello' }] },
                { role: 'model', parts: [{ text: 'world' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.source, 'antigravity');
    });

    test('happy path: role model maps to assistant', () => {
        const info = writeConv('conv2', {
            messages: [
                { role: 'user', parts: [{ text: 'question' }] },
                { role: 'model', parts: [{ text: 'answer' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages.length, 2);
        assert.strictEqual(session.messages[1].role, 'assistant');
    });

    test('happy path: title derived from first user message', () => {
        const info = writeConv('conv3', {
            messages: [
                { role: 'user', parts: [{ text: 'What is TypeScript?' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.title, 'What is TypeScript?');
    });

    test('no user message: title falls back to conversationId', () => {
        const info = writeConv('conv4', {
            messages: [
                { role: 'model', parts: [{ text: 'some response' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.title, 'conv4');
    });

    test('messages with empty text parts are skipped', () => {
        const info = writeConv('conv5', {
            messages: [
                { role: 'user', parts: [{ text: '' }] },
                { role: 'user', parts: [{ text: 'real message' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.messages[0].content, 'real message');
    });

    test('messages with unknown roles are skipped', () => {
        const info = writeConv('conv6', {
            messages: [
                { role: 'user', parts: [{ text: 'hello' }] },
                { role: 'system', parts: [{ text: 'system message' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages.length, 1);
    });

    test('createdAt uses parsed.createTime when valid', () => {
        const info = writeConv('conv7', {
            createTime: '2024-06-15T10:00:00Z',
            messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.ok(session.createdAt.startsWith('2024-06-15'), `createdAt: ${session.createdAt}`);
    });

    test('updatedAt uses parsed.updateTime when valid', () => {
        const info = writeConv('conv8', {
            updateTime: '2024-07-20T15:00:00Z',
            messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.ok(session.updatedAt.startsWith('2024-07-20'), `updatedAt: ${session.updatedAt}`);
    });

    test('missing file returns empty session with error', () => {
        const info = { conversationId: 'missing', jsonFile: path.join(tmpDir, 'nonexistent.json') };
        const { session, errors } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages.length, 0);
        assert.ok(errors.length > 0, 'Expected at least one error');
    });

    test('invalid JSON returns empty session with error', () => {
        const jsonFile = path.join(tmpDir, 'bad.json');
        fs.writeFileSync(jsonFile, '{ not valid json }', 'utf-8');
        const { session, errors } = parseAntigravityJsonConversation({ conversationId: 'bad', jsonFile });
        assert.strictEqual(session.messages.length, 0);
        assert.ok(errors.length > 0, 'Expected a parse error');
        assert.ok(errors[0].includes('parse JSON'), `Error should mention JSON parse: ${errors[0]}`);
    });

    test('null or missing messages field returns zero messages', () => {
        const info = writeConv('conv9', { conversationId: 'conv9' });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages.length, 0);
    });

    test('subSource is conversations', () => {
        const info = writeConv('conv10', {
            messages: [{ role: 'user', parts: [{ text: 'hello' }] }],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.subSource, 'conversations');
    });

    test('no errors when file is valid', () => {
        const info = writeConv('conv11', {
            messages: [{ role: 'user', parts: [{ text: 'hello' }] }],
        });
        const { errors } = parseAntigravityJsonConversation(info);
        assert.deepStrictEqual(errors, []);
    });

    test('message timestamp from createTime is preserved', () => {
        const info = writeConv('conv12', {
            messages: [
                { role: 'user', parts: [{ text: 'hello' }], createTime: '2024-01-01T00:00:00Z' },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.messages[0].timestamp, '2024-01-01T00:00:00Z');
    });

    test('createdAt falls back to first message timestamp when no conversation createTime', () => {
        const info = writeConv('conv13', {
            messages: [
                { role: 'user', parts: [{ text: 'hello' }], createTime: '2024-03-15T08:00:00Z' },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.ok(session.createdAt.startsWith('2024-03-15'), `createdAt: ${session.createdAt}`);
    });
});

// ---------------------------------------------------------------------------
// antigravity.ts — additional branch coverage
// ---------------------------------------------------------------------------

suite('Antigravity Parser — branch coverage', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ag-branch-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeOverviewLines(convId: string, lines: object[]): string {
        const logDir = path.join(tmpDir, convId, '.system_generated', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const fp = path.join(logDir, 'overview.txt');
        fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
        return fp;
    }

    function writeConv2(convId: string, data: object): { conversationId: string; jsonFile: string } {
        const jsonFile = path.join(tmpDir, `${convId}.json`);
        fs.writeFileSync(jsonFile, JSON.stringify(data), 'utf-8');
        return { conversationId: convId, jsonFile };
    }

    test('duplicate consecutive user message is skipped', () => {
        // Two USER_INPUT steps with the same content → second is a skip
        const convId = 'dup-user';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:01Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
        ]);
        const { session } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        // Only 1 user message (second is duplicate, skipped)
        assert.strictEqual(session.messages.filter(m => m.role === 'user').length, 1);
    });

    test('USER_INPUT with empty extracted text is skipped', () => {
        const convId = 'empty-user';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\n\n</USER_REQUEST>' },
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:01Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
        ]);
        const { session } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        assert.strictEqual(session.messages.filter(m => m.role === 'user').length, 1);
    });

    test('invalid sessionCreatedAt date falls back to epoch with error', () => {
        const convId = 'bad-date';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: 'not-a-date', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
        ]);
        const { session, errors } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        assert.ok(session.messages.length >= 1);
        // Invalid date should cause an error about sessionCreatedAt
        assert.ok(errors.some(e => e.includes('sessionCreatedAt')), `Expected sessionCreatedAt error, got: ${JSON.stringify(errors)}`);
        assert.strictEqual(session.createdAt, new Date(0).toISOString());
    });

    test('invalid sessionUpdatedAt date falls back to createdAt with error', () => {
        const convId = 'bad-updated';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: 'INVALID_DATE_XYZZY', content: '<USER_REQUEST>\nHello again\n</USER_REQUEST>' },
        ]);
        const { session, errors } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        // Second step has an invalid date — updatedAt should fall back to createdAt with error
        assert.ok(errors.some(e => e.includes('sessionUpdatedAt')), `Expected sessionUpdatedAt error, got: ${JSON.stringify(errors)}`);
    });

    test('MODEL PLANNER_RESPONSE with empty content is skipped', () => {
        const convId = 'empty-asst';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
            { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T00:00:01Z', content: '   ' },
        ]);
        const { session } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        assert.strictEqual(session.messages.filter(m => m.role === 'assistant').length, 0);
    });

    test('stripTruncationMarker removes truncation suffix from content', () => {
        const convId = 'trunc';
        const fp = writeOverviewLines(convId, [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: 'Some text <truncated 100 bytes>' },
        ]);
        const { session } = parseAntigravityConversation({ conversationId: convId, overviewFile: fp });
        assert.strictEqual(session.messages[0].content, 'Some text');
    });

    test('JSON conversation: invalid createTime falls back to first message timestamp', () => {
        const info = writeConv2('jconv-badcreate', {
            createTime: 'not-a-date',
            messages: [
                { role: 'user', parts: [{ text: 'hello' }], createTime: '2024-05-01T10:00:00Z' },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.ok(session.createdAt.startsWith('2024-05-01'), `Expected 2024-05-01, got: ${session.createdAt}`);
    });

    test('JSON conversation: invalid updateTime falls back to last message timestamp', () => {
        const info = writeConv2('jconv-badupdated', {
            updateTime: 'bad-date',
            messages: [
                { role: 'user', parts: [{ text: 'hello' }], createTime: '2024-05-01T10:00:00Z' },
                { role: 'model', parts: [{ text: 'world' }], createTime: '2024-05-02T10:00:00Z' },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.ok(session.updatedAt.startsWith('2024-05-02'), `Expected 2024-05-02, got: ${session.updatedAt}`);
    });

    test('JSON conversation: no createTime and no message timestamp falls back to epoch', () => {
        const info = writeConv2('jconv-notime', {
            messages: [
                { role: 'user', parts: [{ text: 'hello' }] },
            ],
        });
        const { session } = parseAntigravityJsonConversation(info);
        assert.strictEqual(session.createdAt, new Date(0).toISOString());
    });
});
