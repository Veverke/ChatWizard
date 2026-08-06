/**
 * test/unit/actionItemLlmExtractor.test.ts
 *
 * Unit tests for actionItemLlmExtractor — pure prompt builders and response parsers.
 */

import * as assert from 'assert';
import {
    buildActionItemPrompt,
    buildActionItemSystemPrompt,
    parseActionItems,
} from '../../src/analytics/actionItemLlmExtractor';
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

suite('actionItemLlmExtractor', () => {
    suite('buildActionItemSystemPrompt', () => {
        test('returns a non-empty string with expected instructions', () => {
            const prompt = buildActionItemSystemPrompt();
            assert.ok(prompt.length > 50);
            assert.ok(prompt.includes('action-item extractor'));
            assert.ok(prompt.includes('actionable'));
        });

        test('includes (none) fallback instruction', () => {
            const prompt = buildActionItemSystemPrompt();
            assert.ok(prompt.includes('(none)'));
        });

        test('includes dash-prefix format instruction', () => {
            const prompt = buildActionItemSystemPrompt();
            assert.ok(prompt.includes('- '));
        });
    });

    suite('buildActionItemPrompt', () => {
        test('includes session title', () => {
            const session = makeSession({ id: 's1', title: 'Bug fixing session', messages: [] });
            const prompt = buildActionItemPrompt(session);
            assert.ok(prompt.includes('Bug fixing session'));
        });

        test('includes messages with role markers', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'Found a bug in login'),
                    msg('assistant', 'Lets fix it'),
                ],
            });
            const prompt = buildActionItemPrompt(session);
            assert.ok(prompt.includes('[USER]'));
            assert.ok(prompt.includes('[ASSISTANT]'));
        });

        test('truncates message content to 2000 chars', () => {
            const longContent = 'A'.repeat(5000);
            const session = makeSession({
                id: 's1',
                messages: [msg('user', longContent)],
            });
            const prompt = buildActionItemPrompt(session);
            assert.ok(prompt.length < 5000);
        });
    });

    suite('parseActionItems', () => {
        test('returns items for dash-prefixed lines', () => {
            const raw = '- Add error handling to the login function\n- Run the test suite\n- Update documentation';
            const result = parseActionItems(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.length, 3);
            assert.strictEqual(result![0], 'Add error handling to the login function');
        });

        test('returns null for (none) response', () => {
            const result = parseActionItems('(none)');
            assert.strictEqual(result, null);
        });

        test('returns null for (NONE) case-insensitive', () => {
            const result = parseActionItems('(NONE)');
            assert.strictEqual(result, null);
        });

        test('filters out lines not starting with dash', () => {
            const raw = '- Real action item\nThis is not an action item\n- Another action';
            const result = parseActionItems(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.length, 2);
        });

        test('filters out items shorter than 5 chars', () => {
            const raw = '- Hi\n- Real action item';
            const result = parseActionItems(raw);
            assert.ok(result !== null);
            assert.strictEqual(result!.length, 1);
        });

        test('trims whitespace from items', () => {
            const raw = '-  Add validation  ';
            const result = parseActionItems(raw);
            assert.ok(result !== null);
            assert.strictEqual(result![0], 'Add validation');
        });

        test('returns null for empty string', () => {
            const result = parseActionItems('');
            assert.strictEqual(result, null);
        });

        test('returns null when only non-dash lines present', () => {
            const result = parseActionItems('Just some text without dashes');
            assert.strictEqual(result, null);
        });
    });
});