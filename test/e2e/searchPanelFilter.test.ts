// test/e2e/searchPanelFilter.test.ts
//
// Tests for the "Session contains…" filter entry point of
// `Chat Wizard: Filter Sessions…`, which reuses the full-text search QuickPick:
//
//   search response → preview rows (read-only) → ✓ OK → SessionFilter.contentSessionIds
//
// The preview list must stay a *preview* (no row opens a session) while the OK
// button reports the query plus the distinct IDs of the sessions it matched, so
// the Sessions view can hide everything else.

import * as assert from 'assert';

import { buildSearchItems, collectMatchedSessionIds } from '../../src/search/searchPanel';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { SearchResponse, SearchResult } from '../../src/search/types';
import { SessionIndex } from '../../src/index/sessionIndex';
import { SessionTreeItem, SessionTreeProvider } from '../../src/views/sessionTreeProvider';
import { Session, SessionSummary } from '../../src/types/index';
import { friendlySourceName } from '../../src/ui/sourceUi';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id:                   'sess-1',
        title:                'Auth patterns session',
        source:               'copilot',
        workspaceId:          'ws-abc',
        workspacePath:        '/home/user/myproject',
        filePath:             '/fake/sess-1.jsonl',
        messageCount:         4,
        userMessageCount:     2,
        assistantMessageCount: 2,
        createdAt:            '2025-01-15T10:00:00.000Z',
        updatedAt:            '2025-06-20T14:30:00.000Z',
        ...overrides,
    };
}

function makeHit(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
        sessionId:    'sess-1',
        messageIndex: 1,
        messageRole:  'user',
        snippet:      '…how do I debounce a function in TypeScript?…',
        matchStart:   34,
        matchEnd:     44,
        score:        2,
        ...overrides,
    };
}

function makeResponse(results: SearchResult[], totalCount = results.length): SearchResponse {
    return { results, totalCount };
}

function makeSession(id: string, userContent: string, assistantContent = 'Sure.'): Session {
    return {
        id,
        title:       `Session ${id}`,
        source:      'copilot',
        workspaceId: 'ws-default',
        workspacePath: '/home/user/project',
        messages: [
            { id: `${id}-u`, role: 'user',      content: userContent,      codeBlocks: [] },
            { id: `${id}-a`, role: 'assistant', content: assistantContent, codeBlocks: [] },
        ],
        filePath:   `/tmp/${id}.jsonl`,
        createdAt:  '2026-01-01T00:00:00.000Z',
        updatedAt:  '2026-01-01T00:00:00.000Z',
    };
}

async function visibleSessionIds(provider: SessionTreeProvider): Promise<string[]> {
    const rootChildren = await provider.getChildren(undefined);

// ---------------------------------------------------------------------------
// collectMatchedSessionIds
// ---------------------------------------------------------------------------

suite('collectMatchedSessionIds', () => {
    test('returns an empty list for an empty response', () => {
        assert.deepStrictEqual(collectMatchedSessionIds(makeResponse([])), []);
    });

    test('deduplicates repeated hits from the same session, keeping first-seen order', () => {
        const ids = collectMatchedSessionIds(makeResponse([
            makeHit({ sessionId: 'b', score: 5 }),
            makeHit({ sessionId: 'a', score: 4 }),
            makeHit({ sessionId: 'b', score: 3, messageIndex: 3 }),
            makeHit({ sessionId: 'c', score: 1 }),
        ]));

        assert.deepStrictEqual(ids, ['b', 'a', 'c']);
    });

    test('keeps every matched session, independent of the summary lookup', () => {
        // The filter must not silently drop a match just because the tree has no
        // summary for it — the tree simply has nothing to show for that ID.
        const ids = collectMatchedSessionIds(makeResponse([makeHit({ sessionId: 'not-in-index' })]));
        assert.deepStrictEqual(ids, ['not-in-index']);
    });
});

// ---------------------------------------------------------------------------
// buildSearchItems (preview rows)
// ---------------------------------------------------------------------------

suite('buildSearchItems — Session contains… preview', () => {
    test('renders one preview row per session, even with several matching messages', () => {
        const summary = makeSummary();
        const items = buildSearchItems(makeResponse([
            makeHit({ score: 9 }),
            makeHit({ score: 4, messageIndex: 5 }),
        ]), new Map([[summary.id, summary]]));

        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].summary.id, 'sess-1');
        assert.strictEqual(items[0].result.score, 9, 'the highest-scoring hit represents the session');
    });

    test('label carries the source icon and the session title', () => {
        const summary = makeSummary({ source: 'claude', title: 'Debounce helpers' });
        const items = buildSearchItems(makeResponse([makeHit()]), new Map([[summary.id, summary]]));

        assert.ok(items[0].label.includes('$(hubot)'), `label was: ${items[0].label}`);
        assert.ok(items[0].label.includes('Debounce helpers'));
    });

    test('detail is prefixed with "You:" for user turns and the source name for responses', () => {
        const summary = makeSummary({ source: 'copilot' });
        const map = new Map([[summary.id, summary]]);

        const userItems = buildSearchItems(makeResponse([makeHit({ messageRole: 'user' })]), map);
        assert.ok(userItems[0].detail?.startsWith('You:  '), `detail was: ${userItems[0].detail}`);

        const assistantItems = buildSearchItems(makeResponse([makeHit({ messageRole: 'assistant' })]), map);
        assert.ok(
            assistantItems[0].detail?.startsWith(`${friendlySourceName('copilot')}:  `),
            `detail was: ${assistantItems[0].detail}`,
        );
    });

    test('highlights the matched range inside the snippet detail', () => {
        const summary = makeSummary();
        const items = buildSearchItems(
            makeResponse([makeHit({ matchStart: 5, matchEnd: 12 })]),
            new Map([[summary.id, summary]]),
        );

        const highlights = (items[0] as unknown as { highlights: { detail: number[][] } }).highlights;
        // "You" (3) + ":  " (3) = 6 characters of prefix
        assert.deepStrictEqual(highlights.detail, [[11, 18]]);
    });

    test('adds a truncation banner when the response was capped', () => {
        const summary = makeSummary();
        const items = buildSearchItems(makeResponse([makeHit()], 900), new Map([[summary.id, summary]]));

        assert.strictEqual(items.length, 2);
        assert.ok(items[0].label.includes('Showing top 1 of 900 results'), `label was: ${items[0].label}`);
        assert.strictEqual(items[0].result, undefined, 'the banner is not a result row');
        assert.strictEqual(items[1].summary.id, 'sess-1');
    });

    test('skips hits whose session is no longer in the index', () => {
        const items = buildSearchItems(makeResponse([makeHit({ sessionId: 'gone' })]), new Map());
        assert.strictEqual(items.length, 0);
    });
});

    const ids: string[] = [];
    for (const child of rootChildren) {
        if (child instanceof SessionTreeItem) { ids.push(child.summary.id); }
    }
    return ids.sort();
}

