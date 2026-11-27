/**
 * src/analytics/chatCombiner.ts
 *
 * "Combine Chats" — merge the sessions the Sessions view is currently showing
 * (whatever `Filter Sessions…` leaves, or the whole history when no filter is
 * set) into **one organised conversation**.
 *
 * Why it exists: the same problem is routinely discussed in several chats, each
 * from a different angle — one about the deployment manifest, one about the
 * ingress, one about the pod logs. Reading them side by side is exactly the work
 * a model does better than a human: it can see that three chats are one story,
 * drop the repeated ground, and keep the commands, the errors and the
 * conclusions that actually mattered.
 *
 * The *policy* for asking a model — lazy provider loading, rate-limit backoff,
 * "never throw → null" — lives in `analytics/freeModel`, the same component KB
 * classification and the Commands view reuse. This module only owns:
 *
 *   - the prompts: one merge prompt, plus a per-chat *condense* prompt,
 *   - the transcript budget: a merge prompt that would not fit is first reduced
 *     per chat (map/reduce), so a filter matching many/long sessions still
 *     combines instead of silently truncating,
 *   - the deterministic fallback used when no free model answers, so the command
 *     always produces a document,
 *   - the header and the `Source chats` footer, so a merged chat can always be
 *     traced back to the chats it came from.
 *
 * Everything here is pure apart from the model call itself, so the budgeting and
 * the prompts are unit-testable without a VS Code host (inject `complete`).
 */

import type { MessageRole, Session, SessionSource } from '../types/index';
import { friendlySourceName } from '../ui/sourceUi';
import { askFreeModel, type FreeModelDeps } from './freeModel';

// ── Budgets ─────────────────────────────────────────────────────────────────

/**
 * How many sessions one run combines. The *view order* decides which ones, so
 * with "newest first" the most recent chats win. Merging hundreds of chats in a
 * single prompt is neither useful nor affordable across free models.
 */
export const MAX_COMBINE_SESSIONS = 30;

/** Max characters kept per message — long tool output must not eat the prompt. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Max characters of the whole transcript sent in one merge prompt. */
export const MAX_MERGE_PROMPT_CHARS = 60_000;

/** Max characters of one chat's section inside the merge prompt. */
export const MAX_MERGE_PART_CHARS = 12_000;

/** Max characters of one chat fed to a condense request. */
export const MAX_DIGEST_INPUT_CHARS = 24_000;

/** Wall-clock budget for the merge request (a long answer is expected). */
export const MERGE_TIMEOUT_MS = 180_000;

/** Wall-clock budget for one per-chat condense request. */
export const CONDENSE_TIMEOUT_MS = 60_000;

/** A merged answer shorter than this is treated as unusable. */
export const MIN_MERGED_MARKDOWN_CHARS = 40;

// ── Types ───────────────────────────────────────────────────────────────────

/** The parts of a message the merge needs (kept independent of `Session`). */
export interface CombineMessage {
    role: MessageRole;
    content: string;
}

/** The parts of a session the merge needs. */
export interface CombineSessionInput {
    id: string;
    title: string;
    source?: SessionSource;
    updatedAt?: string;
    model?: string;
    messages: readonly CombineMessage[];
}

/** Where a run currently is — drives the notification progress text. */
export type CombineStep = 'condense' | 'merge';

export interface CombineProgress {
    step: CombineStep;
    done: number;
    total: number;
    /** Short human-readable status for the progress notification. */
    message: string;
}

/** Run options (injectable so tests are deterministic). */
export interface CombineOptions {
    /** Title of the merged document. Defaults to the first chat's title + count. */
    title?: string;
    /** Document date (YYYY-MM-DD). Defaults to today — injectable for tests. */
    date?: string;
    /** Called before each model request so the caller can report progress. */
    onProgress?: (progress: CombineProgress) => void;
    /** Checked between requests; a `true` result aborts the run (returns null). */
    isCancelled?: () => boolean;
}

/** Result of a combine run. `null` only when the run was cancelled or empty. */
export interface CombineResult {
    /** Ready-to-open Markdown document (header + body + source footer). */
    markdown: string;
    /** False when no free model answered and the fallback body was used. */
    usedLlm: boolean;
    /** How many chats had to be condensed before the merge. */
    condensed: number;
    /** How many chats went into the document. */
    included: number;
    /** The document title that was used. */
    title: string;
}

/** Deps for the shared free-model component (same shape as every other caller). */
export type CombineDeps = FreeModelDeps;

// ── Prompts ─────────────────────────────────────────────────────────────────

