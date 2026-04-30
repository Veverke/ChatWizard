// test/suite/embeddingEngine.test.ts

import * as assert from 'assert';
import { EmbeddingEngine, PipelineFactory } from '../../src/search/embeddingEngine';
import { SEMANTIC_DIMS } from '../../src/search/semanticContracts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a PipelineFactory stub that returns a pipeline producing a fixed vector. */
function makeMockFactory(
    embedding: Float32Array = new Float32Array(SEMANTIC_DIMS).fill(0.1),
    opts: { delay?: number; shouldThrow?: Error } = {},
): { factory: PipelineFactory; callCount: number; lastText: string | undefined } {
    const state = { callCount: 0, lastText: undefined as string | undefined };
    const factory: PipelineFactory = async (_cacheDir, _onProgress) => {
        if (opts.shouldThrow) {
            throw opts.shouldThrow;
        }
        state.callCount++;
        return async (text: string, _options: Record<string, unknown>) => {
            state.lastText = text;
            if (opts.delay) {
                await new Promise(r => setTimeout(r, opts.delay));
            }
            return { data: embedding };
        };
    };
    return { factory, ...state };
}

// ── isReady ───────────────────────────────────────────────────────────────────

suite('EmbeddingEngine.isReady', () => {
    test('is false before load() is called', () => {
        const { factory } = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', factory);
        assert.strictEqual(eng.isReady, false);
    });

    test('is true after load() resolves', async () => {
        const { factory } = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load();
        assert.strictEqual(eng.isReady, true);
    });

    test('remains false if load() throws', async () => {
        const err = new Error('download failed');
        const { factory } = makeMockFactory(new Float32Array(SEMANTIC_DIMS), { shouldThrow: err });
        const eng = new EmbeddingEngine('/cache', factory);
        await assert.rejects(() => eng.load(), /download failed/);
        assert.strictEqual(eng.isReady, false);
    });
});

// ── load() ────────────────────────────────────────────────────────────────────

suite('EmbeddingEngine.load', () => {
    test('calls the factory exactly once on first load', async () => {
        const mock = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', mock.factory);
        await eng.load();
        assert.strictEqual(mock.callCount, 1);
    });

    test('is idempotent — second call does not reinvoke the factory', async () => {
        const mock = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', mock.factory);
        await eng.load();
        await eng.load();
        assert.strictEqual(mock.callCount, 1);
    });

    test('concurrent calls share the same promise and invoke factory once', async () => {
        const mock = makeMockFactory(new Float32Array(SEMANTIC_DIMS), { delay: 20 });
        const eng = new EmbeddingEngine('/cache', mock.factory);
        await Promise.all([eng.load(), eng.load(), eng.load()]);
        assert.strictEqual(mock.callCount, 1);
    });

    test('forwards progress messages to onProgress callback', async () => {
        const messages: string[] = [];
        // Factory that invokes onProgress manually to simulate xenova progress events
        const factory: PipelineFactory = async (_cacheDir, onProgress) => {
            onProgress?.('Downloading model.onnx: 50%');
            onProgress?.('Loaded model.onnx');
            return async (_text, _opts) => ({ data: new Float32Array(SEMANTIC_DIMS).fill(0) });
        };
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load(msg => messages.push(msg));
        assert.ok(messages.includes('Downloading model.onnx: 50%'));
        assert.ok(messages.includes('Loaded model.onnx'));
    });

    test('propagates factory errors without swallowing them', async () => {
        const err = new Error('network error');
        const { factory } = makeMockFactory(new Float32Array(SEMANTIC_DIMS), { shouldThrow: err });
        const eng = new EmbeddingEngine('/cache', factory);
        await assert.rejects(() => eng.load(), /network error/);
    });
});

// ── embed() ───────────────────────────────────────────────────────────────────

