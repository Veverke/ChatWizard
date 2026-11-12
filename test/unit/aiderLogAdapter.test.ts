/**
 * test/unit/aiderLogAdapter.test.ts
 *
 * Phase 3 — Aider log adapter unit tests.
 * Verifies the transcript markers that matter for the watch-logs panels
 * (`> !cmd`, `> /run …`, `Applied edit to …`, diff blocks), the output capture,
 * the pure helpers, and the file wrapper (stable sha1 session id).
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    aiderStartTimestamp,
    diffBlockFilePath,
    parseAiderAppliedEdit,
    parseAiderCommandLine,
    parseAiderLogEvents,
    parseAiderLogHistoryText,
} from '../../src/logs/adapters/aiderLogAdapter';
import { CommandEvent, DiffEvent, FileOperationEvent } from '../../src/logs/types';

const CTX = {
    sessionId: 'sess-aider',
    workspacePath: '/repo',
    sourcePath: '/repo/.aider.chat.history.md',
};

const TRANSCRIPT = [
    '# aider chat started at 2024-11-15 09:23:45',
    '',
    '> /add src/utils.ts',
    '',
    '> /run npm test -- --watch=false',
    'PASS src/utils.test.ts',
    'Tests: 3 passed',
    '',
    '#### add a helper',
    '',
    'Sure.',
    '',
    '```diff',
    '--- a/src/utils.ts',
    '+++ b/src/utils.ts',
    '@@ -1,2 +1,3 @@',
    ' export function greet(name: string) {',
    '-  return `Hi ${name}`;',
    '+  return `Hello, ${name}!`;',
    '+  // friendly',
    ' }',
    '```',
    '',
    'Applied edit to src/utils.ts',
    '',
    '> !git status --short',
    ' M src/utils.ts',
    '',
].join('\n');

suite('aiderLogAdapter — transcript markers', () => {
    test('parseAiderCommandLine recognises shell passthroughs and run-commands', () => {
        assert.deepStrictEqual(parseAiderCommandLine('> !npm test'), { commandText: 'npm test', shell: 'shell' });
        assert.deepStrictEqual(parseAiderCommandLine('> /run npm run build'), { commandText: 'npm run build', shell: 'aider' });
        assert.deepStrictEqual(parseAiderCommandLine('> /test'), { commandText: '/test', shell: 'aider' });
        assert.deepStrictEqual(parseAiderCommandLine('> /lint --fix'), { commandText: '--fix', shell: 'aider' });
        assert.deepStrictEqual(parseAiderCommandLine('> /cmd git log -3'), { commandText: 'git log -3', shell: 'aider' });
    });

    test('parseAiderCommandLine ignores meta commands and prose', () => {
        assert.strictEqual(parseAiderCommandLine('> /add src/utils.ts'), undefined);
        assert.strictEqual(parseAiderCommandLine('> /diff'), undefined);
        assert.strictEqual(parseAiderCommandLine('> /model gpt-4o'), undefined);
        assert.strictEqual(parseAiderCommandLine('>'), undefined);
        assert.strictEqual(parseAiderCommandLine('Sure, here is the fix'), undefined);
    });

    test('parseAiderAppliedEdit extracts the edited path', () => {
        assert.strictEqual(parseAiderAppliedEdit('Applied edit to src/utils.ts'), 'src/utils.ts');
        assert.strictEqual(parseAiderAppliedEdit('Applied edit to `src/a b.ts`'), 'src/a b.ts');
        assert.strictEqual(parseAiderAppliedEdit('Nothing to see'), undefined);
    });

    test('diffBlockFilePath reads unified-diff headers and ignores /dev/null', () => {
        assert.strictEqual(
            diffBlockFilePath('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y'),
            'src/a.ts'
        );
        assert.strictEqual(diffBlockFilePath('--- /dev/null\n+++ b/src/new.ts'), 'src/new.ts');
        assert.strictEqual(diffBlockFilePath('no headers here'), undefined);
    });

    test('aiderStartTimestamp parses the local start header', () => {
        const iso = aiderStartTimestamp('2024-11-15 09:23:45');
        assert.ok(iso);
        const date = new Date(iso as string);
        assert.strictEqual(date.getFullYear(), 2024);
        assert.strictEqual(date.getMonth(), 10);
        assert.strictEqual(date.getDate(), 15);
        assert.strictEqual(aiderStartTimestamp('not a date'), undefined);
    });
});

suite('aiderLogAdapter — parseAiderLogHistoryText', () => {
    test('normalizes commands, the applied edit and the diff block', () => {
        const { events, errors } = parseAiderLogHistoryText(TRANSCRIPT, CTX);
        assert.deepStrictEqual(errors, []);

        const commands = events.filter((e) => e.type === 'command') as CommandEvent[];
        assert.deepStrictEqual(
            commands.map((c) => c.commandText),
            ['npm test -- --watch=false', 'git status --short']
        );
        assert.strictEqual(commands[0].shell, 'aider');
        assert.match(commands[0].stdoutSummary ?? '', /3 passed/, 'command output is captured');
        assert.strictEqual(commands[1].shell, 'shell');
        assert.strictEqual(commands[1].cwd, '/repo');

        const fileOps = events.filter((e) => e.type === 'fileOperation') as FileOperationEvent[];
        assert.strictEqual(fileOps.length, 1);
        assert.strictEqual(fileOps[0].filePath, 'src/utils.ts');
        assert.strictEqual(fileOps[0].operationType, 'patch');

        const diffs = events.filter((e) => e.type === 'diff') as DiffEvent[];
        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].filePath, 'src/utils.ts');
        assert.strictEqual(diffs[0].addedLines, 2);
        assert.strictEqual(diffs[0].removedLines, 1);
        assert.match(diffs[0].diffText, /\+  return `Hello/);
    });

    test('every event carries the transcript start time and session identity', () => {
        const { events } = parseAiderLogHistoryText(TRANSCRIPT, CTX);
        assert.ok(events.length > 0);
        const expected = aiderStartTimestamp('2024-11-15 09:23:45');
        for (const event of events) {
            assert.strictEqual(event.timestamp, expected);
            assert.strictEqual(event.tool, 'aider');
            assert.strictEqual(event.sessionId, 'sess-aider');
            assert.strictEqual(event.workspaceId, 'sess-aider');
            assert.strictEqual(event.workspacePath, '/repo');
            assert.strictEqual(event.sourcePath, CTX.sourcePath);
        }
    });

    test('falls back to the supplied timestamp when the header is missing', () => {
        const fallback = '2026-01-02T03:04:05.000Z';
        const { events } = parseAiderLogHistoryText('> !ls\n', { ...CTX, fallbackTimestamp: fallback });
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].timestamp, fallback);
    });

    test('ignores meta commands and reports unterminated fences', () => {
        const raw = ['# aider chat started at 2024-11-15 09:23:45', '', '> /add a.ts', '', '```diff', '--- a/x', '+y'].join('\n');
        const { events, errors } = parseAiderLogHistoryText(raw, CTX);
        // The transcript was cut mid-block: the partial diff is still surfaced
        // (re-ingesting the grown file replaces it) and the problem is reported.
        assert.strictEqual(events.filter((e) => e.type === 'diff').length, 1);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /Unterminated code fence/);
    });

    test('non-diff fences are skipped without leaking fake commands', () => {
        const raw = ['#### question', '', '```typescript', 'const x = 1;', '```', ''].join('\n');
        const { events } = parseAiderLogHistoryText(raw, CTX);
        assert.strictEqual(events.length, 0);
    });
});

suite('aiderLogAdapter — parseAiderLogEvents (file wrapper)', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-adapter-'));
    });

    teardown(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('reads a transcript and derives the sha1 session id used by the parser', () => {
        const historyFile = path.join(dir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile, TRANSCRIPT, 'utf8');

        const { events, errors } = parseAiderLogEvents(historyFile, '/repo');
        assert.deepStrictEqual(errors, []);
        assert.ok(events.length > 0);

        const expectedId = crypto.createHash('sha1').update(historyFile).digest('hex');
        assert.strictEqual(events[0].sessionId, expectedId);
        assert.strictEqual(events[0].sourcePath, historyFile);
    });

    test('honours an explicit session id (as the harvester passes it)', () => {
        const historyFile = path.join(dir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile, '> !ls\n', 'utf8');
        const { events } = parseAiderLogEvents(historyFile, undefined, 'index-session-id');
        assert.strictEqual(events[0].sessionId, 'index-session-id');
    });

    test('a missing file yields an error instead of throwing', () => {
        const { events, errors } = parseAiderLogEvents(path.join(dir, 'nope.md'));
        assert.strictEqual(events.length, 0);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0], /Cannot read aider history/);
    });
});

