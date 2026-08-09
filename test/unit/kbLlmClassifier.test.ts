/**
 * test/unit/kbLlmClassifier.test.ts
 *
 * Unit tests for kbLlmClassifier — pure prompt builders and response parsers.
 */

import * as assert from 'assert';
import {
    buildClassificationPrompt,
    buildSystemPrompt,
    parseClassification,
} from '../../src/analytics/kbLlmClassifier';
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

suite('kbLlmClassifier', () => {
    suite('buildClassificationPrompt', () => {
        test('includes session title', () => {
            const session = makeSession({ id: 's1', title: 'Database schema design', messages: [] });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('Database schema design'));
            assert.ok(prompt.includes('session categorizer'));
        });

        test('includes messages newest-first within budget', () => {
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'old message'),
                    msg('user', 'new message'),
                ],
            });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('new message'));
        });

        test('truncates when exceeding MAX_CONVERSATION_CHARS', () => {
            const bigContent = 'word '.repeat(10_000);
            const session = makeSession({
                id: 's1',
                messages: [
                    msg('user', 'first message'),
                    msg('user', bigContent),
                ],
            });
            const prompt = buildClassificationPrompt(session);
            // Should be truncated to ~24000 chars + overhead
            assert.ok(prompt.length < 30000);
        });
    });

    suite('buildSystemPrompt', () => {
        test('returns expected system prompt content', () => {
            const prompt = buildSystemPrompt();
            assert.ok(prompt.includes('session categorizer'));
            assert.ok(prompt.includes('Examples:'));
            assert.ok(prompt.includes('Other'));
            assert.ok(prompt.includes('Title Case'));
        });
    });

    suite('parseClassification', () => {
        test('returns clean label as-is', () => {
            assert.strictEqual(parseClassification('Bug Fixes'), 'Bug Fixes');
        });

        test('strips markdown code fences', () => {
            assert.strictEqual(parseClassification('```\nBug Fixes\n```'), 'Bug Fixes');
        });

        test('strips language-tagged code fences', () => {
            assert.strictEqual(parseClassification('```markdown\nBug Fixes\n```'), 'Bug Fixes');
        });

        test('handles unclosed fences', () => {
            assert.strictEqual(parseClassification('```\nBug Fixes'), 'Bug Fixes');
        });

        test('returns null for (none)', () => {
            assert.strictEqual(parseClassification('(none)'), null);
        });

        test('returns null for Other', () => {
            assert.strictEqual(parseClassification('Other'), null);
        });

        test('returns null for other (lowercase)', () => {
            assert.strictEqual(parseClassification('other'), null);
        });

        test('returns null for empty string', () => {
            assert.strictEqual(parseClassification(''), null);
        });

        test('takes first line only', () => {
            assert.strictEqual(parseClassification('Bug Fixes\nSome extra text'), 'Bug Fixes');
        });

        test('returns null for >5 word labels', () => {
            assert.strictEqual(parseClassification('This is a very long category label'), null);
        });

        test('returns null for code-like output (backtick prefix)', () => {
            assert.strictEqual(parseClassification('`Bug Fixes`'), null);
        });

        test('returns null for markdown heading', () => {
            assert.strictEqual(parseClassification('# Summary of Updates'), null);
        });

        test('returns null for numbered list', () => {
            assert.strictEqual(parseClassification('1. Bug Fixes'), null);
        });

        test('returns null for emoji-prefixed output', () => {
            assert.strictEqual(parseClassification('✅ COMPLETED'), null);
        });

        test('handles whitespace wrapping', () => {
            assert.strictEqual(parseClassification('  Bug Fixes  '), 'Bug Fixes');
        });
    });