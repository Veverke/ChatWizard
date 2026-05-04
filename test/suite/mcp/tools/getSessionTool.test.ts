// test/suite/mcp/tools/getSessionTool.test.ts

import * as assert from 'assert';
import { GetSessionTool, formatSessionTranscript } from '../../../../src/mcp/tools/getSessionTool';
import { GetSessionFullTool } from '../../../../src/mcp/tools/getSessionFullTool';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { Session, Message } from '../../../../src/types/index';

// ── Fixture helpers ─────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, messages: Message[]): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        workspaceId: 'ws-default',
        messages,
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
    };
}

// ── Tests: formatSessionTranscript (unit) ────────────────────────────────────

suite('formatSessionTranscript', () => {

    test('includes header fields', () => {
        const session = makeSession('s1', [makeMessage('user', 'hello')]);
        const transcript = formatSessionTranscript(session);
        assert.ok(transcript.includes('Session: Session s1'));
        assert.ok(transcript.includes('Source: copilot'));
        assert.ok(transcript.includes('Date: 2026-06-01T00:00:00.000Z'));
        assert.ok(transcript.includes('Messages: 1'));
    });

    test('includes role labels for user and assistant messages', () => {
        const session = makeSession('s1', [
            makeMessage('user', 'What is 2+2?'),
            makeMessage('assistant', 'It is 4.'),
        ]);
        const transcript = formatSessionTranscript(session);
        assert.ok(transcript.includes('User:'));
        assert.ok(transcript.includes('Assistant:'));
        assert.ok(transcript.includes('What is 2+2?'));
        assert.ok(transcript.includes('It is 4.'));
    });

    test('truncates at maxChars and appends truncation note', () => {
        const longContent = 'x'.repeat(5000);
        const session = makeSession('s1', [makeMessage('user', longContent)]);
        const transcript = formatSessionTranscript(session, 200);
        assert.ok(transcript.length < longContent.length);
        assert.ok(transcript.includes('[truncated'));
        assert.ok(transcript.includes('chatwizard_get_session_full'));
    });

    test('no truncation when content is within maxChars', () => {
        const session = makeSession('s1', [makeMessage('user', 'short')]);
        const transcript = formatSessionTranscript(session, 10000);
        assert.ok(!transcript.includes('[truncated'));
    });

    test('no truncation when maxChars is undefined', () => {
        const session = makeSession('s1', [makeMessage('user', 'short content')]);
        const transcript = formatSessionTranscript(session);
        assert.ok(!transcript.includes('[truncated'));
    });
});

// ── Tests: GetSessionTool ────────────────────────────────────────────────────

suite('GetSessionTool', () => {

    let sessionIndex: SessionIndex;
    let tool: GetSessionTool;

    setup(() => {
        sessionIndex = new SessionIndex();
        tool = new GetSessionTool(sessionIndex);
    });

    test('returns error when sessionId is missing', async () => {
        const result = await tool.execute({});
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('non-empty'));
    });

    test('returns error when sessionId is empty string', async () => {
        const result = await tool.execute({ sessionId: '' });
        assert.strictEqual(result.isError, true);
    });

    test('returns isError when sessionId not found', async () => {
        const result = await tool.execute({ sessionId: 'does-not-exist' });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('Session not found'));
    });

    test('returns session transcript when found', async () => {
        const session = makeSession('abc', [makeMessage('user', 'Hello!')]);
        sessionIndex.upsert(session);

        const result = await tool.execute({ sessionId: 'abc' });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('Hello!'));
    });

    test('applies default maxChars of 4000', async () => {
        const longContent = 'y'.repeat(10000);
        const session = makeSession('big', [makeMessage('user', longContent)]);
        sessionIndex.upsert(session);

        const result = await tool.execute({ sessionId: 'big' });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('[truncated'));
    });

    test('respects custom maxChars', async () => {
        const session = makeSession('s-custom', [makeMessage('user', 'Hello world from test')]);
        sessionIndex.upsert(session);

        const result = await tool.execute({ sessionId: 's-custom', maxChars: 50 });
        assert.ok(!result.isError);
        // Should be very short — truncated at 50 chars
        assert.ok(result.content[0].text.length < 200);
    });

    test('tool has correct name', () => {
        assert.strictEqual(tool.name, 'chatwizard_get_session');
    });
});

// ── Tests: GetSessionFullTool ────────────────────────────────────────────────

suite('GetSessionFullTool', () => {

    let sessionIndex: SessionIndex;
    let tool: GetSessionFullTool;

    setup(() => {
        sessionIndex = new SessionIndex();
        tool = new GetSessionFullTool(sessionIndex);
    });

    test('returns full content without truncation', async () => {
        const longContent = 'z'.repeat(10000);
        const session = makeSession('full', [makeMessage('user', longContent)]);
        sessionIndex.upsert(session);

        const result = await tool.execute({ sessionId: 'full' });
        assert.ok(!result.isError);
        assert.ok(!result.content[0].text.includes('[truncated'));
        assert.ok(result.content[0].text.includes(longContent));
    });

    test('returns isError when session not found', async () => {
        const result = await tool.execute({ sessionId: 'nope' });
        assert.strictEqual(result.isError, true);
    });

    test('tool has correct name', () => {
        assert.strictEqual(tool.name, 'chatwizard_get_session_full');
    });
});
