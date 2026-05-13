// test/suite/timelineFeatures.test.ts

import * as assert from 'assert';
import { TimelineEntry } from '../../src/timeline/timelineBuilder';
import {
    buildHeatMap,
    buildWorkBursts,
    buildTopicDrift,
    buildTimelineStats,
    findFirstMatchingEntry,
    getISOWeekKey,
} from '../../src/timeline/timelineFeatures';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TimelineEntry> & { sessionId: string; timestamp: number }): TimelineEntry {
    const date = new Date(overrides.timestamp).toISOString().slice(0, 10);
    return {
        sessionTitle: 'Test Session',
        source: 'claude',
        workspacePath: '/ws',
        workspaceName: 'ws',
        date,
        firstPrompt: 'hello world',
        messageCount: 4,
        promptCount: 2,
        ...overrides,
    };
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Fixed "today" for deterministic tests: 2025-06-15 (Sunday)
const TODAY = new Date('2025-06-15T12:00:00Z');

// ── getISOWeekKey ─────────────────────────────────────────────────────────────

suite('getISOWeekKey', () => {
    test('returns correct week key for a known Monday', () => {
        // 2025-01-06 is a Monday → week 2
        const ts = new Date('2025-01-06T00:00:00Z').getTime();
        assert.strictEqual(getISOWeekKey(ts), '2025-W02');
    });

    test('returns correct week key for a known Sunday (same ISO week as prior Monday)', () => {
        // 2025-01-12 is a Sunday → still W02
        const ts = new Date('2025-01-12T00:00:00Z').getTime();
        assert.strictEqual(getISOWeekKey(ts), '2025-W02');
    });
});

// ── buildHeatMap ──────────────────────────────────────────────────────────────

suite('buildHeatMap', () => {
    test('empty input returns empty array', () => {
        assert.deepStrictEqual(buildHeatMap([]), []);
    });

    test('single entry produces a cell with count=1 on that date', () => {
        const ts = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts })];
        const cells = buildHeatMap(entries, new Date('2025-03-10T12:00:00Z'));
        const cell = cells.find(c => c.date === '2025-03-10');
        assert.ok(cell, 'cell for 2025-03-10 should exist');
        assert.strictEqual(cell!.count, 1);
    });

    test('two entries on the same day produce count=2', () => {
        const ts = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: ts }),
            makeEntry({ sessionId: 'b', timestamp: ts + HOUR }),
        ];
        const cells = buildHeatMap(entries, new Date('2025-03-10T12:00:00Z'));
        const cell = cells.find(c => c.date === '2025-03-10');
        assert.ok(cell);
        assert.strictEqual(cell!.count, 2);
    });

    test('days between min date and today with no sessions have count=0', () => {
        const ts1 = new Date('2025-03-08T10:00:00Z').getTime();
        const ts2 = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: ts1 }),
            makeEntry({ sessionId: 'b', timestamp: ts2 }),
        ];
        const cells = buildHeatMap(entries, new Date('2025-03-10T12:00:00Z'));
        const empty = cells.find(c => c.date === '2025-03-09');
        assert.ok(empty);
        assert.strictEqual(empty!.count, 0);
    });

    test('cells are sorted ascending (oldest first)', () => {
        const ts1 = new Date('2025-03-08T10:00:00Z').getTime();
        const ts2 = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: ts2 }),
            makeEntry({ sessionId: 'a', timestamp: ts1 }),
        ];
        const cells = buildHeatMap(entries, new Date('2025-03-10T12:00:00Z'));
        for (let i = 1; i < cells.length; i++) {
            assert.ok(cells[i].date >= cells[i - 1].date, 'cells should be ascending by date');
        }
    });

    test('last cell date equals today', () => {
        const ts = new Date('2025-03-08T10:00:00Z').getTime();
        const today = new Date('2025-03-10T12:00:00Z');
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts })];
        const cells = buildHeatMap(entries, today);
        assert.strictEqual(cells[cells.length - 1].date, '2025-03-10');
    });
});

