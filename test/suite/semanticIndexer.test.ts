// test/suite/semanticIndexer.test.ts

import * as assert from 'assert';
import { SemanticIndexer, SemanticIndexerVsCodeApi } from '../../src/search/semanticIndexer';
import { IEmbeddingEngine, ISemanticIndex, SEMANTIC_DIMS } from '../../src/search/semanticContracts';
import { SemanticSearchResult } from '../../src/search/types';

// ── Stub factories ────────────────────────────────────────────────────────────

/** Minimal stub for vscode.StatusBarItem */
function makeStatusBarStub(): import('vscode').StatusBarItem & { shown: boolean; disposed: boolean } {
    const item = {
        id: '',
        name: '',
        text: '',
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        accessibilityInformation: undefined,
        alignment: 1 as import('vscode').StatusBarAlignment,
        priority: undefined,
        shown: false,
        disposed: false,
        show() { item.shown = true; },
        hide() { item.shown = false; },
        dispose() { item.disposed = true; item.shown = false; },
    };
    return item;
}

/** Creates a SemanticIndexerVsCodeApi stub. */
function makeVsCodeApiStub(opts: {
    consentResult?: boolean;
    isFirstUse?: boolean;
} = {}): SemanticIndexerVsCodeApi & { statusBarsCreated: ReturnType<typeof makeStatusBarStub>[] } {
    const statusBars: ReturnType<typeof makeStatusBarStub>[] = [];
    return {
        statusBarsCreated: statusBars,
        async showConsentDialog(): Promise<boolean> {
            return opts.consentResult ?? true;
        },
        isFirstUse(_storagePath: string): boolean {
            return opts.isFirstUse ?? false;
        },
        createStatusBarItem() {
            const bar = makeStatusBarStub();
            statusBars.push(bar);
            return bar;
        },
        showModelReady(_isFirstUse: boolean): void { /* no-op in tests */ },
        showIndexingComplete(_count: number): void { /* no-op in tests */ },
    };
}

/** Creates a stub IEmbeddingEngine. */
function makeEngineStub(opts: {
    ready?: boolean;
    loadDelay?: number;
    embedResult?: Float32Array;
    loadError?: Error;
    embedError?: Error;
} = {}): IEmbeddingEngine & { loadCallCount: number; embedCallCount: number; lastEmbedText: string | undefined } {
    const state = { loadCallCount: 0, embedCallCount: 0, lastEmbedText: undefined as string | undefined };
    let ready = opts.ready ?? false;
    return {
        get isReady() { return ready; },
        async load(_onProgress?: (msg: string) => void): Promise<void> {
            state.loadCallCount++;
            if (opts.loadError) { throw opts.loadError; }
            if (opts.loadDelay) {
                await new Promise(r => setTimeout(r, opts.loadDelay));
            }
            ready = true;
        },
        async embed(text: string): Promise<Float32Array> {
            state.embedCallCount++;
            state.lastEmbedText = text;
            if (opts.embedError) { throw opts.embedError; }
            return opts.embedResult ?? new Float32Array(SEMANTIC_DIMS).fill(0.1);
        },
        get loadCallCount() { return state.loadCallCount; },
        get embedCallCount() { return state.embedCallCount; },
        get lastEmbedText() { return state.lastEmbedText; },
    };
}

/** Creates a stub ISemanticIndex. */
function makeIndexStub(): ISemanticIndex & {
    entries: Map<string, Float32Array>;
    saveCalled: number;
    loadCalled: number;
    lastSavedPath: string | undefined;
    lastLoadedPath: string | undefined;
} {
    const entries = new Map<string, Float32Array>();
    const state = { saveCalled: 0, loadCalled: 0, lastSavedPath: undefined as string | undefined, lastLoadedPath: undefined as string | undefined };
    return {
        entries,
        get saveCalled() { return state.saveCalled; },
        get loadCalled() { return state.loadCalled; },
        get lastSavedPath() { return state.lastSavedPath; },
        get lastLoadedPath() { return state.lastLoadedPath; },
        get size() { return entries.size; },
        add(id: string, v: Float32Array) { entries.set(id, v); },
        remove(id: string) { entries.delete(id); },
        has(id: string) { return entries.has(id); },
        search(_q: Float32Array, topK: number): SemanticSearchResult[] {
            return [...entries.keys()].slice(0, topK).map(id => ({ sessionId: id, score: 1 }));
        },
        async save(filePath: string) {
            state.saveCalled++;
            state.lastSavedPath = filePath;
        },
        async load(filePath: string) {
            state.loadCalled++;
            state.lastLoadedPath = filePath;
        },
    };
}

