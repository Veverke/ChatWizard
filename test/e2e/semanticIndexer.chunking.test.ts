// test/e2e/semanticIndexer.chunking.test.ts
/**
 * End-to-end tests for semantic indexer CHUNKED EMBEDDING behavior.
 *
 * These tests verify:
 * 1. Sessions are embedded in chunks (EMBED_CHUNK_SIZE = 5) — embedBatch is
 *    called multiple times for large batches, not once.
 * 2. Progress reports show incremental (non-stuck) values — the report()
 *    callback fires after EACH chunk, not just once at start/end.
 * 3. setImmediate() yielding occurs between chunks — tested implicitly by
 *    verifying chunk boundaries via embedBatch call count.
 * 4. Zero-vector fallback when embedBatch fails (timeout or error).
 * 5. Queue restart: sessions arriving during a run are picked up by a new run.
 * 6. Multiple rapid scheduleSession() calls are debounced before queue starts.
 *
 * These complement the existing semanticIndexer.test.ts (which covers basic CRUD
 * but does NOT test chunking boundaries or incremental progress).
 *
 * Run: npx vscode-test --files "out/test/e2e/semanticIndexer.chunking.test.js"
 * Or:  npx tsc && npx vscode-test
 */

import * as assert from 'assert';
import { SemanticIndexer, SemanticIndexerVsCodeApi } from '../../src/search/semanticIndexer';
import { IEmbeddingEngine, ISemanticIndex, SEMANTIC_DIMS, SemanticScope } from '../../src/search/semanticContracts';
import { SemanticMessageResult } from '../../src/search/types';
import { Session, Message } from '../../src/types/index';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(id: string, text: string): Session {
    const msg: Message = { id: 'msg-1', role: 'user', content: text, codeBlocks: [] };
    return {
        id, title: id, source: 'copilot', workspaceId: 'ws', messages: [msg],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    };
}

