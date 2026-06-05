// test/e2e/kbClassifier.test.ts
// Feature 23 — KB Entry Classification

import * as assert from 'assert';
import { classifySession } from '../../src/analytics/kbClassifier';
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
    test('classifies "decision" session correctly', () => {
        const session = makeSession('We decided to use PostgreSQL. I decided on a microservices approach because of trade-offs.');
        assert.strictEqual(classifySession(session), 'decision');
    });

    test('classifies "gotcha" session correctly', () => {
        const session = makeSession('Watch out for this footgun: the function returns undefined by default. Turns out it was a bug.');
        assert.strictEqual(classifySession(session), 'gotcha');
    });

    test('classifies "architecture" session correctly', () => {
        const session = makeSession('The system design uses a layered architecture with separate service components.');
        assert.strictEqual(classifySession(session), 'architecture');
    });

    test('classifies "pattern" session correctly', () => {
        const session = makeSession('This reusable template follows the strategy pattern for abstraction.');
        assert.strictEqual(classifySession(session), 'pattern');
    });

    test('classifies neutral session as "learning"', () => {
        const session = makeSession('The sky is blue. I learned something today. The code runs fast.');
        assert.strictEqual(classifySession(session), 'learning');
    });

    test('classifies empty message session as "learning"', () => {
        const session = makeSession('');
        assert.strictEqual(classifySession(session), 'learning');
    });

    test('"decision" rule wins over "learning" fallthrough', () => {
        const session = makeSession('We went with React over Vue because of the ecosystem trade-off.');
        assert.strictEqual(classifySession(session), 'decision');
    });

    test('only considers first 10 messages', () => {
        const messages = Array.from({ length: 15 }, (_, i) => ({
            id: `m${i}`,
            role: 'user' as const,
            content: i >= 10 ? 'we chose React for this trade-off decision' : 'boring content',
            codeBlocks: [],
        }));
        const session: Session = {
            id: 'long',
            title: 'Long Session',
            source: 'claude',
            workspaceId: 'ws1',
            messages,
            filePath: '/tmp/long.jsonl',
            createdAt: '2026-06-01T10:00:00Z',
            updatedAt: '2026-06-01T10:30:00Z',
        };
        // Messages 10-14 are decisions but beyond the 10-msg window → should be 'learning'
        assert.strictEqual(classifySession(session), 'learning');
    });

    test('classification is case-insensitive', () => {
        const session = makeSession('WE CHOSE PostgreSQL. THE TRADE-OFF was clear.');
        assert.strictEqual(classifySession(session), 'decision');
    });
});