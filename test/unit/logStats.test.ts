/**
 * test/unit/logStats.test.ts
 *
 * Phase 4 — per-agent / per-session statistics.
 *
 * Covers the aggregation itself (totals, per-agent rows, per-session rows,
 * failures, success rate, diff line counts) plus the markdown report renderer
 * used by `Chat Wizard: Show Agent Log Stats`.
 */

import * as assert from 'assert';
import {
    STATS_SESSION_ROW_LIMIT,
    computeLogStats,
    formatStatsTime,
    formatSuccessRate,
    renderLogStatsMarkdown,
} from '../../src/logs/logStats';
import { CommandEvent, DiffEvent, ErrorEvent, LogEvent } from '../../src/logs/types';

function command(overrides: Partial<CommandEvent> & { id: string; timestamp: string }): CommandEvent {
    return {
        type: 'command',
        tool: 'copilot',
        sessionId: 's1',
        commandText: 'npm test',
        ...overrides,
    } as CommandEvent;
}

function diff(overrides: Partial<DiffEvent> & { id: string; timestamp: string }): DiffEvent {
    return {
        type: 'diff',
        tool: 'cline',
        sessionId: 's2',
        filePath: '/repo/a.ts',
        diffText: '+a\n-b\n',
        addedLines: 1,
        removedLines: 1,
        ...overrides,
    } as DiffEvent;
}

function error(overrides: Partial<ErrorEvent> & { id: string; timestamp: string }): ErrorEvent {
    return {
        type: 'error',
        tool: 'cline',
        sessionId: 's2',
        message: 'boom',
        ...overrides,
    } as ErrorEvent;
}

suite('logStats — computeLogStats', () => {
    test('an empty store produces zeroed totals and no success rate', () => {
        const report = computeLogStats([]);
        assert.strictEqual(report.totalEvents, 0);
        assert.strictEqual(report.toolCount, 0);
        assert.strictEqual(report.sessionCount, 0);
        assert.strictEqual(report.successRate, null);
        assert.deepStrictEqual(report.byTool, []);
        assert.deepStrictEqual(report.sessions, []);
        assert.strictEqual(report.firstTimestamp, undefined);
        assert.strictEqual(report.lastTimestamp, undefined);
    });

    test('aggregates per agent, per session, failures and diff lines', () => {
        const events: LogEvent[] = [
            command({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 }),
            command({ id: 'c2', timestamp: '2026-01-01T10:05:00.000Z', exitCode: 1 }),
            command({ id: 'c3', timestamp: '2026-01-01T11:00:00.000Z', tool: 'cline', sessionId: 's2' }),
            diff({ id: 'd1', timestamp: '2026-01-01T11:05:00.000Z' }),
            error({ id: 'e1', timestamp: '2026-01-01T11:10:00.000Z', severity: 'error' }),
            error({ id: 'e2', timestamp: '2026-01-01T11:15:00.000Z', severity: 'warning' }),
        ];

        const report = computeLogStats(events);
        assert.strictEqual(report.totalEvents, 6);
        assert.strictEqual(report.toolCount, 2);
        assert.strictEqual(report.sessionCount, 2);
        assert.strictEqual(report.commands, 3);
        assert.strictEqual(report.failedCommands, 1);
        assert.strictEqual(report.errors, 2);
        assert.strictEqual(report.diffs, 1);
        assert.strictEqual(report.addedLines, 1);
        assert.strictEqual(report.removedLines, 1);
        // 1 failed command + 1 non-warning error; the warning is not a failure.
        assert.strictEqual(report.failures, 2);
        // Only c1/c2 carried an exit code: 1 of 2 succeeded.
        assert.strictEqual(report.commandsWithExitCode, 2);
        assert.strictEqual(report.successRate, 0.5);
        assert.strictEqual(report.firstTimestamp, '2026-01-01T10:00:00.000Z');
        assert.strictEqual(report.lastTimestamp, '2026-01-01T11:15:00.000Z');

        const copilot = report.byTool.find((row) => row.tool === 'copilot');
        assert.ok(copilot, 'copilot row present');
        assert.strictEqual(copilot?.events, 2);
        assert.strictEqual(copilot?.sessions, 1);
        assert.strictEqual(copilot?.commands, 2);
        assert.strictEqual(copilot?.failedCommands, 1);
        assert.strictEqual(copilot?.failures, 1);

        const cline = report.byTool.find((row) => row.tool === 'cline');
        assert.ok(cline, 'cline row present');
        assert.strictEqual(cline?.events, 4);
        assert.strictEqual(cline?.sessions, 1);
        assert.strictEqual(cline?.commands, 1);
        assert.strictEqual(cline?.diffs, 1);
        assert.strictEqual(cline?.errors, 2);
        assert.strictEqual(cline?.failures, 1);

        // Most active agent first.
        assert.deepStrictEqual(report.byTool.map((row) => row.tool), ['cline', 'copilot']);
    });
});

