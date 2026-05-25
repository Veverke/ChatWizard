// src/analytics/promptConsolidator.ts
//
// Heuristic prompt consolidator (zero-LLM, zero network).
//
// Given a list of user messages from a multi-turn session, strips conversational
// filler, deduplicates near-identical intents, and produces a single numbered
// list prompt that captures all unique intents.
//
// Used as:
//   - the primary consolidation path when promptConsolidatorLlm returns null
//   - the fallback when the VS Code LM API is unavailable
//
// No VS Code dependency — fully unit-testable.

import { countTokens } from '../utils/tokenizer';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidationResult {
    consolidatedPrompt: string;
    consolidatedTokenCount: number;
    /** Number of unique intents retained after deduplication */
    intentCount: number;
}

// ── Filler stripping ─────────────────────────────────────────────────────────

/**
 * Patterns stripped from the START of a message.
 * Applied repeatedly until no more matches.
 */
export const FILLER_START_PATTERNS: RegExp[] = [
    /^(?:hey|hi|hello)[,.\s]+/i,
    /^(?:can you|could you|would you mind|please|kindly)\s+/i,
    /^also[,\s]+/i,
    /^follow(?:\s+up)?[:\s]+/i,
    /^one more(?: thing)?[:\s]+/i,
    /^quick(?:ly)?(?:\s+question)?[:\s]+/i,
    /^sorry(?: to bother you)?[,.\s]+/i,
    /^just (?:wondering|a (?:quick )?(?:follow[- ]?up|question))[,.\s]+/i,
    /^(?:by the way|btw)[,.\s]+/i,
    /^going back to\s+/i,
];

/**
 * Patterns stripped from the END of a message.
 * Applied repeatedly until no more matches.
 */
export const FILLER_END_PATTERNS: RegExp[] = [
    /[,.\s]*(?:thank you|thanks|cheers|appreciate it|much appreciated)[.!]*\s*$/i,
    /[,.\s]*please[.!]*\s*$/i,
];

function stripFiller(text: string): string {
    let result = text.trim();
    let changed = true;
    while (changed) {
        changed = false;
        for (const re of [...FILLER_START_PATTERNS, ...FILLER_END_PATTERNS]) {
            const prev = result;
            result = result.replace(re, '').trim();
            if (result !== prev) { changed = true; }
        }
    }
    // Never return an empty string — fall back to original if stripping empties it
    return result || text.trim();
}

// ── Jaccard deduplication ────────────────────────────────────────────────────

function wordSet(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .split(/\W+/)
            .filter(w => w.length > 2)
    );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) { return 1; }
    if (a.size === 0 || b.size === 0) { return 0; }
    let intersection = 0;
    for (const w of a) { if (b.has(w)) { intersection++; } }
    return intersection / (a.size + b.size - intersection);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Consolidates multiple user messages into a single prompt.
 *
 * Returns null when:
 *   - fewer than 2 messages are provided, OR
 *   - all messages are near-duplicates of each other (only one unique intent remains)
 */
export function consolidate(userMessages: string[]): ConsolidationResult | null {
    if (userMessages.length < 2) { return null; }

    const stripped = userMessages
        .map(m => stripFiller(m))
        .filter(s => s.length > 0);

    if (stripped.length < 2) { return null; }

    // Deduplicate: keep a message only if it is not a near-duplicate of an already-kept message
    const uniqueIntents: string[] = [];
    for (const intent of stripped) {
        const ws = wordSet(intent);
        const isDuplicate = uniqueIntents.some(
            existing => jaccardSimilarity(wordSet(existing), ws) > 0.75,
        );
        if (!isDuplicate) { uniqueIntents.push(intent); }
    }

    if (uniqueIntents.length < 2) { return null; }

    const header = 'Please accomplish all of the following:';
    const items = uniqueIntents.map((intent, i) => `${i + 1}. ${intent}`).join('\n');
    const consolidatedPrompt = `${header}\n${items}`;

    return {
        consolidatedPrompt,
        consolidatedTokenCount: countTokens(consolidatedPrompt),
        intentCount: uniqueIntents.length,
    };
}
