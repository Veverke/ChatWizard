// test/suite/mcp/contextPrompts.test.ts
//
// Unit tests for QueryHistoryPrompt and ContinueFromHistoryPrompt render methods.
//
// Bugs these tests would catch:
//   Bug: --refs not parsed; getSessionFullTool never called.
//   Bug: getSessionFullTool called with wrong sessionId.
//   Bug: session content not included in consolidated prompt.
//   Bug: realQuery mangled when --refs suffix is present.
//   Bug: more than 3 refs fetched even when more are supplied.
//   Bug: error response from getSessionFullTool included in consolidated content.
//   Bug: --continued with no refs falls through to Phase 1 instead of fallback.
//   Bug: --general query text not forwarded to prompt.
//   Bug: ContinueFromHistoryPrompt calls getContextTool even when no topic given.

import * as assert from 'assert';
import { QueryHistoryPrompt, ContinueFromHistoryPrompt } from '../../../src/mcp/prompts/contextPrompts';
import { IMcpTool, McpToolInput, McpToolResult } from '../../../src/mcp/mcpContracts';

// ── Stub helpers ─────────────────────────────────────────────────────────────

interface Call { input: McpToolInput }

/**
 * Creates a stub IMcpTool that records all calls and returns a fixed text response.
 */
function makeTool(returnText: string): IMcpTool & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        name: 'stub',
        description: '',
        inputSchema: {},
        calls,
        async execute(input: McpToolInput): Promise<McpToolResult> {
            calls.push({ input });
            return { content: [{ type: 'text', text: returnText }] };
        },
    } as IMcpTool & { calls: Call[] };
}

/**
 * Creates a stub IMcpTool that returns a different response per call
 * (first call returns responses[0], second returns responses[1], etc.).
 */
function makeMultiTool(responses: string[]): IMcpTool & { calls: Call[] } {
    const calls: Call[] = [];
    let idx = 0;
    return {
        name: 'stub-multi',
        description: '',
        inputSchema: {},
        calls,
        async execute(input: McpToolInput): Promise<McpToolResult> {
            calls.push({ input });
            const text = responses[idx++] ?? '';
            return { content: [{ type: 'text', text }] };
        },
    } as IMcpTool & { calls: Call[] };
}

function resultText(result: McpToolResult): string {
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n\n');
}

// ── QueryHistoryPrompt ────────────────────────────────────────────────────────