/**
 * System instructions for the merge. The rules exist because the failure modes
 * of "summarise these chats" are predictable: it invents steps nobody ran, it
 * drops the exact command that fixed the problem, it re-tells the same topic
 * once per source chat, or it collapses a contradiction into one side.
 */
export const COMBINE_SYSTEM_PROMPT = [
    'You merge several chat conversations between one developer and AI coding assistants into ONE organised conversation.',
    'Rules:',
    '- Output a single Markdown document that reads as one continuous, natural conversation about one subject.',
    '- Organise by TOPIC, not by source chat: the same subject discussed in several chats becomes ONE section.',
    '- Keep every concrete fact: commands, configuration, file paths, resource names, error messages, versions, decisions and their reasons. Quote commands and code verbatim in fenced code blocks.',
    '- Remove duplication, greetings and dead ends, but keep failed attempts and open questions that explain the current state.',
    '- Never invent facts that are not in the input. When sources contradict each other, keep both and say which chat said what.',
    '- Order the document so it reads top-down: what the problem is, what was tried, what worked, what is still open.',
    '- Begin with "## Overview" (one short paragraph), then topical "##" sections, then "## Next steps".',
    '- Do not start with a top-level "#" heading, do not describe the merging process, and do not add a list of sources — the caller appends that.',
].join('\n');

/** System instructions for the per-chat reduction used when the merge is too large. */
export const CONDENSE_SYSTEM_PROMPT = [
    'You condense ONE chat between a developer and an AI coding assistant so it can be merged with other chats on the same subject.',
    'Keep: the problem statement, every command / configuration / code snippet verbatim, error messages, decisions and their reasons, what worked, what failed, and open questions.',
    'Drop: greetings, apologies, repetition, tool plumbing and restatements of the same point.',
    'Write compact Markdown bullet points, at most about 250 words. Do not add commentary about the task itself.',
].join('\n');

/** `1 chat` / `3 chats`. */
function plural(count: number, one: string, many = `${one}s`): string {
    return count === 1 ? one : many;
}

/** Display name for a source, tolerating an unknown/absent one. */
function sourceLabel(input: CombineSessionInput): string {
    return input.source ? friendlySourceName(input.source) : 'AI assistant';
}

/** Messages that actually carry text (skipped/removed turns never do). */
export function countTurns(input: CombineSessionInput): number {
    return input.messages.filter(m => (m.content ?? '').trim().length > 0).length;
}

/** `Chat 2 — "Ingress 502" · GitHub Copilot · 2026-11-26 · 14 messages` */
export function sessionHeading(input: CombineSessionInput, index: number): string {
    const turns = countTurns(input);
    const meta = [
        sourceLabel(input),
        input.updatedAt ? input.updatedAt.slice(0, 10) : '',
        `${turns} ${plural(turns, 'message')}`,
    ].filter(part => part.length > 0);
    return `Chat ${index + 1} — "${input.title || 'Untitled chat'}" · ${meta.join(' · ')}`;
}

/**
 * One chat as a role-labelled transcript, ready to be embedded in a prompt.
 * Long messages are cut (with a visible marker) so one pasted log cannot crowd
 * out the rest of the conversation.
 */
export function formatTranscript(
    input: CombineSessionInput,
    index: number,
    maxMessageChars = MAX_MESSAGE_CHARS,
): string {
    const lines: string[] = [`#### ${sessionHeading(input, index)}`, ''];
    const assistantName = sourceLabel(input);

    for (const message of input.messages) {
        const content = (message.content ?? '').trim();
        if (content.length === 0) { continue; }
        const kept = content.length > maxMessageChars
            ? `${content.slice(0, maxMessageChars)}\n… [truncated ${content.length - maxMessageChars} characters]`
            : content;
        lines.push(`**${message.role === 'user' ? 'You' : assistantName}:**`);
        lines.push('');
        lines.push(kept);
        lines.push('');
    }

    return lines.join('\n').trimEnd();
}

/**
 * The merge request: every chat's transcript (or condensed digest), then the
 * one-line instruction. Each part is capped so a single huge chat cannot push
 * the later chats out of the model's window.
 */
export function buildMergePrompt(
    inputs: readonly CombineSessionInput[],
    parts: readonly string[],
): string {
    const lines: string[] = [
        `Merge these ${inputs.length} ${plural(inputs.length, 'conversation')} into one organised chat.`,
        '',
    ];

    inputs.forEach((_input, i) => {
        const part = (parts[i] ?? '').trim();
        lines.push(part.length > MAX_MERGE_PART_CHARS
            ? `${part.slice(0, MAX_MERGE_PART_CHARS)}\n… [truncated]`
            : part);
        lines.push('');
    });

    lines.push('Reply with the merged Markdown document only.');
    return lines.join('\n');
}

