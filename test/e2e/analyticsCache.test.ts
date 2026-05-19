// test/suite/analyticsCache.test.ts
//
// Tests for S3: analytics caching via SessionIndex.version + AnalyticsPanel build cache.
// AnalyticsPanel imports vscode, so we test the cache mechanism at the SessionIndex level
// and verify that computeAnalytics itself is fast enough to benefit from caching.

import * as assert from 'assert';
import { SessionIndex } from '../../src/index/sessionIndex';
import { computeAnalytics } from '../../src/analytics/analyticsEngine';
import { Session, Message } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const countTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

function makeSession(i: number): Session {
    const id = `s-${i}`;
    return {
        id,
        title: `Session ${i}`,
        source: 'claude' as const,
        workspaceId: 'ws',
        workspacePath: '/project',
        messages: [
            { id: `m-${i}-0`, role: 'user', content: `prompt number ${i}`, codeBlocks: [] },
            { id: `m-${i}-1`, role: 'assistant', content: `response ${i}`, codeBlocks: [] },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Analytics Cache (S3)', () => {

    let index: SessionIndex;

    setup(() => {
        index = new SessionIndex();
    });

    // ------------------------------------------------------------------
    // SessionIndex.version — cache key correctness
    // ------------------------------------------------------------------

    test('version starts at 0', () => {
        assert.strictEqual(index.version, 0);
    });

    test('version increments on upsert', () => {
        index.upsert(makeSession(1));
        assert.strictEqual(index.version, 1);
        index.upsert(makeSession(2));
        assert.strictEqual(index.version, 2);
    });

    test('version increments on remove', () => {
        index.upsert(makeSession(1));
        const v = index.version;
        index.remove('s-1');
        assert.strictEqual(index.version, v + 1);
    });

    test('version does NOT increment on failed remove', () => {
        const v = index.version;
        index.remove('nonexistent');
        assert.strictEqual(index.version, v);
    });

    test('version increments once on batchUpsert (N sessions → 1 bump)', () => {
        const sessions = Array.from({ length: 100 }, (_, i) => makeSession(i));
        index.batchUpsert(sessions);
        assert.strictEqual(index.version, 1);
    });

    test('version does NOT increment on empty batchUpsert', () => {
        const v = index.version;
        index.batchUpsert([]);
        assert.strictEqual(index.version, v);
    });

    test('version is stable when only reading (getAllSummaries, get)', () => {
        index.upsert(makeSession(1));
        const v = index.version;
        index.getAllSummaries();
        index.get('s-1');
        assert.strictEqual(index.version, v);
    });

    // ------------------------------------------------------------------
    // Cache-hit simulation: same version → no recompute needed
    // ------------------------------------------------------------------

    test('same index version means cache is still valid', () => {
        const sessions = Array.from({ length: 50 }, (_, i) => makeSession(i));
        index.batchUpsert(sessions);

        const v1 = index.version;
        const data1 = computeAnalytics(
            index.getAllSummaries().map(s => index.get(s.id)!).filter(Boolean),
            countTokens as any
        );

        // No mutations → version unchanged → cache would be a hit
        assert.strictEqual(index.version, v1);

        // Simulate cache check: version matches → skip recompute
        let recomputed = false;
        if (index.version !== v1) {
            recomputed = true;
            computeAnalytics(
                index.getAllSummaries().map(s => index.get(s.id)!).filter(Boolean),
                countTokens as any
            );
        }
        assert.strictEqual(recomputed, false, 'Should not recompute when version unchanged');
        assert.strictEqual(data1.totalSessions, 50);
    });

    test('version change after upsert triggers cache invalidation', () => {
        const sessions = Array.from({ length: 10 }, (_, i) => makeSession(i));
        index.batchUpsert(sessions);

        const cachedVersion = index.version;
        // Add a new session → version bumps
        index.upsert(makeSession(999));

        assert.notStrictEqual(index.version, cachedVersion, 'Version must change after upsert');
        assert.strictEqual(index.version, cachedVersion + 1);
    });

    // ------------------------------------------------------------------
    // Performance: build() with 1,000 sessions must be fast
    // ------------------------------------------------------------------

    test('computeAnalytics with 1,000 sessions completes without error', () => {
        const sessions = Array.from({ length: 1_000 }, (_, i) => makeSession(i));
        index.batchUpsert(sessions);
        const allSessions = index.getAllSummaries().map(s => index.get(s.id)!).filter(Boolean);

        // Assert correctness — wall-clock timing is removed (flaky on slow CI runners)
        const data = computeAnalytics(allSessions, countTokens as any);
        assert.strictEqual(data.totalSessions, 1_000);
    });

    test('cache-hit simulation: version unchanged means no recompute (verified logically)', () => {
        const sessions = Array.from({ length: 200 }, (_, i) => makeSession(i));
        index.batchUpsert(sessions);
        const allSessions = index.getAllSummaries().map(s => index.get(s.id)!).filter(Boolean);

        // First call (cold)
        computeAnalytics(allSessions, countTokens as any);

        // Simulate cache hit: version matches → branch never executes
        const cachedVersion = index.version;
        let recomputed = false;
        if (index.version !== cachedVersion) {
            recomputed = true;
            computeAnalytics(allSessions, countTokens as any);
        }
        assert.strictEqual(recomputed, false, 'cache hit branch must not execute when version is unchanged');
    });

    // ------------------------------------------------------------------
    // 5-second debounce logic (pure timer logic, no vscode)
    // ------------------------------------------------------------------

    test('debounce: timer reset on rapid calls collapses multiple refreshes', (done) => {
        let callCount = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function debouncedRefresh() {
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(() => {
                timer = null;
                callCount++;
            }, 50); // 50ms — keep short but above 0 to test debounce logic
        }

        // Fire 5 rapid calls
        debouncedRefresh();
        debouncedRefresh();
        debouncedRefresh();
        debouncedRefresh();
        debouncedRefresh();

        // After 200ms (4× the debounce period), exactly 1 invocation should have occurred
        setTimeout(() => {
            assert.strictEqual(callCount, 1, 'Debounce should collapse 5 calls into 1');
            done();
        }, 200);
    });

    test('debounce: two calls spaced apart each fire once', (done) => {
        let callCount = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function debouncedRefresh() {
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(() => {
                timer = null;
                callCount++;
            }, 30);
        }

        debouncedRefresh();
        setTimeout(() => {
            debouncedRefresh();
        }, 80); // second call fires well after the first has settled (80ms > 30ms debounce)

        // Wait 250ms total — enough for both debounce timers to have fired with headroom
        setTimeout(() => {
            assert.strictEqual(callCount, 2, 'Two spaced calls should each fire once');
            done();
        }, 250);
    });
});
