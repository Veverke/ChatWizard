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
    isRateLimitedError,
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
            assert.ok(prompt.includes('Other'));
            assert.ok(prompt.includes('Title Case'));
            assert.ok(prompt.includes('Bugs'));
            assert.ok(prompt.includes('Testing'));
            assert.ok(prompt.includes('Architecture'));
            assert.ok(prompt.includes('Refactoring'));
            assert.ok(prompt.includes('Features'));
            assert.ok(prompt.includes('Best Practices'));
        });
    });

    suite('parseClassification', () => {
        test('returns clean folder label as-is', () => {
            const r = parseClassification('Bug Fixes');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
            assert.strictEqual(r!.subtype, null);
        });

        test('strips markdown code fences', () => {
            const r = parseClassification('```\nBug Fixes\n```');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
        });

        test('strips language-tagged code fences', () => {
            const r = parseClassification('```markdown\nBug Fixes\n```');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
        });

        test('handles unclosed fences', () => {
            const r = parseClassification('```\nBug Fixes');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
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
            const r = parseClassification('Bug Fixes\nSome extra text');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
        });

        test('extracts 2-level pipe format', () => {
            const r = parseClassification('Git|Branch Management');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Git');
            assert.strictEqual(r!.subtype, 'Branch Management');
        });

        test('extracts 2-level pipe format with second level', () => {
            const r = parseClassification('Bugs|UI Crash');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bugs');
            assert.strictEqual(r!.subtype, 'UI Crash');
        });

        test('ignores second level when it equals General', () => {
            const r = parseClassification('Bugs|General');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bugs');
            assert.strictEqual(r!.subtype, null);
        });

        test('returns null for Other|Something', () => {
            assert.strictEqual(parseClassification('Other|Specific'), null);
        });

        test('handles 2-level from code fences', () => {
            const r = parseClassification('```\nPython|Debugging\n```');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Python');
            assert.strictEqual(r!.subtype, 'Debugging');
        });

        test('returns null for >2 word labels (pipe-less)', () => {
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
            const r = parseClassification('  Bug Fixes  ');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bug Fixes');
        });
    });

    suite('isRateLimitedError', () => {
        test('returns true for ChatRateLimited error', () => {
            assert.ok(isRateLimitedError(new Error('ChatRateLimited: too many requests')));
        });

        test('returns true for rate limit message', () => {
            assert.ok(isRateLimitedError('rate limit exceeded'));
        });

        test('returns true for RateLimited string', () => {
            assert.ok(isRateLimitedError('RateLimited'));
        });

        test('returns false for unrelated errors', () => {
            assert.ok(!isRateLimitedError(new Error('Network timeout')));
        });

        test('returns false for empty string', () => {
            assert.ok(!isRateLimitedError(''));
        });
    });
});