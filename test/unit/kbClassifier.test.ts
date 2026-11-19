/**
 * test/unit/kbClassifier.test.ts
 *
 * Unit tests for the knowledge-base classifier orchestration:
 *   LLM (Copilot LM API) → embedding fallback (local ONNX model) → "Other".
 *
 * The LM API and the embedding engine are both stubbed, so these tests assert
 * the *routing* between the three stages (and the `usedLlm` flag) without any
 * model download or network call.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { setupMockLmApi } from './mockLmApi.js';
import { classifySessionWithCategories, setKbEmbeddingEngine } from '../../src/analytics/kbClassifier';
import { EMBEDDING_FALLBACK_CATEGORIES } from '../../src/types/kb';
import type { IEmbeddingEngine } from '../../src/search/semanticContracts';
import type { Message, Session } from '../../src/types/index';

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: 'copilot',
        title: overrides.title ?? 'Branching strategy',
        messages: overrides.messages ?? [msg('user', 'How do I create a git branch?')],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${overrides.id}.jsonl`,
    };
}

/** Minimal embedding engine returning a constant vector (perfect similarity). */
function makeEngine(options?: { ready?: boolean; fail?: boolean }): IEmbeddingEngine {
    const vector = new Float32Array([1, 0, 0]);
    return {
        isReady: options?.ready ?? true,
        load: async () => { /* no-op */ },
        embed: async () => {
            if (options?.fail) { throw new Error('model exploded'); }
            return vector;
        },
        embedBatch: async (texts: string[]) => {
            if (options?.fail) { throw new Error('model exploded'); }
            return texts.map(() => vector);
        },
        dispose: () => { /* no-op */ },
    };
}

suite('kbClassifier — routing between LLM, embedding and the default', () => {
    let lmMock: ReturnType<typeof setupMockLmApi> | undefined;

    teardown(() => {
        if (lmMock) { lmMock.restore(); lmMock = undefined; }
        setKbEmbeddingEngine(undefined);
        sinon.restore();
    });

    test('prefers the LLM and reports usedLlm=true', async () => {
        lmMock = setupMockLmApi({ responseText: 'Testing|Unit Tests' });

        const result = await classifySessionWithCategories(makeSession({ id: 's-llm' }), ['decision']);

        assert.deepStrictEqual(result, { type: 'Testing', subtype: 'Unit Tests', usedLlm: true });
    });

    test('falls back to the embedding engine when no LLM provider answers', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });

        const result = await classifySessionWithCategories(
            makeSession({ id: 's-embed' }),
            ['decision'],
            makeEngine()
        );

        assert.strictEqual(result.usedLlm, false);
        assert.strictEqual(result.subtype, null, 'embedding results carry no subtype');
        assert.ok(
            EMBEDDING_FALLBACK_CATEGORIES.includes(result.type),
            `expected one of the fallback categories, got "${result.type}"`
        );
    });

    test('uses the globally registered engine when no explicit engine is passed', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });
        setKbEmbeddingEngine(makeEngine());

        const result = await classifySessionWithCategories(makeSession({ id: 's-global' }), ['decision']);

        assert.strictEqual(result.usedLlm, false);
        assert.ok(EMBEDDING_FALLBACK_CATEGORIES.includes(result.type), result.type);
    });

    test('an explicit null engine wins over the globally registered one', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });
        setKbEmbeddingEngine(makeEngine());

        const result = await classifySessionWithCategories(makeSession({ id: 's-explicit-null' }), ['decision'], null);

        assert.deepStrictEqual(result, { type: 'Other', subtype: null, usedLlm: false });
    });

    test('returns "Other" when the embedding model is still loading', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });

        const result = await classifySessionWithCategories(
            makeSession({ id: 's-not-ready' }),
            ['decision'],
            makeEngine({ ready: false })
        );

        assert.deepStrictEqual(result, { type: 'Other', subtype: null, usedLlm: false });
    });

    test('returns "Other" when the embedding engine throws', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });

        const result = await classifySessionWithCategories(
            makeSession({ id: 's-throws' }),
            ['decision'],
            makeEngine({ fail: true })
        );

        assert.deepStrictEqual(result, { type: 'Other', subtype: null, usedLlm: false });
    });

    test('returns "Other" when neither an LLM nor an engine is available', async () => {
        lmMock = setupMockLmApi({ modelAvailable: false });
        setKbEmbeddingEngine(null);

        const result = await classifySessionWithCategories(makeSession({ id: 's-none' }), ['decision']);

        assert.deepStrictEqual(result, { type: 'Other', subtype: null, usedLlm: false });
    });

    test('the LM API is consulted before the fallback runs', async () => {
        // Some hosts (Cursor before the agent CLI, plain VS Code without Copilot)
        // expose no usable model — the classifier must still answer.
        lmMock = setupMockLmApi({ modelAvailable: false });
        const selectChatModels = vscode.lm.selectChatModels as unknown as sinon.SinonStub;

        const result = await classifySessionWithCategories(makeSession({ id: 's-no-lm' }), ['decision'], null);

        assert.strictEqual(result.type, 'Other');
        assert.ok(selectChatModels.called, 'the LM API is asked first, then the fallback runs');
    });
});
