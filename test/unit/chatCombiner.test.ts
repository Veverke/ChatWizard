/**
 * test/unit/chatCombiner.test.ts
 *
 * "Combine Chats" — the chats currently in view are merged into one organised
 * conversation by a free model.
 *
 * Covered here: the prompts, the transcript budgeting (one merge request vs
 * condense-then-merge), the deterministic fallback used when no model answers,
 * the document framing, and the `Session → input` projection.
 *
 * The model is injected (`deps.complete`), so no VS Code host and no provider
 * chain is involved.
 */

import * as assert from 'assert';
import {
    COMBINE_SYSTEM_PROMPT,
    CONDENSE_SYSTEM_PROMPT,
    MAX_COMBINE_SESSIONS,
    MAX_MESSAGE_CHARS,
    buildCondensePrompt,
    buildFallbackBody,
    buildMergePrompt,
    buildSourceFooter,
    cleanCombinedMarkdown,
    combineChats,
    countTurns,
    defaultCombinedTitle,
    formatTranscript,
    toCombineInput,
    type CombineSessionInput,
} from '../../src/analytics/chatCombiner';
import type { Session } from '../../src/types/index';

// ── Fixtures ────────────────────────────────────────────────────────────────

const noSleep = { sleep: async (): Promise<void> => undefined };

const MERGED_ANSWER = [
    '## Overview',
    '',
    'The 502 came from a Service targetPort that no longer matched the container port.',
    '',
    '## What fixed it',
    '',
    '```yaml',
    'targetPort: 8080',
    '```',
    '',
    '## Next steps',
    '',
    '- Watch the pods after the rollout.',
].join('\n');

function makeInput(overrides: Partial<CombineSessionInput> = {}): CombineSessionInput {
    return {
        id: 's1',
        title: 'Kubernetes ingress 502',
        source: 'copilot',
        updatedAt: '2026-11-20T10:00:00.000Z',
        messages: [
            { role: 'user', content: 'My ingress returns 502 on the new deployment.' },
            { role: 'assistant', content: 'Check the Service selector and the targetPort.' },
        ],
        ...overrides,
    };
}

/** Two chats whose transcripts together exceed the merge budget. */
function longInputs(): CombineSessionInput[] {
    const message = 'x'.repeat(MAX_MESSAGE_CHARS);
    return [
        makeInput({
            id: 'long-1',
            title: 'Ingress 502',
            messages: Array.from({ length: 8 }, (_v, i) => ({
                role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                content: message,
            })),
        }),
        makeInput({
            id: 'long-2',
            title: 'Service selector',
            messages: Array.from({ length: 8 }, (_v, i) => ({
                role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                content: message,
            })),
        }),
    ];
}

/** Completion stub: records every request, answers through `handler`. */
function stubModel(
    handler: (systemPrompt: string | undefined, userContent: string) => string | null,
): {
    calls: Array<{ systemPrompt: string | undefined; userContent: string }>;
    complete: (systemPrompt: string | undefined, userContent: string) => Promise<string | null>;
} {
    const calls: Array<{ systemPrompt: string | undefined; userContent: string }> = [];
    return {
        calls,
        complete: async (systemPrompt, userContent) => {
            calls.push({ systemPrompt, userContent });
            return handler(systemPrompt, userContent);
        },
    };
}

// ── Transcript & prompts ────────────────────────────────────────────────────

suite('chatCombiner — transcript & prompts', () => {

    test('a transcript is role-labelled and carries the chat metadata', () => {
        const transcript = formatTranscript(makeInput(), 1);

        assert.ok(transcript.includes('Chat 2 — "Kubernetes ingress 502"'), transcript);
        assert.ok(transcript.includes('GitHub Copilot'), transcript);
        assert.ok(transcript.includes('2026-11-20'), transcript);
        assert.ok(transcript.includes('2 messages'), transcript);
        assert.ok(transcript.includes('**You:**'), transcript);
        assert.ok(transcript.includes('**GitHub Copilot:**'), transcript);
    });

    test('long messages are truncated with a visible marker', () => {
        const transcript = formatTranscript(makeInput({
            messages: [{ role: 'user', content: 'y'.repeat(50) }],
        }), 0, 10);

        assert.ok(transcript.includes('… [truncated 40 characters]'), transcript);
        assert.ok(!transcript.includes('y'.repeat(11)), transcript);
    });

    test('the merge prompt lists every chat and asks for Markdown only', () => {
        const inputs = [makeInput(), makeInput({ id: 's2', title: 'Service selector' })];
        const prompt = buildMergePrompt(inputs, [
            formatTranscript(inputs[0], 0),
            formatTranscript(inputs[1], 1),
        ]);

        assert.ok(prompt.startsWith('Merge these 2 conversations into one organised chat.'), prompt);
        assert.ok(prompt.includes('Chat 1 — "Kubernetes ingress 502"'), prompt);
        assert.ok(prompt.includes('Chat 2 — "Service selector"'), prompt);
        assert.ok(prompt.trimEnd().endsWith('Reply with the merged Markdown document only.'), prompt);
    });

    test('the condense prompt reuses the chat heading and asks for a reduction', () => {
        const prompt = buildCondensePrompt(makeInput(), 0);

        assert.ok(prompt.includes('These are the turns of Chat 1 — "Kubernetes ingress 502"'), prompt);
        assert.ok(prompt.includes('Check the Service selector'), prompt);
        assert.ok(prompt.trimEnd().endsWith('Condense this chat as described in your instructions.'), prompt);
    });

    test('the system prompts state the merge and reduce rules', () => {
        assert.ok(COMBINE_SYSTEM_PROMPT.includes('Organise by TOPIC'), COMBINE_SYSTEM_PROMPT);
        assert.ok(COMBINE_SYSTEM_PROMPT.includes('Never invent facts'), COMBINE_SYSTEM_PROMPT);
        assert.ok(CONDENSE_SYSTEM_PROMPT.includes('verbatim'), CONDENSE_SYSTEM_PROMPT);
    });
});

