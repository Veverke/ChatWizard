// test/suite/integration/codeBlocksView.test.ts
//
// Integration tests — Code Blocks View (scenarios 27–30)
//
// Exercises CodeBlockTreeProvider and CodeBlockSearchEngine against fixture
// data. No VS Code host is required — the providers work as plain Node objects.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionIndex } from '../../../src/index/sessionIndex';
import {
    CodeBlockTreeProvider,
    CodeBlockGroupItem,
    CbLanguageGroupItem,
    CodeBlockLoadMoreItem,
} from '../../../src/views/codeBlockTreeProvider';
import { CodeBlockSearchEngine } from '../../../src/codeblocks/codeBlockSearchEngine';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import { parseClaudeSession } from '../../../src/parsers/claude';
import { writeCopilotSessions } from '../../helpers/fixtureFactory';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX = path.join(FIXTURES, 'copilot');
const CLAUDE_FX  = path.join(FIXTURES, 'claude');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(index: SessionIndex): CodeBlockTreeProvider {
    const engine = new CodeBlockSearchEngine();
    engine.index(index.getAllCodeBlocks());
    return new CodeBlockTreeProvider(index, engine);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Code Blocks View', function () {
    this.timeout(15_000);

    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-codeblocks-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Test 27: Population ───────────────────────────────────────────────

    test('27 — code blocks are extracted and available in the index', () => {
        const index = new SessionIndex();

        // sample-session.jsonl contains CSS code blocks
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-27'
        );
        index.upsert(session);

        const allBlocks = index.getAllCodeBlocks();
        assert.ok(allBlocks.length >= 1, `expected ≥1 code block, got ${allBlocks.length}`);
    });

    test('27b — code block has expected fields', () => {
        const index = new SessionIndex();

        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-27b'
        );
        index.upsert(session);

        const block = index.getAllCodeBlocks()[0];
        assert.ok(block.sessionId, 'block must have sessionId');
        assert.ok(block.content, 'block must have non-empty content');
        assert.ok(block.language !== undefined, 'block must have language (may be empty string)');
        assert.ok(['user', 'assistant'].includes(block.messageRole), 'messageRole must be user or assistant');
    });

    test('27c — TypeScript code blocks are extracted from Claude fixture', () => {
        const index = new SessionIndex();

        const { session } = parseClaudeSession(path.join(CLAUDE_FX, 'sample-session.jsonl'));
        index.upsert(session);

        const tsBlocks = index.getAllCodeBlocks().filter(b => b.language === 'typescript');
        assert.ok(tsBlocks.length >= 1, `expected ≥1 TypeScript code block from Claude fixture`);
    });

    // ── Test 28: Filter by language ───────────────────────────────────────

    test('28 — setFilter(language:"css") returns only CSS groups', () => {
        const index = new SessionIndex();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-28a'
        );
        const { session: tsSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-28b'
        );
        index.upsert(cssSession);
        index.upsert(tsSession);

        const provider = makeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ language: 'css' });

        const root = provider.getChildren(undefined);
        // Only groups that have CSS blocks should appear
        const groups = root.filter(n => n instanceof CodeBlockGroupItem) as CodeBlockGroupItem[];
        const allHaveCss = groups.every(g =>
            g.sessionRef.blocks.some(b => b.language.toLowerCase() === 'css')
        );
        assert.ok(allHaveCss, 'all visible groups should contain CSS blocks when language filter is active');
    });

    test('28b — clearFilter restores all groups', () => {
        const index = new SessionIndex();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-28c'
        );
        const { session: tsSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-28d'
        );
        index.upsert(cssSession);
        index.upsert(tsSession);

        const provider = makeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ language: 'css' });

        const filteredCount = provider.getChildren(undefined)
            .filter(n => n instanceof CodeBlockGroupItem).length;

        provider.clearFilter();

        const allCount = provider.getChildren(undefined)
            .filter(n => n instanceof CodeBlockGroupItem).length;

        assert.ok(allCount >= filteredCount, 'clearing filter should show at least as many groups');
    });

    // ── Test 29: Group by language ────────────────────────────────────────

    test('29 — groupMode=language produces CbLanguageGroupItem nodes at root', () => {
        const index = new SessionIndex();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-29a'
        );
        const { session: tsSession } = parseClaudeSession(path.join(CLAUDE_FX, 'sample-session.jsonl'));
        index.upsert(cssSession);
        index.upsert(tsSession);

        const provider = makeProvider(index);
        provider.setGroupMode('language');

        const root = provider.getChildren(undefined);
        const langGroups = root.filter(n => n instanceof CbLanguageGroupItem);
        assert.ok(langGroups.length >= 1, 'expected ≥1 language group at root');
    });

    test('29b — expanding a language group returns CodeBlockGroupItem children', () => {
        const index = new SessionIndex();

        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-29c'
        );
        index.upsert(session);

        const provider = makeProvider(index);
        provider.setGroupMode('language');

        const root = provider.getChildren(undefined);
        const langGroup = root.find(n => n instanceof CbLanguageGroupItem) as CbLanguageGroupItem;
        assert.ok(langGroup, 'expected a language group');

        const children = provider.getChildren(langGroup);
        const sessionGroups = children.filter(n => n instanceof CodeBlockGroupItem);
        assert.ok(sessionGroups.length >= 1, 'language group should expand to session code block groups');
    });

    test('29c — groupMode=none produces CodeBlockGroupItem nodes at root (no language groups)', () => {
        const index = new SessionIndex();

        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-29d'
        );
        index.upsert(session);

        const provider = makeProvider(index);
        provider.setGroupMode('none');

        const root = provider.getChildren(undefined);
        const langGroups = root.filter(n => n instanceof CbLanguageGroupItem);
        assert.strictEqual(langGroups.length, 0, 'no language groups expected in flat mode');

        const sessionGroups = root.filter(n => n instanceof CodeBlockGroupItem);
        assert.ok(sessionGroups.length >= 1, 'expected session group items in flat mode');
    });

    // ── Test 30: Pagination ───────────────────────────────────────────────

    test('30 — CodeBlockLoadMoreItem appears when >200 session groups', () => {
        const paginationDir = path.join(tmpDir, 'pagination');
        writeCopilotSessions(paginationDir, 201);

        const index = new SessionIndex();
        for (const file of fs.readdirSync(paginationDir)) {
            const { session } = parseCopilotSession(path.join(paginationDir, file), 'ws-30');
            index.upsert(session);
        }

        const provider = makeProvider(index);
        provider.setGroupMode('none');

        const root = provider.getChildren(undefined);
        const loadMoreItems = root.filter(n => n instanceof CodeBlockLoadMoreItem);
        assert.ok(loadMoreItems.length === 1, 'expected exactly one CodeBlockLoadMoreItem');

        // After loadMore, all groups should be visible
        provider.loadMore();
        const rootAfter = provider.getChildren(undefined);
        const loadMoreAfter = rootAfter.filter(n => n instanceof CodeBlockLoadMoreItem);
        assert.strictEqual(loadMoreAfter.length, 0, 'LoadMore item should be gone after loading more');
    });

    // ── CodeBlockSearchEngine ─────────────────────────────────────────────

    test('search engine finds blocks by content substring', () => {
        const index = new SessionIndex();

        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-se-1'
        );
        index.upsert(session);

        const engine = new CodeBlockSearchEngine();
        engine.index(index.getAllCodeBlocks());

        const results = engine.search('display');
        assert.ok(results.length >= 1, 'expected at least one block matching "display"');
    });

    test('search engine filters by language', () => {
        const index = new SessionIndex();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-se-2'
        );
        const { session: tsSession } = parseClaudeSession(path.join(CLAUDE_FX, 'sample-session.jsonl'));
        index.upsert(cssSession);
        index.upsert(tsSession);

        const engine = new CodeBlockSearchEngine();
        engine.index(index.getAllCodeBlocks());

        const cssBlocks = engine.search('', 'css');
        assert.ok(cssBlocks.every(b => b.language.toLowerCase() === 'css'),
            'all returned blocks should be css');
    });

    test('search engine getLanguages() returns sorted list', () => {
        const index = new SessionIndex();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-se-3'
        );
        const { session: tsSession } = parseClaudeSession(path.join(CLAUDE_FX, 'sample-session.jsonl'));
        index.upsert(cssSession);
        index.upsert(tsSession);

        const engine = new CodeBlockSearchEngine();
        engine.index(index.getAllCodeBlocks());

        const langs = engine.getLanguages();
        assert.ok(Array.isArray(langs), 'getLanguages should return an array');
        for (let i = 1; i < langs.length; i++) {
            assert.ok(langs[i - 1] <= langs[i], 'languages should be sorted alphabetically');
        }
    });
});
