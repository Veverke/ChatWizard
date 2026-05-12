// test/suite/mcp/chatParticipant.test.ts
//
// Integration tests for the @chatwizard VS Code chat participant handler.
//
// Tests the createParticipantHandler() function in isolation — no running
// VS Code chat API required. A fake request/stream/token replaces the real
// vscode.ChatRequest / vscode.ChatResponseStream / vscode.CancellationToken.
//
// Bugs caught by this suite that were previously invisible:
//   Bug 1 — rendered prompt text printed verbatim instead of being sent to LLM
//   Bug 2 — isTrusted = true (boolean) rejected by VS Code chat participant API
//   Bug 3 — "Session not found" source links when wrong workspace active
//   Bug 4 — >3 tangential sources listed instead of top 3

import * as assert from 'assert';
import { createParticipantHandler } from '../../../src/mcp/chatParticipant';
import { SessionIndex } from '../../../src/index/sessionIndex';
import type { IMcpPrompt } from '../../../src/mcp/mcpContracts';
import type { Session, Message } from '../../../src/types/index';

// ── Fixture helpers ──────────────────────────────────────────────────────────

let _idSeq = 0;

function makeMsg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m${++_idSeq}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, title = `Session ${id}`): Session {
    return {
        id,
        title,
        source: 'copilot',
        workspaceId: 'ws-test',
        messages: [makeMsg('user', 'test question'), makeMsg('assistant', 'test answer')],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

/**
 * Build a rendered prompt string that contains N session reference blocks,
 * matching the format produced by GetContextTool and parsed by parseSessionRefs().
 */
function makeRenderedPrompt(sessionIds: string[], question = 'test question'): string {
    const blocks = sessionIds.map((id, i) => [
        `[Session: Title ${i + 1}] | Source: copilot | Date: 2026-01-0${i + 1}T00:00:00.000Z`,
        `Passage: Some relevant passage text ${i + 1}`,
        `ID: ${id}`,
        '',
    ].join('\n')).join('\n');

    return [
        'You must answer the user question using the retrieved ChatWizard history context below first.',
        'If prior work exists, mention it explicitly before giving recommendations.',
        '',
        'Retrieved context:',
        blocks,
        `User question: ${question}`,
    ].join('\n');
}

// ── Fake infrastructure ──────────────────────────────────────────────────────

/** Async generator yielding fixed chunks — fakes vscode.LanguageModelChatResponse.text */
async function* fakeChunks(...parts: string[]) {
    for (const p of parts) { yield p; }
}

interface FakeStream {
    _calls: Array<string | object>;
    _progressCalls: string[];
    _buttonCalls: Array<{ title: string; command: string; arguments?: unknown[] }>;
    markdown(content: string | object): void;
    progress(message: string): void;
    button(btn: { title: string; command: string; arguments?: unknown[] }): void;
    /** All plain-string markdown calls joined */
    text(): string;
    /** True if a MarkdownString (sources table) was appended via markdown() */
    hasSourcesSection(): boolean;
}

function makeStream(): FakeStream {
    const calls: Array<string | object> = [];
    const progressCalls: string[] = [];
    const buttonCalls: Array<{ title: string; command: string; arguments?: unknown[] }> = [];
    return {
        _calls: calls,
        _progressCalls: progressCalls,
        _buttonCalls: buttonCalls,
        markdown(content) { calls.push(content); },
        progress(message) { progressCalls.push(message); },
        button(btn) { buttonCalls.push(btn); },
        text() { return calls.filter(c => typeof c === 'string').join(''); },
        // A MarkdownString (sources table) has a .value string property.
        // Button objects { title, command } do not, so they won't false-positive here.
        hasSourcesSection() {
            return calls.some(c => typeof c === 'object' && c !== null && typeof (c as { value?: unknown }).value === 'string');
        },
    };
}

interface FakeRequest {
    command: string | undefined;
    prompt: string;
    model: {
        sendRequest: (messages: unknown, opts: unknown, token: unknown) => Promise<{ text: AsyncIterable<string> }>;
        _lastMessages: unknown[];
    };
}

function makeRequest(command: string | undefined, prompt: string, answer = 'LLM synthesized answer'): FakeRequest {
    const lastMessages: unknown[] = [];
    return {
        command,
        prompt,
        model: {
            _lastMessages: lastMessages,
            async sendRequest(messages, _opts, _token) {
                lastMessages.push(...(messages as unknown[]));
                return { text: fakeChunks(answer) };
            },
        },
    };
}

/** Fake prompt that renders a fixed text */
function makePrompt(name: string, renderText: string, argName = 'question'): IMcpPrompt {
    return {
        name,
        description: 'test prompt',
        arguments: [{ name: argName, description: 'test', required: true }],
        async render(_args) {
            return { content: [{ type: 'text', text: renderText }] };
        },
    };
}

/** Fake prompt that throws during render */
function makeThrowingPrompt(name: string, message: string): IMcpPrompt {
    return {
        name,
        description: 'test prompt',
        arguments: [],
        async render(_args) { throw new Error(message); },
    };
}

// Fake message factory: avoids needing vscode.LanguageModelChatMessage (requires VS Code ≥ 1.90)
const fakeMessageFactory = (text: string) => ({ role: 'user', content: text });

const FAKE_TOKEN = {} as unknown as import('vscode').CancellationToken;
const FAKE_CTX   = {} as unknown as import('vscode').ChatContext;

// ── Tests ────────────────────────────────────────────────────────────────────

suite('createParticipantHandler', () => {

    // ── Test 1: bare @chatwizard mention (no command) ────────────────────────

    test('bare mention: lists available slash commands', async () => {
        const index  = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest(undefined, '');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('Chat Wizard'), 'output mentions Chat Wizard');
        assert.ok(out.includes('/answerFromHistory'), 'lists answerFromHistory command');
        assert.ok(out.includes('/troubleshootFromHistory'), 'lists troubleshootFromHistory command');
        assert.ok(out.includes('/continueFromHistory'), 'lists continueFromHistory command');
    });

    // ── Test 2: unknown command ──────────────────────────────────────────────

    test('unknown command: error message shown', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('nonexistent', 'some text');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('unknown command'), `expected "unknown command" in: ${out}`);
        assert.ok(out.includes('nonexistent'), `expected command name in: ${out}`);
    });

    // ── Test 3 (BUG 1 regression): rendered prompt NOT printed raw ───────────
    // Before the fix, stream.markdown received the entire raw prompt text
    // ("You must answer the user question using the retrieved ChatWizard history
    //  context below first.") instead of the LLM's synthesized response.

    test('BUG-1 regression: raw prompt text is NOT printed to stream', async () => {
        const RAW_PROMPT_MARKER = 'You must answer the user question using the retrieved ChatWizard history context below first.';
        const rendered = makeRenderedPrompt([]);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'docker does not start');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(!stream.text().includes(RAW_PROMPT_MARKER),
            'raw prompt instruction text must not appear in stream output');
    });

    // ── Test 4: LLM answer is streamed (when sessions exist in index) ─────────
    // After the Phase-1 refactor, the LLM is only called when sessions are found;
    // the response is accumulated and then emitted after the sources table.

    test('LLM response chunks are streamed to output when sessions found', async () => {
        const session  = makeSession('s-docker-001', 'Docker not starting after reboot');
        const rendered = makeRenderedPrompt(['s-docker-001']);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        index.upsert(session);
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'docker does not start', 'Based on prior history, Docker Desktop had a WSL issue.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(stream.text().includes('Based on prior history'),
            'LLM answer text must appear in stream output');
    });

    // ── Test 4b: no sessions → button shown, LLM never called ────────────────

    test('no sessions: shows no-match message and button without calling LLM', async () => {
        const rendered = makeRenderedPrompt([]);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'docker does not start', 'Based on prior history, Docker Desktop had a WSL issue.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(stream.text().includes('No relevant sessions found'),
            'should show no-match message');
        assert.ok(!stream.text().includes('Based on prior history'),
            'LLM answer must NOT appear — LLM should not be called when no sessions found');
        assert.ok(stream._buttonCalls.some(b => b.command === 'chatwizard.answer.general'),
            'a "Get general guidance" button should be offered');
    });

    // ── Test 4c: LLM says no match → button shown instead of answer ──────────

    test('LLM no-match sentinel: shows button instead of LLM answer', async () => {
        const session  = makeSession('s-irrelevant', 'Some unrelated topic');
        const rendered = makeRenderedPrompt(['s-irrelevant']);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        index.upsert(session);
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        // LLM response contains the sentinel — signals no relevant session found.
        const request = makeRequest('answerFromHistory', 'create github ci job', 'No relevant history found.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(stream.text().includes('No relevant sessions found'),
            'should show no-match message when LLM emits sentinel');
        assert.ok(!stream.hasSourcesSection(),
            'no sources section when LLM says no match');
        assert.ok(stream._buttonCalls.some(b => b.command === 'chatwizard.answer.general'),
            'a "Get general guidance" button should be offered');
    });

    // ── Test 5: rendered prompt sent to LLM ─────────────────────────────────

    test('rendered prompt is forwarded to model.sendRequest', async () => {
        const session  = makeSession('s-001');
        const rendered = makeRenderedPrompt(['s-001'], 'my specific question');
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        index.upsert(session);
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'my specific question');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const sentMessages = (request.model._lastMessages as Array<{ content: string }>);
        assert.strictEqual(sentMessages.length, 1, 'exactly one message sent to model');
        assert.ok(sentMessages[0].content.includes('my specific question'),
            'message sent to model must contain the question');
    });

    // ── Test 6 (BUG 3 regression): no sources when sessions not in index ─────
    // Before the fix, source links appeared with IDs from a different workspace
    // and clicking them showed "Session not found".

    test('BUG-3 regression: no sources section when session IDs not in index', async () => {
        const rendered = makeRenderedPrompt(['session-id-not-in-index']);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex(); // empty — session not loaded
        const handler  = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'some question');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(!stream.hasSourcesSection(),
            'no MarkdownString sources section should be appended when sessions are not in index');
    });

    // ── Test 7: sources appended when sessions are in index ──────────────────

    test('sources section appended when session IDs exist in index', async () => {
        const session  = makeSession('s-docker-001', 'Docker not starting after reboot');
        const rendered = makeRenderedPrompt(['s-docker-001']);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        index.upsert(session);

        const handler = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'docker does not start');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(stream.hasSourcesSection(),
            'a MarkdownString sources section should be appended when sessions exist in index');
    });

    // ── Test 7b (BUG regression): sources table appears BEFORE LLM answer ───
    // Before the Phase-1 refactor the handler streamed LLM chunks live and only
    // appended the sources table afterward — so sources appeared at the bottom.
    // After the fix the handler accumulates the full LLM response first, emits
    // the sources table, then emits the LLM answer text.

    test('BUG regression: sources table appears BEFORE LLM answer text in stream', async () => {
        const session  = makeSession('s-ordering', 'Ordering regression session');
        const rendered = makeRenderedPrompt(['s-ordering']);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        index.upsert(session);

        const handler = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        // LLM returns a distinctive answer — we need to find it in _calls by index
        const request = makeRequest('answerFromHistory', 'docker does not start', 'ANSWER_SENTINEL_TEXT');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        // Find index of the sources table (MarkdownString with .value)
        const sourcesIdx = stream._calls.findIndex(
            c => typeof c === 'object' && c !== null && typeof (c as { value?: unknown }).value === 'string'
        );
        // Find index of the LLM answer text (string containing our sentinel)
        const answerIdx = stream._calls.findIndex(
            c => typeof c === 'string' && (c as string).includes('ANSWER_SENTINEL_TEXT')
        );

        assert.ok(sourcesIdx !== -1, 'sources section must be present in stream');
        assert.ok(answerIdx  !== -1, 'LLM answer must be present in stream');
        assert.ok(sourcesIdx < answerIdx,
            `sources table (index ${sourcesIdx}) must appear BEFORE LLM answer (index ${answerIdx})`);
    });

    // ── Test 8 (BUG 4 regression): sources capped at 3 ──────────────────────
    // Before the fix, up to 8 sessions from the context retrieval were listed,
    // many of which were tangential and unrelated to the LLM's actual answer.

    test('BUG-4 regression: sources capped at 3 even when more are in prompt', async () => {
        const ids     = ['s-001', 's-002', 's-003', 's-004', 's-005'];
        const rendered = makeRenderedPrompt(ids);
        const prompt   = makePrompt('chatwizard.answerFromHistory', rendered);
        const index    = new SessionIndex();
        for (const id of ids) { index.upsert(makeSession(id)); }

        const handler = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'some question');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        // The sources section is a single MarkdownString object. Its `.value` property
        // contains the rendered text with one line per source.
        const sourcesCalls = stream._calls.filter(c => typeof c !== 'string') as Array<{ value: string }>;
        assert.strictEqual(sourcesCalls.length, 1, 'exactly one sources MarkdownString appended');

        const sourcesText = sourcesCalls[0].value ?? '';
        const linkCount   = (sourcesText.match(/chatwizard\.openSession/g) ?? []).length;
        assert.ok(linkCount <= 3,
            `sources must show at most 3 links, got ${linkCount}:\n${sourcesText}`);
    });

    // ── Test 9: render error is caught and reported ───────────────────────────

    test('render error is caught and shown as error message', async () => {
        const prompt  = makeThrowingPrompt('chatwizard.answerFromHistory', 'index not ready');
        const index   = new SessionIndex();
        const handler = createParticipantHandler(
            new Map([['chatwizard.answerFromHistory', prompt]]),
            index,
            fakeMessageFactory,
        );
        const stream  = makeStream();
        const request = makeRequest('answerFromHistory', 'any question');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('error running'), `expected "error running" in: ${out}`);
        assert.ok(out.includes('index not ready'), `expected error detail in: ${out}`);
        assert.ok(!stream.hasSourcesSection(), 'no sources section on error');
    });
});
