/**
 * test/unit/entityLlmExtractor.async.test.ts
 *
 * Unit tests for entityLlmExtractor — async functions that call promptLlm.
 * Uses sinon to stub the VS Code LM API.
 */

import * as assert from 'assert';
import { setupMockLmApi, makeSession, msg } from './mockLmApi.js';

suite('entityLlmExtractor (async)', () => {
    let mock: ReturnType<typeof setupMockLmApi>;

    teardown(() => {
        if (mock) { mock.restore(); }
    });

    suite('extractEntitiesWithLlm', () => {
        test('returns parsed entities when LLM responds with valid JSON', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({
                    frameworks: ['React', 'Express'],
                    apis: ['REST /api/users'],
                    concepts: ['dependency injection'],
                    tools: ['Docker'],
                    languages: ['TypeScript'],
                }),
            });
            const { extractEntitiesWithLlm } = await import('../../src/analytics/entityLlmExtractor.js');
            const session = makeSession({
                id: 's1',
                title: 'API design',
                messages: [msg('user', 'Building a REST API with Express')],
            });
            const result = await extractEntitiesWithLlm(session);
            assert.ok(result !== null);
            assert.ok(result.semantic);
            assert.ok(result.semantic.some((s: string) => s.includes('React')));
        });

        test('returns null when LLM returns null (no provider)', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { extractEntitiesWithLlm } = await import('../../src/analytics/entityLlmExtractor.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await extractEntitiesWithLlm(session);
            assert.strictEqual(result, null);
        });

        test('returns null when LLM returns unparseable response', async () => {
            mock = setupMockLmApi({ responseText: 'not valid json at all' });
            const { extractEntitiesWithLlm } = await import('../../src/analytics/entityLlmExtractor.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await extractEntitiesWithLlm(session);
            assert.strictEqual(result, null);
        });

        test('handles empty session gracefully', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({ frameworks: [], apis: [], concepts: [], tools: [], languages: [] }),
            });
            const { extractEntitiesWithLlm } = await import('../../src/analytics/entityLlmExtractor.js');
            const session = makeSession({ id: 's1', messages: [] });
            const result = await extractEntitiesWithLlm(session);
            assert.ok(result !== null);
            assert.strictEqual(result.semantic?.length, 0);
        });
    });
});