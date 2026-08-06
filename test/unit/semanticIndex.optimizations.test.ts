// test/unit/semanticIndex.optimizations.test.ts
// Unit tests for Item 4: O(1) has()/remove() via _indexedSessions

import * as assert from 'assert';
import { SemanticIndex } from '../../src/search/semanticIndex';

const DIMS = 384;
function fakeEmbedding(seed: number): Float32Array {
    const arr = new Float32Array(DIMS);
    // Normalise so dot product is well-behaved
    for (let i = 0; i < DIMS; i++) { arr[i] = (i + seed) % 17; }
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < DIMS; i++) { arr[i] /= mag; }
    return arr;
}

suite('SemanticIndex – O(1) session tracking', () => {
    test('has() returns false for missing session', () => {
        const idx = new SemanticIndex();
        assert.strictEqual(idx.has('nope'), false);
    });

    test('has() returns true after add()', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, fakeEmbedding(1));
        assert.strictEqual(idx.has('s1'), true);
    });

    test('has() returns false after remove()', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, fakeEmbedding(1));
        idx.remove('s1');
        assert.strictEqual(idx.has('s1'), false);
    });

    test('remove() of non-existent session is a no-op', () => {
        const idx = new SemanticIndex();
        assert.doesNotThrow(() => idx.remove('ghost'));
    });

    test('remove() only removes the target session', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, fakeEmbedding(1));
        idx.add('s2', 'assistant', 0, 0, fakeEmbedding(2));
        idx.remove('s1');
        assert.strictEqual(idx.has('s1'), false);
        assert.strictEqual(idx.has('s2'), true);
    });

    test('size decrements after remove()', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, fakeEmbedding(1));
        idx.add('s1', 'user', 1, 0, fakeEmbedding(2)); // second chunk, same session
        const before = idx.size;
        idx.remove('s1');
        assert.strictEqual(idx.size, 0, `expected 0 after remove, got ${idx.size} (was ${before})`);
    });

    test('_indexedSessions rebuilds after load()', async () => {
        const idx = new SemanticIndex();
        idx.add('session-abc', 'user', 0, 0, fakeEmbedding(3));

        const os = await import('os');
        const path = await import('path');
        const crypto = await import('crypto');
        const tmp = path.join(os.tmpdir(), `cw-test-${crypto.randomBytes(6).toString('hex')}.bin`);
        await idx.save(tmp);

        const idx2 = new SemanticIndex();
        await idx2.load(tmp);
        assert.strictEqual(idx2.has('session-abc'), true);

        // cleanup
        const fs = await import('fs');
        fs.unlinkSync(tmp);
    });
});