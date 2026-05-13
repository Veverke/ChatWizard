// test/suite/integration/timeline.test.ts
//
// Integration tests — Timeline (scenarios 35–36)
//
// Exercises buildTimeline() directly with fixture sessions and synthetic
// sessions with explicit timestamps.

import * as assert from 'assert';
import * as path from 'path';

import { buildTimeline, TimelineEntry } from '../../../src/timeline/timelineBuilder';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import { parseClaudeSession } from '../../../src/parsers/claude';
import { Session } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX = path.join(FIXTURES, 'copilot');
const CLAUDE_FX  = path.join(FIXTURES, 'claude');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, updatedAt: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        workspaceId: 'ws-timeline',
        workspacePath: '/home/user/project',
        messages: [
            { id: `${id}-u`, role: 'user',      content: `Question from ${id}`, codeBlocks: [] },
            { id: `${id}-a`, role: 'assistant', content: `Answer for ${id}`,    codeBlocks: [] },
        ],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: updatedAt,
        updatedAt,
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Timeline', function () {
    this.timeout(10_000);

    // ── Test 35: Chronological order (newest first) ───────────────────────

    test('35 — entries are sorted newest-first', () => {
        const old    = makeSession('t-old',    '2024-01-15T10:00:00.000Z');
        const middle = makeSession('t-middle', '2025-03-20T14:30:00.000Z');
        const newest = makeSession('t-new',    '2026-06-01T08:00:00.000Z');

        const entries = buildTimeline([old, middle, newest]);

        assert.ok(entries.length >= 3, `expected ≥3 entries, got ${entries.length}`);
        // Verify descending order by timestamp
        for (let i = 1; i < entries.length; i++) {
            assert.ok(
                entries[i - 1].timestamp >= entries[i].timestamp,
                `entries not in descending order at position ${i}: ` +
                `${entries[i - 1].sessionId}(${entries[i - 1].timestamp}) < ${entries[i].sessionId}(${entries[i].timestamp})`
            );
        }
    });

    test('35b — newest session appears first in timeline', () => {
        const old    = makeSession('t2-old',    '2024-01-15T10:00:00.000Z');
        const newest = makeSession('t2-new',    '2026-06-01T08:00:00.000Z');

        const entries = buildTimeline([old, newest]);

        assert.strictEqual(entries[0].sessionId, 't2-new', 'newest session should be first');
        assert.strictEqual(entries[1].sessionId, 't2-old',  'oldest session should be last');
    });

    test('35c — timeline entries have correct metadata', () => {
        const session = makeSession('t3-meta', '2026-03-15T12:00:00.000Z');
        const entries = buildTimeline([session]);

        assert.strictEqual(entries.length, 1);
        const e = entries[0];
        assert.strictEqual(e.sessionId, 't3-meta');
        assert.strictEqual(e.date, '2026-03-15', `expected date "2026-03-15", got "${e.date}"`);
        assert.strictEqual(e.source, 'copilot');
        assert.ok(e.firstPrompt.length > 0, 'firstPrompt should not be empty');
        assert.ok(e.messageCount >= 2, 'messageCount should be ≥2');
        assert.ok(e.promptCount >= 1, 'promptCount should be ≥1');
    });

    test('35d — real fixture sessions appear in timeline', () => {
        const { session: copilotSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-35d'
        );
        const { session: claudeSession } = parseClaudeSession(
            path.join(CLAUDE_FX, 'sample-session.jsonl')
        );

        const entries = buildTimeline([copilotSession, claudeSession]);

        assert.strictEqual(entries.length, 2, 'both fixture sessions should appear');
        assert.ok(entries[0].timestamp >= entries[1].timestamp, 'should be sorted newest first');
    });

    test('35e — sessions with 0 messages are excluded from timeline', () => {
        const withMessages = makeSession('t5-msgs', '2026-01-01T00:00:00.000Z');
        const noMessages: Session = {
            id: 't5-empty',
            title: 'Empty',
            source: 'copilot',
            workspaceId: 'ws',
            workspacePath: '/p',
            messages: [],
            filePath: '/tmp/empty.jsonl',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };

        const entries = buildTimeline([withMessages, noMessages]);

        assert.ok(!entries.some(e => e.sessionId === 't5-empty'), 'empty session should be excluded');
        assert.ok(entries.some(e => e.sessionId === 't5-msgs'), 'non-empty session should be included');
    });

    // ── Test 36: Month-count pagination ───────────────────────────────────

    test('36 — monthCount option limits output to N calendar months', () => {
        // Create sessions spanning 3 different months
        const jan = makeSession('t6-jan', '2026-01-15T10:00:00.000Z');
        const feb = makeSession('t6-feb', '2026-02-20T10:00:00.000Z');
        const mar = makeSession('t6-mar', '2026-03-10T10:00:00.000Z');

        const allEntries = buildTimeline([jan, feb, mar]);
        assert.strictEqual(allEntries.length, 3, 'without monthCount, all 3 should appear');

        // With monthCount: 1, only the most recent calendar month (March) should be included
        const oneMonth = buildTimeline([jan, feb, mar], { monthCount: 1 });
        assert.ok(oneMonth.length <= 1, `monthCount:1 should return ≤1 month of sessions, got ${oneMonth.length}`);

        const twoMonths = buildTimeline([jan, feb, mar], { monthCount: 2 });
        assert.ok(twoMonths.length <= 2, `monthCount:2 should return ≤2 months of sessions, got ${twoMonths.length}`);
    });

    test('36b — before option excludes sessions on or after the cutoff', () => {
        const old    = makeSession('t7-old',    '2024-06-01T00:00:00.000Z');
        const recent = makeSession('t7-recent', '2026-01-01T00:00:00.000Z');

        const cutoff = new Date('2025-01-01T00:00:00.000Z');
        const entries = buildTimeline([old, recent], { before: cutoff });

        assert.ok(entries.every(e => e.timestamp < cutoff.getTime()),
            'all entries should be before the cutoff date');
        assert.ok(entries.some(e => e.sessionId === 't7-old'), 'old session should be present');
        assert.ok(!entries.some(e => e.sessionId === 't7-recent'), 'recent session should be excluded');
    });

    // ── Additional timeline quality checks ────────────────────────────────

    test('empty input produces empty timeline', () => {
        const entries = buildTimeline([]);
        assert.deepStrictEqual(entries, []);
    });

    test('workspaceName is the basename of workspacePath', () => {
        const session = makeSession('t8-ws', '2026-01-01T00:00:00.000Z');
        session.workspacePath = '/home/user/my-awesome-project';

        const entries = buildTimeline([session]);

        assert.strictEqual(entries[0].workspaceName, 'my-awesome-project');
    });
});
