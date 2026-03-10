// test/suite/sessionIndex.test.ts

import * as assert from 'assert';
import { SessionIndex, toSummary } from '../../src/index/sessionIndex';
import { Session, Message, SessionSource } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId(): string {
    return `id-${++_idCounter}`;
}

function makeMessage(role: 'user' | 'assistant', content: string, timestamp?: string): Message {
    return {
        id: nextId(),
        role,
        content,
        codeBlocks: [],
        timestamp,
    };
}

function makeSession(
    overrides: Partial<Session> & Pick<Session, 'id'>
): Session {
    return {
        title: 'Test Session',
        source: 'copilot',
        workspaceId: 'ws-default',
        workspacePath: '/home/user/project',
        messages: [],
        filePath: `/tmp/${overrides.id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('SessionIndex', () => {

    let index: SessionIndex;

    setup(() => {
        index = new SessionIndex();
    });

    // 1. upsert + get
    test('upsert and get: inserted session is retrievable by id', () => {
        const session = makeSession({ id: 's1' });
        index.upsert(session);
        const result = index.get('s1');
        assert.strictEqual(result, session);
    });

    // upsert replaces existing
    test('upsert replaces an existing session with the same id', () => {
        const original = makeSession({ id: 's1', title: 'Original' });
        const updated = makeSession({ id: 's1', title: 'Updated' });
        index.upsert(original);
        index.upsert(updated);
        assert.strictEqual(index.get('s1')?.title, 'Updated');
        assert.strictEqual(index.size, 1);
    });

    // 2. remove
    test('remove: get returns undefined and size is 0 after removal', () => {
        const session = makeSession({ id: 's1' });
        index.upsert(session);
        const removed = index.remove('s1');
        assert.strictEqual(removed, true);
        assert.strictEqual(index.get('s1'), undefined);
        assert.strictEqual(index.size, 0);
    });

    test('remove: returns false when session does not exist', () => {
        const removed = index.remove('nonexistent');
        assert.strictEqual(removed, false);
    });

    // 3. size
    test('size: reflects correct count after multiple upserts', () => {
        assert.strictEqual(index.size, 0);
        index.upsert(makeSession({ id: 'a' }));
        index.upsert(makeSession({ id: 'b' }));
        index.upsert(makeSession({ id: 'c' }));
        assert.strictEqual(index.size, 3);
        index.remove('b');
        assert.strictEqual(index.size, 2);
    });

    // 4. getAllSummaries — count and sort order
    test('getAllSummaries: returns correct count and is sorted newest-first by updatedAt', () => {
        const older = makeSession({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' });
        const newer = makeSession({ id: 'new', updatedAt: '2026-03-01T00:00:00.000Z' });
        const middle = makeSession({ id: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' });

        index.upsert(older);
        index.upsert(newer);
        index.upsert(middle);

        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 3);
        assert.strictEqual(summaries[0].id, 'new');
        assert.strictEqual(summaries[1].id, 'mid');
        assert.strictEqual(summaries[2].id, 'old');
    });

    test('getAllSummaries: returned objects are summaries (no messages property)', () => {
        index.upsert(makeSession({
            id: 's1',
            messages: [makeMessage('user', 'hello')],
        }));
        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 1);
        assert.ok(!('messages' in summaries[0]), 'Summary must not expose messages array');
    });

    // 5. getSummariesBySource
    test('getSummariesBySource: filters correctly for copilot vs claude', () => {
        index.upsert(makeSession({ id: 'c1', source: 'copilot' }));
        index.upsert(makeSession({ id: 'c2', source: 'copilot' }));
        index.upsert(makeSession({ id: 'cl1', source: 'claude' }));

        const copilotSummaries = index.getSummariesBySource('copilot');
        assert.strictEqual(copilotSummaries.length, 2);
        assert.ok(copilotSummaries.every(s => s.source === 'copilot'));

        const claudeSummaries = index.getSummariesBySource('claude');
        assert.strictEqual(claudeSummaries.length, 1);
        assert.strictEqual(claudeSummaries[0].id, 'cl1');
    });

    test('getSummariesBySource: returns empty array when no sessions match', () => {
        index.upsert(makeSession({ id: 'c1', source: 'copilot' }));
        const result = index.getSummariesBySource('claude');
        assert.deepStrictEqual(result, []);
    });

    // 6. getSummariesByWorkspace
    test('getSummariesByWorkspace: filters correctly by workspaceId', () => {
        index.upsert(makeSession({ id: 's1', workspaceId: 'ws-a' }));
        index.upsert(makeSession({ id: 's2', workspaceId: 'ws-a' }));
        index.upsert(makeSession({ id: 's3', workspaceId: 'ws-b' }));

        const wsA = index.getSummariesByWorkspace('ws-a');
        assert.strictEqual(wsA.length, 2);
        assert.ok(wsA.every(s => s.workspaceId === 'ws-a'));

        const wsB = index.getSummariesByWorkspace('ws-b');
        assert.strictEqual(wsB.length, 1);
        assert.strictEqual(wsB[0].id, 's3');
    });

    // 7. getAllPrompts
    test('getAllPrompts: extracts only user-role messages across all sessions', () => {
        const session1 = makeSession({
            id: 'p1',
            messages: [
                makeMessage('user', 'First user prompt', '2026-01-01T10:00:00.000Z'),
                makeMessage('assistant', 'First assistant reply'),
                makeMessage('user', 'Second user prompt'),
            ],
        });
        const session2 = makeSession({
            id: 'p2',
            messages: [
                makeMessage('assistant', 'Assistant only'),
            ],
        });

        index.upsert(session1);
        index.upsert(session2);

        const prompts = index.getAllPrompts();
        assert.strictEqual(prompts.length, 2, 'Should extract 2 user messages total');
        assert.ok(prompts.every(p => p.sessionId === 'p1'), 'All prompts should be from session p1');
        assert.strictEqual(prompts[0].content, 'First user prompt');
        assert.strictEqual(prompts[0].messageIndex, 0);
        assert.strictEqual(prompts[0].timestamp, '2026-01-01T10:00:00.000Z');
        assert.strictEqual(prompts[1].content, 'Second user prompt');
        assert.strictEqual(prompts[1].messageIndex, 2);
    });

    test('getAllPrompts: returns empty array when there are no user messages', () => {
        index.upsert(makeSession({
            id: 's1',
            messages: [makeMessage('assistant', 'Only assistant')],
        }));
        assert.deepStrictEqual(index.getAllPrompts(), []);
    });

    // 8. search — finds sessions by user message content
    test('search: finds sessions containing the query in user messages', () => {
        index.upsert(makeSession({
            id: 'match',
            messages: [makeMessage('user', 'How do I use TypeScript generics?')],
        }));
        index.upsert(makeSession({
            id: 'nomatch',
            messages: [makeMessage('user', 'Tell me about Python lists')],
        }));

        const results = index.search('typescript generics');
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, 'match');
    });

    test('search: is case-insensitive', () => {
        index.upsert(makeSession({
            id: 's1',
            messages: [makeMessage('user', 'HELLO WORLD')],
        }));
        const results = index.search('hello world');
        assert.strictEqual(results.length, 1);
    });

    test('search: finds matches in assistant messages by default', () => {
        index.upsert(makeSession({
            id: 's1',
            messages: [makeMessage('assistant', 'Here is how you use async/await in JS')],
        }));
        const results = index.search('async/await');
        assert.strictEqual(results.length, 1);
    });

    test('search: returns empty array when nothing matches', () => {
        index.upsert(makeSession({
            id: 's1',
            messages: [makeMessage('user', 'Unrelated content')],
        }));
        const results = index.search('xyzzy-no-match');
        assert.deepStrictEqual(results, []);
    });

    // 9. search — searchPrompts: false skips user messages
    test('search: searchPrompts false skips user messages, only searches responses', () => {
        index.upsert(makeSession({
            id: 'user-only',
            messages: [
                makeMessage('user', 'Tell me about Rust ownership'),
                makeMessage('assistant', 'Nothing relevant here'),
            ],
        }));
        index.upsert(makeSession({
            id: 'assistant-match',
            messages: [
                makeMessage('user', 'Some other question'),
                makeMessage('assistant', 'Rust ownership is a key concept'),
            ],
        }));

        const results = index.search('rust ownership', { searchPrompts: false });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, 'assistant-match');
    });

    test('search: searchResponses false skips assistant messages, only searches prompts', () => {
        index.upsert(makeSession({
            id: 'user-match',
            messages: [
                makeMessage('user', 'Explain closures in JavaScript'),
                makeMessage('assistant', 'Some unrelated reply'),
            ],
        }));
        index.upsert(makeSession({
            id: 'assistant-only',
            messages: [
                makeMessage('user', 'Unrelated question'),
                makeMessage('assistant', 'closures in JavaScript are functions...'),
            ],
        }));

        const results = index.search('closures in javascript', { searchResponses: false });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, 'user-match');
    });

    // 10. search — source filter
    test('search: source filter limits results to specified source', () => {
        index.upsert(makeSession({
            id: 'cop-match',
            source: 'copilot',
            messages: [makeMessage('user', 'Shared query text')],
        }));
        index.upsert(makeSession({
            id: 'cla-match',
            source: 'claude',
            messages: [makeMessage('user', 'Shared query text')],
        }));

        const copilotResults = index.search('shared query text', { source: 'copilot' });
        assert.strictEqual(copilotResults.length, 1);
        assert.strictEqual(copilotResults[0].id, 'cop-match');

        const claudeResults = index.search('shared query text', { source: 'claude' });
        assert.strictEqual(claudeResults.length, 1);
        assert.strictEqual(claudeResults[0].id, 'cla-match');
    });

    test('search: results are sorted by updatedAt descending', () => {
        index.upsert(makeSession({
            id: 'old',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [makeMessage('user', 'common term')],
        }));
        index.upsert(makeSession({
            id: 'new',
            updatedAt: '2026-03-01T00:00:00.000Z',
            messages: [makeMessage('user', 'common term')],
        }));

        const results = index.search('common term');
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].id, 'new');
        assert.strictEqual(results[1].id, 'old');
    });

    // 11. clear
    test('clear: empties the index', () => {
        index.upsert(makeSession({ id: 'a' }));
        index.upsert(makeSession({ id: 'b' }));
        index.clear();
        assert.strictEqual(index.size, 0);
        assert.deepStrictEqual(index.getAllSummaries(), []);
        assert.strictEqual(index.get('a'), undefined);
    });

    // 12. toSummary — correct message counts
    test('toSummary: computes correct messageCount, userMessageCount, assistantMessageCount', () => {
        const session = makeSession({
            id: 'counts',
            messages: [
                makeMessage('user', 'Q1'),
                makeMessage('assistant', 'A1'),
                makeMessage('user', 'Q2'),
                makeMessage('assistant', 'A2'),
                makeMessage('user', 'Q3'),
            ],
        });

        const summary = toSummary(session);
        assert.strictEqual(summary.messageCount, 5);
        assert.strictEqual(summary.userMessageCount, 3);
        assert.strictEqual(summary.assistantMessageCount, 2);
    });

    test('toSummary: copies scalar fields from session correctly', () => {
        const session = makeSession({
            id: 'meta-check',
            title: 'My Title',
            source: 'claude',
            workspaceId: 'ws-42',
            workspacePath: '/home/dev/repo',
            filePath: '/tmp/meta-check.jsonl',
            createdAt: '2026-02-01T08:00:00.000Z',
            updatedAt: '2026-02-15T12:30:00.000Z',
        });

        const summary = toSummary(session);
        assert.strictEqual(summary.id, 'meta-check');
        assert.strictEqual(summary.title, 'My Title');
        assert.strictEqual(summary.source, 'claude');
        assert.strictEqual(summary.workspaceId, 'ws-42');
        assert.strictEqual(summary.workspacePath, '/home/dev/repo');
        assert.strictEqual(summary.filePath, '/tmp/meta-check.jsonl');
        assert.strictEqual(summary.createdAt, '2026-02-01T08:00:00.000Z');
        assert.strictEqual(summary.updatedAt, '2026-02-15T12:30:00.000Z');
    });

    test('toSummary: handles session with no messages', () => {
        const session = makeSession({ id: 'empty', messages: [] });
        const summary = toSummary(session);
        assert.strictEqual(summary.messageCount, 0);
        assert.strictEqual(summary.userMessageCount, 0);
        assert.strictEqual(summary.assistantMessageCount, 0);
    });
});