suite('QueryHistoryPrompt.render', () => {

    // 1. Empty / missing query → fallback prompt (no tool calls)
    test('empty query returns fallback prompt without calling any tool', async () => {
        const getContextTool = makeTool('some context');
        const getSessionFullTool = makeTool('session full content');
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        const result = await prompt.render({});
        const text = resultText(result);

        assert.ok(text.includes('chatwizard_get_context'), 'fallback should reference the context tool');
        assert.strictEqual(getContextTool.calls.length, 0, 'getContextTool must NOT be called for empty query');
        assert.strictEqual(getSessionFullTool.calls.length, 0, 'getSessionFullTool must NOT be called for empty query');
    });

    test('whitespace-only query treated as empty', async () => {
        const getContextTool = makeTool('ctx');
        const getSessionFullTool = makeTool('full');
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        const result = await prompt.render({ query: '   ' });
        const text = resultText(result);

        assert.ok(text.includes('chatwizard_get_context'));
        assert.strictEqual(getContextTool.calls.length, 0);
    });

    // 2. Phase 1 (default) — calls getContextTool, returns relevance-assessment prompt
    test('phase 1: calls getContextTool with the query as topic', async () => {
        const getContextTool = makeTool('SESSION: abc\nSome content about TypeScript.');
        const getSessionFullTool = makeTool('');
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        await prompt.render({ query: 'TypeScript generics' });

        assert.strictEqual(getContextTool.calls.length, 1, 'getContextTool must be called exactly once');
        assert.strictEqual((getContextTool.calls[0].input as Record<string, unknown>)['topic'], 'TypeScript generics');
        assert.strictEqual(getSessionFullTool.calls.length, 0, 'getSessionFullTool must NOT be called in Phase 1');
    });

    test('phase 1: returned prompt instructs LLM NOT to provide answers yet', async () => {
        const getContextTool = makeTool('CONTEXT');
        const prompt = new QueryHistoryPrompt(getContextTool, makeTool(''));

        const result = await prompt.render({ query: 'debug webpack issue' });
        const text = resultText(result);

        assert.ok(text.includes('Do NOT provide answers'), 'must instruct LLM not to answer in phase 1');
        assert.ok(text.includes('debug webpack issue'), 'original query must be present in the prompt');
    });

    test('phase 1: includes context tool response in the prompt', async () => {
        const getContextTool = makeTool('Session alpha: something relevant');
        const prompt = new QueryHistoryPrompt(getContextTool, makeTool(''));

        const result = await prompt.render({ query: 'webpack config issue' });
        const text = resultText(result);

        assert.ok(text.includes('Session alpha: something relevant'), 'context text must be embedded in the prompt');
    });

    // 3. Phase 2 --general
    test('--general: does NOT call any tool', async () => {
        const getContextTool = makeTool('ctx');
        const getSessionFullTool = makeTool('full');
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        await prompt.render({ query: '--general how does React reconciliation work?' });

        assert.strictEqual(getContextTool.calls.length, 0, 'no tool calls for --general path');
        assert.strictEqual(getSessionFullTool.calls.length, 0, 'no tool calls for --general path');
    });

    test('--general: returned prompt contains the real query without --general prefix', async () => {
        const prompt = new QueryHistoryPrompt(makeTool(''), makeTool(''));

        const result = await prompt.render({ query: '--general how does React reconciliation work?' });
        const text = resultText(result);

        assert.ok(text.includes('how does React reconciliation work?'), 'real query must be in the prompt');
        assert.ok(!text.includes('--general'), '--general prefix must be stripped');
    });

    test('--general: prompt instructs LLM to answer from general knowledge only', async () => {
        const prompt = new QueryHistoryPrompt(makeTool(''), makeTool(''));

        const result = await prompt.render({ query: '--general explain heap vs stack' });
        const text = resultText(result);

        assert.ok(text.includes('general knowledge'), 'prompt should reference general knowledge');
        assert.ok(
            text.toLowerCase().includes('no relevant history') ||
            text.toLowerCase().includes('do not reference any chat history'),
            'prompt should indicate no history usage',
        );
    });

    // 4. Phase 2 --continued with --refs: consolidation path
    test('--continued with refs: calls getSessionFullTool once per ref ID', async () => {
        const getContextTool = makeTool('ctx');
        const getSessionFullTool = makeMultiTool(['Session A content', 'Session B content']);
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        await prompt.render({ query: '--continued fix login bug --refs id-a,id-b' });

        assert.strictEqual(getSessionFullTool.calls.length, 2, 'should call getSessionFullTool for each ref');
        const ids = getSessionFullTool.calls.map(c => (c.input as Record<string, unknown>)['sessionId']);
        assert.deepStrictEqual(ids, ['id-a', 'id-b']);
        assert.strictEqual(getContextTool.calls.length, 0, 'getContextTool must NOT be called when sessions fetched');
    });

    test('--continued with refs: prompt contains synthesized session content', async () => {
        const getSessionFullTool = makeMultiTool(['Session Alpha full content', 'Session Beta full content']);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued login bug --refs id-1,id-2' });
        const text = resultText(result);

        assert.ok(text.includes('Session Alpha full content'), 'session A content must be in prompt');
        assert.ok(text.includes('Session Beta full content'), 'session B content must be in prompt');
    });

    test('--continued with refs: real query present in prompt without --continued prefix or --refs suffix', async () => {
        const getSessionFullTool = makeMultiTool(['content A']);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued fix the login redirect bug --refs sess-1' });
        const text = resultText(result);

        assert.ok(text.includes('fix the login redirect bug'), 'real query must appear in prompt');
        assert.ok(!text.includes('--continued'), '--continued prefix must be stripped');
        assert.ok(!text.includes('--refs'), '--refs suffix must be stripped');
    });

    test('--continued with refs: prompt includes consolidation synthesis instructions', async () => {
        const getSessionFullTool = makeMultiTool(['content X']);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued auth issue --refs sess-x' });
        const text = resultText(result);

        // Must instruct LLM to synthesize
        assert.ok(text.toLowerCase().includes('synthes'), 'prompt must instruct LLM to synthesize sessions');
    });

    test('--continued with refs: capped at 3 sessions even when more than 3 IDs supplied', async () => {
        const getSessionFullTool = makeMultiTool(['c1', 'c2', 'c3', 'c4', 'c5']);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        await prompt.render({ query: '--continued query --refs id1,id2,id3,id4,id5' });

        assert.strictEqual(getSessionFullTool.calls.length, 3, 'must call getSessionFullTool at most 3 times');
    });

    test('--continued with refs: sessions with error response are excluded from consolidation', async () => {
        const getSessionFullTool = makeMultiTool([
            'Error: session not accessible',
            'Valid session content',
        ]);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued some query --refs id-err,id-ok' });
        const text = resultText(result);

        assert.ok(!text.includes('Error: session not accessible'), 'error response must be excluded');
        assert.ok(text.includes('Valid session content'), 'valid session must be included');
    });

    test('--continued with refs: sessions responding with "Session not found" are excluded', async () => {
        const getSessionFullTool = makeMultiTool([
            'Session not found: id-missing',
            'Good content',
        ]);
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued auth issue --refs id-missing,id-good' });
        const text = resultText(result);

        assert.ok(!text.includes('Session not found'), 'not-found response must be excluded');
        assert.ok(text.includes('Good content'), 'found session must be included');
    });

    // 5. Phase 2 --continued without refs (or all sessions not found) → fallback to getContextTool
    test('--continued without refs: falls back to getContextTool', async () => {
        const getContextTool = makeTool('fallback context result');
        const getSessionFullTool = makeTool('');
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        await prompt.render({ query: '--continued some topic' });

        assert.strictEqual(getContextTool.calls.length, 1, 'getContextTool should be called as fallback');
        assert.strictEqual(getSessionFullTool.calls.length, 0, 'getSessionFullTool must NOT be called when no refs');
    });

    test('--continued when all refs return errors: falls back to getContextTool', async () => {
        const getContextTool = makeTool('fallback context');
        const getSessionFullTool = makeMultiTool(['Error: not found', 'Error: not found']);
        const prompt = new QueryHistoryPrompt(getContextTool, getSessionFullTool);

        await prompt.render({ query: '--continued topic --refs id1,id2' });

        assert.strictEqual(getContextTool.calls.length, 1, 'must fall back to getContextTool when all sessions fail');
    });

    test('--continued fallback prompt contains the real query', async () => {
        const getContextTool = makeTool('fallback ctx');
        const prompt = new QueryHistoryPrompt(getContextTool, makeMultiTool([]));

        const result = await prompt.render({ query: '--continued debug websocket timeout' });
        const text = resultText(result);

        assert.ok(text.includes('debug websocket timeout'), 'real query must appear in fallback prompt');
    });
});

