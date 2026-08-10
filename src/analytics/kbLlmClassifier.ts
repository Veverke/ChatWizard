// src/analytics/kbLlmClassifier.ts
// Feature 23 — LLM-based KB entry classification.
// Uses the central llmClient (VS Code LM API → Cursor CLI) to freely generate
// category labels from session content. Falls back gracefully when unavailable.

import type { Session } from '../types/index';
import type { KbEntry } from '../types/kb';
import { createLogger } from '../utils/logger';
import { promptLlm } from './llmClient';

const log = createLogger().withContext('KB-LLM');

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
 *
 * The prompt asks for both the TOP-LEVEL folder (general topic) and the
 * SECOND-LEVEL folder (particular subject) in a single pass. The LLM
 * returns both at once since it already reads the full conversation.
 *
 * Response format: "TopLevel|SecondLevel" on a single line.
 */
export function buildClassificationPrompt(session: Session): string {
    const intro = [
        'You are a session categorizer for a software developer\'s chat history.',
        'Read the conversation below and classify it into a 2-level folder structure.',
        '',
        'I use a 2-level folder structure:',
        '  - Top-level folders capture the general topic (e.g. "Git", "Bugs", "Testing").',
        '  - Second-level folders capture the particular subject within that topic',
        '    (e.g. "Branch Management" under "Git", "UI Crash" under "Bugs").',
        '',
        'Since all chats are about software development, think in terms of both:',
        '  - **Technology/tool** categories: "Git", "Docker", "React", "Python", "Vs Code", "CSS", "API", "Database", "Deployment"',
        '  - **Activity/concept** categories: "Bugs" (problems, fixes, errors), "Testing" (test setup, fixes, additions),',
        '    "Architecture" (plans, design decisions, brainstorming), "Refactoring" (code restructuring, cleanup),',
        '    "Features" (planned features, intents, new capabilities), "Best Practices" (recommendations, patterns, conventions)',
        '',
        'Examples:',
        '- Git branch management → "Git|Branch Management"',
        '- Fixing a UI crash → "Bugs|UI Crash"',
        '- Test fixture setup → "Testing|Fixture Setup"',
        '- Restructuring a module → "Refactoring|Module Restructure"',
        '- Planning a new MCP server → "Features|MCP Server"',
        '- Coding conventions discussion → "Best Practices|Coding Conventions"',
        '- Database schema design → "Architecture|Schema Design"',
        '- Docker container config → "Docker|Container Config"',
        '- Deployment pipeline → "Deployment|Pipeline Setup"',
        '- Python debugging session → "Python|Debugging"',
        '',
        'Rules:',
        '- Return ONLY one line — no commentary, no markdown, no punctuation.',
        '- Format: TopLevel|SecondLevel (separated by a pipe character).',
        '- Use 1-2 words for TopLevel, 1-3 words for SecondLevel, Title Case.',
        '- Keep TopLevel BROAD — it should group multiple related chats together.',
        '- Make SecondLevel SPECIFIC — it distinguishes this chat from others in the same folder.',
        '- Use "Other" as TopLevel ONLY if the session truly does not fit any recognizable',
        '  software development topic.',
        '- Do NOT default to "Other" for sessions about bugs, testing, architecture,',
        '  refactoring, features, or best practices — those are valid top-level categories.',
        '- If unsure about the second level, return just "TopLevel" without a pipe.',
        '',
        '=== CONVERSATION ===',
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
        'You are a session categorizer for a software developer\'s chat history.',
        'Read the conversation and identify the broad subject area it deals with.',
        '',
        'I use a 2-level folder structure:',
        '  - Top-level folders capture the general topic (e.g. "Git", "Bugs", "Testing").',
        '  - Second-level folders capture the particular subject within that topic.',
        '',
        'Your task: give me the TOP-LEVEL folder name for this chat.',
        '',
        'Since all chats are about software development, think in terms of both:',
        '  - Technology/tool categories: "Git", "Docker", "React", "Python", "Vs Code", "CSS", "API", "Database", "Deployment"',
        '  - Activity/concept categories: "Bugs", "Testing", "Architecture", "Refactoring", "Features", "Best Practices"',
        '',
        'Rules:',
        '- Return ONLY the folder name — no commentary, no markdown, no punctuation.',
        '- Use 1-2 words, Title Case.',
        '- Keep it BROAD — it should group multiple related chats together.',
        '- Use "Other" ONLY if the session truly does not fit any recognizable software development topic.',
        '- Do NOT default to "Other" for sessions about bugs, testing, architecture, refactoring,',
        '  features, or best practices — those are valid top-level categories.',
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

export function parseClassification(raw: string): { folder: string; subtype: string | null } | null {
    let cleaned = raw.trim();

    // Strip markdown code fences
    const FENCE_PATTERN = /^```(?:\w+)?\n?([\s\S]*?)\n?```$/;
    const fenceMatch = cleaned.match(FENCE_PATTERN);
    if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
    } else if (/^```(?:\w+)?/.test(cleaned)) {
        cleaned = cleaned.replace(/^```(?:\w+)?\n?/, '').replace(/```$/, '').trim();
    }

    // Take the first line
    const firstLine = cleaned.split('\n')[0].trim();

    // Empty or explicit no-topic markers
    if (!firstLine || firstLine === '(none)' || firstLine === 'Other' || firstLine === 'other') {
        return null;
    }

    // Try pipe-delimited format: "TopLevel|SecondLevel"
    const pipeIndex = firstLine.indexOf('|');
    if (pipeIndex > 0) {
        const topLevel = firstLine.slice(0, pipeIndex).trim();
        const secondLevel = firstLine.slice(pipeIndex + 1).trim();
        if (topLevel && topLevel !== 'Other' && topLevel !== 'other' && topLevel !== '(none)') {
            return {
                folder: topLevel,
                subtype: secondLevel && secondLevel !== 'General' ? secondLevel : null,
            };
        }
        return null;
    }

    // No pipe — treat entire response as top-level folder (backward compat)
    if (!cleaned || cleaned === '(none)' || cleaned === 'Other' || cleaned === 'other') {
        return null;
    }

    const wordCount = firstLine.split(/\s+/).length;
    if (wordCount > 3) {
        return null;
    }

    for (const pattern of REJECT_PATTERNS) {
        if (pattern.test(firstLine)) {
            return null;
        }
    }

    return { folder: firstLine, subtype: null };
}

// ── Category refinement (2nd pass) ────────────────────────────────────────

/**
 * Build the prompt for refining and deduplicating the raw 1st-pass category labels.
 * The LLM sees all labels at once and merges variants (e.g. "Git Pull" + "Git Push" → "Git"),
 * subsumptions (e.g. "Error Handling" ⊂ "Debugging"), and exact duplicates.
 */
export function buildRefinePrompt(labels: string[]): string {
    return [
        'You are a category refinement expert. Below is the complete list of category',
        'labels assigned to individual chat sessions. Your job is to merge/refine them',
        'so that:',
        '',
        '- **Variants** of the same topic are merged (e.g. "Git Pull" and "Git Push" → "Git")',
        '- **Sub-categories** that belong under a broader category are merged upward',
        '  (e.g. "Error Handling" under "Debugging")',
        '- **Typos / near-duplicates** are collapsed into one canonical label',
        '- Labels that are **already unique and self-consistent** are kept as-is',
        '',
        'Rules:',
        '- Return ONLY a JSON object — no commentary, no markdown fences.',
        '- The output is a mapping: each **input label** → **refined label**.',
        '- Every input label must appear as a key in the output.',
        '- If a label is already fine as-is, map it to itself.',
        '- Refined labels should be Title Case, 1-3 words, broad enough to cover variants.',
        '- Do NOT create more than 20 distinct refined labels.',
        '- If unsure, keep labels as-is rather than over-merging.',
        '',
        'Example:',
        'Input: ["Git Pull", "Git Push", "Error Handling", "Debugging Strategy", "Docker", "Docker Compose"]',
        'Output: {"Git Pull":"Git","Git Push":"Git","Error Handling":"Debugging","Debugging Strategy":"Debugging","Docker":"Docker","Docker Compose":"Docker"}',
        '',
        '=== LABELS TO REFINE ===',
        labels.map(l => `- "${l}"`).join('\n'),
    ].join('\n');
}

/**
 * Parse the JSON response from the refinement pass.
 * Returns a Map<inputLabel, refinedLabel> or null on failure.
 */
export function parseRefineResponse(raw: string): Map<string, string> | null {
    const cleaned = raw.trim();
    const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
    const fenceMatch = cleaned.match(FENCE_PATTERN);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : cleaned;

    // Reject if the output is too large (>50 entries) — likely an LLM artifact
    try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed !== 'object' || parsed === null) { return null; }

        const keys = Object.keys(parsed);
        if (keys.length > 50) { return null; }

        const result = new Map<string, string>();
        for (const [input, refined] of Object.entries(parsed)) {
            if (typeof refined === 'string' && refined.trim()) {
                result.set(input, refined.trim());
            }
        }
        return result.size > 0 ? result : null;
    } catch {
        return null;
    }
}

/**
 * Refine raw 1st-pass category labels by asking the LLM to merge similar labels,
 * collapse variants, and subsume narrow categories into broader ones.
 *
 * This is the **2nd pass** of the 3-pass pipeline:
 *   1. classifySessionWithLlm — per-session free-form label
 *   2. refineCategories — merge/deduplicate across all labels
 *   3. refineSubtypes — consolidate subtypes per parent category
 *
 * Returns a Map<originalLabel, refinedLabel> or `null` on failure.
 */
export async function refineCategories(
    labels: string[],
): Promise<Map<string, string> | null> {
    if (labels.length < 2) { return null; }

    const unique = [...new Set(labels)];
    if (unique.length < 2) { return null; }

    const content = buildRefinePrompt(unique);

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        if (attempt > 0) {
            const backoff = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            await delay(backoff);
        }

        try {
            const raw = await promptLlm(undefined, content, { timeoutMs: 30_000 });
            if (raw === null) { return null; }

            const parsed = parseRefineResponse(raw);
            if (parsed && parsed.size > 0) {
                log.info(`Refined ${unique.length} unique labels → ${new Set(parsed.values()).size} canonical labels`);
                return parsed;
            }

            log.debug(`Refine response unparseable, attempt ${attempt + 1}`);
        } catch (err) {
            if (isRateLimitedError(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
                continue;
            }
            log.warn(`Category refinement failed: ${err}`);
            return null;
        }
    }

    return null;
}

// ── Subtype refinement (3rd pass) ─────────────────────────────────────────

/**
 * Build the prompt for refining second-level (subtype) labels within a parent category.
 * Shows all entries under one parent with their titles, summaries, and current subtypes,
 * asking the LLM to consolidate into broader, reusable labels.
 */
export function buildSubtypeRefinePrompt(
    parentType: string,
    childEntries: { title: string; summary: string; subtype?: string | null | undefined }[],
): string {
    const entryBlock = childEntries.map((e, i) =>
        [
            `Entry ${i + 1}:`,
            `  Title:   ${e.title}`,
            `  Summary: ${e.summary.slice(0, 300)}`,
            `  Current: ${e.subtype ?? '(none)'}`,
        ].join('\n'),
    ).join('\n\n');

    return [
        'You are a label consolidator. Below are entries under the parent category',
        `"${parentType}". Each entry has a title, summary, and current second-level label.`,
        'Your job is to consolidate these fine-grained second-level labels into broader,',
        'reusable labels that can group multiple entries together.',
        '',
        'Rules:',
        '- Return ONLY a JSON object — no commentary, no markdown fences.',
        '- Each key is a CURRENT second-level label (exactly as shown).',
        '- Each value is the CONSOLIDATED label you want to map it to.',
        '- Merge similar labels under the same consolidated name.',
        '- Use Title Case for consolidated labels, 1-3 words.',
        '- If a label is already good, map it to itself.',
        '- Use "General" for entries that lack a specific second-level focus.',
        '',
        'Example:',
        'Input entries with labels: ["Git Pull", "Git Push", "Error Handling", "Debugging Strategy", "Docker", "Docker Compose"]',
        'Output: {"Git Pull":"Git","Git Push":"Git","Error Handling":"Debugging","Debugging Strategy":"Debugging","Docker":"Docker","Docker Compose":"Docker"}',
        '',
        '=== ENTRIES UNDER "' + parentType + '" ===',
        entryBlock,
    ].join('\n');
}

/**
 * Parse the JSON response from the subtype refinement pass.
 * Returns a Map<currentSubtypeOrNull, refinedSubtype> or null on failure.
 */
export function parseSubtypeRefineResponse(raw: string): Map<string, string> | null {
    const cleaned = raw.trim();
    const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
    const fenceMatch = cleaned.match(FENCE_PATTERN);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : cleaned;

    try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed !== 'object' || parsed === null) { return null; }

        const result = new Map<string, string>();
        for (const [current, refined] of Object.entries(parsed)) {
            if (typeof refined === 'string' && refined.trim()) {
                result.set(current, refined.trim());
            }
        }
        return result.size > 0 ? result : null;
    } catch {
        return null;
    }
}

/**
 * Refine second-level (subtype) labels across all entries.
 *
 * For each parent category, asks the LLM to consolidate fine-grained per-session
 * subtypes into broader reusable labels — the true 3rd pass of the pipeline:
 *   1. classifySessionWithLlm — per-session free-form label + subtype
 *   2. refineCategories — merge/deduplicate top-level labels
 *   3. refineSubtypes — consolidate subtypes per parent category
 *
 * Returns a Map<currentSubtypeOrNull, refinedSubtype> or `null` on failure.
 */
export async function refineSubtypes(
    entries: KbEntry[],
): Promise<Map<string, string> | null> {
    // Group entries by parent type
    const byParent = new Map<string, KbEntry[]>();
    for (const entry of entries) {
        const arr = byParent.get(entry.type);
        if (arr) { arr.push(entry); } else { byParent.set(entry.type, [entry]); }
    }

    const allMappings = new Map<string, string>();

    for (const [parentType, parentEntries] of byParent) {
        // Skip parents with too few entries — no consolidation needed
        if (parentEntries.length < 2) { continue; }

        const content = buildSubtypeRefinePrompt(parentType, parentEntries);

        let success = false;
        for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
            if (attempt > 0) {
                const backoff = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await delay(backoff);
            }

            try {
                const raw = await promptLlm(undefined, content, { timeoutMs: 30_000 });
                if (raw === null) { break; }

                const parsed = parseSubtypeRefineResponse(raw);
                if (parsed && parsed.size > 0) {
                    // Merge per-parent mappings into the global map
                    for (const [current, refined] of parsed) {
                        allMappings.set(current, refined);
                    }
                    log.info(
                        `Refined ${parentEntries.length} subtypes under "${parentType}" → ` +
                        `${new Set(parsed.values()).size} distinct labels`,
                    );
                    success = true;
                    break;
                }

                log.debug(`Subtype refine unparseable for "${parentType}", attempt ${attempt + 1}`);
            } catch (err) {
                if (isRateLimitedError(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
                    continue;
                }
                log.warn(`Subtype refinement failed for "${parentType}": ${err}`);
                break;
            }
        }

        if (!success) {
            log.debug(`Skipped subtype refinement for "${parentType}" — LLM unavailable`);
        }
    }

    return allMappings.size > 0 ? allMappings : null;
}

// ── Shared utilities for LLM retry logic ──────────────────────────────────

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
 * Classify a session into a 2-level folder structure using the Copilot LM API.
 *
 * The LLM generates both the TOP-LEVEL folder (general topic) and the
 * SECOND-LEVEL folder (particular subject) from the conversation content.
 *
 * Returns `{ folder, subtype }` on success, or `null` if no provider is available
 * or the response could not be parsed.
 */
export async function classifySessionWithLlm(
    session: Session,
): Promise<{ folder: string; subtype: string | null } | null> {
    const content = buildClassificationPrompt(session);

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        if (attempt > 0) {
            const backoff = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            log.debug(`Rate limit retry ${attempt}/${MAX_RATE_LIMIT_RETRIES} for ${session.id} — waiting ${backoff}ms`);
            await delay(backoff);
        }

        try {
            const raw = await promptLlm(undefined, content, { timeoutMs: 30_000 });

            if (raw === null) {
                log.debug(`No response from any LLM provider for ${session.id} — falling back to embedding`);
                return null;
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
                    log.debug(`LLM returned expected refusal/empty for ${session.id} — falling back to embedding`);
                } else {
                    log.warn(`LLM returned unparseable output for ${session.id}: "${raw.slice(0, 100)}" — falling back to embedding`);
                }
            } else {
                log.info(`Classified ${session.id} as "${parsed.folder}|${parsed.subtype}"`);
            }
            return parsed;
        } catch (err) {
            if (isRateLimitedError(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
                continue;
            }

            log.warn(`LLM request failed for ${session.id}: ${err} — falling back to embedding`);
            return null;
        }
    }

    return null;
}