suite('EmbeddingEngine.embed', () => {
    test('throws if called before load()', async () => {
        const { factory } = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', factory);
        await assert.rejects(
            () => eng.embed('hello'),
            /not ready/,
        );
    });

    test('returns a Float32Array of SEMANTIC_DIMS length', async () => {
        const { factory } = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load();
        const result = await eng.embed('hello world');
        assert.ok(result instanceof Float32Array);
        assert.strictEqual(result.length, SEMANTIC_DIMS);
    });

    test('passes full text to the pipeline (no clipping)', async () => {
        const mock = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', mock.factory);
        await eng.load();
        const longText = 'x'.repeat(5000);
        await eng.embed(longText);
        assert.strictEqual(mock.lastText, longText, 'full text should be passed without clipping');
    });

    test('does not alter short text', async () => {
        const mock = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', mock.factory);
        await eng.load();
        const shortText = 'find authentication patterns';
        await eng.embed(shortText);
        assert.strictEqual(mock.lastText, shortText);
    });

    test('converts non-Float32Array data to Float32Array', async () => {
        // Simulate xenova returning a regular Array (edge case)
        const arr = Array.from({ length: SEMANTIC_DIMS }, (_, i) => i / SEMANTIC_DIMS);
        const factory: PipelineFactory = async () => async (_text, _opts) => ({ data: arr });
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load();
        const result = await eng.embed('test');
        assert.ok(result instanceof Float32Array);
        assert.strictEqual(result.length, SEMANTIC_DIMS);
    });

    test('throws if pipeline returns wrong embedding dimension', async () => {
        const wrongDim = new Float32Array(10).fill(0.5);
        const factory: PipelineFactory = async () => async (_text, _opts) => ({ data: wrongDim });
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load();
        await assert.rejects(
            () => eng.embed('test'),
            new RegExp(`Expected ${SEMANTIC_DIMS}-dim embedding, got 10`),
        );
    });

    test('embeds empty string without error', async () => {
        const { factory } = makeMockFactory();
        const eng = new EmbeddingEngine('/cache', factory);
        await eng.load();
        const result = await eng.embed('');
        assert.ok(result instanceof Float32Array);
        assert.strictEqual(result.length, SEMANTIC_DIMS);
    });
});

// ── Integration suite (real model) ───────────────────────────────────────────
// Gated by CW_RUN_INTEGRATION_TESTS=1 to keep the fast suite offline.

if (process.env['CW_RUN_INTEGRATION_TESTS'] === '1') {
    suite('EmbeddingEngine — integration (real model)', function () {
        this.timeout(120_000); // first run downloads the model (~22 MB)

        const CACHE_DIR = require('path').join(require('os').tmpdir(), 'cw-test-model-cache');

        test('load() downloads and caches the model', async () => {
            const eng = new EmbeddingEngine(CACHE_DIR);
            const messages: string[] = [];
            await eng.load(msg => messages.push(msg));
            assert.strictEqual(eng.isReady, true);
        });

        test('embed() returns a normalized 384-dim vector', async () => {
            const eng = new EmbeddingEngine(CACHE_DIR);
            await eng.load();
            const result = await eng.embed('find sessions about authentication patterns');
            assert.strictEqual(result.length, SEMANTIC_DIMS);
            // Verify approximate unit norm (normalized vectors have norm ≈ 1)
            let norm = 0;
            for (let i = 0; i < result.length; i++) {
                norm += result[i] ** 2;
            }
            assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 1e-3, `norm should be ~1, got ${Math.sqrt(norm)}`);
        });

        test('similar texts produce higher cosine similarity than dissimilar texts', async () => {
            const eng = new EmbeddingEngine(CACHE_DIR);
            await eng.load();

            function dot(a: Float32Array, b: Float32Array): number {
                let s = 0;
                for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; }
                return s;
            }

            const query = await eng.embed('authentication and login security');
            const similar = await eng.embed('user login and password validation');
            const dissimilar = await eng.embed('refactor database query performance');

            const simScore = dot(query, similar);
            const dissimScore = dot(query, dissimilar);
            assert.ok(
                simScore > dissimScore,
                `similar score ${simScore.toFixed(3)} should exceed dissimilar score ${dissimScore.toFixed(3)}`,
            );
        });
    });
}
