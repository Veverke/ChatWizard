// test/suite/integration/analytics.test.ts
//
// Integration tests — Analytics & Model Usage (scenarios 33–34)
//
// Exercises the analytics engine and model-usage engine directly against
// fixture sessions parsed from fixture files.

import * as assert from 'assert';
import * as path from 'path';

import { SessionIndex } from '../../../src/index/sessionIndex';
import { computeAnalytics } from '../../../src/analytics/analyticsEngine';
import { countTokens } from '../../../src/analytics/tokenCounter';
import { computeModelUsage } from '../../../src/analytics/modelUsageEngine';
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

/** A wide date range that covers all fixture sessions */
const FROM_DATE = new Date('2020-01-01T00:00:00.000Z');
const TO_DATE   = new Date('2030-12-31T23:59:59.999Z');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Analytics & Model Usage', function () {
    this.timeout(10_000);

    // ── Test 33: Token count ──────────────────────────────────────────────

    test('33 — computeAnalytics returns non-zero token count for fixture session', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-33a'
        );

        const data = computeAnalytics([session], countTokens);

        assert.strictEqual(data.totalSessions, 1, 'should count exactly 1 session');
        assert.ok(data.totalTokens > 0, `totalTokens should be > 0, got ${data.totalTokens}`);
        assert.ok(data.totalPrompts >= 1, `should have ≥1 user turn`);
        assert.ok(data.totalResponses >= 1, `should have ≥1 assistant turn`);
    });

    test('33b — computeAnalytics tallies tokens separately for user and assistant', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-33b'
        );

        const data = computeAnalytics([session], countTokens);

        assert.ok(data.totalUserTokens > 0, 'user tokens should be > 0');
        assert.ok(data.totalAssistantTokens > 0, 'assistant tokens should be > 0');
        assert.strictEqual(
            data.totalTokens,
            data.totalUserTokens + data.totalAssistantTokens,
            'totalTokens should equal userTokens + assistantTokens'
        );
    });

    test('33c — computeAnalytics counts sessions per source', () => {
        const { session: copilotSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-33c-cpt'
        );
        const { session: claudeSession } = parseClaudeSession(
            path.join(CLAUDE_FX, 'sample-session.jsonl')
        );

        const data = computeAnalytics([copilotSession, claudeSession], countTokens);

        assert.strictEqual(data.totalSessions, 2);
        assert.strictEqual(data.sessionCountsBySource['copilot'], 1, 'expected 1 copilot session');
        assert.strictEqual(data.sessionCountsBySource['claude'],  1, 'expected 1 claude session');
    });

    test('33d — computeAnalytics builds daily activity with correct date', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-33d'
        );

        const data = computeAnalytics([session], countTokens);

        // We expect at least one day entry for the session's date
        assert.ok(data.dailyActivity.length >= 1, 'dailyActivity should have ≥1 entry');
        const day = data.dailyActivity[0];
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day.date), `date should be YYYY-MM-DD, got "${day.date}"`);
        assert.ok(day.sessionCount >= 1, 'day should count ≥1 session');
    });

    test('33e — computeAnalytics reports longestByMessages', () => {
        const sessions: Session[] = [];
        for (const file of ['sample-session.jsonl', 'session-with-model.jsonl', 'session-with-claude-model.jsonl']) {
            const { session } = parseCopilotSession(path.join(COPILOT_FX, file), `ws-33e-${file}`);
            sessions.push(session);
        }

        const data = computeAnalytics(sessions, countTokens);

        assert.ok(data.longestByMessages.length >= 1, 'should have ≥1 entry in longestByMessages');
        // Verify descending order
        for (let i = 1; i < data.longestByMessages.length; i++) {
            assert.ok(
                data.longestByMessages[i - 1].totalMessageCount >= data.longestByMessages[i].totalMessageCount,
                'longestByMessages should be sorted descending by message count'
            );
        }
    });

    // ── Test 34: Model breakdown ──────────────────────────────────────────

    test('34 — computeModelUsage groups sessions by model name', () => {
        const index = new SessionIndex();

        const { session: gptSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-34a-gpt'
        );
        const { session: claudeSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-claude-model.jsonl'), 'ws-34a-cld'
        );
        index.upsert(gptSession);
        index.upsert(claudeSession);

        const summaries = index.getAllSummaries();
        const data = computeModelUsage(summaries, FROM_DATE, TO_DATE);

        assert.ok(data.models.length >= 2, `expected ≥2 model entries, got ${data.models.length}`);
    });

    test('34b — computeModelUsage result contains gpt-4o entry', () => {
        const index = new SessionIndex();

        const { session: gptSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-34b-gpt'
        );
        const { session: claudeSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-claude-model.jsonl'), 'ws-34b-cld'
        );
        index.upsert(gptSession);
        index.upsert(claudeSession);

        const summaries = index.getAllSummaries();
        const data = computeModelUsage(summaries, FROM_DATE, TO_DATE);

        const modelNames = data.models.map(m => m.model);
        const hasGpt = modelNames.some(name => name.toLowerCase().includes('gpt'));
        assert.ok(hasGpt, `expected a gpt-4o model entry; got: ${modelNames.join(', ')}`);
    });

    test('34c — computeModelUsage result contains claude entry', () => {
        const index = new SessionIndex();

        const { session: gptSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-34c-gpt'
        );
        const { session: claudeSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-claude-model.jsonl'), 'ws-34c-cld'
        );
        index.upsert(gptSession);
        index.upsert(claudeSession);

        const summaries = index.getAllSummaries();
        const data = computeModelUsage(summaries, FROM_DATE, TO_DATE);

        const modelNames = data.models.map(m => m.model);
        const hasClaude = modelNames.some(name => name.toLowerCase().includes('claude'));
        assert.ok(hasClaude, `expected a claude model entry; got: ${modelNames.join(', ')}`);
    });

    test('34d — computeModelUsage total user-requests matches total sessions', () => {
        const index = new SessionIndex();

        const { session: s1 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-34d-1'
        );
        const { session: s2 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-claude-model.jsonl'), 'ws-34d-2'
        );
        index.upsert(s1);
        index.upsert(s2);

        const summaries = index.getAllSummaries();
        const data = computeModelUsage(summaries, FROM_DATE, TO_DATE);

        const totalFromModels = data.models.reduce((n, m) => n + m.sessionCount, 0);
        assert.strictEqual(totalFromModels, 2, `total session count across models should be 2`);
    });

    // ── Token counter unit tests ──────────────────────────────────────────

    test('countTokens returns 0 for empty string', () => {
        assert.strictEqual(countTokens('', 'copilot'), 0);
        assert.strictEqual(countTokens('', 'claude'), 0);
    });

    test('countTokens returns positive value for non-empty text', () => {
        const text = 'Hello world, this is a test sentence.';
        assert.ok(countTokens(text, 'copilot') > 0);
        assert.ok(countTokens(text, 'claude') > 0);
    });

    test('countTokens uses length-based formula for claude', () => {
        const text = 'abcdefghijklmnop'; // 16 chars → ceil(16/4) = 4 tokens
        assert.strictEqual(countTokens(text, 'claude'), 4);
    });
});