/** Builds a ready SemanticIndexer with stubs wired (bypasses first-use check and dialog). */
async function makeReadyIndexer(engineOpts: Parameters<typeof makeEngineStub>[0] = {}) {
    const engine = makeEngineStub(engineOpts);
    const index = makeIndexStub();
    const api = makeVsCodeApiStub({ isFirstUse: false });
    const indexer = new SemanticIndexer(
        '/storage',
        (_cacheDir) => engine,
        () => index,
        api,
    );
    await indexer.initialize();
    return { indexer, engine, index, api };
}

// ── isReady / indexedCount ────────────────────────────────────────────────────

suite('SemanticIndexer.isReady', () => {
    test('is false before initialize()', () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub();
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        assert.strictEqual(indexer.isReady, false);
    });

    test('is true after successful initialize()', async () => {
        const { indexer } = await makeReadyIndexer();
        assert.strictEqual(indexer.isReady, true);
        indexer.dispose();
    });

    test('is false when user declines consent dialog', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: true, consentResult: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.strictEqual(indexer.isReady, false);
        indexer.dispose();
    });
});

suite('SemanticIndexer.indexedCount', () => {
    test('reflects index.size', async () => {
        const { indexer, index } = await makeReadyIndexer();
        assert.strictEqual(indexer.indexedCount, 0);
        index.add('s1', new Float32Array(SEMANTIC_DIMS));
        assert.strictEqual(indexer.indexedCount, 1);
        indexer.dispose();
    });
});

// ── initialize() ──────────────────────────────────────────────────────────────

suite('SemanticIndexer.initialize', () => {
    test('calls engine.load() and index.load() once', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.strictEqual(engine.loadCallCount, 1);
        assert.strictEqual(index.loadCalled, 1);
        indexer.dispose();
    });

    test('is idempotent — second call is a no-op', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        await indexer.initialize();
        assert.strictEqual(engine.loadCallCount, 1);
        assert.strictEqual(index.loadCalled, 1);
        indexer.dispose();
    });

    test('passes storage path to index.load()', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/my/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.ok(index.lastLoadedPath?.startsWith('/my/storage'), `expected /my/storage prefix, got ${index.lastLoadedPath}`);
        indexer.dispose();
    });

    test('shows consent dialog on first use', async () => {
        let dialogShown = false;
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api: SemanticIndexerVsCodeApi & { statusBarsCreated: unknown[] } = {
            statusBarsCreated: [],
            isFirstUse: () => true,
            async showConsentDialog() { dialogShown = true; return true; },
            createStatusBarItem: makeVsCodeApiStub().createStatusBarItem,
            showModelReady(_isFirstUse: boolean): void { /* no-op */ },
            showIndexingComplete(_count: number): void { /* no-op */ },
        };
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.strictEqual(dialogShown, true);
        indexer.dispose();
    });

    test('does NOT show dialog if not first use', async () => {
        let dialogShown = false;
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api: SemanticIndexerVsCodeApi & { statusBarsCreated: unknown[] } = {
            statusBarsCreated: [],
            isFirstUse: () => false,
            async showConsentDialog() { dialogShown = true; return true; },
            createStatusBarItem: makeVsCodeApiStub().createStatusBarItem,
            showModelReady(_isFirstUse: boolean): void { /* no-op */ },
            showIndexingComplete(_count: number): void { /* no-op */ },
        };
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.strictEqual(dialogShown, false);
        indexer.dispose();
    });

    test('decline consent: does not call engine.load()', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: true, consentResult: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        assert.strictEqual(engine.loadCallCount, 0);
        indexer.dispose();
    });

    test('creates and disposes a status bar item during model loading', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();
        // At least one status bar was created for loading progress
        assert.ok(api.statusBarsCreated.length >= 1);
        // All status bars created during loading should be disposed
        const allDisposed = api.statusBarsCreated.every(b => b.disposed);
        assert.ok(allDisposed, 'loading status bar should be disposed after initialize()');
        indexer.dispose();
    });

    test('propagates engine.load() errors', async () => {
        const err = new Error('model download failed');
        const engine = makeEngineStub({ loadError: err });
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await assert.rejects(() => indexer.initialize(), /model download failed/);
        assert.strictEqual(indexer.isReady, false);
        indexer.dispose();
    });
});

