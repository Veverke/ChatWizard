// test/e2e/scalabilityOptimizations.e2e.test.ts
// E2E-style integration tests for scalability optimizations (Items 4, 5, 7, 8)
// These tests exercise the full pipeline without a live VS Code window.

import * as assert from 'assert';
import { SemanticIndex } from '../../src/search/semanticIndex';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';
import { Session } from '../../src/types/index';

// ── Helpers ────────────────────────────────────────────────────────────────

const DIMS = 384;

function embedding(seed: number): Float32Array {
    const arr = new Float32Array(DIMS);
    for (let i = 0; i < DIMS; i++) { arr[i] = ((i * seed + 7) % 23) / 23; }
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < DIMS; i++) { arr[i] /= mag; }
    return arr;
}

function session(id: string, content: string, updatedAt = '2024-01-01T00:00:00Z'): Session {
    return {
        id,
        source: 'claude',
        title: `Session ${id}`,
        messages: [
            { id: 'u1', role: 'user', content, timestamp: '', codeBlocks: [] },
            { id: 'a1', role: 'assistant', content: `response to ${content}`, timestamp: '', codeBlocks: [] },
        ],
        workspaceId: 'ws',
        filePath: `/tmp/${id}.json`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt,
    };
}

// ── SemanticIndex O(1) integration ─────────────────────────────────────────

suite('E2E: SemanticIndex scalability (Item 4)', () => {
    test('add 1000 entries across 100 sessions, has() remains O(1)', () => {
        const idx = new SemanticIndex();
        for (let s = 0; s < 100; s++) {
            for (let m = 0; m < 10; m++) {
                idx.add(`session-${s}`, 'user', m, 0, embedding(s + m));
            }
        }
        assert.strictEqual(idx.size, 1000);
        // has() should return true for all 100 sessions
        for (let s = 0; s < 100; s++) {
            assert.ok(idx.has(`session-${s}`), `session-${s} should be present`);
        }
        // remove half
        for (let s = 0; s < 50; s++) {
            idx.remove(`session-${s}`);
        }
        assert.strictEqual(idx.size, 500);
        for (let s = 0; s < 50; s++) {
            assert.ok(!idx.has(`session-${s}`), `session-${s} should be gone`);
        }
        for (let s = 50; s < 100; s++) {
            assert.ok(idx.has(`session-${s}`), `session-${s} should remain`);
        }
    });
});

// ── FTS fingerprint integration ────────────────────────────────────────────

suite('E2E: FullTextEngine fingerprint (Item 8)', () => {
    test('re-indexing 200 sessions with same content does not grow postings', () => {
        const engine = new FullTextSearchEngine();
        const sessions = Array.from({ length: 200 }, (_, i) =>
            session(`s${i}`, `unique content about topic${i} and docker containers`)
        );
        for (const s of sessions) { engine.index(s); }
        const statsFirst = engine.indexStats();

        // Re-index all — fingerprints unchanged, so no re-tokenization
        for (const s of sessions) { engine.index(s); }
        const statsSecond = engine.indexStats();

        assert.strictEqual(statsFirst.postingCount, statsSecond.postingCount,
            'postings should not grow when re-indexing unchanged sessions');
    });

    test('updating a session content is reflected in search results', () => {
        const engine = new FullTextSearchEngine();
        const s1 = session('s1', 'original kubernetes deployment content', '2024-01-01T00:00:00Z');
        engine.index(s1);

        // Replace with different content and newer timestamp
        const s2 = session('s1', 'completely new terraform infrastructure', '2024-06-01T00:00:00Z');
        engine.index(s2);

        const results = engine.searchRelaxedBySession('terraform', 5);
        assert.ok(results.some(r => r.sessionId === 's1'), 'updated content should be searchable');
    });
});

// ── LRU render cache integration ───────────────────────────────────────────

suite('E2E: SessionWebviewPanel LRU cache (Item 7)', () => {
    setup(() => { SessionWebviewPanel._renderCache.clear(); });

    test('cache never exceeds RENDER_CACHE_MAX entries', () => {
        const max = SessionWebviewPanel.RENDER_CACHE_MAX;
        for (let i = 0; i < max * 2; i++) {
            SessionWebviewPanel._renderCacheSet(`session-${i}::2024-01-01`, [null, null]);
        }
        assert.ok(SessionWebviewPanel._renderCache.size <= max,
            `cache size ${SessionWebviewPanel._renderCache.size} exceeds max ${max}`);
    });

    test('most recently inserted entry is always retained', () => {
        const max = SessionWebviewPanel.RENDER_CACHE_MAX;
        for (let i = 0; i < max + 5; i++) {
            SessionWebviewPanel._renderCacheSet(`key-${i}`, [null]);
        }
        // The last inserted key should always survive
        assert.ok(SessionWebviewPanel._renderCache.has(`key-${max + 4}`));
    });
});