// ── buildWorkBursts ───────────────────────────────────────────────────────────

suite('buildWorkBursts', () => {
    test('empty input returns empty array', () => {
        assert.deepStrictEqual(buildWorkBursts([]), []);
    });

    test('two sessions within 2 hours form a single burst', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: base + HOUR }),
            makeEntry({ sessionId: 'a', timestamp: base }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts.length, 1);
        assert.strictEqual(bursts[0].sessionCount, 2);
    });

    test('two sessions more than 2 hours apart form two bursts', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: base + 3 * HOUR }),
            makeEntry({ sessionId: 'a', timestamp: base }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts.length, 2);
    });

    test('burst durationMinutes is correct', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: base + 90 * 60 * 1000 }),  // +90 min
            makeEntry({ sessionId: 'a', timestamp: base }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts[0].durationMinutes, 90);
    });

    test('burst sources are deduped', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: base + HOUR, source: 'copilot' }),
            makeEntry({ sessionId: 'a', timestamp: base, source: 'copilot' }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts[0].sources.length, 1);
        assert.strictEqual(bursts[0].sources[0], 'copilot');
    });

    test('burst totalMessages sums correctly', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: base + HOUR, messageCount: 6 }),
            makeEntry({ sessionId: 'a', timestamp: base, messageCount: 4 }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts[0].totalMessages, 10);
    });

    test('single session produces a burst with sessionCount=1', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [makeEntry({ sessionId: 'a', timestamp: base })];
        const bursts = buildWorkBursts(entries);
        assert.strictEqual(bursts.length, 1);
        assert.strictEqual(bursts[0].sessionCount, 1);
    });

    test('bursts are returned newest-first', () => {
        const base = new Date('2025-03-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'd', timestamp: base + 10 * HOUR }),
            makeEntry({ sessionId: 'c', timestamp: base + 9 * HOUR }),
            makeEntry({ sessionId: 'b', timestamp: base + HOUR }),
            makeEntry({ sessionId: 'a', timestamp: base }),
        ];
        const bursts = buildWorkBursts(entries);
        assert.ok(bursts.length >= 2);
        assert.ok(bursts[0].startTimestamp > bursts[1].startTimestamp, 'bursts should be newest-first');
    });
});

// ── buildTopicDrift ───────────────────────────────────────────────────────────

suite('buildTopicDrift', () => {
    test('empty input returns empty array', () => {
        assert.deepStrictEqual(buildTopicDrift([]), []);
    });

    test('returns correct weekKey format', () => {
        const ts = new Date('2025-01-06T10:00:00Z').getTime(); // Monday W02
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts, firstPrompt: 'refactor authentication module' })];
        const drift = buildTopicDrift(entries);
        assert.ok(drift.length > 0);
        assert.ok(/^\d{4}-W\d{2}$/.test(drift[0].weekKey), 'weekKey should match YYYY-Www');
    });

    test('filters stop words', () => {
        const ts = new Date('2025-01-06T10:00:00Z').getTime();
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts, firstPrompt: 'the a an to of authentication' })];
        const drift = buildTopicDrift(entries);
        const allTerms = drift.flatMap(w => w.terms);
        const stopFound = allTerms.filter(t => ['the','a','an','to','of'].includes(t));
        assert.strictEqual(stopFound.length, 0, 'stop words should be filtered out');
    });

    test('returns at most 3 terms per week', () => {
        const ts = new Date('2025-01-06T10:00:00Z').getTime();
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts, firstPrompt: 'alpha beta gamma delta epsilon zeta' })];
        const drift = buildTopicDrift(entries);
        for (const week of drift) {
            assert.ok(week.terms.length <= 3, 'should have at most 3 terms per week');
        }
    });

    test('results are sorted oldest-first', () => {
        const ts1 = new Date('2025-01-06T10:00:00Z').getTime(); // W02
        const ts2 = new Date('2025-01-20T10:00:00Z').getTime(); // W04
        const entries = [
            makeEntry({ sessionId: 'b', timestamp: ts2, firstPrompt: 'deployment pipeline' }),
            makeEntry({ sessionId: 'a', timestamp: ts1, firstPrompt: 'refactor authentication' }),
        ];
        const drift = buildTopicDrift(entries);
        if (drift.length >= 2) {
            assert.ok(drift[0].weekKey < drift[1].weekKey, 'drift should be sorted oldest-first');
        }
    });
});

