// test/suite/antigravityParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseAntigravityConversation } from '../../src/parsers/antigravity';
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

        assert.ok(result.errors.length > 0);
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
