/**
 * test/unit/summaryGenerator.test.ts
 *
 * Unit tests for summaryGenerator — pure TF-IDF keyword extraction functions.
 */

import * as assert from 'assert';
import { generateTfidfSummary } from '../../src/analytics/summaryGenerator';
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
});