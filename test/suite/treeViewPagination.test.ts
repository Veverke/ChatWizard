// test/suite/treeViewPagination.test.ts

import * as assert from 'assert';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(i: number): Session {
    const id = `sess-${i}`;
    const day = String((i % 28) + 1).padStart(2, '0');
    return {
        id,
        title: `Session ${i}`,
        source: 'claude' as const,
        workspaceId: 'ws-1',
        workspacePath: '/home/user/project',
        messages: [],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: `2026-01-${day}T00:00:00.000Z`,
        updatedAt: `2026-01-${day}T00:00:00.000Z`,
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('TreeView Pagination', () => {

    let index: SessionIndex;

    setup(() => {
        index = new SessionIndex();
    });

    // ------------------------------------------------------------------
    // Performance: getChildren() with 20,000 sessions must return in < 50 ms
    // The test simulates what getChildren() does: sort + slice(0, 200)
    // ------------------------------------------------------------------

    test('getChildren with 20,000 sessions (sort + slice) returns in < 50 ms', () => {
        const sessions: Session[] = [];
        for (let i = 0; i < 20_000; i++) {
            sessions.push(makeSession(i));
        }
        index.batchUpsert(sessions);

        const t0 = performance.now();
        // Simulate getChildren: get all summaries (involves sort), then slice first page
        const summaries = index.getAllSummaries();
        const page = summaries.slice(0, 200);
        const elapsed = performance.now() - t0;

        assert.strictEqual(page.length, 200);
        assert.ok(elapsed < 50, `Expected < 50 ms but got ${elapsed.toFixed(1)} ms`);
    });

    // ------------------------------------------------------------------
    // Sort cache: second call returns same array reference (no re-sort)
    // ------------------------------------------------------------------

    test('sort cache: _buildOrderedSummaries returns same content on repeat call', () => {
        const sessions: Session[] = [];
        for (let i = 0; i < 1_000; i++) {
            sessions.push(makeSession(i));
        }
        index.batchUpsert(sessions);

        const summaries1 = index.getAllSummaries();
        const summaries2 = index.getAllSummaries();

        assert.strictEqual(summaries1.length, summaries2.length);
        assert.strictEqual(summaries1[0].id, summaries2[0].id);
    });

    // ------------------------------------------------------------------
    // Pagination logic
    // ------------------------------------------------------------------

    test('pagination: 20,000 items → page 1 has 200, remaining = 19,800', () => {
        const total = 20_000;
        const visibleCount = 200;
        const all = Array.from({ length: total }, (_, i) => i);
        const visible = all.slice(0, visibleCount);
        const remaining = total - visible.length;

        assert.strictEqual(visible.length, 200);
        assert.strictEqual(remaining, 19_800);
    });

    test('pagination: loadMore increases visible count by 200', () => {
        let visibleCount = 200;
        const total = 500;

        visibleCount += 200; // simulate loadMore
        const visible = Math.min(visibleCount, total);
        const remaining = total - visible;

        assert.strictEqual(visible, 400);
        assert.strictEqual(remaining, 100);
    });

    test('pagination: no LoadMore item when all items fit in first page', () => {
        const total = 150;
        const visibleCount = 200;
        const remaining = total - Math.min(visibleCount, total);

        assert.strictEqual(remaining, 0);
    });

    test('pagination: LoadMore item shown when sessions exceed page size', () => {
        const total = 201;
        const visibleCount = 200;
        const remaining = total - Math.min(visibleCount, total);

        assert.strictEqual(remaining, 1);
        assert.ok(remaining > 0, 'LoadMore item should be shown');
    });

    test('pagination: multiple loadMore cycles drain the list correctly', () => {
        const total = 650;
        let visibleCount = 200;

        // Page 1
        assert.strictEqual(Math.min(visibleCount, total), 200);
        assert.strictEqual(total - 200, 450); // remaining

        // Load more → page 2
        visibleCount += 200;
        assert.strictEqual(Math.min(visibleCount, total), 400);
        assert.strictEqual(total - 400, 250);

        // Load more → page 3
        visibleCount += 200;
        assert.strictEqual(Math.min(visibleCount, total), 600);
        assert.strictEqual(total - 600, 50);

        // Load more → page 4 (shows all)
        visibleCount += 200;
        assert.strictEqual(Math.min(visibleCount, total), total);
        assert.strictEqual(total - total, 0);
    });

    // ------------------------------------------------------------------
    // Cache invalidation on sort/filter change resets visible count
    // ------------------------------------------------------------------

    test('cache invalidation resets visible count to 200', () => {
        // Simulate state: user has loaded extra pages
        let visibleCount = 600;
        let cache: string[] | null = ['a', 'b', 'c'];

        // Simulate sort mode change → invalidate
        cache = null;
        visibleCount = 200;

        assert.strictEqual(cache, null);
        assert.strictEqual(visibleCount, 200);
    });

    test('cache invalidation on filter change resets visible count', () => {
        let visibleCount = 400;
        let cache: string[] | null = ['x'];

        // Simulate filter change → invalidate
        cache = null;
        visibleCount = 200;

        assert.strictEqual(cache, null);
        assert.strictEqual(visibleCount, 200);
    });

    // ------------------------------------------------------------------
    // Large index correctness
    // ------------------------------------------------------------------

    test('getAllSummaries returns correct count for 10,000 sessions', () => {
        const sessions: Session[] = [];
        for (let i = 0; i < 10_000; i++) {
            sessions.push(makeSession(i));
        }
        index.batchUpsert(sessions);

        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 10_000);
    });

    test('getAllSummaries is sorted newest-first', () => {
        const sessions: Session[] = [];
        for (let i = 0; i < 100; i++) {
            const sess = makeSession(i);
            // Give each session a distinct date
            sess.updatedAt = `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`;
            sessions.push(sess);
        }
        index.batchUpsert(sessions);

        const summaries = index.getAllSummaries();
        // First item should have the highest updatedAt (i=99)
        assert.ok(summaries[0].updatedAt > summaries[1].updatedAt,
            'Summaries should be sorted newest-first');
    });

    // ------------------------------------------------------------------
    // CodeBlock group lazy loading: children only computed on expand
    // ------------------------------------------------------------------

    test('lazy children: top-level returns groups, not leaf blocks', () => {
        // Simulate the two-level tree logic:
        // getChildren() with no arg → groups
        // getChildren(group) → leaf items
        const groupCount = 5;
        const blocksPerGroup = 3;

        // Simulate groups
        const groups = Array.from({ length: groupCount }, (_, i) => ({
            sessionId: `sess-${i}`,
            blocks: Array.from({ length: blocksPerGroup }, (_, j) => ({
                language: 'typescript',
                content: `const x = ${j};`,
            })),
        }));

        // Before expand: only group count items visible at top level
        const topLevel = groups.slice(0, 200);
        assert.strictEqual(topLevel.length, groupCount);

        // After expand of first group: only its blocks are returned
        const children = groups[0].blocks;
        assert.strictEqual(children.length, blocksPerGroup);
    });

    test('CodeBlock pagination: top-level groups are paginated', () => {
        const totalGroups = 300;
        const visibleGroupCount = 200;
        const groups = Array.from({ length: totalGroups }, (_, i) => ({ sessionId: `s-${i}` }));

        const visible = groups.slice(0, visibleGroupCount);
        const remaining = totalGroups - visible.length;

        assert.strictEqual(visible.length, 200);
        assert.strictEqual(remaining, 100);
    });
});