// ── buildTimelineStats ────────────────────────────────────────────────────────

suite('buildTimelineStats', () => {
    // TODAY = 2025-06-15 (Sunday)

    test('totalSessions equals entry count', () => {
        const ts = TODAY.getTime() - DAY;
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: ts }),
            makeEntry({ sessionId: 'b', timestamp: ts - DAY }),
        ];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.totalSessions, 2);
    });

    test('activeDaysThisWeek counts only days in current ISO week', () => {
        // ISO week for 2025-06-15 (Sun): Mon 2025-06-09 … Sun 2025-06-15
        const mon = new Date('2025-06-09T10:00:00Z').getTime();
        const tue = new Date('2025-06-10T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: mon }),
            makeEntry({ sessionId: 'b', timestamp: tue }),
        ];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.activeDaysThisWeek, 2);
    });

    test('activeDaysThisWeek does not count days outside the current week', () => {
        // 2025-06-08 is last Sunday (previous week)
        const prevWeek = new Date('2025-06-08T10:00:00Z').getTime();
        const entries = [makeEntry({ sessionId: 'a', timestamp: prevWeek })];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.activeDaysThisWeek, 0);
    });

    test('currentStreak is 0 when no sessions today', () => {
        const ts = TODAY.getTime() - 2 * DAY;
        const entries = [makeEntry({ sessionId: 'a', timestamp: ts })];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.currentStreak, 0);
    });

    test('currentStreak counts consecutive days ending today', () => {
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: TODAY.getTime() }),
            makeEntry({ sessionId: 'b', timestamp: TODAY.getTime() - DAY }),
            makeEntry({ sessionId: 'c', timestamp: TODAY.getTime() - 2 * DAY }),
        ];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.currentStreak, 3);
    });

    test('longestStreak detects max run across a gap', () => {
        // 3-day run, gap, 1-day run
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: TODAY.getTime() }),
            makeEntry({ sessionId: 'b', timestamp: TODAY.getTime() - DAY }),
            makeEntry({ sessionId: 'c', timestamp: TODAY.getTime() - 2 * DAY }),
            // gap of 2 days
            makeEntry({ sessionId: 'd', timestamp: TODAY.getTime() - 5 * DAY }),
        ];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.longestStreak, 3);
    });

    test('onThisDayLastMonth returns entries from same date 1 month ago', () => {
        // TODAY = 2025-06-15; last month same day = 2025-05-15
        const target = new Date('2025-05-15T10:00:00Z').getTime();
        const other  = new Date('2025-05-14T10:00:00Z').getTime();
        const entries = [
            makeEntry({ sessionId: 'a', timestamp: target }),
            makeEntry({ sessionId: 'b', timestamp: other }),
        ];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.onThisDayLastMonth.length, 1);
        assert.strictEqual(stats.onThisDayLastMonth[0].sessionId, 'a');
    });

    test('onThisDayLastMonth is empty when no sessions on that date', () => {
        const entries = [makeEntry({ sessionId: 'a', timestamp: TODAY.getTime() })];
        const stats = buildTimelineStats(entries, TODAY);
        assert.strictEqual(stats.onThisDayLastMonth.length, 0);
    });
});

// ── findFirstMatchingEntry ────────────────────────────────────────────────────

