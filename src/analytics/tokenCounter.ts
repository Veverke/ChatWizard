// src/analytics/tokenCounter.ts
import { SessionSource } from '../types/index';

/**
 * Estimate the token count of a piece of text.
 *
 * Approximation strategy:
 *  - Claude (Anthropic): ~4 characters per token  → Math.ceil(text.length / 4)
 *  - Copilot/GPT:        ~1.3 tokens per word      → Math.ceil(wordCount * 1.3)
 *
 * Neither formula is exact; both are well-known approximations used in practice.
 */
export function countTokens(text: string, source: SessionSource): number {
    if (!text) { return 0; }
    if (source === 'claude') {
        return Math.ceil(text.length / 4);
    }
    // copilot / GPT-family: word-based approximation
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    return Math.ceil(wordCount * 1.3);
}
