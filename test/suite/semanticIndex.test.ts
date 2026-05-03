// test/suite/semanticIndex.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticIndex } from '../../src/search/semanticIndex';
import { SEMANTIC_DIMS } from '../../src/search/semanticContracts';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a random unit-normalised Float32Array of length SEMANTIC_DIMS */
function randomUnitVector(): Float32Array {
    const v = new Float32Array(SEMANTIC_DIMS);
    let norm = 0;
    for (let i = 0; i < SEMANTIC_DIMS; i++) {
        v[i] = Math.random() * 2 - 1;
        norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < SEMANTIC_DIMS; i++) {
        v[i] /= norm;
    }
    return v;
}

/** Temporary file path that is cleaned up after each test */
function tmpFile(): string {
    return path.join(os.tmpdir(), `cw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
}

// ── Class skeleton / CRUD ──────────────────────────────────────────────────

suite('SemanticIndex — CRUD', () => {
    test('starts with size 0', () => {
        const idx = new SemanticIndex();
        assert.strictEqual(idx.size, 0);
    });

    test('add() increments size', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        assert.strictEqual(idx.size, 1);
        idx.add('s2', 'user', 0, 0, randomUnitVector());
        assert.strictEqual(idx.size, 2);
    });

    test('add() with the same id overwrites without increasing size', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        assert.strictEqual(idx.size, 1);
    });

    test('has() returns true after add, false before add', () => {
        const idx = new SemanticIndex();
        assert.strictEqual(idx.has('s1'), false);
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        assert.strictEqual(idx.has('s1'), true);
    });

    test('remove() decrements size and has() returns false afterwards', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        idx.remove('s1');
        assert.strictEqual(idx.size, 0);
        assert.strictEqual(idx.has('s1'), false);
    });

    test('remove() on nonexistent id is a no-op', () => {
        const idx = new SemanticIndex();
        assert.doesNotThrow(() => idx.remove('nonexistent'));
        assert.strictEqual(idx.size, 0);
    });
});

// ── search() ───────────────────────────────────────────────────────────────

suite('SemanticIndex — search()', () => {
    test('returns empty array when index is empty', () => {
        const idx = new SemanticIndex();
        const results = idx.search(randomUnitVector(), 10);
        assert.deepStrictEqual(results, []);
    });

    test('returns at most topK results', () => {
        const idx = new SemanticIndex();
        for (let i = 0; i < 10; i++) {
            idx.add(`s${i}`, 'user', 0, i, randomUnitVector());
        }
        const results = idx.search(randomUnitVector(), 3);
        assert.strictEqual(results.length, 3);
    });

    test('returns all results when size < topK', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        idx.add('s2', 'user', 0, 0, randomUnitVector());
        const results = idx.search(randomUnitVector(), 20, -1);
        assert.strictEqual(results.length, 2);
    });

    test('results are sorted descending by score', () => {
        const idx = new SemanticIndex();
        for (let i = 0; i < 5; i++) {
            idx.add(`s${i}`, 'user', 0, i, randomUnitVector());
        }
        const results = idx.search(randomUnitVector(), 5);
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].score >= results[i].score,
                `score at ${i - 1} (${results[i - 1].score}) < score at ${i} (${results[i].score})`);
        }
    });

    test('identical query vector scores ~1.0 as rank-1', () => {
        const idx = new SemanticIndex();
        const target = randomUnitVector();
        idx.add('target', 'user', 0, 0, target);
        idx.add('other1', 'user', 0, 0, randomUnitVector());
        idx.add('other2', 'user', 0, 0, randomUnitVector());

        const results = idx.search(target, 3);
        assert.strictEqual(results[0].sessionId, 'target');
        // dot product of a unit vector with itself == 1 (allow tiny float error)
        assert.ok(results[0].score > 0.9999, `Expected score ~1 but got ${results[0].score}`);
    });

    test('result items have sessionId, role, messageIndex, paragraphIndex and score fields', () => {
        const idx = new SemanticIndex();
        idx.add('abc', 'user', 2, 0, randomUnitVector());
        const results = idx.search(randomUnitVector(), 1, -1);
        assert.ok('sessionId' in results[0]);
        assert.ok('score' in results[0]);
        assert.ok('role' in results[0]);
        assert.ok('messageIndex' in results[0]);
        assert.ok('paragraphIndex' in results[0]);
        assert.strictEqual(results[0].sessionId, 'abc');
        assert.strictEqual(results[0].role, 'user');
        assert.strictEqual(results[0].messageIndex, 2);
        assert.strictEqual(results[0].paragraphIndex, 0);
    });
});

// ── search() scope filter ──────────────────────────────────────────────────

suite('SemanticIndex — search() scope filter', () => {
    test('scope=user excludes assistant entries', () => {
        const idx = new SemanticIndex();
        const v = randomUnitVector();
        idx.add('s1', 'user', 0, 0, v);
        idx.add('s1', 'assistant', 1, 0, randomUnitVector());
        const results = idx.search(v, 10, 0, 'user');
        assert.ok(results.every(r => r.role === 'user'), 'All results should be user role');
    });

    test('scope=assistant excludes user entries', () => {
        const idx = new SemanticIndex();
        const v = randomUnitVector();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        idx.add('s1', 'assistant', 1, 0, v);
        const results = idx.search(v, 10, 0, 'assistant');
        assert.ok(results.every(r => r.role === 'assistant'), 'All results should be assistant role');
    });

    test('scope=both returns entries from both roles', () => {
        const idx = new SemanticIndex();
        idx.add('s1', 'user', 0, 0, randomUnitVector());
        idx.add('s1', 'assistant', 1, 0, randomUnitVector());
        const results = idx.search(randomUnitVector(), 10, -1, 'both');
        assert.strictEqual(results.length, 2);
    });

    test('scope filter on empty index returns []', () => {
        const idx = new SemanticIndex();
        assert.deepStrictEqual(idx.search(randomUnitVector(), 10, 0, 'user'), []);
    });
});

// ── save() / load() round-trip ─────────────────────────────────────────────

suite('SemanticIndex — save() / load() round-trip', () => {
    test('round-trip preserves all entries', async () => {
        const file = tmpFile();
        try {
            const a = new SemanticIndex();
            const v1 = randomUnitVector();
            const v2 = randomUnitVector();
            a.add('session-1', 'user', 0, 0, v1);
            a.add('session-2', 'user', 1, 0, v2);
            await a.save(file);

            const b = new SemanticIndex();
            await b.load(file);

            assert.strictEqual(b.size, 2);
            assert.strictEqual(b.has('session-1'), true);
            assert.strictEqual(b.has('session-2'), true);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('round-trip preserves embedding values (float32 precision)', async () => {
        const file = tmpFile();
        try {
            const a = new SemanticIndex();
            const v = randomUnitVector();
            a.add('s1', 'user', 0, 0, v);
            await a.save(file);

            const b = new SemanticIndex();
            await b.load(file);

            // Search with the same vector — round-tripped entry should be rank 1
            b.add('s2', 'user', 1, 0, randomUnitVector());
            const results = b.search(v, 2);
            assert.strictEqual(results[0].sessionId, 's1');
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('header magic bytes are correct', async () => {
        const file = tmpFile();
        try {
            const idx = new SemanticIndex();
            await idx.save(file);

            const buf = fs.readFileSync(file);
            // Magic "CWSE"
            assert.strictEqual(buf[0], 0x43);
            assert.strictEqual(buf[1], 0x57);
            assert.strictEqual(buf[2], 0x53);
            assert.strictEqual(buf[3], 0x45);
            // Version 2
            assert.strictEqual(buf.readUInt32LE(4), 2);
            // Dims 384
            assert.strictEqual(buf.readUInt32LE(8), 384);
            // Count 0
            assert.strictEqual(buf.readUInt32LE(12), 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('empty index saves and reloads as empty', async () => {
        const file = tmpFile();
        try {
            const a = new SemanticIndex();
            await a.save(file);

            const b = new SemanticIndex();
            await b.load(file);

            assert.strictEqual(b.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });
});

// ── load() resilience ─────────────────────────────────────────────────────

suite('SemanticIndex — load() resilience', () => {
    test('missing file → starts empty, no throw', async () => {
        const idx = new SemanticIndex();
        await assert.doesNotReject(() => idx.load('/nonexistent/path/file.bin'));
        assert.strictEqual(idx.size, 0);
    });

    test('empty (0-byte) file → starts empty, no throw', async () => {
        const file = tmpFile();
        try {
            fs.writeFileSync(file, Buffer.alloc(0));
            const idx = new SemanticIndex();
            await assert.doesNotReject(() => idx.load(file));
            assert.strictEqual(idx.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('3-byte truncated file → starts empty, no throw', async () => {
        const file = tmpFile();
        try {
            fs.writeFileSync(file, Buffer.from([0x43, 0x57, 0x53]));
            const idx = new SemanticIndex();
            await assert.doesNotReject(() => idx.load(file));
            assert.strictEqual(idx.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('bad magic bytes → starts empty, no throw', async () => {
        const file = tmpFile();
        try {
            const buf = Buffer.alloc(16, 0);
            buf.write('BAAD', 0, 'ascii');
            buf.writeUInt32LE(1, 4);
            buf.writeUInt32LE(SEMANTIC_DIMS, 8);
            buf.writeUInt32LE(0, 12);
            fs.writeFileSync(file, buf);

            const idx = new SemanticIndex();
            await assert.doesNotReject(() => idx.load(file));
            assert.strictEqual(idx.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('dims mismatch → starts empty, no throw', async () => {
        const file = tmpFile();
        try {
            const buf = Buffer.alloc(16, 0);
            Buffer.from([0x43, 0x57, 0x53, 0x45]).copy(buf, 0);
            buf.writeUInt32LE(2, 4); // version 2
            buf.writeUInt32LE(128, 8); // wrong dims
            buf.writeUInt32LE(0, 12);
            fs.writeFileSync(file, buf);

            const idx = new SemanticIndex();
            await assert.doesNotReject(() => idx.load(file));
            assert.strictEqual(idx.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('truncated entry data → starts empty, no throw', async () => {
        const file = tmpFile();
        try {
            // Valid v2 header declaring 1 entry, but no actual entry data
            const buf = Buffer.alloc(16, 0);
            Buffer.from([0x43, 0x57, 0x53, 0x45]).copy(buf, 0);
            buf.writeUInt32LE(2, 4); // version 2
            buf.writeUInt32LE(SEMANTIC_DIMS, 8);
            buf.writeUInt32LE(1, 12); // claims 1 entry
            fs.writeFileSync(file, buf);

            const idx = new SemanticIndex();
            await assert.doesNotReject(() => idx.load(file));
            assert.strictEqual(idx.size, 0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test('load() into non-empty index replaces content', async () => {
        const file = tmpFile();
        try {
            // Save index with one session
            const a = new SemanticIndex();
            a.add('s1', 'user', 0, 0, randomUnitVector());
            await a.save(file);

            // Load into already-populated index
            const b = new SemanticIndex();
            b.add('pre-existing', 'user', 0, 0, randomUnitVector());
            await b.load(file);

            assert.strictEqual(b.size, 1);
            assert.strictEqual(b.has('s1'), true);
            assert.strictEqual(b.has('pre-existing'), false);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

});


