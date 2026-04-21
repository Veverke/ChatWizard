// test/suite/aiderParser.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseAiderHistory, extractAiderCodeBlocks } from '../../src/parsers/aider';
import { AiderHistoryInfo } from '../../src/types/index';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'aider');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeInfo(historyFile: string, configFile?: string): AiderHistoryInfo {
    return {
        historyFile,
        workspacePath: path.dirname(historyFile),
        configFile,
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Aider Parser', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Happy path ────────────────────────────────────────────────────────────

    test('happy path: source is aider', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const configFile  = path.join(FIXTURES_DIR, 'sample', '.aider.conf.yml');
        const result = parseAiderHistory(makeInfo(historyFile, configFile));

        assert.strictEqual(result.session.source, 'aider');
    });

    test('happy path: correct number of messages (2 user + 2 assistant)', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        const userMsgs = result.session.messages.filter(m => m.role === 'user');
        const asstMsgs = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(userMsgs.length, 2, 'expected 2 user messages');
        assert.strictEqual(asstMsgs.length, 2, 'expected 2 assistant messages');
    });

    test('happy path: first user message content matches', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        const firstUser = result.session.messages.find(m => m.role === 'user');
        assert.ok(firstUser, 'expected at least one user message');
        assert.strictEqual(firstUser.content, 'Help me refactor this function');
    });

    test('happy path: title derived from first user message', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.session.title, 'Help me refactor this function');
    });

    test('happy path: createdAt parsed from session start header', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.session.createdAt, new Date('2024-11-15T09:23:45').toISOString());
    });

    test('happy path: workspacePath set correctly', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.session.workspacePath, path.dirname(historyFile));
    });

    test('happy path: model read from .aider.conf.yml', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const configFile  = path.join(FIXTURES_DIR, 'sample', '.aider.conf.yml');
        const result = parseAiderHistory(makeInfo(historyFile, configFile));

        assert.strictEqual(result.session.model, 'claude-3-5-sonnet-20241022');
    });

    test('happy path: model undefined when no .aider.conf.yml provided', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));  // no configFile

        assert.strictEqual(result.session.model, undefined);
    });

    test('happy path: code blocks extracted from assistant messages', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        const allBlocks = result.session.messages.flatMap(m => m.codeBlocks);
        assert.ok(allBlocks.length >= 2, 'expected at least 2 code blocks');
        assert.ok(allBlocks.every(b => b.language === 'typescript'));
    });

    test('happy path: no errors on clean fixture', () => {
        const historyFile = path.join(FIXTURES_DIR, 'sample', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.errors.length, 0);
    });

    // ── Aider command lines excluded ──────────────────────────────────────────

    test('aider command lines (> prefix) are excluded from messages', () => {
        const historyFile = path.join(tmpDir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile,
            '# aider chat started at 2025-01-01 10:00:00\n\n' +
            '> /add file.ts\n\n' +
            '#### What does this do?\n\n' +
            'It adds a file.\n'
        );
        const result = parseAiderHistory(makeInfo(historyFile));

        // The > /add line must not appear in any message content
        const allContent = result.session.messages.map(m => m.content).join('\n');
        assert.ok(!allContent.includes('/add'), 'command line must be excluded');
        assert.ok(result.session.messages.some(m => m.role === 'user'), 'user message expected');
        assert.ok(result.session.messages.some(m => m.role === 'assistant'), 'assistant message expected');
    });

    // ── Empty file ────────────────────────────────────────────────────────────

    test('empty file: zero messages, no errors', () => {
        const historyFile = path.join(FIXTURES_DIR, 'empty', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.session.messages.length, 0);
        assert.strictEqual(result.errors.length, 0);
    });

    // ── Missing file ──────────────────────────────────────────────────────────

    test('missing file: errors populated, zero messages', () => {
        const historyFile = path.join(tmpDir, 'nonexistent', '.aider.chat.history.md');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.ok(result.errors.length > 0, 'expected at least one error');
        assert.strictEqual(result.session.messages.length, 0);
    });

    // ── Code fence extraction ─────────────────────────────────────────────────

    test('code blocks extracted correctly with language and sessionId/messageIndex', () => {
        const historyFile = path.join(tmpDir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile,
            '#### Fix the bug\n\n' +
            '```python\nprint("fixed")\n```\n'
        );
        const result = parseAiderHistory(makeInfo(historyFile));

        const allBlocks = result.session.messages.flatMap(m => m.codeBlocks);
        assert.strictEqual(allBlocks.length, 1);
        assert.strictEqual(allBlocks[0].language, 'python');
        assert.strictEqual(allBlocks[0].sessionId, result.session.id);
    });

    // ── .aider.conf.yml absent ────────────────────────────────────────────────

    test('.aider.conf.yml absent: model is undefined', () => {
        const historyFile = path.join(tmpDir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile, '#### Hello\n\nHi there\n');
        const result = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(result.session.model, undefined);
    });

    // ── .aider.conf.yml present with model key ────────────────────────────────

    test('.aider.conf.yml with model key: model populated', () => {
        const historyFile = path.join(tmpDir, '.aider.chat.history.md');
        const configFile  = path.join(tmpDir, '.aider.conf.yml');
        fs.writeFileSync(historyFile, '#### Hello\n\nHi\n');
        fs.writeFileSync(configFile, 'model: gpt-4o\n');
        const result = parseAiderHistory(makeInfo(historyFile, configFile));

        assert.strictEqual(result.session.model, 'gpt-4o');
    });

    // ── extractAiderCodeBlocks ────────────────────────────────────────────────

    test('extractAiderCodeBlocks: detects language and propagates IDs', () => {
        const blocks = extractAiderCodeBlocks('```rust\nfn main() {}\n```', 'sess-1', 2);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, 'rust');
        assert.strictEqual(blocks[0].sessionId, 'sess-1');
        assert.strictEqual(blocks[0].messageIndex, 2);
    });

    test('extractAiderCodeBlocks: no blocks returns empty array', () => {
        const blocks = extractAiderCodeBlocks('No code here.', 'sess-2', 0);
        assert.strictEqual(blocks.length, 0);
    });

    // ── Stable session ID ─────────────────────────────────────────────────────

    test('session ID is stable SHA-1 of file path (not content)', () => {
        const historyFile = path.join(tmpDir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile, '#### Hello\n\nHi\n');
        const r1 = parseAiderHistory(makeInfo(historyFile));

        fs.appendFileSync(historyFile, '\n#### More?\n\nYep.\n');
        const r2 = parseAiderHistory(makeInfo(historyFile));

        assert.strictEqual(r1.session.id, r2.session.id, 'ID must not change when file content grows');
    });
});
