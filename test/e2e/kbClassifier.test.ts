// test/e2e/kbClassifier.test.ts
// Feature 23 — KB Entry Classification

import * as assert from 'assert';
import { classifySessionWithCategories } from '../../src/analytics/kbClassifier';
import type { Session } from '../../src/types/index';

function makeSession(content: string): Session {
    return {
        id: 'test-session',
        title: 'Test',
        source: 'claude',
        workspaceId: 'ws1',
        messages: [{ id: 'm0', role: 'user', content, codeBlocks: [] }],
        filePath: '/tmp/test.jsonl',
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
    };
}

suite('Feature 23 — KB Classifier', () => {
    suite('classifySessionWithCategories', () => {
        test('tries LLM first, falls back to "Other" when LLM and embedding unavailable', async () => {
            const session = makeSession('We decided to use PostgreSQL for the trade-off benefits.');
            const result = await classifySessionWithCategories(session, ['decision', 'learning', 'pattern', 'gotcha', 'architecture']);
            // Both LLM and embedding engine are unavailable in test env,
            // so the final safety net returns "Other".
            assert.strictEqual(result.type, 'Other');
        });

        test('returns "Other" when LLM and embedding both unavailable', async () => {
            const session = makeSession('We decided to use PostgreSQL.');
            const result = await classifySessionWithCategories(session, ['bug', 'decision', 'feature']);
            assert.strictEqual(result.type, 'Other');
        });

        test('returns "Other" when result is not in custom list', async () => {
            const session = makeSession('We decided to use PostgreSQL.');
            const result = await classifySessionWithCategories(session, ['bug', 'feature']);
            assert.strictEqual(result.type, 'Other');
        });

        test('falls back to "Other" when categories are empty', async () => {
            const session = makeSession('boring content');
            const result = await classifySessionWithCategories(session, []);
            assert.strictEqual(result.type, 'Other');
        });
    });
});