// ── ContinueFromHistoryPrompt ─────────────────────────────────────────────────

suite('ContinueFromHistoryPrompt.render', () => {

    test('no topic: calls listRecentTool but NOT getContextTool', async () => {
        const listRecentTool = makeTool('recent session 1\nrecent session 2');
        const getContextTool = makeTool('ctx');
        const prompt = new ContinueFromHistoryPrompt(listRecentTool, getContextTool);

        await prompt.render({});

        assert.strictEqual(listRecentTool.calls.length, 1, 'listRecentTool must be called');
        assert.strictEqual(getContextTool.calls.length, 0, 'getContextTool must NOT be called without a topic');
    });

    test('no topic: prompt contains recent session content', async () => {
        const listRecentTool = makeTool('Session: My Recent Work');
        const prompt = new ContinueFromHistoryPrompt(listRecentTool, makeTool(''));

        const result = await prompt.render({});
        const text = resultText(result);

        assert.ok(text.includes('Session: My Recent Work'), 'recent session content must be in prompt');
    });

    test('no topic: prompt includes continuation instruction', async () => {
        const prompt = new ContinueFromHistoryPrompt(makeTool('recent'), makeTool(''));

        const result = await prompt.render({});
        const text = resultText(result);

        assert.ok(
            text.toLowerCase().includes('recent') || text.toLowerCase().includes('continu'),
            'prompt must mention continuation or recent work',
        );
    });

    test('with topic: calls both listRecentTool and getContextTool', async () => {
        const listRecentTool = makeTool('recent');
        const getContextTool = makeTool('topic context');
        const prompt = new ContinueFromHistoryPrompt(listRecentTool, getContextTool);

        await prompt.render({ topic: 'authentication refactor' });

        assert.strictEqual(listRecentTool.calls.length, 1, 'listRecentTool must be called');
        assert.strictEqual(getContextTool.calls.length, 1, 'getContextTool must be called when topic given');
    });

    test('with topic: getContextTool called with the topic as the topic param', async () => {
        const getContextTool = makeTool('topic ctx');
        const prompt = new ContinueFromHistoryPrompt(makeTool('recent'), getContextTool);

        await prompt.render({ topic: 'authentication refactor' });

        const topicArg = (getContextTool.calls[0].input as Record<string, unknown>)['topic'];
        assert.strictEqual(topicArg, 'authentication refactor', 'topic must be forwarded to getContextTool');
    });

    test('with topic: prompt contains both recent and topic-specific content', async () => {
        const listRecentTool = makeTool('Recent Work Summary');
        const getContextTool = makeTool('Auth Context Details');
        const prompt = new ContinueFromHistoryPrompt(listRecentTool, getContextTool);

        const result = await prompt.render({ topic: 'auth' });
        const text = resultText(result);

        assert.ok(text.includes('Recent Work Summary'), 'recent content must be in prompt');
        assert.ok(text.includes('Auth Context Details'), 'topic context must be in prompt');
    });

    test('whitespace-only topic treated as no topic', async () => {
        const listRecentTool = makeTool('recent');
        const getContextTool = makeTool('ctx');
        const prompt = new ContinueFromHistoryPrompt(listRecentTool, getContextTool);

        await prompt.render({ topic: '   ' });

        assert.strictEqual(getContextTool.calls.length, 0, 'whitespace topic should not trigger getContextTool');
    });
});

