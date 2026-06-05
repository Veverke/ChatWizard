// test/e2e/actionItemExtractor.test.ts
// Feature 34 — Outcome / Follow-Up Tracking

import * as assert from 'assert';
import { extractActionItems } from '../../src/analytics/actionItemExtractor';
import type { Session } from '../../src/types/index';

function makeSession(assistantMessages: string[]): Session {
    return {
        id: 'session-test-001',
        title: 'Test Session',
        source: 'claude',
        workspaceId: 'ws1',
        messages: assistantMessages.map((content, i) => ({
            id: `msg-${i}`,
            role: 'assistant' as const,
            content,
            codeBlocks: [],
        })),
        filePath: '/tmp/test.jsonl',
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
    };
}

suite('Feature 34 — Action Item Extractor', () => {
    test('returns items for a session with actionable phrases', () => {
        const session = makeSession([
            'You should add error handling to the login function.',
            'Next step: run the test suite to verify changes.',
            "Don't forget to update the documentation.",
        ]);
        const items = extractActionItems(session);
        assert.ok(items.length >= 2, `should find at least 2 action items, got ${items.length}`);
    });

    test('returns empty array for a purely conversational session', () => {
        const session = makeSession([
            'That is a great approach to the problem.',
            'The code looks good overall.',
            'I think this design pattern is elegant.',
        ]);
        const items = extractActionItems(session);
        assert.strictEqual(items.length, 0, 'should return empty array for non-actionable content');
    });

    test('extracts items only from assistant messages, not user messages', () => {
        const session: Session = {
            id: 'mixed-session',
            title: 'Mixed',
            source: 'claude',
            workspaceId: 'ws1',
            messages: [
                { id: 'u0', role: 'user', content: 'You should do this.', codeBlocks: [] },
                { id: 'a0', role: 'assistant', content: 'I agree. You should also check the logs.', codeBlocks: [] },
            ],
            filePath: '/tmp/mixed.jsonl',
            createdAt: '2026-06-01T10:00:00Z',
            updatedAt: '2026-06-01T10:30:00Z',
        };
        const items = extractActionItems(session);
        // Only the assistant message should contribute
        assert.strictEqual(items.length, 1, 'only assistant messages should be scanned');
    });

    test('deduplicates items with the same normalized text', () => {
        const session = makeSession([
            'You should test the changes. You should test the changes.',
        ]);
        const items = extractActionItems(session);
        // Duplicate sentence should appear only once
        const unique = new Set(items.map(i => i.text.toLowerCase().trim()));
        assert.strictEqual(unique.size, items.length, 'duplicate items should be removed');
    });

    test('caps extracted items at 20', () => {
        // Create a message with many actionable phrases
        const lines = Array.from({ length: 30 }, (_, i) => `You should do step ${i}.`);
        const session = makeSession([lines.join('\n')]);
        const items = extractActionItems(session);
        assert.ok(items.length <= 20, `should cap at 20 items, got ${items.length}`);
    });

    test('each item has correct structure', () => {
        const session = makeSession([
            'Make sure to commit your changes before merging.',
        ]);
        const items = extractActionItems(session);
        if (items.length > 0) {
            const item = items[0];
            assert.ok(typeof item.id === 'string' && item.id.length > 0, 'id should be non-empty string');
            assert.ok(typeof item.text === 'string' && item.text.length > 0, 'text should be non-empty string');
            assert.strictEqual(item.done, false, 'new items should have done: false');
            assert.strictEqual(item.source, 'extracted', "source should be 'extracted'");
            assert.ok(typeof item.createdAt === 'string', 'createdAt should be a string');
        }
    });

    test('identifies todo: phrase', () => {
        const session = makeSession(['Todo: write integration tests for the auth module.']);
        const items = extractActionItems(session);
        assert.ok(items.length > 0, 'should find action item with "todo:" phrase');
    });

    test('identifies "remember to" phrase', () => {
        const session = makeSession(['Remember to update the environment variables in production.']);
        const items = extractActionItems(session);
        assert.ok(items.length > 0, 'should find action item with "remember to" phrase');
    });

    test('returns empty array for session with no messages', () => {
        const session: Session = {
            id: 'empty',
            title: 'Empty',
            source: 'claude',
            workspaceId: 'ws1',
            messages: [],
            filePath: '/tmp/empty.jsonl',
            createdAt: '2026-06-01T10:00:00Z',
            updatedAt: '2026-06-01T10:30:00Z',
        };
        const items = extractActionItems(session);
        assert.strictEqual(items.length, 0, 'should return empty array for session with no messages');
    });
});