// test/suite/searchEngine.test.ts

import * as assert from 'assert';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session, Message } from '../../src/types/index';
import { SearchQuery } from '../../src/search/types';

// â”€â”€ Fixture builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('FullTextSearchEngine', () => {

    // 1. Basic index + search: tokens must appear in â‰¥ 2 sessions to reach the main index (S11).
    test('index and search plain text â€” tokens in â‰¥2 sessions are searchable', () => {
        const engine = new FullTextSearchEngine();
        const session    = makeSession('s1',   [makeMessage('user', 'How do I implement a binary search tree?')]);
        const companion  = makeSession('s1-b', [makeMessage('user', 'binary search tree tutorial')]);
        engine.index(session);
        engine.index(companion);

        const { results } = engine.search({ text: 'binary search tree' });

        assert.ok(results.length >= 1);
        const s1Result = results.find(r => r.sessionId === 's1');
        assert.ok(s1Result, 's1 should be in results');
        assert.strictEqual(s1Result!.messageIndex, 0);
        assert.strictEqual(s1Result!.messageRole,  'user');
    });

    // 2. Multi-token query â€” all tokens must be present.
    test('multi-token query excludes messages missing any token', () => {
        const engine = new FullTextSearchEngine();

        const sessionMatch   = makeSession('s-match',    [makeMessage('user', 'quick brown fox jumps over the lazy dog')]);
        const sessionNoMatch = makeSession('s-no-match', [makeMessage('user', 'quick brown fox without the last word')]);
        // Companion ensures 'lazy' and 'dog' reach MIN_DOC_FREQ (S11).
        const companion      = makeSession('s-lazy-dog', [makeMessage('user', 'the lazy dog slept all day')]);
        engine.index(sessionMatch);
        engine.index(sessionNoMatch);
        engine.index(companion);

        // "lazy dog" â€” both tokens must appear; s-no-match must be excluded.
        const { results } = engine.search({ text: 'lazy dog' });

        assert.ok(results.length >= 1);
        assert.ok(!results.some(r => r.sessionId === 's-no-match'), 's-no-match must not appear');
        assert.ok(results.some(r => r.sessionId === 's-match'),     's-match must appear');
    });

    // 2b. Substring query starting mid-word — boundary-fragment token absent from index.
    //     Searching "he thing is" should still match a message containing "the thing is"
    //     because "he thing is" is a literal substring of that text, even though "he" is
    //     not a standalone indexed word.
    test('phrase query with boundary fragment finds substring match', () => {
        const engine = new FullTextSearchEngine();

        const sessionMatch = makeSession('s-phrase', [makeMessage('user', 'the thing is I do not have access')]);
        // Companion ensures 'thing' reaches MIN_DOC_FREQ so it enters the main index.
        const companion    = makeSession('s-phrase-cmp', [makeMessage('user', 'this thing works differently')]);
        engine.index(sessionMatch);
        engine.index(companion);

        // "he thing is" — "he" is not an indexed standalone word, but the substring exists.
        const { results } = engine.search({ text: 'he thing is' });

        assert.ok(results.some(r => r.sessionId === 's-phrase'),
            '"he thing is" must match the session containing "the thing is" as a substring');
    });

    // 3. Role filter â€” searchPrompts:false skips user messages.
    test('searchPrompts:false excludes user messages', () => {
        const engine = new FullTextSearchEngine();
        const session    = makeSession('s-roles',    [
            makeMessage('user',      'hello world from the user'),
            makeMessage('assistant', 'hello world from the assistant'),
        ]);
        // Companion ensures 'hello' and 'world' reach MIN_DOC_FREQ (S11).
        const companion  = makeSession('s-roles-cmp', [makeMessage('user', 'hello world companion content')]);
        engine.index(session);
        engine.index(companion);

        const { results } = engine.search({
            text:   'hello world',
            filter: { searchPrompts: false },
        });

        assert.ok(results.length >= 1, 'expected at least one result');
        for (const r of results) {
            if (r.sessionId === 's-roles') {
                assert.strictEqual(r.messageRole, 'assistant');
            }
        }
    });

    // 4. Source filter â€” copilot session excluded when filter.source='claude'.
    test('source filter excludes sessions from wrong source', () => {
        const engine = new FullTextSearchEngine();
        const copilotSession = makeSession('s-copilot', [
            makeMessage('user', 'please refactor function implementation'),
        ], { source: 'copilot' });
        const claudeSession = makeSession('s-claude', [
            makeMessage('user', 'please refactor function implementation'),
        ], { source: 'claude' });
        engine.index(copilotSession);
        engine.index(claudeSession);

        const { results } = engine.search({
            text:   'refactor function',
            filter: { source: 'claude' },
        });

        assert.ok(results.length >= 1);
        for (const r of results) {
            assert.strictEqual(r.sessionId, 's-claude');
        }
    });

    // 5. Workspace filter â€” different workspaceId is excluded.
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

        const { results } = engine.search({
            text:   'database query',
            filter: { workspaceId: 'workspace-A' },
        });

        assert.ok(results.length >= 1);
        for (const r of results) {
            assert.strictEqual(r.sessionId, 's-ws-a');
        }
    });

    // 6. Date filter â€” dateFrom / dateTo exclude sessions outside range.
    test('dateFrom and dateTo filter sessions by updatedAt', () => {
        const engine = new FullTextSearchEngine();

        const old    = makeSession('s-old',    [makeMessage('user', 'fix the memory leak')], { updatedAt: '2023-01-15T00:00:00.000Z' });
        const recent = makeSession('s-recent', [makeMessage('user', 'fix the memory leak')], { updatedAt: '2024-08-20T00:00:00.000Z' });
        const future = makeSession('s-future', [makeMessage('user', 'fix the memory leak')], { updatedAt: '2025-03-01T00:00:00.000Z' });
        engine.index(old);
        engine.index(recent);
        engine.index(future);

        const { results } = engine.search({
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

    // 7. Regex search â€” pattern matches across content.
    test('regex search matches pattern spanning content', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-regex', [
            makeMessage('assistant', 'hello, this is a wonderful world we live in'),
        ]);
        engine.index(session);

        const { results } = engine.search({ text: 'hello.*world', isRegex: true });

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].sessionId,   's-regex');
        assert.strictEqual(results[0].messageRole, 'assistant');
    });

    // 8. remove â€” searching after removal returns no results for that session.
    test('remove clears the session from search results', () => {
        const engine    = new FullTextSearchEngine();
        const session   = makeSession('s-remove',     [makeMessage('user', 'deploy application to production')]);
        // Companion ensures tokens reach MIN_DOC_FREQ so the main index is exercised (S11).
        const companion = makeSession('s-remove-cmp', [makeMessage('user', 'deploy application guide')]);
        engine.index(session);
        engine.index(companion);

        // Both sessions are found before removal.
        assert.strictEqual(engine.search({ text: 'deploy application' }).results.length, 2);
        assert.strictEqual(engine.size, 2);

        engine.remove('s-remove');

        assert.strictEqual(engine.size, 1);
        const { results } = engine.search({ text: 'deploy application' });
        assert.ok(!results.some(r => r.sessionId === 's-remove'), 's-remove must be gone');
        assert.strictEqual(results.length, 1, 'companion still matches');
    });

    // 9. index idempotency â€” indexing the same session twice does not duplicate results.
    test('indexing the same session twice yields no duplicate results', () => {
        const engine    = new FullTextSearchEngine();
        const session   = makeSession('s-idem',     [makeMessage('user', 'write unit tests parser functions')]);
        // Companion ensures tokens reach MIN_DOC_FREQ (S11).
        const companion = makeSession('s-idem-cmp', [makeMessage('user', 'unit tests parser guide')]);
        engine.index(session);
        engine.index(companion);
        engine.index(session);  // second call â€” should overwrite, not append.

        const { results } = engine.search({ text: 'unit tests parser' });

        assert.ok(results.length === 2, 'expected exactly 2 results (s-idem + companion), not duplicated');
        assert.strictEqual(engine.size, 2);
    });

    // 10. Empty query returns empty response.
    test('empty query text returns empty results', () => {
        const engine = new FullTextSearchEngine();
        const session = makeSession('s-empty', [
            makeMessage('user', 'some content that would normally match anything'),
        ]);
        engine.index(session);

        const response = engine.search({ text: '' });

        assert.deepStrictEqual(response, { results: [], totalCount: 0 });
    });

    // 11. searchRelaxedBySession — stop words must not inflate scores over specific terms.
    //     Regression: "restarted machine and docker does not start anymore" was
    //     failing to rank a Docker-specific session at the top because stop words
    //     ("not", "and", "does", "start") matched many generic sessions and gave
    //     them higher scores than the session containing the rare token "docker".
    test('searchRelaxedBySession ranks specific-token session above generic sessions', () => {
        const engine = new FullTextSearchEngine();

        // The target session: the one we want to find.
        const dockerSession = makeSession('s-docker', [
            makeMessage('user', 'Docker not starting after reboot issue'),
            makeMessage('assistant', 'Try restarting the Docker service and checking WSL2 configuration.'),
        ]);

        // Noise sessions that contain common stop words but nothing docker-specific.
        const generic1 = makeSession('s-generic-1', [
            makeMessage('user', 'How does not the build system start when I run it'),
        ]);
        const generic2 = makeSession('s-generic-2', [
            makeMessage('user', 'It does not start and I am not sure why — any ideas?'),
        ]);
        const generic3 = makeSession('s-generic-3', [
            makeMessage('user', 'Machine learning does not start training and fails'),
        ]);

        engine.index(dockerSession);
        engine.index(generic1);
        engine.index(generic2);
        engine.index(generic3);

        const results = engine.searchRelaxedBySession(
            'restarted machine and docker does not start anymore',
            5,
        );

        assert.ok(results.length >= 1, 'expected at least one result');
        assert.strictEqual(results[0].sessionId, 's-docker',
            'docker-specific session must rank first — stop words must not inflate generic sessions');
    });

    // 12. searchRelaxedBySession — hapax tokens score higher than main-index tokens.
    //     A rare token (hapax) appearing in only one session is more distinctive
    //     than a common token and should boost that session's score.
    test('searchRelaxedBySession boosts hapax-token sessions above common-token sessions', () => {
        const engine = new FullTextSearchEngine();

        // "kubernetes" only appears in one session (hapax) — it is highly distinctive.
        const kubernetesSession = makeSession('s-k8s', [
            makeMessage('user', 'kubernetes cluster pod scheduling issue'),
        ]);

        // "cluster" appears in two sessions — it's in the main index (less distinctive).
        const genericCluster = makeSession('s-cluster', [
            makeMessage('user', 'database cluster configuration problem'),
        ]);

        engine.index(kubernetesSession);
        engine.index(genericCluster);

        // Query matches "kubernetes" (hapax, score +2) and "cluster" (main, score +1).
        // s-k8s should score 3 (kubernetes hapax=2 + cluster main=1).
        // s-cluster should score 1 (cluster main=1 only).
        const results = engine.searchRelaxedBySession('kubernetes cluster', 5);

        assert.ok(results.length >= 1);
        assert.strictEqual(results[0].sessionId, 's-k8s',
            'session with hapax (rare) token must rank above session with only common tokens');
    });
});