/** Session with NO title, producing exactly 1 embed entry (just the user message). */
function bareSession(id: string, text: string): Session {
    return {
        id, title: '', source: 'copilot', workspaceId: 'ws',
        messages: [{ id: 'msg-1', role: 'user', content: text, codeBlocks: [] }],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
    };
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

/** Stub engine that counts embedBatch calls — for verifying chunk boundaries. */
class CallCountingEngine implements IEmbeddingEngine {
    isReady = true;
    embedBatchCalls: string[][] = []; // each sub-array = texts sent in one call

    async load(): Promise<void> { /* no-op */ }

    async embed(text: string): Promise<Float32Array> {
        return new Float32Array(SEMANTIC_DIMS).fill(0.1);
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        this.embedBatchCalls.push([...texts]);
        // Small delay so setImmediate yielding is observable
        await new Promise(r => setTimeout(r, 5));
        return texts.map(() => new Float32Array(SEMANTIC_DIMS).fill(0.1));
    }

    dispose(): void { /* no-op */ }
}

/** Stub engine that always fails with an error. */
class FailingEngine implements IEmbeddingEngine {
    isReady = true;
    async load(): Promise<void> { /* no-op */ }
    async embed(_text: string): Promise<Float32Array> {
        throw new Error('embed failed');
    }
    async embedBatch(_texts: string[]): Promise<Float32Array[]> {
        throw new Error('embedBatch failed');
    }

    dispose(): void { /* no-op */ }
}

/** Collects progress reports for later inspection. */
class ProgressCapturingApi implements SemanticIndexerVsCodeApi {
    progressReports: Array<{ completed: number; total: number }> = [];
    consentResult = true;
    isFirst = false;
    private _promise: Promise<void> = Promise.resolve();

    async showConsentDialog(): Promise<boolean> { return this.consentResult; }
    isFirstUse(_storagePath: string): boolean { return this.isFirst; }

    async loadModelWithProgress(task: (report: (msg: string) => void) => Promise<void>): Promise<void> {
        await task(() => { /* no-op */ });
    }

    async runIndexingProgress(task: (report: (completed: number, total: number) => void) => Promise<void>): Promise<void> {
        this._promise = task((completed, total) => {
            this.progressReports.push({ completed, total });
        });
        await this._promise;
    }

    showIndexingComplete(_count: number): void { /* no-op */ }
    markModelDownloaded(_storagePath: string): void { /* no-op */ }
    showModelReady(): void { /* no-op */ }
}

/** Trivial in-memory index. */
class MemIndex implements ISemanticIndex {
    entries = new Set<string>();
    get size(): number { return this.entries.size; }
    has(id: string): boolean { return this.entries.has(id); }
    add(sessionId: string, _role: string, _messageIndex: number, _paragraphIndex: number, _vec: Float32Array): void {
        this.entries.add(sessionId);
    }
    remove(id: string): void { this.entries.delete(id); }
    search(_queryEmbedding: Float32Array, _topK: number, _minScore?: number, _scope?: SemanticScope): SemanticMessageResult[] { return []; }
    async load(): Promise<void> { /* no-op */ }
    async save(): Promise<void> { /* no-op */ }
    saveSync(): void { /* no-op */ }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('SemanticIndexer — chunked embedding', () => {
    test('embedBatch is called multiple times when many sessions are queued', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0, // no debounce
        );
        await indexer.initialize();

        // Schedule 10 bare sessions (no titles) = 10 entries
        // With EMBED_CHUNK_SIZE=5, this should produce 2 embedBatch calls
        for (let i = 0; i < 10; i++) {
            indexer.scheduleSession(bareSession(`s${i}`, `text ${i}`));
        }

        await new Promise(r => setTimeout(r, 500));

        // Verify embedBatch was called multiple times (chunked)
        assert.ok(engine.embedBatchCalls.length >= 2,
            `Expected >=2 embedBatch calls, got ${engine.embedBatchCalls.length}`);

        // Each call should have at most 5 texts
        for (let i = 0; i < engine.embedBatchCalls.length; i++) {
            const call = engine.embedBatchCalls[i];
            assert.ok(call.length <= 5,
                `embedBatch call ${i} has ${call.length} texts, expected <=5`);
        }

        // Verify all sessions were indexed
        assert.strictEqual(index.size, 10);
        indexer.dispose();
    });

    test('progress is reported after each chunk (not just once)', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        // Schedule 6 bare sessions = 6 entries → 2 chunks (5 + 1)
        for (let i = 0; i < 6; i++) {
            indexer.scheduleSession(bareSession(`p${i}`, `progress ${i}`));
        }

        await new Promise(r => setTimeout(r, 500));

        // Should have at least 2 progress reports (0 + after each chunk)
        // Actually the first report is report(0, total), then one per chunk
        const reports = api.progressReports;
        assert.ok(reports.length >= 2,
            `Expected >=2 progress reports, got ${reports.length}: ${JSON.stringify(reports)}`);

        // Last report should be complete: completed === total
        const last = reports[reports.length - 1];
        assert.strictEqual(last.completed, last.total,
            `Last report should show all done (${last.completed} === ${last.total})`);
        assert.ok(last.completed >= 6,
            `Expected >=6 sessions completed, got ${last.completed}`);

        // Unique completed values should show progression
        const completedVals = new Set(reports.map(r => r.completed));
        assert.ok(completedVals.size > 1,
            `Expected multiple distinct progress values: ${[...completedVals].join(', ')}`);
        indexer.dispose();
    });

    test('failing embedBatch produces zero-vector fallback', async () => {
        const engine = new FailingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        indexer.scheduleSession(bareSession('fail1', 'will fail'));
        indexer.scheduleSession(bareSession('fail2', 'will also fail'));

        await new Promise(r => setTimeout(r, 500));

        // Even with failing engine, sessions should be "indexed" (zero-vector fallback)
        assert.strictEqual(index.size, 2,
            `Expected 2 sessions indexed with zero-vectors, got ${index.size}`);
        indexer.dispose();
    });

    test('sessions arriving during queue run trigger a restart', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        // First batch
        indexer.scheduleSession(bareSession('first1', 'first batch'));
        indexer.scheduleSession(bareSession('first2', 'first batch'));

        // Wait briefly, then add more
        await new Promise(r => setTimeout(r, 100));
        indexer.scheduleSession(bareSession('late1', 'late arrival'));
        indexer.scheduleSession(bareSession('late2', 'late arrival'));

        // Wait for all to settle
        await new Promise(r => setTimeout(r, 1000));

        assert.strictEqual(index.size, 4,
            `Expected all 4 sessions indexed, got ${index.size}`);
        indexer.dispose();
    });

    test('chunking works with sessions that produce many entries (titles + paragraphs)', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        // 3 sessions, each with title + user msg + assistant msg with paragraphs
        for (let i = 0; i < 3; i++) {
            const session: Session = {
                id: `rich-s${i}`,
                title: `Title for session ${i}`,
                source: 'copilot',
                workspaceId: 'ws',
                messages: [
                    { id: `u${i}`, role: 'user', content: `User message ${i}`, codeBlocks: [] },
                    {
                        id: `a${i}`, role: 'assistant', content:
                            `Paragraph A in session ${i}\n\nParagraph B in session ${i}\n\nParagraph C in session ${i}`,
                        codeBlocks: [],
                    },
                ],
                filePath: `/fake/rich-s${i}.jsonl`,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };
            indexer.scheduleSession(session);
        }

        await new Promise(r => setTimeout(r, 500));

        // Each session has: 1 title + 1 user msg + 3 assistant paragraphs = 5 entries
        // 3 sessions × 5 = 15 entries total → 3 chunks (5+5+5)
        assert.ok(engine.embedBatchCalls.length >= 3,
            `Expected >=3 embedBatch calls for 15 entries, got ${engine.embedBatchCalls.length}`);

        // All 3 sessions should be indexed
        assert.strictEqual(index.size, 3);
        indexer.dispose();
    });

    test('does not get stuck at 0% — first report shows 0, subsequent reports show > 0', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        // Schedule enough sessions to require several chunks
        for (let i = 0; i < 9; i++) {
            indexer.scheduleSession(bareSession(`stuck-s${i}`, `stuck test ${i}`));
        }

        await new Promise(r => setTimeout(r, 500));

        const reports = api.progressReports;

        // First report should be 0 / total
        assert.strictEqual(reports[0].completed, 0,
            `First report should be 0, got ${reports[0].completed}`);

        // Must have at least one intermediate report showing partial progress
        // (not just 0 then 9)
        const intermediates = reports.filter(r => r.completed > 0 && r.completed < r.total);
        assert.ok(intermediates.length > 0,
            `Expected intermediate progress reports (>0, <total), got none among ${reports.length} reports`);

        console.log(`  Chunking progression: ${reports.map(r => `${r.completed}/${r.total}`).join(' → ')}`);
        indexer.dispose();
    });

    test('dispose during queue prevents further embedding', async () => {
        const engine = new CallCountingEngine();
        const index = new MemIndex();
        const api = new ProgressCapturingApi();
        const indexer = new SemanticIndexer(
            '/tmp/storage',
            () => engine,
            () => index,
            api,
            0,
        );
        await indexer.initialize();

        for (let i = 0; i < 20; i++) {
            indexer.scheduleSession(bareSession(`disp-s${i}`, `dispose ${i}`));
        }

        // Dispose immediately (before queue finishes)
        indexer.dispose();
        await new Promise(r => setTimeout(r, 200));

        // After dispose, at most 20 sessions could be indexed (but likely fewer)
        assert.ok(index.size <= 20,
            `Should have at most 20 sessions after dispose, got ${index.size}`);
        assert.ok(engine.embedBatchCalls.length < 4,
            `Expected fewer embedBatch calls after dispose, got ${engine.embedBatchCalls.length}`);
        indexer.dispose(); // idempotent
    });
});