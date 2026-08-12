/**
 * test/unit/kbEmbeddingClassifier.test.ts
 *
 * Unit tests for kbEmbeddingClassifier — embedding-based fallback classifier.
 */

import * as assert from 'assert';
import { buildSessionText } from '../../src/analytics/kbEmbeddingClassifier.js';
import type { Session, Message } from '../../src/types/index.js';

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: 'copilot',
        title: overrides.title ?? 'Test session',
        messages: overrides.messages ?? [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${overrides.id}.jsonl`,
    };
}

suite('kbEmbeddingClassifier', () => {
    suite('buildSessionText', () => {
        test('includes session title', () => {
            const session = makeSession({ id: 's1', title: 'Database schema design', messages: [] });
            const text = buildSessionText(session);
            assert.ok(text.includes('Database schema design'));
        });

        test('includes messages with role prefixes', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'How do I create a table?'),
                    msg('assistant', 'Use CREATE TABLE'),
                ],
            });
            const text = buildSessionText(session);
            assert.ok(text.includes('[USER]'));
            assert.ok(text.includes('[ASSISTANT]'));
            assert.ok(text.includes('CREATE TABLE'));
        });

        test('truncates at MAX_CHARS (4000)', () => {
            const longContent = 'word '.repeat(2000);
            const session = makeSession({
                id: 's1',
                messages: [msg('user', longContent)],
            });
            const text = buildSessionText(session);
            assert.ok(text.length <= 4200); // title + overhead
        });

        test('handles empty messages', () => {
            const session = makeSession({ id: 's1', messages: [] });
            const text = buildSessionText(session);
            assert.ok(text.includes('Title:'));
        });
    });

    suite('classifySessionWithEmbedding', () => {
        test('returns null when engine is null', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithEmbedding(null, session, ['Git', 'Bugs']);
            assert.strictEqual(result, null);
        });

        test('returns null when engine is not ready', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            const engine = { isReady: false, embed: async () => new Float32Array(384), embedBatch: async () => [] };
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithEmbedding(engine as any, session, ['Git', 'Bugs']);
            assert.strictEqual(result, null);
        });

        test('returns null when categories are empty', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            const engine = { isReady: true, embed: async () => new Float32Array(384), embedBatch: async () => [] };
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithEmbedding(engine as any, session, []);
            assert.strictEqual(result, null);
        });

        test('returns best category when above threshold', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            // Create embeddings where "Git" is most similar to session
            const sessionEmb = new Float32Array([1, 0, 0]);
            const gitEmb = new Float32Array([0.9, 0.1, 0]);
            const bugsEmb = new Float32Array([0.1, 0.9, 0]);
            const engine = {
                isReady: true,
                embed: async () => sessionEmb,
                embedBatch: async (texts: string[]) => texts.map(t => t.includes('Git') ? gitEmb : bugsEmb),
            };
            const session = makeSession({ id: 's1', messages: [msg('user', 'git branch management')] });
            const result = await classifySessionWithEmbedding(engine as any, session, ['Git-Embed-4', 'Bugs'], 0.2);
            assert.strictEqual(result, 'Git-Embed-4');
        });

        test('returns null when best score is below threshold', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            const sessionEmb = new Float32Array([1, 0, 0]);
            const gitEmb = new Float32Array([0.1, 0.9, 0]);
            const engine = {
                isReady: true,
                embed: async () => sessionEmb,
                embedBatch: async (texts: string[]) => texts.map(() => gitEmb),
            };
            const session = makeSession({ id: 's1', messages: [msg('user', 'random chat')] });
            const result = await classifySessionWithEmbedding(engine as any, session, ['Git-Embed-5'], 0.5);
            assert.strictEqual(result, null);
        });

        test('caches category embeddings across calls', async () => {
            const { classifySessionWithEmbedding } = await import('../../src/analytics/kbEmbeddingClassifier.js');
            let embedBatchCalls = 0;
            const sessionEmb = new Float32Array([1, 0, 0]);
            const gitEmb = new Float32Array([0.9, 0.1, 0]);
            const engine = {
                isReady: true,
                embed: async () => sessionEmb,
                embedBatch: async (texts: string[]) => {
                    embedBatchCalls++;
                    return texts.map(() => gitEmb);
                },
            };
            const session = makeSession({ id: 's1', messages: [msg('user', 'git stuff')] });
            await classifySessionWithEmbedding(engine as any, session, ['Git-Embed-6'], 0.2);
            await classifySessionWithEmbedding(engine as any, session, ['Git-Embed-6'], 0.2);
            // embedBatch should only be called once (second call uses cache)
            assert.strictEqual(embedBatchCalls, 1);
        });
    });
});