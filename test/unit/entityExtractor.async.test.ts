/**
 * test/unit/entityExtractor.async.test.ts
 *
 * Unit tests for entityExtractor — async functions that call promptLlm.
 * Uses sinon to stub the VS Code LM API.
 */

import * as assert from 'assert';
import { setupMockLmApi, makeSession, msg } from './mockLmApi.js';

suite('entityExtractor (async)', () => {
    let mock: ReturnType<typeof setupMockLmApi>;

    teardown(() => {
        if (mock) { mock.restore(); }
    });

    suite('extractEntitiesSmart', () => {
        test('merges LLM semantic entities with regex result', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({
                    frameworks: ['React'],
                    apis: [],
                    concepts: [],
                    tools: [],
                    languages: [],
                }),
            });
            const { extractEntitiesSmart } = await import('../../src/analytics/entityExtractor.js');
            const session = makeSession({
                id: 's1',
                title: 'React app',
                messages: [msg('user', 'Check src/App.tsx for the bug')],
            });
            const result = await extractEntitiesSmart(session);
            assert.ok(result.filePaths.length > 0);
            assert.ok(result.semantic);
            assert.ok(result.semantic.some(s => s.includes('React')));
        });

        test('returns regex-only result when LLM unavailable', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { extractEntitiesSmart } = await import('../../src/analytics/entityExtractor.js');
            const session = makeSession({
                id: 's1',
                title: 'Test',
                messages: [msg('user', 'Fix src/util.ts')],
            });
            const result = await extractEntitiesSmart(session);
            assert.ok(result.filePaths.length > 0);
            assert.strictEqual(result.semantic, undefined);
        });

        test('deduplicates LLM entities against regex result', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({
                    frameworks: ['React'],
                    apis: [],
                    concepts: [],
                    tools: [],
                    languages: ['TypeScript'],
                }),
            });
            const { extractEntitiesSmart } = await import('../../src/analytics/entityExtractor.js');
            const session = makeSession({
                id: 's1',
                title: 'React TypeScript',
                messages: [msg('user', 'Using React with TypeScript')],
            });
            const result = await extractEntitiesSmart(session);
            assert.ok(result.semantic);
            // 'React' and 'TypeScript' should appear in semantic
            assert.ok(result.semantic.some(s => /react/i.test(s)));
        });

        test('handles LLM returning null gracefully', async () => {
            mock = setupMockLmApi({ responseText: 'not valid json' });
            const { extractEntitiesSmart } = await import('../../src/analytics/entityExtractor.js');
            const session = makeSession({
                id: 's1',
                title: 'Test',
                messages: [msg('user', 'hello')],
            });
            const result = await extractEntitiesSmart(session);
            assert.ok(result);
            assert.strictEqual(result.semantic, undefined);
        });
    });

    suite('runEntityExtractionJob', () => {
        test('processes sessions without entities', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({ frameworks: ['React'], apis: [], concepts: [], tools: [], languages: [] }),
            });
            const { runEntityExtractionJob } = await import('../../src/analytics/entityExtractor.js');
            const calls: string[] = [];
            const store = {
                get: async (id: string) => id === 's2' ? { entitiesVersion: 2 } : undefined,
                patch: async (id: string, data: any) => { calls.push(`patch:${id}`); },
            };
            const sessions = new Map([
                ['s1', makeSession({ id: 's1', messages: [msg('user', 'hello')] })],
                ['s2', makeSession({ id: 's2', messages: [msg('user', 'hello')] })],
            ]);
            await runEntityExtractionJob(
                () => ['s1', 's2'],
                (id) => sessions.get(id),
                store as any,
                { appendLine: () => {} },
            );
            // s2 should be skipped (already has entitiesVersion), s1 should be processed
            assert.ok(calls.some(c => c.includes('s1')));
        });
    });
});