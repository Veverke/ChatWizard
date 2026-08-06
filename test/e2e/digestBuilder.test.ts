// test/e2e/digestBuilder.test.ts
// Feature 26 — Workspace Digest / Standup Reports

import * as assert from 'assert';
import { buildDigest } from '../../src/analytics/digestBuilder';
import type { Session } from '../../src/types/index';

function makeSession(id: string, updatedAt: string, title?: string, branch?: string): Session {
    return {
        id,
        title: title ?? `Session ${id}`,
        source: 'claude',
        workspaceId: 'ws1',
        messages: [
            { id: `${id}-u0`, role: 'user', content: 'What should I do?', codeBlocks: [] },
            { id: `${id}-a0`, role: 'assistant', content: 'Here is what to do next.', codeBlocks: [] },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: updatedAt,
        updatedAt,
        chronicleData: branch ? {
            overview: null, workDone: null, technicalDetails: null, nextSteps: null,
            createdAt: null, branch,
        } : undefined,
    };
}

/** Returns a fixed "now" anchored to 2026-06-04T12:00:00Z (Wednesday) */
const NOW = new Date('2026-06-04T12:00:00Z');

suite('Feature 26 — Digest Builder', () => {
    test('buildDigest("today") includes only sessions from today', () => {
        const sessions = [
            makeSession('today-1', '2026-06-04T08:00:00Z'),  // today
            makeSession('today-2', '2026-06-04T11:00:00Z'),  // today
            makeSession('yesterday', '2026-06-03T15:00:00Z'), // yesterday
            makeSession('last-week', '2026-05-28T10:00:00Z'), // last week
        ];
        const { entries } = buildDigest(sessions, 'today', NOW);
        assert.strictEqual(entries.length, 2, 'should include only 2 today sessions');
        assert.ok(entries.every(e => e.date === '2026-06-04'), 'all entries should be from today');
    });

    test('buildDigest("thisWeek") includes sessions from current Monday onward', () => {
        const sessions = [
            makeSession('monday', '2026-06-01T10:00:00Z'),    // Monday (start of week)
            makeSession('tuesday', '2026-06-02T10:00:00Z'),   // Tuesday
            makeSession('today', '2026-06-04T10:00:00Z'),     // Wednesday (today)
            makeSession('last-week', '2026-05-31T10:00:00Z'), // Sunday before this week
        ];
        const { entries } = buildDigest(sessions, 'thisWeek', NOW);
        assert.ok(entries.length >= 3, 'should include Mon, Tue, and today');
        assert.ok(!entries.some(e => e.sessionId === 'last-week'), 'last week session should be excluded');
    });

    test('buildDigest markdown starts with "## What I worked on"', () => {
        const sessions = [makeSession('s1', '2026-06-04T10:00:00Z')];
        const { markdown } = buildDigest(sessions, 'today', NOW);
        assert.ok(markdown.startsWith('## What I worked on'), 'markdown should start with expected header');
    });

    test('buildDigest groups sessions by branch when gitContext available', () => {
        const sessions = [
            makeSession('auth-1', '2026-06-04T08:00:00Z', 'JWT auth', 'feature/auth'),
            makeSession('auth-2', '2026-06-04T09:00:00Z', 'Refresh token', 'feature/auth'),
            makeSession('main-1', '2026-06-04T10:00:00Z', 'Hotfix', 'main'),
        ];
        const { markdown } = buildDigest(sessions, 'today', NOW);
        assert.ok(markdown.includes('### feature/auth'), 'should have feature/auth branch group');
        assert.ok(markdown.includes('### main'), 'should have main branch group');
        assert.ok(markdown.includes('(2 sessions)'), 'feature/auth should show 2 sessions');
    });

    test('buildDigest falls back to first assistant message when no sidecar summary', () => {
        const sessions = [makeSession('s1', '2026-06-04T10:00:00Z')];
        const { entries } = buildDigest(sessions, 'today', NOW);
        assert.ok(entries.length > 0, 'should have entries');
        assert.ok(entries[0].summary.length > 0, 'summary should be non-empty');
        // Fallback is the first assistant message content
        assert.ok(entries[0].summary.includes('Here is what to do'), 'should use assistant message as fallback');
    });

    test('buildDigest uses sidecar summary when provided', () => {
        const sessions = [makeSession('s1', '2026-06-04T10:00:00Z')];
        const summaries = new Map([['s1', 'Custom sidecar summary text']]);
        const { entries } = buildDigest(sessions, 'today', NOW, summaries);
        assert.strictEqual(entries[0].summary, 'Custom sidecar summary text');
    });

    test('buildDigest returns empty entries for empty session array', () => {
        const { entries, markdown } = buildDigest([], 'today', NOW);
        assert.strictEqual(entries.length, 0, 'should have no entries');
        assert.ok(markdown.includes('No sessions found'), 'should mention no sessions');
    });

    test('buildDigest returns empty entries when no sessions fall in window', () => {
        const sessions = [makeSession('old', '2026-01-01T10:00:00Z')];
        const { entries } = buildDigest(sessions, 'today', NOW);
        assert.strictEqual(entries.length, 0, 'old session should not appear in today digest');
    });

    test('entries are sorted by date ascending within the window', () => {
        const sessions = [
            makeSession('s3', '2026-06-04T11:00:00Z'),
            makeSession('s1', '2026-06-04T08:00:00Z'),
            makeSession('s2', '2026-06-04T09:00:00Z'),
        ];
        const { entries } = buildDigest(sessions, 'today', NOW);
        if (entries.length >= 2) {
            for (let i = 1; i < entries.length; i++) {
                assert.ok(
                    entries[i - 1].date <= entries[i].date,
                    'entries should be sorted ascending by date'
                );
            }
        }
    });
});