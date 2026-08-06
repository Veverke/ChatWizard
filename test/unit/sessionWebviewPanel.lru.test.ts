// test/unit/sessionWebviewPanel.lru.test.ts
// Unit tests for Item 7: Bounded LRU render cache in SessionWebviewPanel

import * as assert from 'assert';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';

suite('SessionWebviewPanel – LRU render cache', () => {
    setup(() => {
        SessionWebviewPanel._renderCache.clear();
    });

    test('_renderCacheSet stores an entry', () => {
        SessionWebviewPanel._renderCacheSet('key1', ['<p>hello</p>', null]);
        assert.ok(SessionWebviewPanel._renderCache.has('key1'));
    });

    test('_renderCacheSet evicts oldest entry when at capacity', () => {
        const max = SessionWebviewPanel.RENDER_CACHE_MAX;

        // Fill to capacity
        for (let i = 0; i < max; i++) {
            SessionWebviewPanel._renderCacheSet(`key${i}`, [null]);
        }
        assert.strictEqual(SessionWebviewPanel._renderCache.size, max);

        // Insert one more — should evict 'key0'
        SessionWebviewPanel._renderCacheSet('overflow', [null]);
        assert.strictEqual(SessionWebviewPanel._renderCache.size, max);
        assert.ok(!SessionWebviewPanel._renderCache.has('key0'), 'oldest key should be evicted');
        assert.ok(SessionWebviewPanel._renderCache.has('overflow'), 'new key should be present');
    });

    test('entries below capacity are not evicted', () => {
        SessionWebviewPanel._renderCacheSet('a', [null]);
        SessionWebviewPanel._renderCacheSet('b', [null]);
        assert.strictEqual(SessionWebviewPanel._renderCache.size, 2);
        assert.ok(SessionWebviewPanel._renderCache.has('a'));
        assert.ok(SessionWebviewPanel._renderCache.has('b'));
    });

    test('RENDER_CACHE_MAX is 50', () => {
        assert.strictEqual(SessionWebviewPanel.RENDER_CACHE_MAX, 50);
    });
});