// ── Answer cleaning ─────────────────────────────────────────────────────────

suite('chatCombiner — answer cleaning', () => {

    test('unwraps a document the model fenced as a whole', () => {
        const cleaned = cleanCombinedMarkdown(`\`\`\`markdown\n${MERGED_ANSWER}\n\`\`\``);

        assert.strictEqual(cleaned, MERGED_ANSWER);
    });

    test('drops a leading H1 so the caller header is the only title', () => {
        const cleaned = cleanCombinedMarkdown(`# Ingress troubleshooting\n\n${MERGED_ANSWER}`);

        assert.ok(cleaned?.startsWith('## Overview'), cleaned ?? 'null');
    });

    test('rejects an empty or too-short answer', () => {
        assert.strictEqual(cleanCombinedMarkdown(''), null);
        assert.strictEqual(cleanCombinedMarkdown(null), null);
        assert.strictEqual(cleanCombinedMarkdown('ok'), null);
    });
});

// ── Combining ───────────────────────────────────────────────────────────────

suite('chatCombiner — combining', () => {

    test('merges in a single request when the transcript fits', async () => {
        const model = stubModel(() => MERGED_ANSWER);
        const inputs = [makeInput(), makeInput({ id: 's2', title: 'Service selector' })];

        const result = await combineChats(inputs, { date: '2026-11-27' }, { ...noSleep, complete: model.complete });

        assert.ok(result, 'expected a result');
        assert.strictEqual(model.calls.length, 1, 'one merge request');
        assert.strictEqual(model.calls[0].systemPrompt, COMBINE_SYSTEM_PROMPT);
        assert.strictEqual(result.usedLlm, true);
        assert.strictEqual(result.included, 2);
        assert.strictEqual(result.condensed, 0);
        assert.strictEqual(result.title, 'Kubernetes ingress 502 + 1 more');
        assert.ok(result.markdown.startsWith('# Kubernetes ingress 502 + 1 more\n'), result.markdown);
        assert.ok(result.markdown.includes('Combined from 2 chats by Chat Wizard · 2026-11-27'), result.markdown);
        assert.ok(result.markdown.includes('## Overview'), result.markdown);
        assert.ok(result.markdown.includes('### Source chats'), result.markdown);
    });

    test('condenses every chat first when the transcript is too long', async () => {
        const model = stubModel((systemPrompt) =>
            systemPrompt === CONDENSE_SYSTEM_PROMPT ? 'DIGEST: targetPort fix' : MERGED_ANSWER);

        const result = await combineChats(longInputs(), { date: '2026-11-27' }, { ...noSleep, complete: model.complete });

        assert.ok(result, 'expected a result');
        assert.strictEqual(model.calls.length, 3, 'two condense requests plus one merge');
        assert.strictEqual(result.condensed, 2);
        assert.ok(result.markdown.includes('2 long chats condensed first'), result.markdown);

        const mergePrompt = model.calls[2].userContent;
        assert.strictEqual(model.calls[2].systemPrompt, COMBINE_SYSTEM_PROMPT);
        assert.ok(mergePrompt.includes('DIGEST: targetPort fix'), mergePrompt);
        assert.ok(!mergePrompt.includes('x'.repeat(MAX_MESSAGE_CHARS)), 'raw long transcript must not reach the merge');
    });

    test('a failed reduction falls back to that chat and the merge still runs', async () => {
        let condenseCalls = 0;
        const model = stubModel((systemPrompt) => {
            if (systemPrompt !== CONDENSE_SYSTEM_PROMPT) { return MERGED_ANSWER; }
            condenseCalls++;
            return condenseCalls === 1 ? null : 'DIGEST: second chat';
        });

        const result = await combineChats(longInputs(), { date: '2026-11-27' }, { ...noSleep, complete: model.complete });

        assert.ok(result, 'expected a result');
        assert.strictEqual(result.condensed, 1);
        const mergePrompt = model.calls[2].userContent;
        assert.ok(mergePrompt.includes('DIGEST: second chat'), mergePrompt);
        assert.ok(mergePrompt.includes('truncated'), 'the un-reduced chat keeps its transcript');
    });

    test('no model answer keeps every chat in a deterministic document', async () => {
        const model = stubModel(() => null);
        const inputs = [makeInput(), makeInput({ id: 's2', title: 'Service selector' })];

        const result = await combineChats(inputs, { date: '2026-11-27' }, { ...noSleep, complete: model.complete });

        assert.ok(result, 'expected a result');
        assert.strictEqual(result.usedLlm, false);
        assert.ok(result.markdown.includes('no free model available'), result.markdown);
        assert.ok(result.markdown.includes('Merged without a model.'), result.markdown);
        assert.ok(result.markdown.includes('## 1. Kubernetes ingress 502'), result.markdown);
        assert.ok(result.markdown.includes('## 2. Service selector'), result.markdown);
        assert.ok(result.markdown.includes('### Source chats'), result.markdown);
    });

    test('cancellation between requests aborts the run', async () => {
        const model = stubModel((systemPrompt) =>
            systemPrompt === CONDENSE_SYSTEM_PROMPT ? 'DIGEST' : MERGED_ANSWER);

        const result = await combineChats(
            longInputs(),
            { isCancelled: () => model.calls.length >= 1 },
            { ...noSleep, complete: model.complete },
        );

        assert.strictEqual(result, null);
        assert.strictEqual(model.calls.length, 1, 'aborted before the second condense');
    });

    test('caps the number of chats per run', async () => {
        const model = stubModel(() => MERGED_ANSWER);
        const inputs = Array.from({ length: MAX_COMBINE_SESSIONS + 2 }, (_v, i) =>
            makeInput({ id: `s${i}`, title: `Chat ${i}` }));

        const result = await combineChats(inputs, { date: '2026-11-27' }, { ...noSleep, complete: model.complete });

        assert.ok(result, 'expected a result');
        assert.strictEqual(result.included, MAX_COMBINE_SESSIONS);
        assert.ok(model.calls[0].userContent.startsWith(`Merge these ${MAX_COMBINE_SESSIONS} conversations`),
            model.calls[0].userContent.slice(0, 120));
    });

    test('chats without usable turns are skipped, and an empty set yields nothing', async () => {
        const empty = makeInput({ id: 'empty', messages: [{ role: 'user', content: '   ' }] });
        const model = stubModel(() => MERGED_ANSWER);

        const result = await combineChats([empty, makeInput(), makeInput({ id: 's2' })],
            { date: '2026-11-27' }, { ...noSleep, complete: model.complete });
        assert.strictEqual(result?.included, 2);

        const nothing = await combineChats([empty], {}, { ...noSleep, complete: model.complete });
        assert.strictEqual(nothing, null);
    });
});


