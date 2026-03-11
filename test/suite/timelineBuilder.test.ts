// test/suite/timelineBuilder.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { buildTimeline, TimelineEntry } from '../../src/timeline/timelineBuilder';
import { Session, Message } from '../../src/types/index';

// ── helpers ────────────────────────────────────────────────────────────────

function makeMessage(
    role: 'user' | 'assistant',
    content: string,
    id = Math.random().toString(),
): Message {
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
        updatedAt: '2024-06-01T10:00:00Z',
        ...overrides,
    };
}

// ── suite ──────────────────────────────────────────────────────────────────

suite('buildTimeline', () => {

    // ── empty input ────────────────────────────────────────────────────────

    test('empty sessions array returns []', () => {
        const result = buildTimeline([]);
        assert.deepStrictEqual(result, []);
    });

    // ── single session ─────────────────────────────────────────────────────

    test('single session returns one entry with correct fields', () => {
        const session = makeSession({
            id: 'sess-1',
            title: 'My Chat',
            source: 'copilot',
            workspacePath: '/home/user/myProject',
            updatedAt: '2024-06-15T08:30:00Z',
            messages: [
                makeMessage('user', 'How do I write a loop?'),
                makeMessage('assistant', 'You can use a for loop.'),
            ],
        });

        const result = buildTimeline([session]);
        assert.strictEqual(result.length, 1);

        const entry = result[0];
        assert.strictEqual(entry.sessionId, 'sess-1');
        assert.strictEqual(entry.sessionTitle, 'My Chat');
        assert.strictEqual(entry.source, 'copilot');
        assert.strictEqual(entry.workspacePath, '/home/user/myProject');
        assert.strictEqual(entry.workspaceName, 'myProject');
        assert.strictEqual(entry.date, '2024-06-15');
        assert.strictEqual(entry.timestamp, Date.parse('2024-06-15T08:30:00Z'));
        assert.strictEqual(entry.firstPrompt, 'How do I write a loop?');
        assert.strictEqual(entry.messageCount, 2);
        assert.strictEqual(entry.promptCount, 1);
    });

    // ── epoch-zero session skipped ─────────────────────────────────────────

    test('session with updatedAt resolving to epoch zero is skipped', () => {
        const session = makeSession({
            id: 'epoch-session',
            updatedAt: '1970-01-01T00:00:00Z',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.deepStrictEqual(result, []);
    });

    test('session with empty updatedAt string is skipped', () => {
        const session = makeSession({
            id: 'no-date-session',
            updatedAt: '',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.deepStrictEqual(result, []);
    });

    test('session with invalid updatedAt (NaN) is skipped', () => {
        const session = makeSession({
            id: 'bad-date-session',
            updatedAt: 'not-a-date',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.deepStrictEqual(result, []);
    });

    // ── zero-message session skipped ───────────────────────────────────────

    test('session with 0 messages is skipped', () => {
        const session = makeSession({
            id: 'empty-session',
            updatedAt: '2024-06-01T10:00:00Z',
            messages: [],
        });
        const result = buildTimeline([session]);
        assert.deepStrictEqual(result, []);
    });

    // ── sorting ────────────────────────────────────────────────────────────

    test('multiple sessions are sorted newest-first by timestamp', () => {
        const sessions = [
            makeSession({ id: 'older', updatedAt: '2024-03-01T00:00:00Z', messages: [makeMessage('user', 'first')] }),
            makeSession({ id: 'newest', updatedAt: '2024-06-01T00:00:00Z', messages: [makeMessage('user', 'third')] }),
            makeSession({ id: 'middle', updatedAt: '2024-04-15T00:00:00Z', messages: [makeMessage('user', 'second')] }),
        ];
        const result = buildTimeline(sessions);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].sessionId, 'newest');
        assert.strictEqual(result[1].sessionId, 'middle');
        assert.strictEqual(result[2].sessionId, 'older');
    });

    // ── workspaceName extraction ───────────────────────────────────────────

    test('workspaceName from Windows-style path with backslashes', () => {
        const session = makeSession({
            id: 'win-path',
            workspacePath: 'C:\\Users\\foo\\myProject',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].workspaceName, 'myProject');
    });

    test('workspaceName from POSIX-style path', () => {
        const session = makeSession({
            id: 'posix-path',
            workspacePath: '/home/user/my-repo',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].workspaceName, 'my-repo');
    });

    test('workspaceName is empty string when workspacePath is empty string', () => {
        const session = makeSession({
            id: 'empty-path',
            workspacePath: '',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].workspaceName, '');
        assert.strictEqual(result[0].workspacePath, '');
    });

    test('workspaceName is empty string when workspacePath is undefined', () => {
        const session = makeSession({
            id: 'no-path',
            messages: [makeMessage('user', 'hello')],
        });
        delete (session as Partial<Session>).workspacePath;
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].workspaceName, '');
        assert.strictEqual(result[0].workspacePath, '');
    });

    // ── firstPrompt from string content ────────────────────────────────────

    test('firstPrompt is taken from the first user message (string content)', () => {
        const session = makeSession({
            id: 'fp-string',
            messages: [
                makeMessage('assistant', 'I am the assistant, speaking first.'),
                makeMessage('user', 'What is TypeScript?'),
                makeMessage('user', 'Second user message'),
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, 'What is TypeScript?');
    });

    // ── firstPrompt from array content blocks ──────────────────────────────

    test('firstPrompt is extracted from first text block in array content', () => {
        const session = makeSession({
            id: 'fp-blocks',
            messages: [
                {
                    id: 'msg-1',
                    role: 'user',
                    // Cast to any to simulate array content blocks not in the strict type
                    content: [
                        { type: 'tool_result', text: undefined },
                        { type: 'text', text: 'Explain async/await please' },
                    ] as unknown as string,
                    codeBlocks: [],
                },
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, 'Explain async/await please');
    });

    test('firstPrompt skips non-text blocks and picks first text block', () => {
        const session = makeSession({
            id: 'fp-mixed-blocks',
            messages: [
                {
                    id: 'msg-1',
                    role: 'user',
                    content: [
                        { type: 'image', text: undefined },
                        { type: 'text', text: 'First text block' },
                        { type: 'text', text: 'Second text block' },
                    ] as unknown as string,
                    codeBlocks: [],
                },
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, 'First text block');
    });

    // ── firstPrompt capped at 150 chars ────────────────────────────────────

    test('firstPrompt is capped at 150 chars with ellipsis appended when over 150', () => {
        const longText = 'a'.repeat(200);
        const session = makeSession({
            id: 'fp-long',
            messages: [makeMessage('user', longText)],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, 'a'.repeat(150) + '…');
    });

    test('firstPrompt is not capped when exactly 150 chars', () => {
        const exactText = 'b'.repeat(150);
        const session = makeSession({
            id: 'fp-exact',
            messages: [makeMessage('user', exactText)],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, exactText);
        assert.ok(!result[0].firstPrompt.endsWith('…'));
    });

    // ── firstPrompt is empty when no user/human messages ──────────────────

    test('firstPrompt is empty string when no user messages exist', () => {
        const session = makeSession({
            id: 'no-user-msg',
            messages: [
                makeMessage('assistant', 'I will speak first and only.'),
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].firstPrompt, '');
    });

    // ── source propagation ─────────────────────────────────────────────────

    test('source copilot is propagated correctly', () => {
        const session = makeSession({
            id: 'copilot-sess',
            source: 'copilot',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].source, 'copilot');
    });

    test('source claude is propagated correctly', () => {
        const session = makeSession({
            id: 'claude-sess',
            source: 'claude',
            messages: [makeMessage('user', 'hello')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].source, 'claude');
    });

    // ── promptCount ────────────────────────────────────────────────────────

    test('promptCount counts only user-role messages, not assistant', () => {
        const session = makeSession({
            id: 'prompt-count',
            messages: [
                makeMessage('user', 'prompt 1'),
                makeMessage('assistant', 'response 1'),
                makeMessage('user', 'prompt 2'),
                makeMessage('assistant', 'response 2'),
                makeMessage('user', 'prompt 3'),
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].promptCount, 3);
        assert.strictEqual(result[0].messageCount, 5);
    });

    test('promptCount is 0 when all messages are from the assistant', () => {
        const session = makeSession({
            id: 'assistant-only',
            messages: [
                makeMessage('assistant', 'I start the conversation.'),
                makeMessage('assistant', 'And continue.'),
            ],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].promptCount, 0);
    });

    // ── mixed valid and invalid sessions ──────────────────────────────────

    test('valid sessions are returned while invalid ones are filtered out', () => {
        const sessions = [
            makeSession({
                id: 'valid-1',
                updatedAt: '2024-06-10T00:00:00Z',
                messages: [makeMessage('user', 'valid session')],
            }),
            makeSession({
                id: 'no-messages',
                updatedAt: '2024-06-11T00:00:00Z',
                messages: [],
            }),
            makeSession({
                id: 'epoch-zero',
                updatedAt: '1970-01-01T00:00:00Z',
                messages: [makeMessage('user', 'skipped')],
            }),
            makeSession({
                id: 'valid-2',
                updatedAt: '2024-06-12T00:00:00Z',
                messages: [makeMessage('user', 'another valid')],
            }),
        ];
        const result = buildTimeline(sessions);
        assert.strictEqual(result.length, 2);
        const ids = result.map(e => e.sessionId);
        assert.ok(ids.includes('valid-1'));
        assert.ok(ids.includes('valid-2'));
        assert.ok(!ids.includes('no-messages'));
        assert.ok(!ids.includes('epoch-zero'));
        // Newest first
        assert.strictEqual(result[0].sessionId, 'valid-2');
        assert.strictEqual(result[1].sessionId, 'valid-1');
    });

    // ── date field ─────────────────────────────────────────────────────────

    test('date field is YYYY-MM-DD slice of updatedAt ISO string', () => {
        const session = makeSession({
            id: 'date-check',
            updatedAt: '2025-11-28T23:59:59Z',
            messages: [makeMessage('user', 'test')],
        });
        const result = buildTimeline([session]);
        assert.strictEqual(result[0].date, '2025-11-28');
    });
});
