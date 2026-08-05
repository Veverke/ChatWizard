// src/analytics/kbClassifier.ts
// Feature 23 — KB Entry Classification
// Supports both heuristic (default types) and LLM-based (custom categories) classification.

import type { Session } from '../types/index';
import type { KbEntryType } from '../types/kb';
import { classifySessionWithLlm } from './kbLlmClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB');

/**
 * Heuristic signal phrases for each KB entry type.
 * Rules are evaluated in order; first match wins.
 * Fallthrough: any session not matching the above rules is classified as 'learning'.
 */
const CLASSIFICATION_RULES: Array<{ type: KbEntryType; phrases: string[] }> = [
    {
        type: 'decision',
        phrases: [
            'i decided', 'we chose', 'we went with', 'the reason we',
            'trade-off', 'tradeoff', 'alternative', 'chose to', 'we decided',
        ],
    },
    {
        type: 'gotcha',
        phrases: [
            'gotcha', 'footgun', 'be careful', 'watch out',
            "don't forget", 'turns out', 'fixed by', 'tricky',
            'common mistake', 'easy to miss',
        ],
    },
    {
        type: 'architecture',
        phrases: [
            'architecture', 'component', 'service', 'layer', 'schema',
            'system design', 'dependency graph', 'microservice', 'monolith',
            'api design', 'data model',
        ],
    },
    {
        type: 'pattern',
        phrases: [
            'pattern', 'template', 'reusable', 'abstraction', 'convention',
            'strategy', 'best practice', 'idiom', 'recipe',
        ],
    },
    // 'learning' is the fallthrough — no explicit phrases needed
];

/**
 * Classify a session into one of five KB entry types using heuristic phrase matching.
 *
 * Applies rules in order against the concatenated text of the first 10 messages
 * (lowercased). Returns the type of the first matching rule, or 'learning' if no
 * rule matches.
 */
export function classifySession(session: Session): KbEntryType {
    // Take only the first 10 messages for classification
    const firstTenMessages = session.messages.slice(0, 10);
    const combinedText = firstTenMessages
        .map(m => m.content)
        .join(' ')
        .toLowerCase();

    for (const rule of CLASSIFICATION_RULES) {
        for (const phrase of rule.phrases) {
            if (combinedText.includes(phrase)) {
                return rule.type;
            }
        }
    }

    // Fallthrough: any session not matching the above is a 'learning'
    return 'learning';
}

/**
 * Classify a session using the given categories.
 *
 * Tries the free AI model (Copilot LM API) first — the LLM generates a
 * free-form category label from the conversation content with no predefined
 * buckets. Falls back to heuristic phrase-matching (hardcoded types) only
 * when the model is unavailable.
 *
 * @returns The best-matching category name — either an LLM-invented label
 *          or a hardcoded type from the heuristic fallback.
 */
export async function classifySessionWithCategories(
    session: Session,
    categories: string[],
): Promise<KbEntryType> {
    // Try LLM first — no predefined categories, it invents a label freely
    const llmResult = await classifySessionWithLlm(session);
    if (llmResult) {
        // Normalise: if the LLM label looks like one of the known heuristic
        // types, map it for consistency (e.g. "debugging" stays as is,
        // but "architecture" maps to itself).
        return llmResult;
    }

    // LLM unavailable — fall back to heuristic
    log.debug(`LLM returned null for session ${session.id} — using heuristic fallback`);
    const heuristic = classifySession(session);
    if (categories.includes(heuristic)) {
        return heuristic;
    }

    // If even the heuristic result isn't in the requested categories,
    // return the first category as a safe default
    return categories[0] ?? 'learning';
}