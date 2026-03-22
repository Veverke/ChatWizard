// test/suite/modelUsageEngine.test.ts

import * as assert from 'assert';
import { computeModelUsage } from '../../src/analytics/modelUsageEngine';
import { SessionSummary } from '../../src/types/index';

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        title: 'Test',
        source: 'claude',
        workspaceId: 'ws',
        filePath: '/tmp/test.jsonl',
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-15T12:00:00Z',
        ...overrides,
    };
}

const JAN1 = new Date(2026, 0, 1);
const JAN31 = new Date(2026, 0, 31);

suite('computeModelUsage', () => {

    test('empty sessions array returns zeros and empty models', () => {
        const result = computeModelUsage([], JAN1, JAN31);
        assert.strictEqual(result.totalSessions, 0);
        assert.strictEqual(result.totalUserRequests, 0);
        assert.deepStrictEqual(result.models, []);
    });

    test('sessions outside date range are excluded', () => {
        const s = makeSummary({ id: 's1', updatedAt: '2025-12-31T23:59:59Z', model: 'gpt-4o', userMessageCount: 5 });
        const result = computeModelUsage([s], JAN1, JAN31);
        assert.strictEqual(result.totalSessions, 0);
        assert.strictEqual(result.totalUserRequests, 0);
        assert.deepStrictEqual(result.models, []);
    });

    test('sessions on the boundary dates are included', () => {
        const s1 = makeSummary({ id: 's1', updatedAt: '2026-01-01T00:00:00Z', model: 'gpt-4o', userMessageCount: 2 });
        const s2 = makeSummary({ id: 's2', updatedAt: '2026-01-31T23:59:59Z', model: 'gpt-4o', userMessageCount: 3 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        assert.strictEqual(result.totalSessions, 2);
        assert.strictEqual(result.totalUserRequests, 5);
    });

    test('sessions with model undefined group under "Unknown"', () => {
        const s = makeSummary({ id: 's1', model: undefined, userMessageCount: 4 });
        const result = computeModelUsage([s], JAN1, JAN31);
        assert.strictEqual(result.models.length, 1);
        assert.strictEqual(result.models[0].model, 'Unknown');
        assert.strictEqual(result.models[0].source, 'claude');
        assert.strictEqual(result.models[0].userRequests, 4);
    });

    test('sessions with whitespace-only model string group under "Unknown"', () => {
        const s = makeSummary({ id: 's1', model: '   ', userMessageCount: 3 });
        const result = computeModelUsage([s], JAN1, JAN31);
        assert.strictEqual(result.models[0].model, 'Unknown');
    });

    test('multiple sessions with same model and same source are aggregated', () => {
        const s1 = makeSummary({ id: 's1', model: 'gpt-4o', source: 'copilot', userMessageCount: 3 });
        const s2 = makeSummary({ id: 's2', model: 'gpt-4o', source: 'copilot', userMessageCount: 7 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        assert.strictEqual(result.models.length, 1);
        assert.strictEqual(result.models[0].sessionCount, 2);
        assert.strictEqual(result.models[0].userRequests, 10);
        assert.strictEqual(result.models[0].source, 'copilot');
    });

    test('same model name from different sources stays as separate entries', () => {
        // e.g. Claude Sonnet accessed via Claude Code AND via Copilot Chat
        const s1 = makeSummary({ id: 's1', model: 'claude-sonnet-4-20250514', source: 'claude',  userMessageCount: 5 });
        const s2 = makeSummary({ id: 's2', model: 'claude-sonnet-4-20250514', source: 'copilot', userMessageCount: 3 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        assert.strictEqual(result.models.length, 2);
        const claudeEntry  = result.models.find(m => m.source === 'claude');
        const copilotEntry = result.models.find(m => m.source === 'copilot');
        assert.strictEqual(claudeEntry?.userRequests, 5);
        assert.strictEqual(copilotEntry?.userRequests, 3);
    });

    test('models array sorted descending by userRequests', () => {
        const s1 = makeSummary({ id: 's1', model: 'gpt-4o', userMessageCount: 5 });
        const s2 = makeSummary({ id: 's2', model: 'claude-sonnet', userMessageCount: 10 });
        const s3 = makeSummary({ id: 's3', model: 'gemini', userMessageCount: 2 });
        const result = computeModelUsage([s1, s2, s3], JAN1, JAN31);
        // Model names are normalized — gpt-4o becomes GPT-4o; unrecognised IDs pass through
        assert.strictEqual(result.models[0].model, 'claude-sonnet');
        assert.strictEqual(result.models[1].model, 'GPT-4o');
        assert.strictEqual(result.models[2].model, 'gemini');
    });

    test('percentage sums to ~100 (within floating point tolerance)', () => {
        const s1 = makeSummary({ id: 's1', model: 'gpt-4o', userMessageCount: 7 });
        const s2 = makeSummary({ id: 's2', model: 'claude-sonnet', userMessageCount: 3 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        const total = result.models.reduce((acc, m) => acc + m.percentage, 0);
        assert.ok(Math.abs(total - 100) < 0.1, `Expected ~100, got ${total}`);
    });

    test('percentage is 0 for all models when totalUserRequests is 0', () => {
        const s = makeSummary({ id: 's1', model: 'gpt-4o', userMessageCount: 0 });
        const result = computeModelUsage([s], JAN1, JAN31);
        assert.strictEqual(result.models[0].percentage, 0);
        assert.strictEqual(result.totalUserRequests, 0);
    });

    test('totalSessions and totalUserRequests reflect only filtered sessions', () => {
        const inside = makeSummary({ id: 's1', model: 'gpt-4o', userMessageCount: 5, updatedAt: '2026-01-10T00:00:00Z' });
        const outside = makeSummary({ id: 's2', model: 'gpt-4o', userMessageCount: 99, updatedAt: '2026-02-01T00:00:00Z' });
        const result = computeModelUsage([inside, outside], JAN1, JAN31);
        assert.strictEqual(result.totalSessions, 1);
        assert.strictEqual(result.totalUserRequests, 5);
    });

    test('from and to fields in result are YYYY-MM-DD strings', () => {
        const result = computeModelUsage([], JAN1, JAN31);
        assert.strictEqual(result.from, '2026-01-01');
        assert.strictEqual(result.to, '2026-01-31');
    });

    test('workspaceBreakdown is populated per workspace path', () => {
        const s1 = makeSummary({ id: 's1', model: 'gpt-4o', source: 'copilot', workspacePath: '/ws/a', userMessageCount: 4 });
        const s2 = makeSummary({ id: 's2', model: 'gpt-4o', source: 'copilot', workspacePath: '/ws/b', userMessageCount: 6 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        const entry = result.models[0];
        assert.strictEqual(entry.workspaceBreakdown.length, 2);
        // sorted descending by userRequests
        assert.strictEqual(entry.workspaceBreakdown[0].workspace, '/ws/b');
        assert.strictEqual(entry.workspaceBreakdown[0].userRequests, 6);
        assert.strictEqual(entry.workspaceBreakdown[1].workspace, '/ws/a');
        assert.strictEqual(entry.workspaceBreakdown[1].userRequests, 4);
    });

    test('workspaceBreakdown aggregates requests from multiple sessions in same workspace', () => {
        const s1 = makeSummary({ id: 's1', model: 'gpt-4o', source: 'copilot', workspacePath: '/ws/a', userMessageCount: 3 });
        const s2 = makeSummary({ id: 's2', model: 'gpt-4o', source: 'copilot', workspacePath: '/ws/a', userMessageCount: 5 });
        const result = computeModelUsage([s1, s2], JAN1, JAN31);
        const entry = result.models[0];
        assert.strictEqual(entry.workspaceBreakdown.length, 1);
        assert.strictEqual(entry.workspaceBreakdown[0].userRequests, 8);
    });

    test('workspaceBreakdown falls back to workspaceId when workspacePath is absent', () => {
        const s = makeSummary({ id: 's1', model: 'gpt-4o', source: 'copilot', workspaceId: 'abc123', userMessageCount: 2 });
        // makeSummary does not set workspacePath, so workspaceId should be used
        const result = computeModelUsage([s], JAN1, JAN31);
        const entry = result.models[0];
        assert.strictEqual(entry.workspaceBreakdown[0].workspace, 'abc123');
    });
});
