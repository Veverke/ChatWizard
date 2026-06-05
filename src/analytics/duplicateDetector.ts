// src/analytics/duplicateDetector.ts
// Feature 33 — Duplicate Session Detection

import type { Session } from '../types/index';

export interface DuplicateGroup {
    /** The canonical session (first seen, used as the representative) */
    canonical: Session;
    /** Duplicate sessions that are considered identical or near-identical to canonical */
    duplicates: Session[];
    /** Reason for flagging as duplicate */
    reason: 'exact-title' | 'same-first-message' | 'high-similarity';
}

/**
 * Normalize a string for comparison:
 * - Lowercase
 * - Collapse whitespace
 * - Strip leading/trailing whitespace
 */
function normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Get the first user message content from a session, or empty string.
 */
function firstUserMessage(session: Session): string {
    return session.messages.find(m => m.role === 'user')?.content ?? '';
}

/**
 * Compute a simple Jaccard similarity between two strings based on
 * the overlapping set of trigrams. Returns a value between 0.0 and 1.0.
 *
 * Used for near-duplicate detection when exact title/message matching fails.
 */
function trigramJaccard(a: string, b: string): number {
    if (a.length < 3 || b.length < 3) {
        return normalizeText(a) === normalizeText(b) ? 1.0 : 0.0;
    }

    const trigramsA = new Set<string>();
    const trigramsB = new Set<string>();

    for (let i = 0; i <= a.length - 3; i++) {
        trigramsA.add(a.slice(i, i + 3));
    }
    for (let i = 0; i <= b.length - 3; i++) {
        trigramsB.add(b.slice(i, i + 3));
    }

    let intersection = 0;
    for (const tg of trigramsA) {
        if (trigramsB.has(tg)) { intersection++; }
    }

    const union = trigramsA.size + trigramsB.size - intersection;
    return union === 0 ? 1.0 : intersection / union;
}

export interface DuplicateDetectionOptions {
    /**
     * Minimum Jaccard trigram similarity score to flag as near-duplicate.
     * Defaults to 0.85.
     */
    similarityThreshold?: number;
    /**
     * Minimum message count that a session must have to be included in similarity checks.
     * Short sessions (1-2 messages) are excluded from trigram similarity to reduce false positives.
     * Defaults to 3.
     */
    minMessagesForSimilarity?: number;
}

const DEFAULT_OPTIONS: Required<DuplicateDetectionOptions> = {
    similarityThreshold: 0.85,
    minMessagesForSimilarity: 3,
};

/**
 * Detect duplicate or near-duplicate sessions in a collection.
 *
 * Three detection strategies (evaluated in order):
 * 1. **Exact title match**: Two sessions with identical normalized titles.
 * 2. **Same first message**: First user messages are character-identical (normalized).
 * 3. **High similarity**: Trigram Jaccard similarity of first user messages ≥ threshold.
 *
 * Returns groups where each group has one canonical session and one or more duplicates.
 * Sessions that are unique are not included in the result.
 *
 * Time complexity: O(n²) — acceptable for typical session counts (< 10,000).
 * For very large corpora, use the `semanticIndexMaxAgeDays` retention filter to
 * limit the candidate set.
 */
export function detectDuplicates(
    sessions: Session[],
    options: DuplicateDetectionOptions = {}
): DuplicateGroup[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const groups: DuplicateGroup[] = [];
    const grouped = new Set<string>(); // session IDs already assigned to a group

    // Build normalized keys for quick exact-match lookups
    const byTitle = new Map<string, Session[]>();
    const byFirstMessage = new Map<string, Session[]>();

    for (const session of sessions) {
        const normTitle = normalizeText(session.title);
        const normFirstMsg = normalizeText(firstUserMessage(session));

        const titleGroup = byTitle.get(normTitle) ?? [];
        titleGroup.push(session);
        byTitle.set(normTitle, titleGroup);

        if (normFirstMsg) {
            const msgGroup = byFirstMessage.get(normFirstMsg) ?? [];
            msgGroup.push(session);
            byFirstMessage.set(normFirstMsg, msgGroup);
        }
    }

    // Strategy 1: Exact title duplicates
    for (const [, group] of byTitle.entries()) {
        if (group.length < 2) { continue; }
        const ungrouped = group.filter(s => !grouped.has(s.id));
        if (ungrouped.length < 2) { continue; }

        const canonical = ungrouped[0];
        const duplicates = ungrouped.slice(1);

        grouped.add(canonical.id);
        duplicates.forEach(s => grouped.add(s.id));

        groups.push({ canonical, duplicates, reason: 'exact-title' });
    }

    // Strategy 2: Same first user message (exact)
    for (const [, group] of byFirstMessage.entries()) {
        const ungrouped = group.filter(s => !grouped.has(s.id));
        if (ungrouped.length < 2) { continue; }

        const canonical = ungrouped[0];
        const duplicates = ungrouped.slice(1);

        grouped.add(canonical.id);
        duplicates.forEach(s => grouped.add(s.id));

        groups.push({ canonical, duplicates, reason: 'same-first-message' });
    }

    // Strategy 3: Near-duplicate by trigram similarity
    const candidates = sessions.filter(
        s => !grouped.has(s.id) && s.messages.length >= opts.minMessagesForSimilarity
    );

    for (let i = 0; i < candidates.length; i++) {
        if (grouped.has(candidates[i].id)) { continue; }

        const a = candidates[i];
        const msgA = normalizeText(firstUserMessage(a));
        if (!msgA) { continue; }

        const nearDuplicates: Session[] = [];

        for (let j = i + 1; j < candidates.length; j++) {
            if (grouped.has(candidates[j].id)) { continue; }

            const b = candidates[j];
            const msgB = normalizeText(firstUserMessage(b));
            if (!msgB) { continue; }

            const similarity = trigramJaccard(msgA, msgB);
            if (similarity >= opts.similarityThreshold) {
                nearDuplicates.push(b);
            }
        }

        if (nearDuplicates.length > 0) {
            grouped.add(a.id);
            nearDuplicates.forEach(s => grouped.add(s.id));
            groups.push({ canonical: a, duplicates: nearDuplicates, reason: 'high-similarity' });
        }
    }

    return groups;
}