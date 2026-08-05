// src/analytics/kbLlmClassifier.ts
// Feature 23 — LLM-based KB entry classification.
// Uses the VS Code Copilot Language Model API to freely generate category labels
// from session content. No predefined categories — they emerge from the data.
// Falls back gracefully when the LM API is unavailable.

import * as vscode from 'vscode';
import type { Session } from '../types/index';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB-LLM');

// ── Model selection ──────────────────────────────────────────────────────────

/**
 * Pool of free models to try, in priority order.
 * The classifier walks this chain and uses the first model that is available.
 * Each entry is passed as a filter to `vscode.lm.selectChatModels`, so
 * `family` matches the Copilot model family (e.g. "o4-mini", "gpt-4o-mini").
 */
const FREE_MODEL_CHAIN = [
    { family: 'o4-mini' },
    { family: 'gpt-4o-mini' },
    { family: 'gpt-4.1-mini' },
    { family: 'gpt-4o' },
    { family: 'gpt-4.1' },
    { family: 'gpt-3.5-turbo' },
];

async function selectCopilotModel(): Promise<vscode.LanguageModelChat | undefined> {
    // Try the explicit free-model chain first…
    for (const filter of FREE_MODEL_CHAIN) {
        try {
            const model = await Promise.race([
                vscode.lm.selectChatModels({ vendor: 'copilot', ...filter }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), 3000),
                ),
            ]);
            if (model?.[0]) {
                log.debug(`Selected model: ${model[0].name || model[0].family || filter.family}`);
                return model[0];
            }
        } catch {
            // try next
        }
    }
    // …then fall back to any Copilot model at all (user's default selection).
    try {
        const any = await Promise.race([
            vscode.lm.selectChatModels({ vendor: 'copilot' }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 3000),
            ),
        ]);
        if (any?.[0]) {
            log.debug(`Selected fallback model: ${any[0].name || any[0].family || 'unknown'}`);
            return any[0];
        }
    } catch {
        // no model available at all
    }
    return undefined;
}

// ── Prompt building ─────────────────────────────────────────────────────────

/**
 * Maximum characters for the conversation portion of the classification prompt.
 * ~6000 token budget (1 token ≈ 4 chars for English), safe for all Copilot models.
 * Older messages are dropped first when the limit is exceeded.
 */
const MAX_CONVERSATION_CHARS = 24_000;

/**
 * Build the full user message for the classification request.
 *
 * Instructions are embedded INLINE (not as systemPrompt) because not all
 * Copilot LM models consistently honor the `systemPrompt` request option.
 * Embedding them in the user message guarantees the model sees them.
 */
export function buildClassificationPrompt(session: Session): string {
    const intro = [
        'You are a session categorizer. Read the conversation below and derive the main',
        'topic or subject it deals with. Render it as up to 3 keywords.',
        '',
        'Examples:',
        '- Chat discussing adopting a different approach to solve a problem → "Logic Change"',
        '- Chat about fixing bugs → "Bug Fixes"',
        '- Chat about discussing or exploring new features → "New Features"',
        '- Chat about database schema design decisions → "Schema Design"',
        '- Chat about troubleshooting a deployment issue → "Deployment Debug"',
        '- Chat about code review feedback → "Code Review"',
        '',
        'Rules:',
        '- Return ONLY the category label — no commentary, no markdown, no punctuation.',
        '- Respond with exactly 1-3 words.',
        '- Use Title Case.',
        '- If the session has no clear topic, respond with "Other".',
        '',
        '=== CONVERSATION TO CLASSIFY ===',
        `Session title: ${session.title}`,
        '',
    ].join('\n');

    // Build conversation messages newest-first, stop when we exceed the budget.
    let conversation = '';
    const reversed = [...session.messages].reverse();

    for (const msg of reversed) {
        const block = `[${msg.role.toUpperCase()}]\n${msg.content}\n\n`;
        if (conversation.length + block.length > MAX_CONVERSATION_CHARS) {
            const remaining = MAX_CONVERSATION_CHARS - conversation.length;
            if (remaining > 50) {
                conversation =
                    `[${msg.role.toUpperCase()}]\n${msg.content.slice(0, remaining - 12)}...[truncated]\n\n` +
                    conversation;
            }
            break;
        }
        conversation = block + conversation;
    }

    return intro + conversation;
}

export function buildSystemPrompt(): string {
    // Kept for backwards compatibility with tests, but no longer used in the API call.
    return [
        'You are a session categorizer. Read the conversation and derive the main',
        'topic or subject it deals with. Render it as up to 3 keywords.',
        '',
        'Examples:',
        '- Chat discussing adopting a different approach to solve a problem → "Logic Change"',
        '- Chat about fixing bugs → "Bug Fixes"',
        '- Chat about discussing or exploring new features → "New Features"',
        '- Chat about database schema design decisions → "Schema Design"',
        '- Chat about troubleshooting a deployment issue → "Deployment Debug"',
        '- Chat about code review feedback → "Code Review"',
        '',
        'Rules:',
        '- Return ONLY the category label — no commentary, no markdown, no punctuation.',
        '- Respond with exactly 1-3 words.',
        '- Use Title Case.',
        '- If the session has no clear topic, respond with "Other".',
    ].join('\n');
}

