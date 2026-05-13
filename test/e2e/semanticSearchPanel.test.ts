// test/suite/semanticSearchPanel.test.ts

import * as assert from 'assert';
import { buildItems, nextSourceState, sourceButtonTooltip, SemanticResultItem } from '../../src/search/semanticSearchPanel';
import { SemanticSearchResult } from '../../src/search/types';
import { SessionSummary } from '../../src/types/index';

// ── Fixture builders ───────────────────────────────────────────────────────

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

function makeResult(sessionId: string, score: number): SemanticSearchResult {
    return { sessionId, score };
}

// ── buildItems ─────────────────────────────────────────────────────────────

suite('buildItems', () => {
    test('returns empty array for empty results', () => {
        const items = buildItems([], new Map());
        assert.deepStrictEqual(items, []);
    });

    test('skips results whose sessionId is not in summaryMap', () => {
        const results = [makeResult('missing-id', 0.9)];
        const items = buildItems(results, new Map());
        assert.strictEqual(items.length, 0);
    });

    test('maps a result to correct label with source icon', () => {
        const summary = makeSummary({ source: 'copilot', title: 'Auth patterns' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.88)], map);

        assert.strictEqual(items.length, 1);
        assert.ok(items[0].label.includes('$(github)'), 'copilot should use github icon');
        assert.ok(items[0].label.includes('Auth patterns'), 'label should include title');
    });

    test('description includes workspacePath when present', () => {
        const summary = makeSummary({ workspacePath: '/home/user/myproject' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.75)], map);

        assert.ok(items[0].description?.includes('/home/user/myproject'));
    });

    test('description falls back to workspaceId when workspacePath is absent', () => {
        const summary = makeSummary({ workspacePath: undefined, workspaceId: 'ws-xyz' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.75)], map);

        assert.ok(items[0].description?.includes('ws-xyz'));
    });

    test('description includes ISO date (first 10 chars of updatedAt)', () => {
        const summary = makeSummary({ updatedAt: '2025-06-20T14:30:00.000Z' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.75)], map);

        assert.ok(items[0].description?.includes('2025-06-20'));
    });

    test('description includes score percentage rounded', () => {
        const summary = makeSummary();
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.876)], map);

        // Math.round(0.876 * 100) = 88
        assert.ok(items[0].description?.includes('Score: 88%'), `description was: ${items[0].description}`);
    });

    test('score field matches rounded percentage / 100 source', () => {
        const summary = makeSummary();
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.5)], map);

        // score stored as Math.round(0.5 * 100) = 50
        assert.strictEqual(items[0].score, 50);
    });

    test('summary field is the original SessionSummary', () => {
        const summary = makeSummary({ id: 'sess-1' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.9)], map);

        assert.strictEqual(items[0].summary, summary);
    });

    test('preserves result order from input', () => {
        const s1 = makeSummary({ id: 'a', title: 'Alpha' });
        const s2 = makeSummary({ id: 'b', title: 'Beta' });
        const map = new Map([['a', s1], ['b', s2]]);
        const results = [makeResult('a', 0.9), makeResult('b', 0.8)];
        const items = buildItems(results, map);

        assert.strictEqual(items[0].summary.id, 'a');
        assert.strictEqual(items[1].summary.id, 'b');
    });

    test('claude source uses hubot icon', () => {
        const summary = makeSummary({ source: 'claude', id: 'sess-1' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.7)], map);

        assert.ok(items[0].label.includes('$(hubot)'), 'claude should use hubot icon');
    });

    test('cursor source uses sparkle icon', () => {
        const summary = makeSummary({ source: 'cursor', id: 'sess-1' });
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 0.7)], map);

        assert.ok(items[0].label.includes('$(sparkle)'), 'cursor should use sparkle icon');
    });

    test('score of exactly 1.0 renders as Score: 100%', () => {
        const summary = makeSummary();
        const map = new Map([['sess-1', summary]]);
        const items = buildItems([makeResult('sess-1', 1.0)], map);

        assert.ok(items[0].description?.includes('Score: 100%'));
    });

    test('multiple valid results all appear in output', () => {
        const s1 = makeSummary({ id: 'a' });
        const s2 = makeSummary({ id: 'b' });
        const s3 = makeSummary({ id: 'c' });
        const map = new Map([['a', s1], ['b', s2], ['c', s3]]);
        const items = buildItems(
            [makeResult('a', 0.9), makeResult('b', 0.8), makeResult('c', 0.7)],
            map
        );

        assert.strictEqual(items.length, 3);
    });
});

// ── nextSourceState ────────────────────────────────────────────────────────

suite('nextSourceState', () => {
    test('all → copilot', () => {
        assert.strictEqual(nextSourceState('all'), 'copilot');
    });

    test('copilot → claude', () => {
        assert.strictEqual(nextSourceState('copilot'), 'claude');
    });

    test('claude → antigravity', () => {
        assert.strictEqual(nextSourceState('claude'), 'antigravity');
    });

    test('antigravity → all (wraps)', () => {
        assert.strictEqual(nextSourceState('antigravity'), 'all');
    });
});

// ── sourceButtonTooltip ────────────────────────────────────────────────────

suite('sourceButtonTooltip', () => {
    test('all state mentions Copilot as next', () => {
        const tip = sourceButtonTooltip('all');
        assert.ok(tip.toLowerCase().includes('copilot'), `tooltip: ${tip}`);
    });

    test('copilot state mentions Claude as next', () => {
        const tip = sourceButtonTooltip('copilot');
        assert.ok(tip.toLowerCase().includes('claude'), `tooltip: ${tip}`);
    });

    test('claude state mentions Antigravity as next', () => {
        const tip = sourceButtonTooltip('claude');
        assert.ok(tip.toLowerCase().includes('antigravity'), `tooltip: ${tip}`);
    });

    test('antigravity state mentions All as next', () => {
        const tip = sourceButtonTooltip('antigravity');
        assert.ok(tip.toLowerCase().includes('all'), `tooltip: ${tip}`);
    });
});

// ── SemanticResultItem shape ───────────────────────────────────────────────

suite('SemanticResultItem shape', () => {
    test('item has label, description, summary, and score', () => {
        const summary = makeSummary();
        const map = new Map([['sess-1', summary]]);
        const items: SemanticResultItem[] = buildItems([makeResult('sess-1', 0.85)], map);

        const item = items[0];
        assert.ok(typeof item.label === 'string');
        assert.ok(typeof item.description === 'string');
        assert.ok(typeof item.score === 'number');
        assert.ok(item.summary !== undefined);
    });
});
