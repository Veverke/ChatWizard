/**
 * src/analytics/freeModel.ts
 *
 * One reusable entry point for "ask a free model, best effort".
 *
 * Several features need the same non-critical LLM behaviour: read some text,
 * ask whatever *free* model is available for a short answer, and silently keep
 * the heuristic result when none is. That policy used to be re-implemented per
 * feature (model chain + rate-limit backoff + null handling):
 *
 *   - KB classification — `kbLlmClassifier.classifySessionWithLlm`,
 *     `refineCategories`, `refineSubtypes`
 *   - Commands view — `commandPurpose.deriveCommandPurpose`
 *
 * This module owns that policy exactly once:
 *
 *   - **Lazy** — `llmClient` (and therefore the VS Code LM API) is imported on
 *     the first request only, never at activation.
 *   - **Resilient** — rate-limited requests are retried with exponential
 *     backoff; every other failure resolves to `null`.
 *   - **Cheap** — when a `cacheKey` is supplied, the mapped answer is memoised
 *     (including "no answer") and concurrent requests for the same key share a
 *     single model call.
 *   - **Silent** — never throws: "no free model available" is a normal outcome
 *     and the caller keeps its fallback (heuristic description, embedding-based
 *     category, …).
 *
 * Provider selection itself stays in `llmClient.promptLlm()` (free Copilot
 * model chain → Cursor `agent` CLI); this module only adds the *policy* around
 * asking, so any future feature can reuse it instead of writing its own loop.
 */

import { createLogger } from '../utils/logger';

const log = createLogger().withContext('FreeModel');

// ── Defaults ────────────────────────────────────────────────────────────────

/** Default wall-clock budget for a single completion request. */
export const FREE_MODEL_DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of extra attempts after a rate-limited request. */
export const FREE_MODEL_MAX_RETRIES = 3;

/** Base delay for exponential backoff between attempts (doubles per attempt). */
export const FREE_MODEL_BASE_DELAY_MS = 2_000;

/** How many memoised answers a cache keeps before evicting the oldest. */
export const FREE_MODEL_CACHE_LIMIT = 200;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Transport used to talk to the model. The default implementation is
 * `llmClient.promptLlm()`, loaded lazily; tests inject their own.
 */
export type FreeModelCompletion = (
    systemPrompt: string | undefined,
    userContent: string,
    timeoutMs: number,
) => Promise<string | null>;

/** Injection points (tests, or a caller with its own provider). */
export interface FreeModelDeps {
    /** Replacement transport; when omitted `llmClient.promptLlm` is used. */
    complete?: FreeModelCompletion;
    /** Replacement sleep, so tests do not wait for the real backoff. */
    sleep?: (ms: number) => Promise<void>;
}

/** One "ask the free model" request. */
export interface FreeModelRequest<T = string> {
    /** The prompt content sent to the model. */
    userContent: string;
    /** Optional system instructions (inlined by providers that lack one). */
    systemPrompt?: string;
    /**
     * Identity for memoisation. Omit to disable caching for this request;
     * use a namespace prefix (`'cmd-purpose:'`) so `clearFreeModelCache(prefix)`
     * can drop just those entries.
     */
    cacheKey?: string;
    /**
     * Turns the raw answer into the value the caller wants. Return `null` to
     * reject an unusable answer (unparseable JSON, empty sentence, …).
     * Applied before caching.
     */
    transform?: (raw: string) => T | null;
    /**
     * When true, a `null` from `transform` is retried with the same backoff as
     * a rate-limited request (KB's "ask again if the answer did not parse").
     * Default: false — a rejected answer is final.
     */
    retryRejectedAnswers?: boolean;
    /** Per-request timeout. Default: {@link FREE_MODEL_DEFAULT_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Extra attempts after a rate-limited request. Default: {@link FREE_MODEL_MAX_RETRIES}. */
    maxRetries?: number;
    /** Backoff base. Default: {@link FREE_MODEL_BASE_DELAY_MS}. */
    baseDelayMs?: number;
}


// ── Cache ───────────────────────────────────────────────────────────────────

const _answers = new Map<string, unknown>();
const _inFlight = new Map<string, Promise<unknown>>();

/**
 * The already-derived answer for a cache key, if one is cached.
 * `undefined` means "not asked yet" — a cached `null` (no model answered) reads
 * as `undefined` so callers simply keep their fallback.
 */
export function peekFreeModelAnswer<T = string>(cacheKey: string): T | undefined {
    return (_answers.get(cacheKey) as T | null | undefined) ?? undefined;
}