suite('logStats — sessions and edge cases', () => {
    test('sessions are ordered newest-first and unsessioned events bucket per tool', () => {
        const events: LogEvent[] = [
            command({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', sessionId: 'old' }),
            command({ id: 'c2', timestamp: '2026-02-01T10:00:00.000Z', sessionId: 'new' }),
            command({ id: 'c3', timestamp: '2026-03-01T10:00:00.000Z', sessionId: undefined, tool: 'aider' }),
        ];
        const report = computeLogStats(events);
        assert.deepStrictEqual(report.sessions.map((row) => row.key), ['tool:aider', 'new', 'old']);
        assert.strictEqual(report.sessions[0].sessionId, undefined);
        assert.strictEqual(report.sessions[0].tool, 'aider');
    });

    test('the session list is capped but the session count is not', () => {
        const events: LogEvent[] = [];
        for (let i = 0; i < STATS_SESSION_ROW_LIMIT + 5; i += 1) {
            events.push(command({
                id: `c${i}`,
                timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
                sessionId: `s${i}`,
            }));
        }
        const report = computeLogStats(events);
        assert.strictEqual(report.sessionCount, STATS_SESSION_ROW_LIMIT + 5);
        assert.strictEqual(report.sessions.length, STATS_SESSION_ROW_LIMIT);
    });

    test('success rate stays null when no command logged an exit code', () => {
        const report = computeLogStats([
            command({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', tool: 'aider', exitCode: undefined }),
        ]);
        assert.strictEqual(report.commandsWithExitCode, 0);
        assert.strictEqual(report.successRate, null);
    });
});

suite('logStats — markdown report', () => {
    test('formatStatsTime and formatSuccessRate', () => {
        assert.strictEqual(formatStatsTime(undefined), '—');
        assert.strictEqual(formatStatsTime('not-a-date'), 'not-a-date');
        const local = new Date(2026, 4, 6, 7, 8, 0); // 2026-05-06 07:08 local
        assert.strictEqual(formatStatsTime(local.toISOString()), '2026-05-06 07:08');
        assert.strictEqual(formatSuccessRate(null), '—');
        assert.strictEqual(formatSuccessRate(0.923), '92.3%');
        assert.strictEqual(formatSuccessRate(1), '100.0%');
    });

    test('renders summary, per-agent and per-session tables', () => {
        const report = computeLogStats([
            command({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 1 }),
            diff({ id: 'd1', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        const markdown = renderLogStatsMarkdown(report, (tool) => (tool === 'copilot' ? 'GitHub Copilot' : 'Cline'));

        assert.ok(markdown.startsWith('# Agent Log Stats'));
        assert.ok(markdown.includes('## Summary'));
        assert.ok(markdown.includes('| Failed commands | 1 |'));
        assert.ok(markdown.includes('| Command success rate | 0.0% of 1 |'));
        assert.ok(markdown.includes('## Per agent'));
        assert.ok(markdown.includes('| GitHub Copilot | 1 |'), 'per-agent row uses the friendly name');
        assert.ok(markdown.includes('| Cline | 1 |'));
        assert.ok(markdown.includes('## Per session (newest 2)'));
        assert.ok(markdown.includes('| s1 |'));
        assert.ok(markdown.includes('| s2 |'));
    });

    test('renders an empty report without throwing', () => {
        const markdown = renderLogStatsMarkdown(computeLogStats([]));
        assert.ok(markdown.includes('**0** events'));
        assert.ok(markdown.includes('| Command success rate | — (no exit codes recorded) |'));
        assert.ok(markdown.includes('_No sessions recorded._'));
    });

    test('pipes in tool labels are escaped so the table stays intact', () => {
        const report = computeLogStats([
            command({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 }),
        ]);
        const markdown = renderLogStatsMarkdown(report, () => 'Odd|Agent');
        assert.ok(markdown.includes('| Odd\\|Agent |'), 'escaped pipe in agent name');
    });

    test('omitted sessions are reported', () => {
        const events: LogEvent[] = [];
        for (let i = 0; i < STATS_SESSION_ROW_LIMIT + 2; i += 1) {
            events.push(command({
                id: `c${i}`,
                timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
                sessionId: `s${i}`,
            }));
        }
        const markdown = renderLogStatsMarkdown(computeLogStats(events));
        assert.ok(markdown.includes('_2 older session(s) omitted._'));
    });
});

