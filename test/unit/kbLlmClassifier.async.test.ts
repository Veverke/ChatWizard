/**
 * test/unit/kbLlmClassifier.async.test.ts
 *
 * Unit tests for kbLlmClassifier — async functions that call promptLlm.
 * Uses sinon to stub the VS Code LM API.
 */

import * as assert from 'assert';
import { setupMockLmApi, makeSession, msg } from './mockLmApi.js';

suite('kbLlmClassifier (async)', () => {
    let mock: ReturnType<typeof setupMockLmApi>;

    teardown(() => {
        if (mock) { mock.restore(); }
    });

    suite('classifySessionWithLlm', () => {
        test('returns folder and subtype when LLM responds with pipe format', async () => {
            mock = setupMockLmApi({ responseText: 'Git|Branch Management' });
            const { classifySessionWithLlm } = await import('../../src/analytics/kbLlmClassifier.js');
            const session = makeSession({
                id: 's1',
                title: 'Git branching',
                messages: [msg('user', 'How do I create a new branch?')],
            });
            const result = await classifySessionWithLlm(session);
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Git');
            assert.strictEqual(result!.subtype, 'Branch Management');
        });

        test('returns null when LLM returns null (no provider)', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { classifySessionWithLlm } = await import('../../src/analytics/kbLlmClassifier.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithLlm(session);
            assert.strictEqual(result, null);
        });

        test('returns null when LLM returns Other', async () => {
            mock = setupMockLmApi({ responseText: 'Other' });
            const { classifySessionWithLlm } = await import('../../src/analytics/kbLlmClassifier.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithLlm(session);
            assert.strictEqual(result, null);
        });

        test('returns null when LLM returns unparseable output', async () => {
            mock = setupMockLmApi({ responseText: '# Summary of Updates' });
            const { classifySessionWithLlm } = await import('../../src/analytics/kbLlmClassifier.js');
            const session = makeSession({ id: 's1', messages: [msg('user', 'hello')] });
            const result = await classifySessionWithLlm(session);
            assert.strictEqual(result, null);
        });

        test('returns folder-only when no pipe in response', async () => {
            mock = setupMockLmApi({ responseText: 'Bugs' });
            const { classifySessionWithLlm } = await import('../../src/analytics/kbLlmClassifier.js');
            const session = makeSession({
                id: 's1',
                title: 'Bug fixing',
                messages: [msg('user', 'Found a crash')],
            });
            const result = await classifySessionWithLlm(session);
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Bugs');
            assert.strictEqual(result!.subtype, null);
        });
    });

    suite('refineCategories', () => {
        test('returns null when fewer than 2 labels', async () => {
            mock = setupMockLmApi({ responseText: '{"label":"refined"}' });
            const { refineCategories } = await import('../../src/analytics/kbLlmClassifier.js');
            const result = await refineCategories(['Single']);
            assert.strictEqual(result, null);
        });

        test('returns null when LLM unavailable', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { refineCategories } = await import('../../src/analytics/kbLlmClassifier.js');
            const result = await refineCategories(['Git', 'Bugs']);
            assert.strictEqual(result, null);
        });

        test('returns parsed mapping when LLM responds', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({ 'Git Pull': 'Git', 'Git Push': 'Git', 'Error Handling': 'Debugging' }),
            });
            const { refineCategories } = await import('../../src/analytics/kbLlmClassifier.js');
            const result = await refineCategories(['Git Pull', 'Git Push', 'Error Handling']);
            assert.ok(result !== null);
            assert.strictEqual(result.get('Git Pull'), 'Git');
            assert.strictEqual(result.get('Git Push'), 'Git');
            assert.strictEqual(result.get('Error Handling'), 'Debugging');
        });
    });

    suite('refineSubtypes', () => {
        test('returns null when no entries', async () => {
            mock = setupMockLmApi({ responseText: '{}' });
            const { refineSubtypes } = await import('../../src/analytics/kbLlmClassifier.js');
            const result = await refineSubtypes([]);
            assert.strictEqual(result, null);
        });

        test('returns null when LLM unavailable', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { refineSubtypes } = await import('../../src/analytics/kbLlmClassifier.js');
            const entries = [
                { sessionId: 's1', type: 'Git', subtype: 'pull', title: 'Pull', summary: 'pull' },
                { sessionId: 's2', type: 'Git', subtype: 'push', title: 'Push', summary: 'push' },
            ] as any;
            const result = await refineSubtypes(entries);
            assert.strictEqual(result, null);
        });

        test('returns mapping when LLM responds', async () => {
            mock = setupMockLmApi({
                responseText: JSON.stringify({ pull: 'Git Ops', push: 'Git Ops' }),
            });
            const { refineSubtypes } = await import('../../src/analytics/kbLlmClassifier.js');
            const entries = [
                { sessionId: 's1', type: 'Git', subtype: 'pull', title: 'Pull', summary: 'pull' },
                { sessionId: 's2', type: 'Git', subtype: 'push', title: 'Push', summary: 'push' },
            ] as any;
            const result = await refineSubtypes(entries);
            assert.ok(result !== null);
            assert.strictEqual(result.get('pull'), 'Git Ops');
            assert.strictEqual(result.get('push'), 'Git Ops');
        });
    });
});