// ── Response parsing ────────────────────────────────────────────────────────

/** Minimum sanity checks for LLM output — prompt handles the rest. */
const REJECT_PATTERNS = [
    /^```/,         // code fence
    /^#\s/,         // single # heading (e.g. "# Summary of Updates", "# Changelog")
    /^##+\s/,       // markdown heading (## or more)
    /^\*\*/,       // bold markdown
    /^\* /,        // unordered list item
    /^\- /,        // unordered list item
    /^`/,           // backtick-wrapped text
    /^\/\//,        // code comment (// ...)
    /^\[/m,         // markdown link, image, or task marker ([X], [![...)
    /^\d+[.\)]\s/, // numbered list (1. or 1))
    /^\p{So}/u, // emoji/symbol prefix (e.g. "✅ COMPLETED") — Unicode "Symbol, other"
    /^graph\s+\w+[:;{]/i, // Mermaid diagram syntax (e.g. "graph TD;")
    /^sequenceDiagram/i,   // Mermaid sequence diagram keyword
    /^(let|const|var)\s/,  // JS/TS variable declaration (e.g. "let showTimer = null;")
    /^function\s/,         // JS/TS function declaration
    /^if\s*\(/,            // JS/TS if statement
    /^yes\s/i,      // conversational response
    /^no\s/i,       // conversational response
    /^sorry/i,      // refusal
    /^i can'?t/i,   // refusal
];

export function parseClassification(raw: string): string | null {
    let cleaned = raw.trim();

    // Strip markdown code fences (```language\n...\n```) before parsing —
    // the LLM occasionally wraps output in fences despite the system prompt.
    // Handle both closed fences (```...```) and unclosed fences (```... without closing).
    const FENCE_PATTERN = /^```(?:\w+)?\n?([\s\S]*?)\n?```$/;
    const fenceMatch = cleaned.match(FENCE_PATTERN);
    if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
    } else if (/^```(?:\w+)?/.test(cleaned)) {
        // Unclosed fence — strip the opening fence line and take everything after it
        cleaned = cleaned.replace(/^```(?:\w+)?\n?/, '').trim();
    }

    // Empty or explicit no-topic markers
    if (!cleaned || cleaned === '(none)' || cleaned === 'Other' || cleaned === 'other') {
        return null;
    }

    // Take the first line only
    const firstLine = cleaned.split('\n')[0].trim();
    if (!firstLine || firstLine === '(none)' || firstLine === 'Other' || firstLine === 'other') {
        return null;
    }

    // Reject if too long (more than 5 words = sentence, not a category)
    const wordCount = firstLine.split(/\s+/).length;
    if (wordCount > 5) {
        return null;
    }

    // Light reject patterns for obvious artifacts
    for (const pattern of REJECT_PATTERNS) {
        if (pattern.test(firstLine)) {
            return null;
        }
    }

    return firstLine;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Maximum number of retries for rate-limited requests.
 */
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Base delay (ms) for exponential backoff on rate-limited requests.
 */
const RATE_LIMIT_BASE_DELAY_MS = 2_000;

function isRateLimitedError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes('ChatRateLimited') || msg.includes('rate limit') || msg.includes('RateLimited');
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Classify a session into a free-form category label using the VS Code LM API.
 *
 * The LLM generates a short category label (1-3 words) based on the conversation
 * content. There are no predefined categories — they emerge from the data.
 *
 * Returns the category label on success, or `null` if the LM API is unavailable
 * or the response could not be parsed.
 */
export async function classifySessionWithLlm(
    session: Session,
): Promise<string | null> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        if (attempt > 0) {
            const backoff = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            log.debug(`Rate limit retry ${attempt}/${MAX_RATE_LIMIT_RETRIES} for ${session.id} — waiting ${backoff}ms`);
            await delay(backoff);
        }

        try {
            const model = await selectCopilotModel();
            if (!model) {
                log.warn(`No model available for ${session.id} — falling back to heuristic`);
                return null;
            }

            const content = buildClassificationPrompt(session);
            const messages = [vscode.LanguageModelChatMessage.User(content)];
            const response = await model.sendRequest(messages);

            let raw = '';
            for await (const chunk of response.text) {
                raw += chunk;
            }

            const parsed = parseClassification(raw);
            if (parsed === null) {
                // Distinguish expected refusals/empty responses from genuine misbehavior
                const trimmed = raw.trim().toLowerCase();
                const isExpectedRefusal =
                    !trimmed ||
                    trimmed === '(none)' ||
                    trimmed === 'other' ||
                    /^sorry/i.test(trimmed) ||
                    /^i can'?t/i.test(trimmed);
                if (isExpectedRefusal) {
                    log.debug(`LLM returned expected refusal/empty for ${session.id} — falling back to heuristic`);
                } else {
                    log.warn(`LLM returned unparseable output for ${session.id}: "${raw.slice(0, 100)}" — falling back to heuristic`);
                }
            } else {
                log.info(`Classified ${session.id} as "${parsed}"`);
            }
            return parsed;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (isRateLimitedError(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
                // Retry with backoff
                continue;
            }

            // Non-retryable or exhausted retries
            log.warn(`LLM request failed for ${session.id}: ${err} — falling back to heuristic`);
            return null;
        }
    }

    return null;
}