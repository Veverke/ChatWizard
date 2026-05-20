// src/search/reranker.ts
// TF-IDF cross-reranker that re-ranks a list of candidate sessions
// by computing query-candidate overlap scores.
//
// This is a lightweight re-ranker that does NOT require an ONNX cross-encoder
// model. It provides a meaningful re-ranking signal for the majority of queries
// by scoring each candidate's text against the query tokens using TF-IDF-inspired
// term weighting.
//
// A full neural cross-encoder ONNX model can be dropped in by implementing
// the same `IReranker` interface and swapping the constructor argument in extension.ts.
//
// Feature 21: MCP Reranker

import { Session } from '../types/index';
import { tokenizeQuery } from './fullTextEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoredSession {
    id: string;
    /** Original rank (0-based, lower = higher original rank) */
    originalRank: number;
    /** Reranker relevance score (0–1) */
    score: number;
}

export interface IReranker {
    /**
     * Reranks candidate session IDs by relevance to the query.
     * @param query       User query string
     * @param candidates  Ordered list of (id, session) pairs in initial rank order
     * @returns           Re-ordered list of ScoredSession, most relevant first
     */
    rerank(query: string, candidates: Array<{ id: string; session: Session }>): ScoredSession[];

    /** Whether the reranker is ready to score (always true for TF-IDF). */
    isReady(): boolean;
}

// ─── TF-IDF Reranker ──────────────────────────────────────────────────────────

/**
 * TF-IDF cross-reranker.
 *
 * Scores each candidate by:
 *   1. Computing IDF-like weight for each query token across the candidate corpus.
 *   2. For each candidate, summing (TF × IDF) for all query tokens found in
 *      the candidate's content (title + first 2000 chars of assistant messages).
 *   3. Normalising to 0–1.
 *
 * This provides a meaningful improvement over pure semantic or keyword ordering
 * because it weights rare-but-discriminative tokens more heavily.
 */
export class TfIdfReranker implements IReranker {
    isReady(): boolean { return true; }

    rerank(
        query: string,
        candidates: Array<{ id: string; session: Session }>,
    ): ScoredSession[] {
        if (candidates.length === 0) { return []; }

        const queryTokens = tokenizeQuery(query);
        if (queryTokens.length === 0) {
            // No tokens to score — preserve original order with zero scores
            return candidates.map((c, i) => ({ id: c.id, originalRank: i, score: 0 }));
        }

        // Build candidate texts (title + first 2000 chars of assistant responses)
        const candidateTexts = candidates.map(({ session }) =>
            buildCandidateText(session),
        );

        // Compute IDF for each query token across the candidate set
        const n = candidates.length;
        const idf = new Map<string, number>();
        for (const token of queryTokens) {
            let df = 0; // document frequency
            for (const text of candidateTexts) {
                if (text.includes(token)) { df++; }
            }
            // IDF = log( (n + 1) / (df + 1) ) + 1  — smooth, avoids division by zero
            idf.set(token, Math.log((n + 1) / (df + 1)) + 1);
        }

        // Score each candidate
        const rawScores = candidateTexts.map((text, i) => {
            const words = text.split(/\s+/);
            const wordCount = Math.max(words.length, 1);
            const tokenCounts = new Map<string, number>();
            for (const w of words) {
                if (queryTokens.includes(w)) {
                    tokenCounts.set(w, (tokenCounts.get(w) ?? 0) + 1);
                }
            }
            let score = 0;
            for (const token of queryTokens) {
                const tf = (tokenCounts.get(token) ?? 0) / wordCount;
                score += tf * (idf.get(token) ?? 1);
            }
            return { id: candidates[i].id, originalRank: i, rawScore: score };
        });

        // Normalise scores to 0–1
        const maxScore = Math.max(...rawScores.map(s => s.rawScore), 1e-9);
        const scored: ScoredSession[] = rawScores.map(s => ({
            id: s.id,
            originalRank: s.originalRank,
            score: s.rawScore / maxScore,
        }));

        // Sort by score descending; break ties by original rank ascending
        scored.sort((a, b) =>
            b.score !== a.score ? b.score - a.score : a.originalRank - b.originalRank,
        );

        return scored;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a space-separated token string from session title + assistant message content. */
function buildCandidateText(session: Session): string {
    const parts: string[] = [session.title.toLowerCase()];
    let charBudget = 2000;
    for (const msg of session.messages) {
        if (msg.role !== 'assistant') { continue; }
        const snippet = msg.content.slice(0, charBudget).toLowerCase();
        parts.push(snippet);
        charBudget -= snippet.length;
        if (charBudget <= 0) { break; }
    }
    return parts.join(' ');
}
