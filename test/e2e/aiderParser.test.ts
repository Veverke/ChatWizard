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
        assert.ok(
            result.errors[0].toLowerCase().includes('nonexistent') ||
            result.errors[0].toLowerCase().includes('no such file') ||
            result.errors[0].toLowerCase().includes('not found') ||
            result.errors[0].toLowerCase().includes('enoent'),
            `error message should reference the missing file, got: "${result.errors[0]}"`,
        );
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

// ---------------------------------------------------------------------------
// aiderParser — branch coverage edge cases
// ---------------------------------------------------------------------------
suite('aiderParser — branch coverage edge cases', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-branch-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeInfo(historyFile: string, configFile?: string): AiderHistoryInfo {
        return { historyFile, configFile, workspacePath: tmpDir };
    }

    function writeHistory(name: string, content: string): string {
        const filePath = path.join(tmpDir, name);
        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }

    test('no user messages → title is Untitled Aider Session', () => {
        const historyFile = writeHistory('no-user.md',
            '# Aider session\n\n> Cmd line only\n\nAssistant only response\n'
        );
        const { session } = parseAiderHistory(makeInfo(historyFile));
        assert.strictEqual(session.title, 'Untitled Aider Session');
    });

    test('assistant buffer with only whitespace is discarded without message', () => {
        // Create file where assistant section has only blank lines
        const historyFile = writeHistory('whitespace-asst.md',
            '#### Hello\n\n   \n\n#### Second\n\nActual assistant response\n'
        );
        const { session } = parseAiderHistory(makeInfo(historyFile));
        // The whitespace-only assistant output should be discarded, not produce a message
        assert.ok(session.messages.every(m => m.content.trim().length > 0));
    });

    test('_readModel reads model from config file with quotes', () => {
        const configFile = path.join(tmpDir, '.aider.conf.yml');
        fs.writeFileSync(configFile, 'model: "claude-3-5-sonnet-20241022"\n');
        const historyFile = writeHistory('with-model.md',
            '#### User asked something\n\nAssistant replied\n'
        );
        const { session } = parseAiderHistory(makeInfo(historyFile, configFile));
        assert.strictEqual(session.model, 'claude-3-5-sonnet-20241022');
    });

    test('_readModel reads model from config without quotes', () => {
        const configFile = path.join(tmpDir, '.aider.conf2.yml');
        fs.writeFileSync(configFile, 'model: gpt-4o\nother: value\n');
        const historyFile = writeHistory('with-model2.md',
            '#### User asked something\n\nAssistant replied\n'
        );
        const { session } = parseAiderHistory(makeInfo(historyFile, configFile));
        assert.strictEqual(session.model, 'gpt-4o');
    });

    test('blank line inside assistant block adds paragraph break', () => {
        const historyFile = writeHistory('para-break.md',
            '#### User question\n\nFirst paragraph.\n\nSecond paragraph.\n'
        );
        const { session } = parseAiderHistory(makeInfo(historyFile));
        const asst = session.messages.find(m => m.role === 'assistant');
        assert.ok(asst);
        assert.ok(asst.content.includes('First paragraph'));
        assert.ok(asst.content.includes('Second paragraph'));
    });
});

// ---------------------------------------------------------------------------
// Branch coverage suite
// ---------------------------------------------------------------------------

suite('Aider Parser — branch coverage', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-branch-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeInfo2(historyFile: string, configFile?: string): AiderHistoryInfo {
        return { historyFile, workspacePath: path.dirname(historyFile), configFile };
    }

    test('file read failure returns empty session with error', () => {
        const missing = path.join(tmpDir, 'does-not-exist.md');
        const { session, errors } = parseAiderHistory(makeInfo2(missing));
        assert.ok(errors.length > 0, 'should have errors');
        assert.ok(errors[0].includes('Failed to read'), `got: ${errors[0]}`);
        assert.strictEqual(session.messages.length, 0);
    });

    test('empty history file returns session with no messages', () => {
        const fp = path.join(tmpDir, 'empty.md');
        fs.writeFileSync(fp, '   ');
        const { session } = parseAiderHistory(makeInfo2(fp));
        assert.strictEqual(session.messages.length, 0);
    });

    test('user line with empty text after prefix is skipped', () => {
        const fp = path.join(tmpDir, 'empty-user.md');
        fs.writeFileSync(fp, '####    \n');
        const { session } = parseAiderHistory(makeInfo2(fp));
        assert.strictEqual(session.messages.filter(m => m.role === 'user').length, 0);
    });

    test('aider command line (> prefix) is skipped', () => {
        const fp = path.join(tmpDir, 'cmd-skip.md');
        fs.writeFileSync(fp, '> aider command\n#### user question\n');
        const { session } = parseAiderHistory(makeInfo2(fp));
        // Command line should not appear in messages
        const allContent = session.messages.map(m => m.content).join('');
        assert.ok(!allContent.includes('aider command'), 'command line should be skipped');
    });

    test('assistant message truncated when it exceeds MAX_MESSAGE_BYTES', () => {
        const fp = path.join(tmpDir, 'truncated.md');
        // Write a 1.1MB assistant block by repeating lines
        const bigLine = 'A'.repeat(1000);
        let content = '>? user asks\n';
        for (let i = 0; i < 1100; i++) {
            content += bigLine + '\n';
        }
        fs.writeFileSync(fp, content);
        const { session, errors } = parseAiderHistory(makeInfo2(fp));
        const asst = session.messages.find(m => m.role === 'assistant');
        assert.ok(asst, 'should have an assistant message');
        assert.ok(asst.content.includes('[...truncated'), 'should have truncation marker');
        assert.ok(errors.some(e => e.includes('truncated')), 'should have truncation error');
    });

    test('no title: title falls back to "Untitled Aider Session" when no user messages', () => {
        const fp = path.join(tmpDir, 'no-user.md');
        fs.writeFileSync(fp, 'Just some assistant text without user prefix\n');
        const { session } = parseAiderHistory(makeInfo2(fp));
        assert.strictEqual(session.title, 'Untitled Aider Session');
    });

    test('oversized line is skipped with error', () => {
        const fp = path.join(tmpDir, 'oversized.md');
        const longLine = 'B'.repeat(2001);
        fs.writeFileSync(fp, `#### user\n${longLine}\n`);
        // Pass a small maxLineChars to trigger the oversized path
        const { errors } = parseAiderHistory(makeInfo2(fp), 2000);
        assert.ok(errors.some(e => e.includes('Line skipped')), `errors: ${JSON.stringify(errors)}`);
    });
});
