/**
 * test/unit/entityLlmExtractor.test.ts
 *
 * Unit tests for entityLlmExtractor — pure prompt builders and response parsers.
 * The actual LM API calls are tested via integration/e2e tests.
 */

import * as assert from 'assert';
import {
    buildEntitySystemPrompt,
    buildEntityUserPrompt,
    parseEntityResponse,
} from '../../src/analytics/entityLlmExtractor';
import type { Session, Message } from '../../src/types/index';

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

suite('entityLlmExtractor', () => {
    suite('buildEntitySystemPrompt', () => {
        test('returns a non-empty string with expected instructions', () => {
            const prompt = buildEntitySystemPrompt();
            assert.ok(prompt.length > 50);
            assert.ok(prompt.includes('entity extractor'));
            assert.ok(prompt.includes('frameworks'));
            assert.ok(prompt.includes('apis'));
            assert.ok(prompt.includes('concepts'));
            assert.ok(prompt.includes('tools'));
            assert.ok(prompt.includes('languages'));
            assert.ok(prompt.includes('JSON'));
        });

        test('includes example JSON output format', () => {
            const prompt = buildEntitySystemPrompt();
            assert.ok(prompt.includes('Example'));
        });
    });

    suite('buildEntityUserPrompt', () => {
        test('includes session title', () => {
            const session = makeSession({ id: 's1', title: 'User auth refactor', messages: [] });
            const prompt = buildEntityUserPrompt(session);
            assert.ok(prompt.includes('User auth refactor'));
        });

        test('includes conversation messages with role prefixes', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Hello'),
                    msg('assistant', 'Hi there'),
                ],
            });
            const prompt = buildEntityUserPrompt(session);
            assert.ok(prompt.includes('[USER]'));
            assert.ok(prompt.includes('[ASSISTANT]'));
            assert.ok(prompt.includes('Hello'));
            assert.ok(prompt.includes('Hi there'));
        });

        test('truncates message content to 1500 chars per message', () => {
            const longContent = 'A'.repeat(3000);
            const session = makeSession({
                id: 's1',
                messages: [msg('user', longContent)],
            });
            const prompt = buildEntityUserPrompt(session);
            // Content should be truncated to ~1500 chars
            assert.ok(prompt.length < 2500);
        });

        test('handles empty messages', () => {
            const session = makeSession({ id: 's1', messages: [] });
            const prompt = buildEntityUserPrompt(session);
            assert.ok(prompt.includes('Session title:'));
        });
    });

    suite('parseEntityResponse', () => {
        test('parses valid JSON with all entity types', () => {
            const raw = JSON.stringify({
                frameworks: ['React', 'Express'],
                apis: ['REST /api/users'],
                concepts: ['dependency injection'],
                tools: ['Docker'],
                languages: ['TypeScript'],
            });
            const result = parseEntityResponse(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.frameworks?.length, 2);
            assert.strictEqual(result!.apis?.length, 1);
            assert.strictEqual(result!.concepts?.length, 1);
            assert.strictEqual(result!.tools?.length, 1);
            assert.strictEqual(result!.languages?.length, 1);
        });

        test('returns null for invalid JSON', () => {
            const result = parseEntityResponse('not json');
            assert.strictEqual(result, null);
        });

        test('returns null when parsed value is not an object', () => {
            const result = parseEntityResponse('"string"');
            assert.strictEqual(result, null);
        });

        test('strips markdown code fences from response', () => {
            const raw = '```json\n{"frameworks":["Jest"]}\n```';
            const result = parseEntityResponse(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.frameworks?.[0], 'Jest');
        });

        test('strips code fences without language tag', () => {
            const raw = '```\n{"frameworks":["Mocha"]}\n```';
            const result = parseEntityResponse(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.frameworks?.[0], 'Mocha');
        });

        test('filters out empty strings and limits to 15 items', () => {
            const raw = JSON.stringify({
                frameworks: ['A', '', 'B', '', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'],
            });
            const result = parseEntityResponse(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.frameworks?.length, 15);
            assert.ok(result!.frameworks!.every(f => f.length > 0));
        });

        test('returns empty arrays when key is missing', () => {
            const raw = JSON.stringify({ frameworks: ['React'] });
            const result = parseEntityResponse(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.frameworks?.length, 1);
            assert.strictEqual(result!.apis, undefined);
        });
    });
});