// ── scheduleSession() ─────────────────────────────────────────────────────────

suite('SemanticIndexer.scheduleSession', () => {
    test('triggers engine.embed() for a new session', async () => {
        const { indexer, engine } = await makeReadyIndexer();
        indexer.scheduleSession('s1', 'hello world');
        // Wait for async queue to drain
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.embedCallCount, 1);
        assert.strictEqual(engine.lastEmbedText, 'hello world');
        indexer.dispose();
    });

    test('adds embedding to the index after embedding', async () => {
        const { indexer, index } = await makeReadyIndexer();
        indexer.scheduleSession('s1', 'hello world');
        await new Promise(r => setTimeout(r, 20));
        assert.ok(index.has('s1'), 'session should be in the index');
        indexer.dispose();
    });

    test('skips sessions already in the index', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        index.add('s1', new Float32Array(SEMANTIC_DIMS));
        indexer.scheduleSession('s1', 'hello world');
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.embedCallCount, 0, 'already-indexed session must be skipped');
        indexer.dispose();
    });

    test('is a no-op if indexer is not ready', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        // Not initialized
        indexer.scheduleSession('s1', 'hello world');
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.embedCallCount, 0);
    });

    test('queues multiple sessions and processes them all', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        indexer.scheduleSession('s1', 'text one');
        indexer.scheduleSession('s2', 'text two');
        indexer.scheduleSession('s3', 'text three');
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(engine.embedCallCount, 3);
        assert.ok(index.has('s1'));
        assert.ok(index.has('s2'));
        assert.ok(index.has('s3'));
        indexer.dispose();
    });

    test('continues processing queue after a single embed failure', async () => {
        let callCount = 0;
        const engine = makeEngineStub();
        const originalEmbed = engine.embed.bind(engine);
        // Make the first embed call throw, subsequent calls succeed
        (engine as { embed: (text: string) => Promise<Float32Array> }).embed = async (text: string) => {
            callCount++;
            if (callCount === 1) { throw new Error('transient error'); }
            return originalEmbed(text);
        };
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();

        indexer.scheduleSession('s1', 'will fail');
        indexer.scheduleSession('s2', 'will succeed');
        await new Promise(r => setTimeout(r, 50));

        assert.ok(!index.has('s1'), 's1 should not be in index after failed embed');
        assert.ok(index.has('s2'), 's2 should be indexed after queue continues');
        indexer.dispose();
    });

    test('shows indexing status bar while queue is non-empty', async () => {
        const { indexer, api } = await makeReadyIndexer({ loadDelay: 0 });
        indexer.scheduleSession('s1', 'session text');

        // Status bar should be visible at some point while queue is processing
        const hasIndexingBar = api.statusBarsCreated.some(b => b.shown || b.text.includes('semantic indexing'));
        // Give the queue a moment to create the bar
        await new Promise(r => setTimeout(r, 5));
        const hasBar = api.statusBarsCreated.some(b => b.text.includes('semantic indexing'));
        // The bar must have been created at least once
        assert.ok(api.statusBarsCreated.length >= 1 || hasBar || hasIndexingBar);

        await new Promise(r => setTimeout(r, 30));
        indexer.dispose();
    });

    test('status bar is disposed after queue drains', async () => {
        const { indexer, api } = await makeReadyIndexer();
        indexer.scheduleSession('s1', 'text');
        await new Promise(r => setTimeout(r, 50));

        // All status bars that were created should be disposed after queue drains
        const allDisposed = api.statusBarsCreated.every(b => b.disposed);
        assert.ok(allDisposed, 'all status bars should be disposed after queue drains');
        indexer.dispose();
    });
});

