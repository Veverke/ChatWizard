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
});