/**
 * test/unit/aider.test.ts
 *
 * Unit tests for aider.ts parser — focuses on edge cases not covered by e2e tests.
 * Tests avoid file system I/O by using temp files.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseAiderHistory, extractAiderCodeBlocks } from '../../src/parsers/aider';
import { AiderHistoryInfo } from '../../src/types/index';

function makeInfo(historyFile: string, configFile?: string): AiderHistoryInfo {
    return {
        historyFile,
        workspacePath: path.dirname(historyFile),
        configFile,
    };
}

suite('aider (unit)', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-unit-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    suite('extractAiderCodeBlocks', () => {
        test('returns empty array for content with no code fences', () => {
            const blocks = extractAiderCodeBlocks('plain text without code', 'session-1', 0);
            assert.strictEqual(blocks.length, 0);
        });

        test('extracts code blocks from fenced content', () => {
            const content = '```typescript\nconst x = 1;\n```';
            const blocks = extractAiderCodeBlocks(content, 'session-1', 1);
            assert.strictEqual(blocks.length, 1);
            assert.strictEqual(blocks[0].language, 'typescript');
            assert.strictEqual(blocks[0].content, 'const x = 1;\n');
        });
    });

    suite('parseAiderHistory — edge cases', () => {
        test('returns empty session when file cannot be read', () => {
            const result = parseAiderHistory(makeInfo('/nonexistent/file.md'));
            assert.strictEqual(result.session.source, 'aider');
            assert.strictEqual(result.session.messages.length, 0);
            assert.ok(result.errors.length > 0);
            assert.ok(result.errors[0].includes('Failed to read'));
        });

        test('returns empty session from empty file', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, '', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.strictEqual(result.session.messages.length, 0);
            assert.strictEqual(result.session.title, 'Untitled Aider Session');
        });

        test('reads model from config file', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            const cfgFile = path.join(tmpDir, '.aider.conf.yml');
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### Hello\nSome response', 'utf8');
            fs.writeFileSync(cfgFile, 'model: gpt-4-turbo\n', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile, cfgFile));
            assert.strictEqual(result.session.model, 'gpt-4-turbo');
        });

        test('model undefined when config file absent', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### Hello\nSome response', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.strictEqual(result.session.model, undefined);
        });

        test('model undefined when config file has no model key', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            const cfgFile = path.join(tmpDir, '.aider.conf.yml');
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### Hello\nSome response', 'utf8');
            fs.writeFileSync(cfgFile, 'key: value\n', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile, cfgFile));
            assert.strictEqual(result.session.model, undefined);
        });

        test('truncates very long title from first user message', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            const longMsg = 'A'.repeat(200);
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### ' + longMsg + '\nResponse', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.ok(result.session.title.endsWith('…'));
            assert.strictEqual(result.session.title.length, 121); // 120 chars + ellipsis
        });

        test('handles assistant message byte cap (1 MB warning)', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            const largeLine = 'LargeContent ' + 'x'.repeat(1000);
            const lines: string[] = ['# aider chat started at 2024-01-01 12:00:00', '#### Hello'];
            // Generate content just over 1 MB
            let totalBytes = 0;
            while (totalBytes < 1_024 * 1_024 + 100) {
                lines.push(largeLine);
                totalBytes += Buffer.byteLength(largeLine, 'utf8');
            }
            fs.writeFileSync(histFile, lines.join('\n'), 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.strictEqual(result.session.messages.length, 2); // user + assistant
            const asstMsg = result.session.messages[1];
            assert.ok(asstMsg.content.includes('[...truncated'), 'expected truncation marker');
            assert.ok(result.errors.some(e => e.includes('truncated')), 'expected truncation error');
        });

        test('skips lines exceeding maxLineChars', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            const longLine = 'x'.repeat(1_000_001);
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### Hello\n' + longLine + '\nNormal line', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile), 100);
            assert.ok(result.errors.some(e => e.includes('Line skipped')), 'expected skip error');
        });

        test('preserves paragraph breaks in assistant output', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, [
                '# aider chat started at 2024-01-01 12:00:00',
                '#### Hello',
                'First paragraph.',
                '',
                'Second paragraph.',
                '#### Next user message',
                'Response.',
            ].join('\n'), 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.strictEqual(result.session.messages.length, 4);
            const asstMsg = result.session.messages[1];
            assert.ok(asstMsg.content.includes('First paragraph.'));
            assert.ok(asstMsg.content.includes('Second paragraph.'));
        });

        test('createdAt from session start header when present', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, '# aider chat started at 2024-06-15 08:30:00\n#### Hello\nResponse', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            assert.strictEqual(result.session.createdAt, new Date('2024-06-15T08:30:00').toISOString());
        });

        test('createdAt falls back to file mtime when no header', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, '#### Hello\nResponse', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            // Should be close to now since we just created the file
            const now = Date.now();
            const createdAt = new Date(result.session.createdAt).getTime();
            assert.ok(Math.abs(now - createdAt) < 5000, 'createdAt should be near current time');
        });

        test('empty user message text is not added', () => {
            const histFile = path.join(tmpDir, '.aider.chat.history.md');
            fs.writeFileSync(histFile, '# aider chat started at 2024-01-01 12:00:00\n#### \nResponse', 'utf8');
            const result = parseAiderHistory(makeInfo(histFile));
            // The ####  line produces empty user content → skipped
            assert.strictEqual(result.session.messages.length, 1);
            assert.strictEqual(result.session.messages[0].role, 'assistant');
        });
    });
});