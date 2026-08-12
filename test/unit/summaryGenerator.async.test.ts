/**
 * test/unit/summaryGenerator.async.test.ts
 *
 * Unit tests for summaryGenerator — async functions that call the VS Code LM API.
 * Uses sinon to stub vscode.lm.selectChatModels.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { setupMockLmApi, makeSession, msg } from './mockLmApi.js';

suite('summaryGenerator (async)', () => {
    let mock: ReturnType<typeof setupMockLmApi>;

    teardown(() => {
        if (mock) { mock.restore(); }
    });

    suite('SummaryGenerator.generate', () => {
        test('returns chronicle overview when available (Tier 1)', async () => {
            mock = setupMockLmApi({ responseText: 'should not be used' });
            const { SummaryGenerator } = await import('../../src/analytics/summaryGenerator.js');
            const gen = new SummaryGenerator();
            const session = makeSession({
                id: 's1',
                title: 'Test',
                messages: [msg('user', 'hello')],
            });
            (session as any).chronicleData = { overview: 'Chronicle overview of the session' };
            const result = await gen.generate(session);
            assert.strictEqual(result, 'Chronicle overview of the session');
        });

        test('falls back to TF-IDF when LM API unavailable (Tier 3)', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { SummaryGenerator } = await import('../../src/analytics/summaryGenerator.js');
            const gen = new SummaryGenerator();
            const session = makeSession({
                id: 's1',
                title: 'React component refactor',
                messages: [msg('user', 'We need to refactor the React component to use hooks')],
            });
            const result = await gen.generate(session);
            // Should be TF-IDF keywords, not the title
            assert.ok(result !== 'React component refactor');
            assert.ok(result.length > 0);
        });

        test('returns TF-IDF fallback when LM API throws', async () => {
            // Make sendRequest throw
            mock = setupMockLmApi({ responseText: 'mock' });
            mock.sendRequest.rejects(new Error('API error'));
            const { SummaryGenerator } = await import('../../src/analytics/summaryGenerator.js');
            const gen = new SummaryGenerator();
            const session = makeSession({
                id: 's1',
                title: 'Debugging',
                messages: [msg('user', 'The database query is slow because the index is missing')],
            });
            const result = await gen.generate(session);
            assert.ok(result.length > 0);
        });

        test('returns TF-IDF fallback when LM returns empty', async () => {
            mock = setupMockLmApi({ responseText: '' });
            const { SummaryGenerator } = await import('../../src/analytics/summaryGenerator.js');
            const gen = new SummaryGenerator();
            const session = makeSession({
                id: 's1',
                title: 'Testing',
                messages: [msg('user', 'Adding unit tests for the API layer')],
            });
            const result = await gen.generate(session);
            assert.ok(result.length > 0);
        });
    });

    suite('runSummaryBackgroundJob', () => {
        test('processes sessions without cached summaries', async () => {
            mock = setupMockLmApi({ responseText: 'Mock summary' });
            const { runSummaryBackgroundJob, SummaryGenerator } = await import('../../src/analytics/summaryGenerator.js');
            const gen = new SummaryGenerator();
            const calls: string[] = [];
            const store = {
                get: async (id: string) => id === 's2' ? { summary: 'existing' } : undefined,
                setSummary: async (id: string, summary: string) => { calls.push(`${id}:${summary}`); },
            };
            const sessions = new Map([
                ['s1', makeSession({ id: 's1', messages: [msg('user', 'hello')] })],
                ['s2', makeSession({ id: 's2', messages: [msg('user', 'hello')] })],
            ]);
            await runSummaryBackgroundJob(
                () => ['s1', 's2'],
                (id) => sessions.get(id),
                store as any,
                { appendLine: () => {} },
                gen,
            );
            // s2 should be skipped (has cached summary), s1 should be processed
            assert.ok(calls.some(c => c.startsWith('s1:')));
            assert.ok(!calls.some(c => c.startsWith('s2:')));
        });
    });
});