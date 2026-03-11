// test/suite/analyticsEngine.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { computeAnalytics } from '../../src/analytics/analyticsEngine';
import { Session, Message } from '../../src/types/index';

const countTokens = (text: string, _source: unknown): number =>
    text.split(/\s+/).filter(Boolean).length;

function makeMessage(role: 'user' | 'assistant', content: string, id = Math.random().toString()): Message {
    return { id, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: 'Test Session',
        source: 'claude',
        workspaceId: 'ws-default',
        workspacePath: '/default/workspace',
        messages: [],
        filePath: '/tmp/test.jsonl',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

suite('computeAnalytics', () => {

    // ── empty input ────────────────────────────────────────────────────────

    test('empty sessions array returns all zeros and empty arrays', () => {
        const result = computeAnalytics([], countTokens);
        assert.strictEqual(result.totalSessions, 0);
        assert.strictEqual(result.totalPrompts, 0);
        assert.strictEqual(result.totalResponses, 0);
        assert.strictEqual(result.totalUserTokens, 0);
        assert.strictEqual(result.totalAssistantTokens, 0);
        assert.strictEqual(result.totalTokens, 0);
        assert.strictEqual(result.copilotSessions, 0);
        assert.strictEqual(result.claudeSessions, 0);
        assert.deepStrictEqual(result.dailyActivity, []);
        assert.deepStrictEqual(result.projectActivity, []);
        assert.deepStrictEqual(result.topTerms, []);
        assert.deepStrictEqual(result.longestByMessages, []);
        assert.deepStrictEqual(result.longestByTokens, []);
    });

    // ── single session ─────────────────────────────────────────────────────

    test('single session with one user + one assistant message returns correct counts', () => {
        const session = makeSession({
            id: 's1',
            source: 'claude',
            messages: [
                makeMessage('user', 'hello world'),
                makeMessage('assistant', 'hi there friend'),
            ],
            updatedAt: '2024-03-15T10:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);

        assert.strictEqual(result.totalSessions, 1);
        assert.strictEqual(result.totalPrompts, 1);
        assert.strictEqual(result.totalResponses, 1);
        assert.strictEqual(result.totalUserTokens, 2);       // "hello world" = 2 tokens
        assert.strictEqual(result.totalAssistantTokens, 3);  // "hi there friend" = 3 tokens
        assert.strictEqual(result.totalTokens, 5);
        assert.strictEqual(result.claudeSessions, 1);
        assert.strictEqual(result.copilotSessions, 0);
    });

    // ── source counts ──────────────────────────────────────────────────────

    test('copilotSessions and claudeSessions counts are correct', () => {
        const sessions = [
            makeSession({ id: 'c1', source: 'copilot', messages: [] }),
            makeSession({ id: 'c2', source: 'copilot', messages: [] }),
            makeSession({ id: 'cl1', source: 'claude', messages: [] }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.copilotSessions, 2);
        assert.strictEqual(result.claudeSessions, 1);
    });

    // ── daily activity ─────────────────────────────────────────────────────

    test('multiple sessions on same day produce one dailyActivity entry', () => {
        const sessions = [
            makeSession({
                id: 's1',
                messages: [makeMessage('user', 'one two three')],
                updatedAt: '2024-03-15T08:00:00Z',
            }),
            makeSession({
                id: 's2',
                messages: [makeMessage('user', 'four five')],
                updatedAt: '2024-03-15T18:00:00Z',
            }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.dailyActivity.length, 1);
        const day = result.dailyActivity[0];
        assert.strictEqual(day.date, '2024-03-15');
        assert.strictEqual(day.sessionCount, 2);
        assert.strictEqual(day.promptCount, 2);
        assert.strictEqual(day.tokenCount, 5); // 3 + 2
    });

    test('multiple sessions on different days produce entries sorted ascending', () => {
        const sessions = [
            makeSession({
                id: 's1',
                messages: [makeMessage('user', 'alpha beta')],
                updatedAt: '2024-03-20T00:00:00Z',
            }),
            makeSession({
                id: 's2',
                messages: [makeMessage('user', 'gamma')],
                updatedAt: '2024-03-10T00:00:00Z',
            }),
            makeSession({
                id: 's3',
                messages: [makeMessage('user', 'delta epsilon zeta')],
                updatedAt: '2024-03-15T00:00:00Z',
            }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.dailyActivity.length, 3);
        assert.strictEqual(result.dailyActivity[0].date, '2024-03-10');
        assert.strictEqual(result.dailyActivity[1].date, '2024-03-15');
        assert.strictEqual(result.dailyActivity[2].date, '2024-03-20');
    });

    test('tokenCount in dailyActivity equals sum of all session tokens on that day', () => {
        const sessions = [
            makeSession({
                id: 's1',
                messages: [
                    makeMessage('user', 'one two'),
                    makeMessage('assistant', 'three four five'),
                ],
                updatedAt: '2024-04-01T00:00:00Z',
            }),
            makeSession({
                id: 's2',
                messages: [
                    makeMessage('user', 'six seven eight nine'),
                ],
                updatedAt: '2024-04-01T00:00:00Z',
            }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.dailyActivity.length, 1);
        // s1: user=2, assistant=3 → 5; s2: user=4 → 4; total = 9
        assert.strictEqual(result.dailyActivity[0].tokenCount, 9);
    });

    // ── project activity ───────────────────────────────────────────────────

    test('sessions with same workspacePath are merged into one project entry', () => {
        const sessions = [
            makeSession({
                id: 's1',
                workspacePath: '/home/user/project',
                workspaceId: 'ws1',
                messages: [makeMessage('user', 'alpha beta gamma')],
                updatedAt: '2024-03-01T00:00:00Z',
            }),
            makeSession({
                id: 's2',
                workspacePath: '/home/user/project',
                workspaceId: 'ws2',
                messages: [makeMessage('user', 'delta epsilon')],
                updatedAt: '2024-03-02T00:00:00Z',
            }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.projectActivity.length, 1);
        const proj = result.projectActivity[0];
        assert.strictEqual(proj.workspacePath, '/home/user/project');
        assert.strictEqual(proj.sessionCount, 2);
        assert.strictEqual(proj.promptCount, 2);
        assert.strictEqual(proj.tokenCount, 5); // 3 + 2
    });

    test('session with no workspacePath uses workspaceId as key', () => {
        const session = makeSession({
            id: 's1',
            workspaceId: 'hash-abc123',
            messages: [makeMessage('user', 'test query')],
            updatedAt: '2024-03-01T00:00:00Z',
        });
        delete (session as Partial<Session>).workspacePath;

        const result = computeAnalytics([session], countTokens);
        assert.strictEqual(result.projectActivity.length, 1);
        assert.strictEqual(result.projectActivity[0].workspacePath, 'hash-abc123');
    });

    test('project activity is sorted by tokenCount descending', () => {
        const sessions = [
            makeSession({
                id: 's1',
                workspacePath: '/proj/small',
                workspaceId: 'ws1',
                messages: [makeMessage('user', 'one')],
                updatedAt: '2024-03-01T00:00:00Z',
            }),
            makeSession({
                id: 's2',
                workspacePath: '/proj/large',
                workspaceId: 'ws2',
                messages: [makeMessage('user', 'one two three four five six seven eight nine ten')],
                updatedAt: '2024-03-01T00:00:00Z',
            }),
            makeSession({
                id: 's3',
                workspacePath: '/proj/medium',
                workspaceId: 'ws3',
                messages: [makeMessage('user', 'one two three')],
                updatedAt: '2024-03-01T00:00:00Z',
            }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.projectActivity.length, 3);
        assert.strictEqual(result.projectActivity[0].workspacePath, '/proj/large');
        assert.strictEqual(result.projectActivity[1].workspacePath, '/proj/medium');
        assert.strictEqual(result.projectActivity[2].workspacePath, '/proj/small');
    });

    // ── top terms ──────────────────────────────────────────────────────────

    test('stop words are excluded from topTerms', () => {
        const session = makeSession({
            id: 's1',
            messages: [makeMessage('user', 'the and for are but not you all can her was')],
            updatedAt: '2024-03-01T00:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);
        const terms = result.topTerms.map(t => t.term);
        const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was'];
        for (const sw of stopWords) {
            assert.ok(!terms.includes(sw), `stop word "${sw}" should not appear in topTerms`);
        }
    });

    test('terms shorter than 3 characters are excluded from topTerms', () => {
        const session = makeSession({
            id: 's1',
            messages: [makeMessage('user', 'go do it no ok yes hi')],
            updatedAt: '2024-03-01T00:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);
        for (const { term } of result.topTerms) {
            assert.ok(term.length >= 3, `term "${term}" has length < 3`);
        }
    });

    test('topTerms are sorted by count descending and limited to 20', () => {
        const words = Array.from({ length: 25 }, (_, i) => `word${String(i).padStart(2, '0')}`);
        const content = words.map((w, i) => Array(25 - i).fill(w).join(' ')).join(' ');
        const session = makeSession({
            id: 's1',
            messages: [makeMessage('user', content)],
            updatedAt: '2024-03-01T00:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);
        assert.ok(result.topTerms.length <= 20, `expected at most 20 terms, got ${result.topTerms.length}`);
        for (let i = 0; i < result.topTerms.length - 1; i++) {
            assert.ok(
                result.topTerms[i].count >= result.topTerms[i + 1].count,
                `topTerms not sorted: ${result.topTerms[i].count} < ${result.topTerms[i + 1].count}`,
            );
        }
    });

    test('topTerms only counts user message content, not assistant', () => {
        const session = makeSession({
            id: 's1',
            messages: [
                makeMessage('user', 'typescript programming language'),
                makeMessage('assistant', 'javascript python ruby golang'),
            ],
            updatedAt: '2024-03-01T00:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);
        const terms = result.topTerms.map(t => t.term);
        assert.ok(terms.includes('typescript'), 'expected "typescript" in topTerms');
        assert.ok(!terms.includes('javascript'), '"javascript" should not appear (assistant only)');
        assert.ok(!terms.includes('python'), '"python" should not appear (assistant only)');
    });

    // ── longestByMessages ──────────────────────────────────────────────────

    test('longestByMessages returns sessions sorted by totalMessageCount desc', () => {
        const sessions = [
            makeSession({ id: 's1', messages: [makeMessage('user', 'a'), makeMessage('assistant', 'b')], updatedAt: '2024-01-01T00:00:00Z' }),
            makeSession({ id: 's2', messages: [makeMessage('user', 'a'), makeMessage('assistant', 'b'), makeMessage('user', 'c'), makeMessage('assistant', 'd')], updatedAt: '2024-01-01T00:00:00Z' }),
            makeSession({ id: 's3', messages: [makeMessage('user', 'a')], updatedAt: '2024-01-01T00:00:00Z' }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.longestByMessages[0].sessionId, 's2');
        assert.strictEqual(result.longestByMessages[1].sessionId, 's1');
        assert.strictEqual(result.longestByMessages[2].sessionId, 's3');
    });

    test('longestByMessages is capped at 10 entries', () => {
        const sessions = Array.from({ length: 15 }, (_, i) =>
            makeSession({
                id: `s${i}`,
                messages: Array.from({ length: i + 1 }, (__, j) => makeMessage('user', `msg ${j}`)),
                updatedAt: '2024-01-01T00:00:00Z',
            }),
        );
        const result = computeAnalytics(sessions, countTokens);
        assert.ok(result.longestByMessages.length <= 10, `expected at most 10, got ${result.longestByMessages.length}`);
        assert.strictEqual(result.longestByMessages[0].totalMessageCount, 15);
    });

    // ── longestByTokens ────────────────────────────────────────────────────

    test('longestByTokens returns sessions sorted by totalTokens desc', () => {
        const sessions = [
            makeSession({ id: 's1', messages: [makeMessage('user', 'one word')], updatedAt: '2024-01-01T00:00:00Z' }),
            makeSession({ id: 's2', messages: [makeMessage('user', 'one two three four five six seven eight nine ten')], updatedAt: '2024-01-01T00:00:00Z' }),
            makeSession({ id: 's3', messages: [makeMessage('user', 'one two three')], updatedAt: '2024-01-01T00:00:00Z' }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.longestByTokens[0].sessionId, 's2');
        assert.strictEqual(result.longestByTokens[1].sessionId, 's3');
        assert.strictEqual(result.longestByTokens[2].sessionId, 's1');
    });

    test('longestByTokens is capped at 10 entries', () => {
        const sessions = Array.from({ length: 15 }, (_, i) =>
            makeSession({
                id: `s${i}`,
                messages: [makeMessage('user', Array(i + 1).fill('word').join(' '))],
                updatedAt: '2024-01-01T00:00:00Z',
            }),
        );
        const result = computeAnalytics(sessions, countTokens);
        assert.ok(result.longestByTokens.length <= 10, `expected at most 10, got ${result.longestByTokens.length}`);
        assert.strictEqual(result.longestByTokens[0].totalTokens, 15);
    });

    // ── time span ─────────────────────────────────────────────────────────

    test('empty sessions yield empty oldestDate, newestDate and timeSpanDays=0', () => {
        const result = computeAnalytics([], countTokens);
        assert.strictEqual(result.oldestDate, '');
        assert.strictEqual(result.newestDate, '');
        assert.strictEqual(result.timeSpanDays, 0);
    });

    test('single session has oldestDate === newestDate and timeSpanDays === 1', () => {
        const session = makeSession({
            id: 's1',
            messages: [makeMessage('user', 'hello')],
            updatedAt: '2024-06-15T10:00:00Z',
        });
        const result = computeAnalytics([session], countTokens);
        assert.strictEqual(result.oldestDate, '2024-06-15');
        assert.strictEqual(result.newestDate, '2024-06-15');
        assert.strictEqual(result.timeSpanDays, 1);
    });

    test('sessions on consecutive days produce timeSpanDays = 2', () => {
        const sessions = [
            makeSession({ id: 's1', messages: [makeMessage('user', 'a')], updatedAt: '2024-06-15T00:00:00Z' }),
            makeSession({ id: 's2', messages: [makeMessage('user', 'b')], updatedAt: '2024-06-16T00:00:00Z' }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.oldestDate, '2024-06-15');
        assert.strictEqual(result.newestDate, '2024-06-16');
        assert.strictEqual(result.timeSpanDays, 2);
    });

    test('oldestDate and newestDate reflect the full range across all sessions', () => {
        const sessions = [
            makeSession({ id: 's1', messages: [makeMessage('user', 'a')], updatedAt: '2024-06-20T00:00:00Z' }),
            makeSession({ id: 's2', messages: [makeMessage('user', 'b')], updatedAt: '2024-06-01T00:00:00Z' }),
            makeSession({ id: 's3', messages: [makeMessage('user', 'c')], updatedAt: '2024-06-10T00:00:00Z' }),
        ];
        const result = computeAnalytics(sessions, countTokens);
        assert.strictEqual(result.oldestDate, '2024-06-01');
        assert.strictEqual(result.newestDate, '2024-06-20');
        assert.strictEqual(result.timeSpanDays, 20); // June 1–20 inclusive
    });

    // ── SessionMetrics fields ──────────────────────────────────────────────

    test('SessionMetrics fields are populated correctly', () => {
        const session = makeSession({
            id: 'sess-xyz',
            title: 'My Chat',
            source: 'copilot',
            workspacePath: '/my/project',
            updatedAt: '2024-06-01T12:00:00Z',
            messages: [
                makeMessage('user', 'hello world'),
                makeMessage('assistant', 'hi there'),
                makeMessage('user', 'thanks'),
            ],
        });
        const result = computeAnalytics([session], countTokens);
        const m = result.longestByMessages[0];
        assert.strictEqual(m.sessionId, 'sess-xyz');
        assert.strictEqual(m.sessionTitle, 'My Chat');
        assert.strictEqual(m.sessionSource, 'copilot');
        assert.strictEqual(m.workspacePath, '/my/project');
        assert.strictEqual(m.updatedAt, '2024-06-01T12:00:00Z');
        assert.strictEqual(m.userMessageCount, 2);
        assert.strictEqual(m.assistantMessageCount, 1);
        assert.strictEqual(m.totalMessageCount, 3);
        assert.strictEqual(m.userTokens, 3);       // "hello world"=2 + "thanks"=1
        assert.strictEqual(m.assistantTokens, 2);  // "hi there"=2
        assert.strictEqual(m.totalTokens, 5);
    });
});
