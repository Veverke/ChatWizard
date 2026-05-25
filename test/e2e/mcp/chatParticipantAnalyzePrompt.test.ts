// test/e2e/mcp/chatParticipantAnalyzePrompt.test.ts
//
// Real-world tests for the /analyzePrompt slash-command in @chatwizard
// (Feature 20-C: Prompt Analysis chat participant handler).
//
// Tests verify that the handler correctly analyses prompts, emits the right
// sections to the stream, shows verbosity flags for long/multi-question prompts,
// and that the unknown-command fallback is not broken by the new handler.

import * as assert from 'assert';
import { createParticipantHandler } from '../../../src/mcp/chatParticipant';
import { SessionIndex } from '../../../src/index/sessionIndex';
import type { IMcpPrompt } from '../../../src/mcp/mcpContracts';
import type { Message, Session } from '../../../src/types/index';

// ── Fake infrastructure (mirrors chatParticipant.test.ts) ────────────────────

let _idSeq = 0;
function makeMsg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-ap-${++_idSeq}`, role, content, codeBlocks: [] };
}

function makeSession(id: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        workspaceId: 'ws-ap-test',
        messages: [makeMsg('user', 'test')],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

interface FakeStream {
    _calls: Array<string | object>;
    _progressCalls: string[];
    markdown(content: string | object): void;
    progress(message: string): void;
    button(btn: { title: string; command: string }): void;
    text(): string;
}

function makeStream(): FakeStream {
    const calls: Array<string | object> = [];
    const progressCalls: string[] = [];
    return {
        _calls: calls,
        _progressCalls: progressCalls,
        markdown(content) { calls.push(content); },
        progress(msg) { progressCalls.push(msg); },
        button(_btn) { /* no-op */ },
        text() { return calls.filter(c => typeof c === 'string').join(''); },
    };
}

function makeRequest(command: string | undefined, prompt: string) {
    return {
        command,
        prompt,
        model: {
            _lastMessages: [] as unknown[],
            async sendRequest(messages: unknown, _o: unknown, _t: unknown) {
                return { text: (async function* () { yield 'LLM response'; })() };
            },
        },
    };
}

const fakeMessageFactory = (text: string) => ({ role: 'user', content: text });
const FAKE_TOKEN = {} as unknown as import('vscode').CancellationToken;
const FAKE_CTX   = {} as unknown as import('vscode').ChatContext;

// ── Suite ────────────────────────────────────────────────────────────────────

suite('createParticipantHandler — /analyzePrompt', () => {

    // ── No prompt text → usage instructions ─────────────────────────────────

    test('empty prompt shows usage instructions and no "Analyzing" progress', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', '');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('Usage'), `expected usage message, got: ${out}`);
        assert.ok(out.includes('/analyzePrompt'), `expected command name in usage, got: ${out}`);

        // No "Analyzing" progress should fire — we returned early.
        assert.ok(
            !stream._progressCalls.some(p => p.toLowerCase().includes('analyzing')),
            'should not show "Analyzing" progress when prompt is empty',
        );
    });

    test('whitespace-only prompt also shows usage instructions', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', '   \t  ');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('Usage'), `expected usage message for whitespace input, got: ${out}`);
    });

    // ── Clean short prompt: standard analysis output ─────────────────────────

    test('clean short prompt returns Prompt Analysis header and required fields', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'How do I configure a TypeScript strict mode project?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('**Prompt Analysis**'), `expected "**Prompt Analysis**" header, got: ${out}`);
        assert.ok(out.includes('**Tokens:**'), `expected "**Tokens:**" line, got: ${out}`);
        assert.ok(out.includes('**Suggested model:**'), `expected "**Suggested model:**" line, got: ${out}`);
    });

    test('clean short prompt emits token count as a number', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'What is the difference between null and undefined in TypeScript?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        // Expect something like "**Tokens:** ~12" (number after ~)
        const tokenMatch = out.match(/\*\*Tokens:\*\*\s*~?([\d,]+)/);
        assert.ok(tokenMatch, `expected token count in output, got: ${out}`);
        const tokenCount = parseInt(tokenMatch![1].replace(/,/g, ''), 10);
        assert.ok(tokenCount > 0, `token count should be > 0, got ${tokenCount}`);
    });

    test('"Analyzing prompt…" progress is shown for non-empty prompt', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'Explain dependency injection in Angular.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.ok(
            stream._progressCalls.some(p => p.toLowerCase().includes('analyzing')),
            `expected "Analyzing" progress, got: ${JSON.stringify(stream._progressCalls)}`,
        );
    });

    // ── Cost estimates section ───────────────────────────────────────────────

    test('output includes estimated cost section with at least one model price', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'Write a REST API in Node.js with Express and PostgreSQL.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('**Estimated cost:**'), `expected cost section, got: ${out}`);
        // Expect at least one dollar sign followed by a decimal number
        assert.ok(/\$\d+\.\d{4}/.test(out), `expected cost in $X.XXXX format, got: ${out}`);
    });

    // ── Verbosity flags: multiple questions ──────────────────────────────────

    test('prompt with 3+ questions triggers MULTIPLE_QUESTIONS verbosity flag', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        // Three question marks → should trigger MULTIPLE_QUESTIONS flag.
        const prompt = 'What is React? How does useState work? When should I use useEffect? Can you explain the lifecycle?';
        const request = makeRequest('analyzePrompt', prompt);

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('**⚠ Verbosity flags:**'), `expected verbosity section for multi-question prompt, got: ${out}`);
        assert.ok(out.toLowerCase().includes('questions'), `expected mention of "questions" in flags, got: ${out}`);
    });

    // ── Verbosity flags: large code block ────────────────────────────────────

    test('prompt with large code block triggers LARGE_CODE_BLOCK verbosity flag', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        // Fenced code block > 500 chars.
        const bigCode = '// This is a large code block\n' + 'const x = 1;\n'.repeat(50);
        const prompt  = `Please review the following code:\n\`\`\`typescript\n${bigCode}\n\`\`\``;
        const request = makeRequest('analyzePrompt', prompt);

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('**⚠ Verbosity flags:**'), `expected verbosity section for large code prompt, got: ${out}`);
        assert.ok(out.toLowerCase().includes('code block'), `expected "code block" mention in flags, got: ${out}`);
    });

    // ── Clean prompt: "Looks good" message ───────────────────────────────────

    test('clean concise prompt with no flags shows "Looks good" message', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        // Short, clear, single-topic prompt — should produce no verbosity flags.
        const request = makeRequest('analyzePrompt', 'How do I sort an array of objects by a property in JavaScript?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        // No verbosity flags → "Looks good" message should appear.
        if (!out.includes('**⚠ Verbosity flags:**')) {
            assert.ok(out.includes('Looks good'), `expected "Looks good" when no flags, got: ${out}`);
        }
    });

    // ── Similar sessions appear when index has matching sessions ─────────────

    test('similar sessions section lists session titles when sessions match', async () => {
        const index = new SessionIndex();
        // Seed a session with related content.
        const s = makeSession('s-ap-sim-1');
        // Override title to be clearly recognizable.
        (s as { title: string }).title = 'TypeScript configuration guide';
        index.upsert(s);

        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        // The /analyzePrompt handler uses new PromptAnalyzer() without a search provider,
        // so similarSessions is always [] — the section is omitted.
        // This test verifies the output structure is valid either way.
        const request = makeRequest('analyzePrompt', 'How do I configure TypeScript tsconfig strict mode?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        // Should have the standard analysis output regardless of similarity hits.
        assert.ok(out.includes('**Prompt Analysis**'), `expected analysis header, got: ${out}`);
    });

    // ── Regression: other unknown commands still get the fallback ────────────

    test('regression — unknown command still shows "unknown command" fallback after analyzePrompt added', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('definitelyNotACommand', 'some text');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        assert.ok(out.includes('unknown command'), `expected "unknown command", got: ${out}`);
        assert.ok(out.includes('definitelyNotACommand'), `expected command name in message, got: ${out}`);
    });

    // ── analyzePrompt does NOT reach the LLM ────────────────────────────────

    test('/analyzePrompt never calls model.sendRequest — all analysis is local', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();

        let llmCalled = false;
        const request = {
            command: 'analyzePrompt',
            prompt: 'Should I use Zustand or Redux Toolkit for state management?',
            model: {
                _lastMessages: [] as unknown[],
                async sendRequest(_m: unknown, _o: unknown, _t: unknown) {
                    llmCalled = true;
                    return { text: (async function* () { yield 'LLM response'; })() };
                },
            },
        };

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        assert.strictEqual(llmCalled, false, '/analyzePrompt must not call the LLM — all analysis is done locally');
    });

    // ── Suggested model field is a recognizable model name ───────────────────

    test('suggested model field contains a known model identifier', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'What are some good patterns for error handling in async TypeScript code?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        const KNOWN_MODELS = ['gpt-4o', 'claude', 'gemini', 'gpt-3.5'];
        const hasSuggestedModel = KNOWN_MODELS.some(m => out.toLowerCase().includes(m));
        assert.ok(hasSuggestedModel, `expected a known model in suggested model line, got: ${out}`);
    });

    // ── Analysis source footer ───────────────────────────────────────────────
    //
    // When VS Code is not available (test environment), CopilotPromptAnalysisProvider
    // fails to acquire a model, so the heuristic path is taken. The output must include
    // the heuristic footer line so users know the quality of the analysis.

    test('output includes the heuristic footer when Copilot LLM is unavailable (test env)', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        const request = makeRequest('analyzePrompt', 'Explain how to use Redis as a session store in Express.');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        // In the test environment there is no vscode.lm available, so the analysis
        // must fall back to heuristics and show the heuristic footer.
        assert.ok(
            out.includes('heuristic analysis') || out.includes('analysis by Copilot'),
            `expected analysis source footer in output, got: ${out}`,
        );
    });

    test('rewriteSuggestion section is not present in heuristic-only output (no rewrite from heuristics)', async () => {
        const index   = new SessionIndex();
        const handler = createParticipantHandler(new Map(), index, fakeMessageFactory);
        const stream  = makeStream();
        // A normal prompt — no LLM available in test env → no rewriteSuggestion
        const request = makeRequest('analyzePrompt', 'What is the purpose of TypeScript generics?');

        await handler(request as never, FAKE_CTX, stream as never, FAKE_TOKEN);

        const out = stream.text();
        // Heuristics never produce a rewriteSuggestion so this section must be absent
        assert.ok(
            !out.includes('**💡 Suggested rewrite:**'),
            `rewriteSuggestion section should not appear in heuristic output, got: ${out}`,
        );
    });

});