suite('findFirstMatchingEntry', () => {
    test('returns undefined when no entries', () => {
        assert.strictEqual(findFirstMatchingEntry([], 'test'), undefined);
    });

    test('returns undefined when no match', () => {
        const entries = [makeEntry({ sessionId: 'a', timestamp: TODAY.getTime(), firstPrompt: 'hello world' })];
        assert.strictEqual(findFirstMatchingEntry(entries, 'xyzzy'), undefined);
    });

    test('matches against firstPrompt case-insensitively', () => {
        const entries = [makeEntry({ sessionId: 'a', timestamp: TODAY.getTime(), firstPrompt: 'Hello World' })];
        const result = findFirstMatchingEntry(entries, 'hello');
        assert.ok(result);
        assert.strictEqual(result!.sessionId, 'a');
    });

    test('matches against sessionTitle', () => {
        const entries = [makeEntry({ sessionId: 'a', timestamp: TODAY.getTime(), sessionTitle: 'Auth Refactor', firstPrompt: 'unrelated' })];
        const result = findFirstMatchingEntry(entries, 'auth');
        assert.ok(result);
        assert.strictEqual(result!.sessionId, 'a');
    });

    test('returns the chronologically earliest match (oldest entry)', () => {
        // entries sorted newest-first
        const newer = makeEntry({ sessionId: 'newer', timestamp: TODAY.getTime(),          firstPrompt: 'authentication work' });
        const older = makeEntry({ sessionId: 'older', timestamp: TODAY.getTime() - 5 * DAY, firstPrompt: 'authentication started' });
        const entries = [newer, older]; // newest-first
        const result = findFirstMatchingEntry(entries, 'authentication');
        assert.ok(result);
        assert.strictEqual(result!.sessionId, 'older', 'should return the earliest (oldest) match');
    });
});

// ── toolSwitchHighlight (tested via buildTimeline) ────────────────────────────

import { buildTimeline } from '../../src/timeline/timelineBuilder';
import { Session, Message } from '../../src/types/index';

function makeMsg(role: 'user' | 'assistant', content: string): Message {
    return { id: Math.random().toString(), role, content, codeBlocks: [] };
}

function makeSession(id: string, updatedAt: string, source: 'claude' | 'copilot'): Session {
    return {
        id,
        title: id,
        source,
        workspaceId: 'ws',
        workspacePath: '/ws',
        messages: [makeMsg('user', 'hello')],
        filePath: '/tmp/test.jsonl',
        createdAt: updatedAt,
        updatedAt,
    };
}

suite('toolSwitchHighlight annotation in buildTimeline', () => {
    test('different sources within 30 min → newer gets toolSwitchHighlight=true', () => {
        const base = '2025-06-15T10:00:00Z';
        const later = '2025-06-15T10:20:00Z';
        const sessions = [
            makeSession('old-claude', base, 'claude'),
            makeSession('new-copilot', later, 'copilot'),
        ];
        const entries = buildTimeline(sessions);
        const copilotEntry = entries.find(e => e.sessionId === 'new-copilot');
        assert.ok(copilotEntry);
        assert.strictEqual(copilotEntry!.toolSwitchHighlight, true);
    });

    test('same source within 30 min → no toolSwitchHighlight', () => {
        const base = '2025-06-15T10:00:00Z';
        const later = '2025-06-15T10:20:00Z';
        const sessions = [
            makeSession('old-claude', base, 'claude'),
            makeSession('new-claude', later, 'claude'),
        ];
        const entries = buildTimeline(sessions);
        const newer = entries.find(e => e.sessionId === 'new-claude');
        assert.ok(newer);
        assert.ok(!newer!.toolSwitchHighlight);
    });

    test('different sources but > 30 min apart → no toolSwitchHighlight', () => {
        const base = '2025-06-15T10:00:00Z';
        const later = '2025-06-15T11:00:00Z'; // 60 min later
        const sessions = [
            makeSession('old-claude', base, 'claude'),
            makeSession('new-copilot', later, 'copilot'),
        ];
        const entries = buildTimeline(sessions);
        const copilotEntry = entries.find(e => e.sessionId === 'new-copilot');
        assert.ok(copilotEntry);
        assert.ok(!copilotEntry!.toolSwitchHighlight);
    });
});