// ---------------------------------------------------------------------------
// End to end: search response → filter → Sessions view
// ---------------------------------------------------------------------------

suite('Session contains… — search result applied as a Sessions view filter', () => {
    /** Index three sessions and return an engine with all of them indexed. */
    function buildFixture(): { index: SessionIndex; engine: FullTextSearchEngine } {
        const index = new SessionIndex();
        const engine = new FullTextSearchEngine();

        const sessions = [
            makeSession('s-ts-1', 'How do I debounce a function in TypeScript?'),
            makeSession('s-ts-2', 'TypeScript generics explained, with TypeScript examples.'),
            makeSession('s-css',  'How to center a div in CSS?'),
        ];
        for (const session of sessions) {
            index.upsert(session);
            engine.index(session);
        }

        return { index, engine };
    }

    test('the matched session IDs hide every non-matching session', async () => {
        const { index, engine } = buildFixture();

        const matched = collectMatchedSessionIds(engine.search({ text: 'typescript' }));
        assert.deepStrictEqual([...matched].sort(), ['s-ts-1', 's-ts-2']);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        assert.strictEqual((await visibleSessionIds(provider)).length, 3);

        provider.setFilter({ content: 'typescript', contentSessionIds: new Set(matched) });

        assert.deepStrictEqual(await visibleSessionIds(provider), ['s-ts-1', 's-ts-2']);
    });

    test('the active filter is announced in the view title', async () => {
        const { index, engine } = buildFixture();
        const matched = collectMatchedSessionIds(engine.search({ text: 'typescript' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ content: 'typescript', contentSessionIds: new Set(matched) });

        assert.strictEqual(provider.hasActiveFilter(), true);
        assert.strictEqual(provider.getFilter().content, 'typescript');
        assert.ok(
            provider.getDescription().includes('contains:"typescript"'),
            `description was: ${provider.getDescription()}`,
        );
    });

    test('a query with no matches filters everything out (an active, empty filter)', async () => {
        const { index, engine } = buildFixture();

        const matched = collectMatchedSessionIds(engine.search({ text: 'kubernetes' }));
        assert.deepStrictEqual(matched, []);

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ content: 'kubernetes', contentSessionIds: new Set(matched) });

        assert.deepStrictEqual(await visibleSessionIds(provider), []);
        assert.strictEqual(provider.hasActiveFilter(), true);
    });

    test('clearing the filter restores every session', async () => {
        const { index, engine } = buildFixture();
        const matched = collectMatchedSessionIds(engine.search({ text: 'typescript' }));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({ content: 'typescript', contentSessionIds: new Set(matched) });
        assert.strictEqual((await visibleSessionIds(provider)).length, 2);

        provider.clearFilter();
        assert.strictEqual((await visibleSessionIds(provider)).length, 3);
        assert.strictEqual(provider.hasActiveFilter(), false);
    });

    test('the content filter composes with the other filters', async () => {
        const { index, engine } = buildFixture();
        const claudeSession = makeSession('s-ts-claude', 'TypeScript unions in Claude.');
        claudeSession.source = 'claude';
        index.upsert(claudeSession);
        engine.index(claudeSession);

        const matched = collectMatchedSessionIds(engine.search({ text: 'typescript' }));
        assert.ok(matched.includes('s-ts-claude'));

        const provider = new SessionTreeProvider(index);
        provider.setGroupMode('none');
        provider.setFilter({
            content: 'typescript',
            contentSessionIds: new Set(matched),
            source: 'claude',
        });

        assert.deepStrictEqual(await visibleSessionIds(provider), ['s-ts-claude']);
    });
});

