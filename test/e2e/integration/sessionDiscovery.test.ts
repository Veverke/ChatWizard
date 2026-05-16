// test/suite/integration/sessionDiscovery.test.ts
//
// Integration tests — Session Discovery (scenarios 4–10)
//
// Exercises each parser/reader against fixture files and verifies that
// parsed sessions are correctly structured and can be upserted into a
// shared SessionIndex (multi-source scenario).
//
// No vscode.* APIs are used — runs in the Node Mocha host.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionIndex } from '../../../src/index/sessionIndex';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import { parseClaudeSession } from '../../../src/parsers/claude';
import { parseClineTask } from '../../../src/parsers/cline';
import { parseCursorWorkspace } from '../../../src/parsers/cursor';
import { parseWindsurfWorkspace } from '../../../src/parsers/windsurf';
import { parseAiderHistory } from '../../../src/parsers/aider';
import { AiderHistoryInfo } from '../../../src/types/index';
import { createCursorDb, createWindsurfDb } from '../../helpers/fixtureFactory';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX   = path.join(FIXTURES, 'copilot');
const CLAUDE_FX    = path.join(FIXTURES, 'claude');
const CLINE_FX     = path.join(FIXTURES, 'cline');
const AIDER_FX     = path.join(FIXTURES, 'aider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAiderInfo(historyFile: string): AiderHistoryInfo {
    return { historyFile, workspacePath: path.dirname(historyFile) };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Session Discovery', function () {
    this.timeout(15_000);

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-discovery-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Test 4: Copilot ───────────────────────────────────────────────────

    test('4 — Copilot: fixture is parsed with correct source and messages', () => {
        const fixturePath = path.join(COPILOT_FX, 'sample-session.jsonl');
        const { session, errors } = parseCopilotSession(fixturePath, 'ws-copilot', '/home/user/projects/mywebapp');

        assert.strictEqual(session.source, 'copilot');
        assert.ok(session.messages.length >= 2, `expected ≥2 messages, got ${session.messages.length}`);
        assert.ok(session.messages.some(m => m.role === 'user'), 'no user message found');
        assert.ok(session.messages.some(m => m.role === 'assistant'), 'no assistant message found');
        assert.strictEqual(errors.length, 0, `unexpected parse errors: ${errors.join('; ')}`);
    });

    test('4b — Copilot: code blocks are extracted from assistant response', () => {
        const fixturePath = path.join(COPILOT_FX, 'sample-session.jsonl');
        const { session } = parseCopilotSession(fixturePath, 'ws-copilot');

        const blocks = session.messages.flatMap(m => m.codeBlocks);
        assert.ok(blocks.length >= 1, `expected ≥1 code block, got ${blocks.length}`);
        assert.ok(blocks.some(b => b.language === 'css'), 'expected a CSS code block');
    });

    test('4c — Copilot: model field populated from session-with-model fixture', () => {
        const fixturePath = path.join(COPILOT_FX, 'session-with-model.jsonl');
        const { session } = parseCopilotSession(fixturePath, 'ws-model');

        assert.strictEqual(session.model, 'gpt-4o', `expected model "gpt-4o", got "${session.model}"`);
    });

    test('4d — Copilot: claude model field populated from session-with-claude-model fixture', () => {
        const fixturePath = path.join(COPILOT_FX, 'session-with-claude-model.jsonl');
        const { session } = parseCopilotSession(fixturePath, 'ws-model-claude');

        assert.ok(
            session.model?.startsWith('claude-'),
            `expected a claude model string, got "${session.model}"`
        );
    });

    // ── Test 5: Claude ────────────────────────────────────────────────────

    test('5 — Claude: fixture is parsed with correct source and messages', () => {
        const fixturePath = path.join(CLAUDE_FX, 'sample-session.jsonl');
        const { session, errors } = parseClaudeSession(fixturePath);

        assert.strictEqual(session.source, 'claude');
        assert.ok(session.messages.length >= 2, `expected ≥2 messages, got ${session.messages.length}`);
        assert.ok(session.messages.some(m => m.role === 'user'));
        assert.ok(session.messages.some(m => m.role === 'assistant'));
        assert.strictEqual(errors.length, 0, `unexpected parse errors: ${errors.join('; ')}`);
    });

    test('5b — Claude: code blocks are extracted from assistant response', () => {
        const fixturePath = path.join(CLAUDE_FX, 'sample-session.jsonl');
        const { session } = parseClaudeSession(fixturePath);

        const blocks = session.messages.flatMap(m => m.codeBlocks);
        assert.ok(blocks.length >= 1, `expected ≥1 code block, got ${blocks.length}`);
        assert.ok(blocks.some(b => b.language === 'typescript'), 'expected a TypeScript code block');
    });

    // ── Test 6: Cline ─────────────────────────────────────────────────────

    test('6 — Cline: fixture task is parsed with correct source and messages', async () => {
        const taskDir = path.join(CLINE_FX, 'sample-task');
        const { session, errors } = await parseClineTask(taskDir);

        assert.strictEqual(session.source, 'cline');
        assert.ok(session.messages.length >= 1, `expected ≥1 message, got ${session.messages.length}`);
        assert.ok(session.messages.some(m => m.role === 'user'));
        assert.strictEqual(errors.length, 0, `unexpected parse errors: ${errors.join('; ')}`);
    });

    test('6b — RooCode: same parser works with source override', async () => {
        const taskDir = path.join(FIXTURES, 'roocode', 'sample-task');
        const { session } = await parseClineTask(taskDir, undefined, 'roocode');

        assert.strictEqual(session.source, 'roocode');
        assert.ok(session.messages.length >= 1);
    });

    // ── Test 7: Cursor ────────────────────────────────────────────────────

    test('7 — Cursor: fixture-data.json seeds a SQLite DB that parses to sessions', async () => {
        const dbPath = path.join(tmpDir, 'cursor-state.vscdb');
        createCursorDb(dbPath);

        const results = await parseCursorWorkspace(dbPath, 'cursor-hash-001', '/home/user/cursor-project');

        assert.ok(results.length >= 1, `expected ≥1 result, got ${results.length}`);
        assert.ok(results.every(r => r.session.source === 'cursor'));
        const totalMessages = results.reduce((n, r) => n + r.session.messages.length, 0);
        assert.ok(totalMessages >= 2, `expected ≥2 messages across all sessions, got ${totalMessages}`);
    });

    test('7b — Cursor: TypeScript code block extracted from fixture', async () => {
        const dbPath = path.join(tmpDir, 'cursor-state-cb.vscdb');
        createCursorDb(dbPath);

        const results = await parseCursorWorkspace(dbPath, 'cursor-hash-cb');
        const allBlocks = results.flatMap(r => r.session.messages.flatMap(m => m.codeBlocks));

        assert.ok(allBlocks.some(b => b.language === 'typescript'), 'expected TypeScript code block');
    });

    // ── Test 8: Windsurf ──────────────────────────────────────────────────

    test('8 — Windsurf: fixture-data.json seeds a SQLite DB that parses to sessions', async () => {
        const dbPath = path.join(tmpDir, 'windsurf-state.vscdb');
        createWindsurfDb(dbPath);

        const results = await parseWindsurfWorkspace(dbPath, 'windsurf-hash-001', '/home/user/windsurf-project');

        assert.ok(results.length >= 1, `expected ≥1 result, got ${results.length}`);
        assert.ok(results.every(r => r.session.source === 'windsurf'));
        const totalMessages = results.reduce((n, r) => n + r.session.messages.length, 0);
        assert.ok(totalMessages >= 2, `expected ≥2 messages across all sessions, got ${totalMessages}`);
    });

    test('8b — Windsurf: YAML code block extracted from fixture', async () => {
        const dbPath = path.join(tmpDir, 'windsurf-state-cb.vscdb');
        createWindsurfDb(dbPath);

        const results = await parseWindsurfWorkspace(dbPath, 'windsurf-hash-cb');
        const allBlocks = results.flatMap(r => r.session.messages.flatMap(m => m.codeBlocks));

        assert.ok(allBlocks.some(b => b.language === 'yaml'), 'expected YAML code block from CI pipeline fixture');
    });

    // ── Test 9: Aider ─────────────────────────────────────────────────────

    test('9 — Aider: fixture history file parses with correct source and messages', () => {
        const historyFile = path.join(AIDER_FX, 'sample', '.aider.chat.history.md');
        const { session, errors } = parseAiderHistory(makeAiderInfo(historyFile));

        assert.strictEqual(session.source, 'aider');
        assert.ok(session.messages.length >= 2, `expected ≥2 messages, got ${session.messages.length}`);
        assert.ok(session.messages.some(m => m.role === 'user'));
        assert.ok(session.messages.some(m => m.role === 'assistant'));
        assert.strictEqual(errors.length, 0, `unexpected parse errors: ${errors.join('; ')}`);
    });

    // ── Test 10: Multi-source ─────────────────────────────────────────────

    test('10 — Multi-source: Copilot + Claude sessions both land in the same index', async () => {
        const index = new SessionIndex();

        // Copilot
        const { session: copilotSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'),
            'ws-copilot'
        );
        index.upsert(copilotSession);

        // Claude
        const { session: claudeSession } = parseClaudeSession(
            path.join(CLAUDE_FX, 'sample-session.jsonl')
        );
        index.upsert(claudeSession);

        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 2, `expected 2 sessions in index, got ${summaries.length}`);

        const sources = summaries.map(s => s.source).sort();
        assert.deepStrictEqual(sources, ['claude', 'copilot']);
    });

    test('10b — Multi-source: Cursor + Windsurf sessions coexist in the same index', async () => {
        const index = new SessionIndex();

        const cursorDb = path.join(tmpDir, 'cursor-multi.vscdb');
        createCursorDb(cursorDb);
        const cursorResults = await parseCursorWorkspace(cursorDb, 'cursor-ws');
        for (const { session } of cursorResults) { index.upsert(session); }

        const windsurfDb = path.join(tmpDir, 'windsurf-multi.vscdb');
        createWindsurfDb(windsurfDb);
        const windsurfResults = await parseWindsurfWorkspace(windsurfDb, 'windsurf-ws');
        for (const { session } of windsurfResults) { index.upsert(session); }

        const summaries = index.getAllSummaries();
        assert.ok(summaries.some(s => s.source === 'cursor'),   'cursor sessions missing');
        assert.ok(summaries.some(s => s.source === 'windsurf'), 'windsurf sessions missing');
    });
});