/**
 * Whether this key's question is **settled** — a value or a cached `null`
 * ("no model answered"). An in-flight request does not count: callers use this
 * to decide between showing a loading placeholder and showing the final text.
 */
export function hasFreeModelAnswer(cacheKey: string): boolean {
    return _answers.has(cacheKey);
}

/**
 * Forget memoised answers. With a `prefix`, only keys starting with it are
 * dropped (cache keys are namespaced per feature, e.g. `'cmd-purpose:'`).
 */
export function clearFreeModelCache(prefix?: string): void {
    if (!prefix) {
        _answers.clear();
        _inFlight.clear();
        return;
    }
    for (const key of [..._answers.keys()]) {
        if (key.startsWith(prefix)) { _answers.delete(key); }
    }
    for (const key of [..._inFlight.keys()]) {
        if (key.startsWith(prefix)) { _inFlight.delete(key); }
    }
}

function remember(key: string, value: unknown): void {
    if (!_answers.has(key) && _answers.size >= FREE_MODEL_CACHE_LIMIT) {
        const oldest = _answers.keys().next().value;
        if (oldest !== undefined) { _answers.delete(oldest); }
    }
    _answers.set(key, value);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether a failure looks like provider throttling (worth retrying) rather
 * than a permanent error (bad request, unsupported model, …).
 */
export function isRateLimitedError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes('ChatRateLimited') || msg.includes('rate limit') || msg.includes('RateLimited');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load the provider chain on first use — never at activation, so no model is
 * touched until a feature actually needs an answer.
 */
async function loadCompletion(): Promise<FreeModelCompletion | undefined> {
    try {
        const mod = await import('./llmClient.js');
        return (systemPrompt, userContent, timeoutMs) =>
            mod.promptLlm(systemPrompt, userContent, { timeoutMs });
    } catch (err) {
        log.warn('LLM client unavailable: %s', err);
        return undefined;
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Ask the best available **free** model and map its answer.
 *
 * Resolves to the value produced by `request.transform` (or the raw text when
 * no transform is given), or `null` when:
 *   - no provider is available,
 *   - every attempt was rejected by `transform`,
 *   - the request failed for a non-retryable reason, or
 *   - `userContent` is blank (the model is not called at all).
 *
 * Never throws.
 */
export async function askFreeModel<T = string>(
    request: FreeModelRequest<T>,
    deps: FreeModelDeps = {},
): Promise<T | null> {
    if ((request.userContent ?? '').trim().length === 0) { return null; }

    const cacheKey = request.cacheKey;
    if (cacheKey) {
        if (_answers.has(cacheKey)) {
            return (_answers.get(cacheKey) as T | null | undefined) ?? null;
        }
        const running = _inFlight.get(cacheKey);
        if (running) { return running as Promise<T | null>; }
    }

    const task = run(request, deps);
    if (!cacheKey) { return task; }

    _inFlight.set(cacheKey, task);
    const answer = await task;
    _inFlight.delete(cacheKey);
    remember(cacheKey, answer);
    return answer;
}

/** One request including its retry loop. Callers go through `askFreeModel`. */
async function run<T>(
    request: FreeModelRequest<T>,
    deps: FreeModelDeps,
): Promise<T | null> {
    const complete = deps.complete ?? await loadCompletion();
    if (!complete) { return null; }

    const timeoutMs = request.timeoutMs ?? FREE_MODEL_DEFAULT_TIMEOUT_MS;
    const maxRetries = Math.max(0, request.maxRetries ?? FREE_MODEL_MAX_RETRIES);
    const baseDelayMs = request.baseDelayMs ?? FREE_MODEL_BASE_DELAY_MS;
    const sleep = deps.sleep ?? delay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const backoff = baseDelayMs * Math.pow(2, attempt - 1);
            log.debug('retrying free model request (%d/%d) after %dms', attempt, maxRetries, backoff);
            await sleep(backoff);
        }

        try {
            const raw = await complete(request.systemPrompt, request.userContent, timeoutMs);
            if (raw === null || raw === undefined) {
                // No provider answered — another attempt cannot change that.
                log.debug('no free model answered');
                return null;
            }

            const answer = request.transform
                ? request.transform(raw)
                : (raw as unknown as T);

            if (answer === null || answer === undefined) {
                if (request.retryRejectedAnswers && attempt < maxRetries) {
                    log.debug('answer rejected by transform, retrying');
                    continue;
                }
                return null;
            }
            return answer;
        } catch (err) {
            if (isRateLimitedError(err) && attempt < maxRetries) {
                log.debug('rate limited by the provider, retrying');
                continue;
            }
            log.warn('free model request failed: %s', err);
            return null;
        }
    }

    return null;
}
