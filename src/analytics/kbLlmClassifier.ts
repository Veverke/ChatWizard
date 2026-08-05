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
            if (model?.[0]) { return model[0]; }
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
        if (any?.[0]) { return any[0]; }
    } catch {
        // no model available at all
    }
    return undefined;
}

// ── Prompt building ─────────────────────────────────────────────────────────

export function buildClassificationPrompt(session: Session): string {
    const conversation = session.messages
        .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
        .join('\n\n');

    return [
        `Session title: ${session.title}`,
        '',
        conversation,
    ].join('\n');
}

export function buildSystemPrompt(): string {
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
    /^##+\s/,       // markdown heading
    /^\*\*/,       // bold markdown
    /^yes\s/i,      // conversational response
    /^no\s/i,       // conversational response
    /^sorry/i,      // refusal
    /^i can'?t/i,   // refusal
];

export function parseClassification(raw: string): string | null {
    const cleaned = raw.trim();

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
    try {
        const model = await selectCopilotModel();
        if (!model) {
            log.warn(`No model available for ${session.id} — falling back to heuristic`);
            return null;
        }

        const content = buildClassificationPrompt(session);
        const messages = [vscode.LanguageModelChatMessage.User(content)];
        const response = await model.sendRequest(messages, {
            systemPrompt: buildSystemPrompt(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }

        const parsed = parseClassification(raw);
        if (parsed === null) {
            log.warn(`LLM returned unparseable output for ${session.id}: "${raw.slice(0, 100)}" — falling back to heuristic`);
        } else {
            log.info(`Classified ${session.id} as "${parsed}"`);
        }
        return parsed;
    } catch (err) {
        log.warn(`LLM request failed for ${session.id}: ${err} — falling back to heuristic`);
        return null;
    }
}