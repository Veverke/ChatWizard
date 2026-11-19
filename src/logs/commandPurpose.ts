/**
 * src/logs/commandPurpose.ts
 *
 * Derives what an executed command sequence is *for* — the final fallback
 * Description of a Terminal Command row in the Commands view:
 *
 *   `rg "TOKEN" --glob "*.json" src`  →  "Searches JSON files under src for
 *                                         the TOKEN string."
 *
 * The heuristic catalogue in `logEventSummary.describeCommand()` only knows the
 * first word of the command (`Runs a shell command “rg …”`), which says nothing
 * about intent. When a **free** language model is available (`promptLlm()` tries
 * the free Copilot family chain, then the Cursor `agent` CLI) we ask it for one
 * sentence describing the purpose of the whole statement sequence.
 *
 * The "ask a free model, best effort" policy itself lives in
 * `analytics/freeModel` — the same component that KB classification uses — so
 * this module only owns the prompt, the answer sanitizer and the cache key:
 *
 *   - **Lazy**: the shared component loads the provider module on its first
 *     call, never at activation, so no model is touched until a command detail
 *     panel is opened.
 *   - **Best effort**: any failure (no model, timeout, unhelpful answer) yields
 *     `null`, and the caller keeps the heuristic description.
 *   - **Cheap**: results (including "no answer") are cached per command text +
 *     cwd + shell, and concurrent requests for the same command share one call.
 *   - **Testable**: the completion function is injectable, so unit tests never
 *     touch the VS Code LM API.
 */

import type { CommandEvent } from './types';
import { splitCommandStatements } from './commandStatements';
import {
    askFreeModel,
    clearFreeModelCache,
    hasFreeModelAnswer,
    peekFreeModelAnswer,
    type FreeModelDeps,
} from '../analytics/freeModel';

/** One-sentence answers only — keeps the Description row readable. */
const MAX_PURPOSE_CHARS = 220;

/** Cap the command text embedded in the prompt (logs can be noisy). */
const MAX_PROMPT_COMMAND_CHARS = 4_000;

/** System instructions sent with every purpose request. */
export const COMMAND_PURPOSE_SYSTEM_PROMPT = [
    'You explain shell commands to a developer reviewing an AI coding agent log.',
    'Reply with ONE sentence (at most 30 words) describing the PURPOSE / INTENT of the command sequence:',
    'what it achieves and on what, e.g. "Searches JSON files under src for the TOKEN string."',
    'Do not start with "This command", do not mention that it runs a shell command,',
    'do not use markdown, lists, code fences or quotes.',
].join(' ');

/** Injection point for tests (the real one is `llmClient.promptLlm`). */
export type CommandPurposeCompletion = (
    systemPrompt: string | undefined,
    userContent: string,
) => Promise<string | null>;

export interface CommandPurposeDeps extends FreeModelDeps {
    /** Replacement completion function; when omitted the shared free-model client is used. */
    complete?: CommandPurposeCompletion;
}

/**
 * The user prompt: the command sequence one statement per line, plus the
 * context that changes its meaning (working directory, shell, exit code).
 */
export function buildCommandPurposePrompt(
    event: Pick<CommandEvent, 'commandText' | 'cwd' | 'shell' | 'exitCode'>,
): string {
    const statements = splitCommandStatements(event.commandText);
    const commandBlock = statements.join('\n').slice(0, MAX_PROMPT_COMMAND_CHARS);
    const lines: string[] = [
        'The agent executed this command sequence:',
        '',
        commandBlock.length > 0 ? commandBlock : '(empty command)',
        '',
    ];
    if (statements.length > 1) {
        lines.push(`It consists of ${statements.length} separate statements.`);
    }
    if (event.cwd) { lines.push(`Working directory: ${event.cwd}`); }
    if (event.shell) { lines.push(`Shell: ${event.shell}`); }
    if (event.exitCode !== undefined) { lines.push(`Exit code: ${event.exitCode}`); }
    lines.push('', 'Describe its purpose in one sentence.');
    return lines.join('\n');
}

/**
 * Normalize a model answer into a single display sentence.
 *
 * Strips markdown bullets / code fences / wrapping quotes / a leading
 * `Purpose:` label, collapses whitespace and caps the length. Returns `null`
 * when nothing usable is left (the caller then keeps the heuristic text).
 */
export function cleanCommandPurpose(raw: string | null | undefined): string | null {
    if (!raw) { return null; }
    const firstLine = raw
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        // Skip markdown fence lines (``` or ```bash) — the answer follows them.
        .find((line) => line.length > 0 && !/^```/.test(line)) ?? '';

    let text = firstLine
        .replace(/^[-*•]\s+/, '')
        .replace(/^(purpose|intent|description)\s*[:\-]\s+/i, '')
        .replace(/`+/g, '')
        .trim();

    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' || first === '\'') && last === first) {
            text = text.slice(1, -1).trim();
        }
    }

    text = text.replace(/\s+/g, ' ');
    if (text.length === 0) { return null; }
    return text.length > MAX_PURPOSE_CHARS ? `${text.slice(0, MAX_PURPOSE_CHARS - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Namespace for the shared free-model cache — clearing command purposes must
 * never drop answers memoised by another feature (KB classification, …).
 */
const PURPOSE_CACHE_PREFIX = 'cmd-purpose:';

function purposeCacheKey(event: Pick<CommandEvent, 'commandText' | 'cwd' | 'shell'>): string {
    return `${PURPOSE_CACHE_PREFIX}${[event.shell ?? '', event.cwd ?? '', event.commandText ?? ''].join('\u0000')}`;
}

/** Clear the memoized purposes (tests, and future cache-invalidation hooks). */
export function clearCommandPurposeCache(): void {
    clearFreeModelCache(PURPOSE_CACHE_PREFIX);
}

/**
 * The already-derived purpose for an event, if one is cached.
 * `undefined` means "not asked yet" — a cached `null` (no model) reads as
 * `undefined` so the caller simply keeps the heuristic description.
 */
export function peekCommandPurpose(
    event: Pick<CommandEvent, 'commandText' | 'cwd' | 'shell'>,
): string | undefined {
    return peekFreeModelAnswer(purposeCacheKey(event));
}

/**
 * Whether the free-model answer for this command is already settled — either a
 * purpose, or "no model answered". A caller that opens the row again can then
 * render the final text immediately instead of a loading placeholder.
 */
export function isCommandPurposeResolved(
    event: Pick<CommandEvent, 'commandText' | 'cwd' | 'shell'>,
): boolean {
    return hasFreeModelAnswer(purposeCacheKey(event));
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Ask the free model (when available) what the command sequence is for.
 *
 * The lazy provider loading, single-flight caching and "never throw" policy all
 * come from `analytics/freeModel`; this function only supplies the prompt, the
 * sanitizer and the cache key. Returns the cleaned one-sentence purpose, or
 * `null` when no model is available or the answer is unusable.
 */
export async function deriveCommandPurpose(
    event: CommandEvent,
    deps: CommandPurposeDeps = {},
): Promise<string | null> {
    if ((event.commandText ?? '').trim().length === 0) { return null; }

    return askFreeModel({
        systemPrompt: COMMAND_PURPOSE_SYSTEM_PROMPT,
        userContent: buildCommandPurposePrompt(event),
        cacheKey: purposeCacheKey(event),
        transform: cleanCommandPurpose,
        timeoutMs: 20_000,
        // A description is display-only: never spend retries on it.
        maxRetries: 0,
    }, deps);
}