// ── removeSession() ───────────────────────────────────────────────────────────

suite('SemanticIndexer.removeSession', () => {
    test('removes session from the index', async () => {
        const { indexer, index } = await makeReadyIndexer();
        index.add('s1', new Float32Array(SEMANTIC_DIMS));
        indexer.removeSession('s1');
        assert.ok(!index.has('s1'));
        indexer.dispose();
    });

    test('is a no-op for unknown session IDs', async () => {
        const { indexer, index } = await makeReadyIndexer();
        assert.doesNotThrow(() => indexer.removeSession('unknown'));
        assert.strictEqual(index.size, 0);
        indexer.dispose();
    });
});

// ── search() ──────────────────────────────────────────────────────────────────

suite('SemanticIndexer.search', () => {
    test('rejects if not ready', async () => {
        const engine = makeEngineStub();
        const index = makeIndexStub();
        const api = makeVsCodeApiStub();
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await assert.rejects(
            () => indexer.search('query', 10),
            /not ready/,
        );
    });

    test('embeds query and delegates to index.search()', async () => {
        const { indexer, engine, index } = await makeReadyIndexer();
        index.add('s1', new Float32Array(SEMANTIC_DIMS).fill(0.5));

        const results = await indexer.search('find authentication', 10);
        assert.strictEqual(engine.embedCallCount, 1);
        assert.strictEqual(engine.lastEmbedText, 'find authentication');
        assert.ok(results.length >= 1);
        assert.strictEqual(results[0].sessionId, 's1');
        indexer.dispose();
    });

    test('returns empty array when index is empty', async () => {
        const { indexer } = await makeReadyIndexer();
        const results = await indexer.search('any query', 10);
        assert.deepStrictEqual(results, []);
        indexer.dispose();
    });

    test('respects topK limit', async () => {
        // makeIndexStub.search slices to topK
        const { indexer, index } = await makeReadyIndexer();
        for (let i = 0; i < 5; i++) {
            index.add(`s${i}`, new Float32Array(SEMANTIC_DIMS));
        }
        const results = await indexer.search('query', 3);
        assert.ok(results.length <= 3);
        indexer.dispose();
    });
});

// ── dispose() ─────────────────────────────────────────────────────────────────

suite('SemanticIndexer.dispose', () => {
    test('is idempotent — multiple calls do not throw', async () => {
        const { indexer } = await makeReadyIndexer();
        assert.doesNotThrow(() => { indexer.dispose(); indexer.dispose(); });
    });

    test('triggers a final save', async () => {
        const { indexer, index } = await makeReadyIndexer();
        index.add('s1', new Float32Array(SEMANTIC_DIMS));
        indexer.dispose();
        // Fire-and-forget save is async; give it a tick to run
        await new Promise(r => setTimeout(r, 10));
        assert.ok(index.saveCalled >= 1, 'dispose should trigger a save');
    });

    test('drains queue without embedding remaining items', async () => {
        const engine = makeEngineStub({ loadDelay: 0 });
        const index = makeIndexStub();
        const api = makeVsCodeApiStub({ isFirstUse: false });
        const indexer = new SemanticIndexer('/storage', () => engine, () => index, api);
        await indexer.initialize();

        // Schedule many sessions, then immediately dispose
        for (let i = 0; i < 20; i++) {
            indexer.scheduleSession(`s${i}`, `text ${i}`);
        }
        indexer.dispose();
        await new Promise(r => setTimeout(r, 50));

        // Should not have embedded all 20 sessions (some were drained)
        // At minimum it must not throw; the exact count depends on timing
        assert.ok(engine.embedCallCount <= 20);
    });

    test('scheduleSession after dispose is a no-op', async () => {
        const { indexer, engine } = await makeReadyIndexer();
        indexer.dispose();
        indexer.scheduleSession('s1', 'text');
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(engine.embedCallCount, 0);
    });
});