// ── Contract / Sentinel-string tests (INFRA-3) ────────────────────────────────
//
// These tests lock the exact sentinel strings and structural contracts that
// chatParticipant.ts relies on when routing Phase 1 → Phase 2.  If either
// contextPrompts.ts or chatParticipant.ts drifts, one of these will fail.

suite('Sentinel-string contracts', () => {

    // Contract 1 — Phase 1 prompt must instruct the LLM to return a JSON array.
    // chatParticipant.ts relies on parsing a JSON array from the LLM response to
    // know which sessions are relevant.  This exact instruction drives that contract.
    test('Phase 1 prompt contains JSON array instruction sentinel', async () => {
        const getContextTool = makeTool('[Session: Auth] | Source: copilot | Date: 2026-01-01T00:00:00Z\nPassage: jwt auth\nID: sess-1\n');
        const prompt = new QueryHistoryPrompt(getContextTool, makeTool(''));

        const result = await prompt.render({ query: 'handleAuthError JWT' });
        const text = resultText(result);

        assert.ok(
            text.includes('Output ONLY a JSON array'),
            'Phase 1 prompt must contain the JSON array routing sentinel used by chatParticipant.ts',
        );
    });

    // Contract 2 — "Retrieved sessions" block appears BEFORE the query line.
    // chatParticipant.ts and the LLM must see session context before the query.
    test('Phase 1 prompt: sources block appears before the query line', async () => {
        const sessionBlock = '[Session: DB Migration] | Source: copilot | Date: 2026-01-01T00:00:00Z\nPassage: prisma migration\nID: sess-2\n';
        const getContextTool = makeTool(sessionBlock);
        const prompt = new QueryHistoryPrompt(getContextTool, makeTool(''));

        const result = await prompt.render({ query: 'database migration rollback' });
        const text = resultText(result);

        const retrievedIdx = text.indexOf('Retrieved sessions');
        const queryIdx = text.indexOf('Query:');
        assert.ok(retrievedIdx !== -1, 'Phase 1 prompt must contain "Retrieved sessions" header');
        assert.ok(queryIdx !== -1, 'Phase 1 prompt must contain "Query:" line');
        assert.ok(
            retrievedIdx < queryIdx,
            'Sources block ("Retrieved sessions") must appear before the "Query:" line in Phase 1 prompt',
        );
    });

    // Contract 3 — Empty fallback prompt must contain the "No relevant history found." sentinel.
    // This is the exact string the prompt instructs the LLM to output when nothing is relevant,
    // and is also shown verbatim in the ChatWizard UI.
    test('empty-query fallback prompt contains "No relevant history found." sentinel', async () => {
        const prompt = new QueryHistoryPrompt(makeTool(''), makeTool(''));

        const result = await prompt.render({});
        const text = resultText(result);

        assert.ok(
            text.includes('No relevant history found.'),
            'fallback prompt must contain the exact sentinel string "No relevant history found."',
        );
    });

    // Contract 4 — The --general prefix that chatParticipant.ts sends MUST be exactly
    // '--general ' (with trailing space).  contextPrompts.ts checks startsWith('--general ').
    // If either side changes the exact token the routing breaks silently.
    test('--general prefix: QueryHistoryPrompt routes to general-knowledge path', async () => {
        const getContextTool = makeTool('some context');
        const prompt = new QueryHistoryPrompt(getContextTool, makeTool(''));

        // chatParticipant.ts sends exactly `--general ${query}` when user clicks "No"
        const result = await prompt.render({ query: '--general how do I fix ECONNREFUSED' });
        const text = resultText(result);

        assert.ok(
            text.toLowerCase().includes('general knowledge') || text.toLowerCase().includes('no relevant history'),
            '--general path must produce a general-knowledge prompt, not a session-grounded one',
        );
        assert.strictEqual(
            getContextTool.calls.length,
            0,
            '--general path must NOT call getContextTool — general guidance is knowledge-only',
        );
    });

    // Contract 5 — The --continued prefix sentinel.
    // chatParticipant.ts sends '--continued <query> --refs <ids>' to trigger Phase 2.
    // This test verifies the exact prefix token is honoured.
    test('--continued prefix: QueryHistoryPrompt routes to phase-2 consolidation path', async () => {
        const getSessionFullTool = makeTool('Auth session content: jwt middleware fixed');
        const prompt = new QueryHistoryPrompt(makeTool(''), getSessionFullTool);

        const result = await prompt.render({ query: '--continued auth error --refs sess-auth-1' });
        const text = resultText(result);

        assert.ok(
            text.includes('Auth session content: jwt middleware fixed'),
            '--continued path must embed the fetched session content in the consolidation prompt',
        );
    });

    // Contract 6 — Phase 1 prompt must NOT already contain an answer.
    // The LLM must only rank sessions in Phase 1 — answers come in Phase 2.
    test('Phase 1 prompt instructs LLM NOT to provide answers', async () => {
        const prompt = new QueryHistoryPrompt(makeTool('session context'), makeTool(''));

        const result = await prompt.render({ query: 'slow query optimization' });
        const text = resultText(result);

        assert.ok(
            text.includes('Do NOT provide answers') || text.includes('IMPORTANT: Do NOT provide'),
            'Phase 1 prompt must explicitly forbid the LLM from providing answers before Phase 2',
        );
    });
});
