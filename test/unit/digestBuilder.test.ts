/**
 * test/unit/digestBuilder.test.ts
 *
 * Unit tests for digestBuilder — pure date-windowing and markdown rendering.
 */

import * as assert from 'assert';
import { buildDigest, type DigestWindow } from '../../src/analytics/digestBuilder';
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
        chronicleData: overrides.chronicleData,
    };
}

suite('digestBuilder', () => {
    const now = new Date('2024-06-15T12:00:00Z'); // Saturday
    const today = '2024-06-15T10:00:00Z';
    const yesterday = '2024-06-14T10:00:00Z';
    const lastWeek = '2024-06-08T10:00:00Z';
    const old = '2024-05-01T10:00:00Z';

    test('empty sessions returns no entries and empty markdown', () => {
        const result = buildDigest([], 'today', now);
        assert.strictEqual(result.entries.length, 0);
        assert.ok(result.markdown.includes('No sessions found'));
    });

    test('today window filters to sessions updated today', () => {
        const sessions = [
            makeSession({ id: 's1', updatedAt: today }),
            makeSession({ id: 's2', updatedAt: yesterday }),
        ];
        const result = buildDigest(sessions, 'today', now);
        assert.strictEqual(result.entries.length, 1);
        assert.strictEqual(result.entries[0].sessionId, 's1');
    });

    test('thisWeek window includes sessions from Monday to now', () => {
        const sessions = [
            makeSession({ id: 's1', updatedAt: today }),
            makeSession({ id: 's2', updatedAt: old }),
        ];
        // Monday June 10, 2024 (current week)
        const result = buildDigest(sessions, 'thisWeek', now);
        assert.strictEqual(result.entries.length, 1);
        assert.strictEqual(result.entries[0].sessionId, 's1');
    });

    test('thisSprint window includes sessions within the 2-week sprint', () => {
        const sessions = [
            makeSession({ id: 's1', updatedAt: today }),
            makeSession({ id: 's2', updatedAt: lastWeek }),
        ];
        const result = buildDigest(sessions, 'thisSprint', now);
        assert.strictEqual(result.entries.length, 2);
    });

    test('sessions are sorted by updatedAt ascending', () => {
        const sessions = [
            makeSession({ id: 's1', updatedAt: '2024-06-15T10:00:00Z', title: 'Second' }),
            makeSession({ id: 's2', updatedAt: '2024-06-15T08:00:00Z', title: 'First' }),
            makeSession({ id: 's3', updatedAt: '2024-06-15T12:00:00Z', title: 'Third' }),
        ];
        const result = buildDigest(sessions, 'today', now);
        assert.strictEqual(result.entries.length, 3);
        assert.strictEqual(result.entries[0].title, 'First');
        assert.strictEqual(result.entries[1].title, 'Second');
        assert.strictEqual(result.entries[2].title, 'Third');
    });

    test('uses sidecar summary when available', () => {
        const session = makeSession({ id: 's1', updatedAt: today });
        const summaries = new Map([['s1', 'Custom summary text']]);
        const result = buildDigest([session], 'today', now, summaries);
        assert.strictEqual(result.entries[0].summary, 'Custom summary text');
    });

    test('falls back to first assistant message when no sidecar summary', () => {
        const session = makeSession({
            id: 's1',
            updatedAt: today,
            messages: [
                msg('user', 'hello'),
                msg('assistant', 'Assistant response content here'),
            ],
        });
        const result = buildDigest([session], 'today', now);
        assert.strictEqual(result.entries[0].summary, 'Assistant response content here');
    });

    test('falls back to placeholder when no messages and no summary', () => {
        const session = makeSession({ id: 's1', updatedAt: today, messages: [] });
        const result = buildDigest([session], 'today', now);
        assert.strictEqual(result.entries[0].summary, '(no summary available)');
    });

    test('groups entries by branch in markdown', () => {
        const sessions = [
            makeSession({ id: 's1', updatedAt: today, title: 'Fix bug', chronicleData: { overview: null, workDone: null, technicalDetails: null, nextSteps: null, createdAt: null, branch: 'fix/bug' } }),
            makeSession({ id: 's2', updatedAt: today, title: 'Add feature', chronicleData: { overview: null, workDone: null, technicalDetails: null, nextSteps: null, createdAt: null, branch: 'feat/x' } }),
        ];
        const result = buildDigest(sessions, 'today', now);
        assert.ok(result.markdown.includes('fix/bug'));
        assert.ok(result.markdown.includes('feat/x'));
        assert.ok(result.markdown.includes('Fix bug'));
        assert.ok(result.markdown.includes('Add feature'));
    });

    test('handles invalid dates gracefully', () => {
        const session = makeSession({ id: 's1', updatedAt: 'not-a-date' });
        const result = buildDigest([session], 'today', now);
        assert.strictEqual(result.entries.length, 0);
    });

    test('truncates long assistant messages to 120 chars', () => {
        const longContent = 'A'.repeat(200);
        const session = makeSession({
            id: 's1',
            updatedAt: today,
            messages: [
                msg('user', 'hi'),
                msg('assistant', longContent),
            ],
        });
        const result = buildDigest([session], 'today', now);
        assert.ok(result.entries[0].summary.length <= 121); // 120 + ellipsis char
    });
});