/** The reduction request for one chat (used only when the merge would not fit). */
export function buildCondensePrompt(
    input: CombineSessionInput,
    index: number,
    transcript: string = formatTranscript(input, index),
): string {
    const body = transcript.length > MAX_DIGEST_INPUT_CHARS
        ? `${transcript.slice(0, MAX_DIGEST_INPUT_CHARS)}\n… [truncated]`
        : transcript;

    return [
        `These are the turns of ${sessionHeading(input, index)}.`,
        '',
        body,
        '',
        'Condense this chat as described in your instructions.',
    ].join('\n');
}

/**
 * Normalize a model answer into a merged document body.
 *
 * Free models like to wrap a whole document in a ```markdown fence, or to start
 * with their own `# Title` even when asked not to. Both are unwrapped here, so
 * the caller's header (`# <title>`) stays the only top-level heading. Returns
 * `null` when the answer is empty or too short to be a merged chat (the caller
 * then keeps the deterministic fallback).
 */
export function cleanCombinedMarkdown(raw: string | null | undefined): string | null {
    if (!raw) { return null; }

    let text = raw.replace(/\r\n/g, '\n').trim();

    // Unwrap a document that the model fenced as a whole.
    const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
    if (fenced) { text = fenced[1].trim(); }

    // Drop a leading H1 — the document header supplies it.
    const withoutTitle = text.replace(/^#\s+[^\n]*\n+/, '').trim();
    if (withoutTitle.length > 0) { text = withoutTitle; }

    if (text.length < MIN_MERGED_MARKDOWN_CHARS) { return null; }
    return text;
}

// ── Fallback / framing (no model needed) ────────────────────────────────────

/**
 * Body used when no free model answered: the chats' turns in view order, each
 * under its own heading, with an explicit note that no model was available.
 * Combining is never worse than not combining — the user still gets one file.
 */
export function buildFallbackBody(inputs: readonly CombineSessionInput[]): string {
    const lines: string[] = [
        '> **Merged without a model.** No free AI model answered, so each chat is kept as it was instead of',
        '> being reorganised into one narrative. Run **Chat Wizard: Combine Chats…** again once a free model',
        '> is available (GitHub Copilot in VS Code, or the Cursor `agent` CLI) for the merged version.',
        '',
    ];

    inputs.forEach((input, i) => {
        const turns = countTurns(input);
        const meta = [
            sourceLabel(input),
            input.updatedAt ? input.updatedAt.slice(0, 10) : '',
            `${turns} ${plural(turns, 'message')}`,
        ].filter(part => part.length > 0);

        lines.push(`## ${i + 1}. ${input.title || 'Untitled chat'}`);
        lines.push('');
        lines.push(`*${meta.join(' · ')}*`);
        lines.push('');

        for (const message of input.messages) {
            const content = (message.content ?? '').trim();
            if (content.length === 0) { continue; }
            lines.push(`**${message.role === 'user' ? 'You' : sourceLabel(input)}:**`);
            lines.push('');
            lines.push(content.length > MAX_MESSAGE_CHARS
                ? `${content.slice(0, MAX_MESSAGE_CHARS)}\n… [truncated]`
                : content);
            lines.push('');
        }
    });

    return lines.join('\n').trim();
}

/** Traceability footer: which chats, which assistants, which dates. */
export function buildSourceFooter(inputs: readonly CombineSessionInput[]): string {
    const lines: string[] = ['---', '', '### Source chats', ''];

    inputs.forEach((input, i) => {
        const turns = countTurns(input);
        const meta = [
            sourceLabel(input),
            input.updatedAt ? input.updatedAt.slice(0, 10) : '',
            `${turns} ${plural(turns, 'message')}`,
        ].filter(part => part.length > 0);
        lines.push(`${i + 1}. **${input.title || 'Untitled chat'}** — ${meta.join(' · ')}`);
    });

    return lines.join('\n');
}

/** Default document title — the first chat plus how many were merged into it. */
export function defaultCombinedTitle(inputs: readonly CombineSessionInput[]): string {
    const first = inputs[0]?.title?.trim() || 'Combined chat';
    return inputs.length <= 1 ? first : `${first} + ${inputs.length - 1} more`;
}

/** Header + body + footer. */
export function composeDocument(args: {
    title: string;
    body: string;
    inputs: readonly CombineSessionInput[];
    usedLlm: boolean;
    condensed: number;
    date?: string;
}): string {
    const date = args.date ?? new Date().toISOString().slice(0, 10);
    const notes = [
        `Combined from ${args.inputs.length} ${plural(args.inputs.length, 'chat')} by Chat Wizard`,
        date,
    ];
    if (!args.usedLlm) { notes.push('no free model available'); }
    if (args.condensed > 0) {
        notes.push(`${args.condensed} long ${plural(args.condensed, 'chat')} condensed first`);
    }

    return [
        `# ${args.title}`,
        '',
        `> ${notes.join(' · ')}`,
        '',
        args.body.trim(),
        '',
        buildSourceFooter(args.inputs),
        '',
    ].join('\n');
}

// ── Session → input mapping ─────────────────────────────────────────────────

/**
 * Project an indexed `Session` onto what the merge needs. Removed turns
 * (Feature 51), oversized skipped lines and empty messages are dropped: they
 * would only waste prompt budget.
 */
export function toCombineInput(session: Session): CombineSessionInput {
    return {
        id: session.id,
        title: session.title,
        source: session.source,
        updatedAt: session.updatedAt,
        model: session.model,
        messages: session.messages
            .filter(m => !m.removed && !m.skipped && (m.content ?? '').trim().length > 0)
            .map(m => ({ role: m.role, content: m.content })),
    };
}

// ── Combining ───────────────────────────────────────────────────────────────

/**
 * Merge `inputs` into one organised Markdown chat with the best available free
 * model.
 *
 * Stages:
 *   1. **merge** — the whole transcript fits the prompt budget: one request.
 *   2. **condense → merge** — it does not: every chat is reduced to key points
 *      first (a chat whose reduction fails contributes its own truncated
 *      transcript, so nothing is lost), then the digests are merged.
 *   3. **fallback** — no model answered: the deterministic body is used, and the
 *      result says so (`usedLlm: false`).
 *
 * Returns `null` when there is nothing to combine or `options.isCancelled()`
 * fired between two requests (the caller then leaves the view untouched).
 */
export async function combineChats(
    inputs: readonly CombineSessionInput[],
    options: CombineOptions = {},
    deps: CombineDeps = {},
): Promise<CombineResult | null> {
    const usable = inputs
        .filter(input => countTurns(input) > 0)
        .slice(0, MAX_COMBINE_SESSIONS);
    if (usable.length === 0) { return null; }

    const title = options.title?.trim() || defaultCombinedTitle(usable);
    const transcripts = usable.map((input, i) => formatTranscript(input, i));
    const totalChars = transcripts.reduce((sum, text) => sum + text.length, 0);

    let parts = transcripts;
    let condensed = 0;

    if (totalChars > MAX_MERGE_PROMPT_CHARS) {
        parts = [];
        for (let i = 0; i < usable.length; i++) {
            if (options.isCancelled?.()) { return null; }

            options.onProgress?.({
                step: 'condense',
                done: i,
                total: usable.length,
                message: `Condensing chat ${i + 1} of ${usable.length}…`,
            });

            const digest = await askFreeModel({
                systemPrompt: CONDENSE_SYSTEM_PROMPT,
                userContent: buildCondensePrompt(usable[i], i, transcripts[i]),
                timeoutMs: CONDENSE_TIMEOUT_MS,
                maxRetries: 1,
            }, deps);

            const trimmed = (digest ?? '').trim();
            if (trimmed.length > 0) {
                condensed++;
                parts.push(trimmed);
            } else {
                // Reduction failed — keep the (capped) transcript of that chat.
                parts.push(transcripts[i].slice(0, MAX_DIGEST_INPUT_CHARS));
            }
        }
    }

    if (options.isCancelled?.()) { return null; }

    options.onProgress?.({
        step: 'merge',
        done: 0,
        total: 1,
        message: `Merging ${usable.length} ${plural(usable.length, 'chat')}…`,
    });

    const merged = cleanCombinedMarkdown(await askFreeModel({
        systemPrompt: COMBINE_SYSTEM_PROMPT,
        userContent: buildMergePrompt(usable, parts),
        timeoutMs: MERGE_TIMEOUT_MS,
        // A merge is a one-shot, user-initiated action: do not retry a rejection.
        maxRetries: 0,
    }, deps));

    const usedLlm = merged !== null;
    const body = merged ?? buildFallbackBody(usable);

    return {
        markdown: composeDocument({
            title,
            body,
            inputs: usable,
            usedLlm,
            condensed,
            date: options.date,
        }),
        usedLlm,
        condensed,
        included: usable.length,
        title,
    };
}


