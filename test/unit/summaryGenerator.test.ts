/**
 * test/unit/summaryGenerator.test.ts
 *
 * Unit tests for summaryGenerator — pure TF-IDF keyword extraction functions.
 */

import * as assert from 'assert';
import { generateTfidfSummary, extractKeywords, RateLimiter } from '../../src/analytics/summaryGenerator';
import type { Session, Message } from '../../src/types/index';

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: overrides.source ?? 'copilot',
        title: overrides.title ?? `Session ${overrides.id}`,
        messages: overrides.messages ?? [],
        createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        workspaceId: overrides.workspaceId ?? 'ws',
        workspacePath: overrides.workspacePath ?? '/ws',
        filePath: overrides.filePath ?? `/ws/${overrides.id}.jsonl`,
        model: overrides.model,
    };
}

suite('summaryGenerator', () => {
    suite('generateTfidfSummary', () => {
        test('extracts top 3 keywords from user messages', () => {
            const session = makeSession({
                id: 's1',
                title: 'React component refactor',
                messages: [
                    msg('user', 'We need to refactor the React component to use hooks instead of class component for better state management'),
                    msg('assistant', 'Here is how to convert your class component to hooks'),
                ],
            });
            const summary = generateTfidfSummary(session);
            assert.ok(summary.length > 0);
            assert.ok(summary.includes('component') || summary.includes('hooks') || summary.includes('react'));
        });

        test('falls back to title when no user messages', () => {
            const session = makeSession({
                id: 's1',
                title: 'My custom session',
                messages: [
                    msg('assistant', 'Hello'),
                ],
            });
            assert.strictEqual(generateTfidfSummary(session), 'My custom session');
        });

        test('falls back to title when user messages are empty', () => {
            const session = makeSession({
                id: 's1',
                title: 'Empty session',
                messages: [
                    msg('user', ''),
                ],
            });
            assert.strictEqual(generateTfidfSummary(session), 'Empty session');
        });

        test('falls back to title when no keywords extracted', () => {
            const session = makeSession({
                id: 's1',
                title: 'Minimal session',
                messages: [
                    msg('user', 'the a an and or of'), // all stop words
                ],
            });
            assert.strictEqual(generateTfidfSummary(session), 'Minimal session');
        });

        test('extracts meaningful keywords from technical content', () => {
            const session = makeSession({
                id: 's1',
                title: 'Debugging',
                messages: [
                    msg('user', 'The database query is slow because the index is missing on the foreign key column. We should add an index to improve performance.'),
                    msg('user', 'Also the API endpoint returns 500 when the input is null. Need to add validation.'),
                ],
            });
            const summary = generateTfidfSummary(session);
            assert.ok(summary.length > 0);
            // Should contain meaningful keywords, not stop words
            assert.ok(!summary.includes('the'));
            // 'a' as a standalone stop word should not appear in the keyword list
            assert.ok(!summary.split(', ').includes('a'));
        });

        test('only considers first 4000 chars of user content', () => {
            const longContent = 'database '.repeat(1000); // 8000 chars
            const session = makeSession({
                id: 's1',
                title: 'Long session',
                messages: [
                    msg('user', longContent),
                ],
            });
            // Should not throw
            const summary = generateTfidfSummary(session);
            assert.ok(typeof summary === 'string');
        });
    });

    suite('extractKeywords', () => {
        test('returns top N keywords sorted by frequency', () => {
            const result = extractKeywords('react react react angular angular vue', 2);
            assert.deepStrictEqual(result, ['react', 'angular']);
        });

        test('filters out stop words', () => {
            const result = extractKeywords('the and of react for with', 3);
            assert.deepStrictEqual(result, ['react']);
        });

        test('ignores words shorter than 3 characters', () => {
            const result = extractKeywords('react js go ts vue', 3);
            assert.deepStrictEqual(result, ['react', 'vue']);
        });

        test('handles punctuation and special characters', () => {
            const result = extractKeywords('react! component? (testing) [api]', 3);
            assert.deepStrictEqual(result, ['react', 'component', 'testing']);
        });

        test('returns empty array for empty text', () => {
            assert.deepStrictEqual(extractKeywords('', 3), []);
        });

        test('returns empty array for text with only stop words', () => {
            assert.deepStrictEqual(extractKeywords('the a an and or of', 3), []);
        });

        test('defaults to topN=3', () => {
            const result = extractKeywords('react angular vue svelte');
            assert.strictEqual(result.length, 3);
        });
    });

    suite('RateLimiter', () => {
        test('runs function when under max concurrency', async () => {
            const limiter = new RateLimiter(5);
            const result = await limiter.run(() => Promise.resolve(42));
            assert.strictEqual(result, 42);
        });

        test('queues tasks when at max concurrency', async () => {
            const limiter = new RateLimiter(1);
            let order: string[] = [];
            const p1 = limiter.run(async () => {
                order.push('start1');
                await new Promise(r => setTimeout(r, 50));
                order.push('end1');
                return 1;
            });
            const p2 = limiter.run(async () => {
                order.push('start2');
                return 2;
            });
            const results = await Promise.all([p1, p2]);
            assert.strictEqual(results[0], 1);
            assert.strictEqual(results[1], 2);
            assert.strictEqual(order[0], 'start1');
            assert.strictEqual(order[1], 'end1');
            assert.strictEqual(order[2], 'start2');
        });

        test('handles concurrent tasks up to max', async () => {
            const limiter = new RateLimiter(3);
            const results = await Promise.all([
                limiter.run(() => Promise.resolve('a')),
                limiter.run(() => Promise.resolve('b')),
                limiter.run(() => Promise.resolve('c')),
            ]);
            assert.deepStrictEqual(results, ['a', 'b', 'c']);
        });

        test('propagates errors from the wrapped function', async () => {
            const limiter = new RateLimiter(5);
            await assert.rejects(
                limiter.run(() => Promise.reject(new Error('test error'))),
                /test error/,
            );
        });
    });
});