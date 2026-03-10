// test/suite/searchEngine.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session, Message } from '../../src/types/index';
import { SearchQuery } from '../../src/search/types';

// ── Fixture builder ──────────────────────────────────────────────────────────

let _idCounter = 0;

function makeMessage(
    role: 'user' | 'assistant',
    content: string
): Message {
    return {
        id:         `msg-${++_idCounter}`,
        role,
        content,
        codeBlocks: [],
    };
}

interface SessionOpts {
    source?:        'copilot' | 'claude';
    workspaceId?:   string;
    updatedAt?:     string;
    createdAt?:     string;
}

function makeSession(
    id:       string,
    messages: Message[],
    opts:     SessionOpts = {}
): Session {
    return {
        id,
        title:         `Session ${id}`,
        source:        opts.source      ?? 'copilot',
        workspaceId:   opts.workspaceId ?? 'ws-default',
        messages,
        filePath:      `/fake/${id}.jsonl`,
        createdAt:     opts.createdAt   ?? '2024-01-01T00:00:00.000Z',
        updatedAt:     opts.updatedAt   ?? '2024-06-01T00:00:00.000Z',
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

suite('FullTextSearchEngine', () => {

    // 1. Basic index + search: single session, one user message.
    test('index and search plain text — single session returns one result', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s1', [
            makeMessage('user', 'How do I implement a binary search tree?'),
        ]);
        engine.index(session);

        const results = engine.search({ text: 'binary search tree' });

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sessionId,    's1');
        assert.strictEqual(results[0].messageIndex, 0);
        assert.strictEqual(results[0].messageRole,  'user');
    });

    // 2. Multi-token query — all tokens must be present.
    test('multi-token query excludes messages missing any token', () => {
        const engine = new FullTextSearchEngine();

        const sessionMatch = makeSession('s-match', [
            makeMessage('user', 'quick brown fox jumps over the lazy dog'),
        ]);
        const sessionNoMatch = makeSession('s-no-match', [
            makeMessage('user', 'quick brown fox without the last word'),
        ]);
        engine.index(sessionMatch);
        engine.index(sessionNoMatch);

        // "lazy dog" — both tokens must appear.
        const results = engine.search({ text: 'lazy dog' });

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sessionId, 's-match');
    });

    // 3. Role filter — searchPrompts:false skips user messages.
    test('searchPrompts:false excludes user messages', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-roles', [
            makeMessage('user',      'hello world from the user'),
            makeMessage('assistant', 'hello world from the assistant'),
        ]);
        engine.index(session);

        const results = engine.search({
            text:   'hello world',
            filter: { searchPrompts: false },
        });

        assert.ok(results.length >= 1, 'expected at least one result');
        for (const r of results) {
            assert.strictEqual(r.messageRole, 'assistant');
        }
    });

    // 4. Source filter — copilot session excluded when filter.source='claude'.
    test('source filter excludes sessions from wrong source', () => {
        const engine = new FullTextSearchEngine();
        const copilotSession = makeSession('s-copilot', [
            makeMessage('user', 'refactor this function please'),
        ], { source: 'copilot' });
        const claudeSession = makeSession('s-claude', [
            makeMessage('user', 'refactor this function please'),
        ], { source: 'claude' });
        engine.index(copilotSession);
        engine.index(claudeSession);

        const results = engine.search({
            text:   'refactor function',
            filter: { source: 'claude' },
        });

        assert.ok(results.length >= 1);
        for (const r of results) {
            assert.strictEqual(r.sessionId, 's-claude');
        }
    });

    // 5. Workspace filter — different workspaceId is excluded.
    test('workspaceId filter excludes sessions from other workspaces', () => {
        const engine = new FullTextSearchEngine();
        const wsA = makeSession('s-ws-a', [
            makeMessage('user', 'optimize the database query'),
        ], { workspaceId: 'workspace-A' });
        const wsB = makeSession('s-ws-b', [
            makeMessage('user', 'optimize the database query'),
        ], { workspaceId: 'workspace-B' });
        engine.index(wsA);
        engine.index(wsB);

        const results = engine.search({
            text:   'database query',
            filter: { workspaceId: 'workspace-A' },
        });

        assert.ok(results.length >= 1);
        for (const r of results) {
            assert.strictEqual(r.sessionId, 's-ws-a');
        }
    });

    // 6. Date filter — dateFrom / dateTo exclude sessions outside range.
    test('dateFrom and dateTo filter sessions by updatedAt', () => {
        const engine = new FullTextSearchEngine();

        const old    = makeSession('s-old',    [makeMessage('user', 'fix the memory leak')], { updatedAt: '2023-01-15T00:00:00.000Z' });
        const recent = makeSession('s-recent', [makeMessage('user', 'fix the memory leak')], { updatedAt: '2024-08-20T00:00:00.000Z' });
        const future = makeSession('s-future', [makeMessage('user', 'fix the memory leak')], { updatedAt: '2025-03-01T00:00:00.000Z' });
        engine.index(old);
        engine.index(recent);
        engine.index(future);

        const results = engine.search({
            text:   'memory leak',
            filter: {
                dateFrom: '2024-01-01T00:00:00.000Z',
                dateTo:   '2024-12-31T23:59:59.999Z',
            },
        });

        assert.ok(results.length >= 1);
        for (const r of results) {
            assert.strictEqual(r.sessionId, 's-recent');
        }
    });

    // 7. Regex search — pattern matches across content.
    test('regex search matches pattern spanning content', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-regex', [
            makeMessage('assistant', 'hello, this is a wonderful world we live in'),
        ]);
        engine.index(session);

        const results = engine.search({ text: 'hello.*world', isRegex: true });

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sessionId,   's-regex');
        assert.strictEqual(results[0].messageRole, 'assistant');
    });

    // 8. remove — searching after removal returns no results.
    test('remove clears the session from search results', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-remove', [
            makeMessage('user', 'deploy the application to production'),
        ]);
        engine.index(session);

        // Verify it's found before removal.
        assert.strictEqual(engine.search({ text: 'deploy application' }).length, 1);
        assert.strictEqual(engine.size, 1);

        engine.remove('s-remove');

        assert.strictEqual(engine.size, 0);
        assert.strictEqual(engine.search({ text: 'deploy application' }).length, 0);
    });

    // 9. index idempotency — indexing the same session twice does not duplicate results.
    test('indexing the same session twice yields no duplicate results', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-idem', [
            makeMessage('user', 'write unit tests for the parser'),
        ]);

        engine.index(session);
        engine.index(session);  // second call — should overwrite, not append.

        const results = engine.search({ text: 'unit tests parser' });

        assert.strictEqual(results.length, 1, 'expected exactly one result, not duplicated');
        assert.strictEqual(engine.size, 1);
    });

    // 10. Empty query returns [].
    test('empty query text returns empty array', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-empty', [
            makeMessage('user', 'some content that would normally match anything'),
        ]);
        engine.index(session);

        const results = engine.search({ text: '' });

        assert.deepStrictEqual(results, []);
    });
});
