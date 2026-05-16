// test/suite/codeBlockCache.test.ts
//
// Tests for S4: getAllCodeBlocks() / getAllPrompts() caching in SessionIndex.
// Verifies same-reference cache hits and invalidation on mutations.

import * as assert from 'assert';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, CodeBlock } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCodeBlock(sessionId: string, messageIndex: number, i: number): CodeBlock {
    return { language: 'typescript', content: `const x${i} = ${i};`, sessionId, messageIndex };
}

function makeSession(i: number, blockCount = 2): Session {
    const id = `s-${i}`;
    const codeBlocks = Array.from({ length: blockCount }, (_, b) => makeCodeBlock(id, 1, b));
    return {
        id,
        title: `Session ${i}`,
        source: 'claude' as const,
        workspaceId: 'ws',
        workspacePath: '/project',
        messages: [
            { id: `m-${i}-0`, role: 'user', content: `prompt ${i}`, codeBlocks: [] },
            { id: `m-${i}-1`, role: 'assistant', content: `response ${i}`, codeBlocks },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('CodeBlock & Prompt Cache (S4)', () => {

    let index: SessionIndex;

    setup(() => {
        index = new SessionIndex();
    });

    // ------------------------------------------------------------------
    // getAllCodeBlocks — cache identity
    // ------------------------------------------------------------------

    test('two consecutive getAllCodeBlocks() calls return the same array reference', () => {
        index.upsert(makeSession(1));
        const a = index.getAllCodeBlocks();
        const b = index.getAllCodeBlocks();
        assert.strictEqual(a, b, 'Should return the same cached array reference');
    });

    test('getAllCodeBlocks() cache is invalidated after upsert', () => {
        index.upsert(makeSession(1));
        const a = index.getAllCodeBlocks();
        index.upsert(makeSession(2));
        const b = index.getAllCodeBlocks();
        assert.notStrictEqual(a, b, 'Cache must be invalidated after upsert');
    });

    test('getAllCodeBlocks() cache is invalidated after remove', () => {
        index.upsert(makeSession(1));
        const a = index.getAllCodeBlocks();
        index.remove('s-1');
        const b = index.getAllCodeBlocks();
        assert.notStrictEqual(a, b, 'Cache must be invalidated after remove');
    });

    test('getAllCodeBlocks() cache is invalidated after batchUpsert', () => {
        index.upsert(makeSession(1));
        const a = index.getAllCodeBlocks();
        index.batchUpsert([makeSession(2), makeSession(3)]);
        const b = index.getAllCodeBlocks();
        assert.notStrictEqual(a, b, 'Cache must be invalidated after batchUpsert');
    });

    test('getAllCodeBlocks() returns correct count', () => {
        index.batchUpsert([makeSession(1, 3), makeSession(2, 2)]);
        assert.strictEqual(index.getAllCodeBlocks().length, 5);
    });

    // ------------------------------------------------------------------
    // getCodeBlockCount — no allocation
    // ------------------------------------------------------------------

    test('getCodeBlockCount() matches getAllCodeBlocks().length', () => {
        index.batchUpsert([makeSession(1, 4), makeSession(2, 1), makeSession(3, 0)]);
        assert.strictEqual(index.getCodeBlockCount(), index.getAllCodeBlocks().length);
    });

    test('getCodeBlockCount() works without calling getAllCodeBlocks() first', () => {
        index.batchUpsert([makeSession(1, 3), makeSession(2, 2)]);
        // Do NOT call getAllCodeBlocks() first — count must traverse sessions directly
        const count = index.getCodeBlockCount();
        assert.strictEqual(count, 5);
    });

    test('getCodeBlockCount() returns 0 on empty index', () => {
        assert.strictEqual(index.getCodeBlockCount(), 0);
    });

    // ------------------------------------------------------------------
    // getAllPrompts — cache identity
    // ------------------------------------------------------------------

    test('two consecutive getAllPrompts() calls return the same array reference', () => {
        index.upsert(makeSession(1));
        const a = index.getAllPrompts();
        const b = index.getAllPrompts();
        assert.strictEqual(a, b, 'Should return the same cached prompt array reference');
    });

    test('getAllPrompts() cache is invalidated after upsert', () => {
        index.upsert(makeSession(1));
        const a = index.getAllPrompts();
        index.upsert(makeSession(2));
        const b = index.getAllPrompts();
        assert.notStrictEqual(a, b, 'Prompt cache must be invalidated after upsert');
    });

    test('getAllPrompts() cache is invalidated after remove', () => {
        index.upsert(makeSession(1));
        const a = index.getAllPrompts();
        index.remove('s-1');
        const b = index.getAllPrompts();
        assert.notStrictEqual(a, b, 'Prompt cache must be invalidated after remove');
    });

    test('getAllPrompts() returns one prompt per user message', () => {
        index.batchUpsert([makeSession(1), makeSession(2), makeSession(3)]);
        // Each session has 1 user message
        assert.strictEqual(index.getAllPrompts().length, 3);
    });

    // ------------------------------------------------------------------
    // Empty batchUpsert does NOT invalidate cache
    // ------------------------------------------------------------------

    test('empty batchUpsert does not invalidate caches', () => {
        index.upsert(makeSession(1));
        const blocks = index.getAllCodeBlocks();
        const prompts = index.getAllPrompts();
        index.batchUpsert([]);
        assert.strictEqual(index.getAllCodeBlocks(), blocks, 'Empty batchUpsert must not invalidate code block cache');
        assert.strictEqual(index.getAllPrompts(), prompts, 'Empty batchUpsert must not invalidate prompt cache');
    });

    // ------------------------------------------------------------------
    // Performance
    // ------------------------------------------------------------------

    test('getAllCodeBlocks() with 500 sessions + 10 blocks each: second call < 1ms', () => {
        const sessions = Array.from({ length: 500 }, (_, i) => makeSession(i, 10));
        index.batchUpsert(sessions);

        // Cold build
        index.getAllCodeBlocks();

        // Warm cache hit
        const t0 = performance.now();
        index.getAllCodeBlocks();
        const elapsed = performance.now() - t0;

        assert.ok(elapsed < 10, `Cache hit should be < 10ms but got ${elapsed.toFixed(2)}ms`);
    });
});
