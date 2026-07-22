// test/e2e/kbLlmClassifier.test.ts
// Feature 23 — LLM Classifier: prompt building, response parsing, fallback logic

import * as assert from 'assert';
import {
    buildClassificationPrompt,
    buildSystemPrompt,
    parseClassification,
} from '../../src/analytics/kbLlmClassifier';
import type { Session } from '../../src/types/index';

function makeSession(overrides?: Partial<Session>): Session {
    return {
        id: 'llm-test-sid',
        title: 'Test Session',
        source: 'copilot',
        workspaceId: 'ws1',
        messages: [{ id: 'm0', role: 'user', content: 'hello world', codeBlocks: [] }],
        filePath: '/tmp/test.jsonl',
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
        ...overrides,
    };
}

suite('Feature 23 — LLM Classifier', () => {
    suite('buildClassificationPrompt', () => {
        test('includes session title', () => {
            const session = makeSession({ title: 'My Custom Title' });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('Session title: My Custom Title'));
        });

        test('includes first 5 messages only', () => {
            const messages = Array.from({ length: 10 }, (_, i) => ({
                id: `m${i}`,
                role: 'user' as const,
                content: `message ${i}`,
                codeBlocks: [] as never[],
            }));
            const session = makeSession({ messages });
            const prompt = buildClassificationPrompt(session);

            // Should include first 5
            assert.ok(prompt.includes('[USER]\nmessage 0'));
            assert.ok(prompt.includes('[USER]\nmessage 4'));

            // Should NOT include message 5+
            assert.ok(!prompt.includes('[USER]\nmessage 5'));
        });

        test('formats messages with [ROLE] header', () => {
            const session = makeSession({
                messages: [
                    { id: 'm0', role: 'user', content: 'user text', codeBlocks: [] },
                    { id: 'm1', role: 'assistant', content: 'assistant text', codeBlocks: [] },
                ],
            });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('[USER]\nuser text'));
            assert.ok(prompt.includes('[ASSISTANT]\nassistant text'));
        });

        test('truncates message content to 1500 chars', () => {
            const longContent = 'x'.repeat(2000);
            const session = makeSession({
                messages: [{ id: 'm0', role: 'user', content: longContent, codeBlocks: [] }],
            });
            const prompt = buildClassificationPrompt(session);
            // 1500 chars + role prefix
            assert.ok(prompt.length < 1600);
        });
    });

    suite('buildSystemPrompt', () => {
        test('lists all categories', () => {
            const prompt = buildSystemPrompt(['decision', 'learning', 'bug']);
            assert.ok(prompt.includes('1. decision'));
            assert.ok(prompt.includes('2. learning'));
            assert.ok(prompt.includes('3. bug'));
        });

        test('includes classification rules', () => {
            const prompt = buildSystemPrompt(['decision']);
            assert.ok(prompt.includes('Return ONLY the category name'));
            assert.ok(prompt.includes('case-insensitive'));
        });
    });

    suite('parseClassification', () => {
        test('returns exact match (case-insensitive)', () => {
            const result = parseClassification('Decision', ['decision', 'learning']);
            assert.strictEqual(result, 'decision');
        });

        test('returns exact match with whitespace', () => {
            const result = parseClassification('  learning  ', ['decision', 'learning']);
            assert.strictEqual(result, 'learning');
        });

        test('returns contains match when exact fails', () => {
            const result = parseClassification('the answer is architecture', ['decision', 'architecture']);
            assert.strictEqual(result, 'architecture');
        });

        test('returns null when no match found', () => {
            const result = parseClassification('nothing matches here', ['decision', 'learning']);
            assert.strictEqual(result, null);
        });

        test('returns null for empty string', () => {
            const result = parseClassification('', ['decision', 'learning']);
            assert.strictEqual(result, null);
        });

        test('prefers exact match over contains match', () => {
            // "pattern" is contained in "architecture-pattern" but exact match for "pattern" should win
            const result = parseClassification('pattern', ['architecture', 'pattern']);
            assert.strictEqual(result, 'pattern');
        });
    });
});