// ── Framing & projection ────────────────────────────────────────────────────

suite('chatCombiner — framing & projection', () => {

    test('the source footer lists every chat with its assistant, date and size', () => {
        const footer = buildSourceFooter([
            makeInput(),
            makeInput({ id: 's2', title: 'Service selector', source: 'claude' }),
        ]);

        assert.ok(footer.startsWith('---\n\n### Source chats'), footer);
        assert.ok(footer.includes('1. **Kubernetes ingress 502** — GitHub Copilot · 2026-11-20 · 2 messages'), footer);
        assert.ok(footer.includes('2. **Service selector** — Claude Code · 2026-11-20 · 2 messages'), footer);
    });

    test('the fallback body keeps the turns of every chat', () => {
        const body = buildFallbackBody([makeInput()]);

        assert.ok(body.includes('Merged without a model.'), body);
        assert.ok(body.includes('## 1. Kubernetes ingress 502'), body);
        assert.ok(body.includes('My ingress returns 502'), body);
        assert.ok(body.includes('Check the Service selector'), body);
    });

    test('the default title names the first chat and the number merged into it', () => {
        assert.strictEqual(defaultCombinedTitle([makeInput()]), 'Kubernetes ingress 502');
        assert.strictEqual(
            defaultCombinedTitle([makeInput(), makeInput({ id: 'b' }), makeInput({ id: 'c' })]),
            'Kubernetes ingress 502 + 2 more',
        );
    });

    test('countTurns ignores empty messages', () => {
        assert.strictEqual(countTurns(makeInput({
            messages: [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: '  ' },
            ],
        })), 1);
    });

    test('toCombineInput drops removed, skipped and empty turns', () => {
        const session = {
            id: 's1',
            title: 'Ingress 502',
            source: 'copilot',
            updatedAt: '2026-11-20T10:00:00.000Z',
            model: 'gpt-4o',
            messages: [
                { id: 'm1', role: 'user', content: 'kept', codeBlocks: [] },
                { id: 'm2', role: 'assistant', content: 'removed turn', codeBlocks: [], removed: true },
                { id: 'm3', role: 'assistant', content: 'skipped line', codeBlocks: [], skipped: true },
                { id: 'm4', role: 'assistant', content: '   ', codeBlocks: [] },
            ],
        } as unknown as Session;

        const input = toCombineInput(session);

        assert.strictEqual(input.messages.length, 1);
        assert.deepStrictEqual(input.messages[0], { role: 'user', content: 'kept' });
        assert.strictEqual(input.source, 'copilot');
        assert.strictEqual(input.model, 'gpt-4o');
    });
});

