// src/analytics/kbEngine.ts
// Feature 23 — Shared KB engine: builds classified entries from sessions + sidecar.
// Used by both the dashboard (kbDashboardPanel.ts) and the exporter (extension.ts).

import type { Session, SessionMetadata } from '../types/index';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifySessionWithCategories } from './kbClassifier';
import { refineCategories } from './kbLlmClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB');

export interface KbEngineResult {
    /** Every session classified as a KB entry. */
    entries: KbEntry[];
    /** Entries grouped by type (top-level folder). */
    grouped: Map<KbEntryType, KbEntry[]>;
    /** Total entry count. */
    total: number;
    /** Whether the LLM was used for classification (vs embedding fallback). */
    usedLlm: boolean;
}

/**
 * Merge new entries into an existing result, replacing any entries with the same sessionId.
 * Returns a new KbEngineResult (does not mutate the original).
 */
export async function mergeIntoResult(
    existing: KbEngineResult,
    newEntries: KbEntry[],
): Promise<KbEngineResult> {
    // Build a map of existing entries keyed by sessionId
    const entryMap = new Map<string, KbEntry>();
    for (const e of existing.entries) {
        entryMap.set(e.sessionId, e);
    }
    // Upsert new entries
    for (const e of newEntries) {
        entryMap.set(e.sessionId, e);
    }

    const merged = Array.from(entryMap.values());
    const grouped = new Map<KbEntryType, KbEntry[]>();
    for (const entry of merged) {
        const group = grouped.get(entry.type);
        if (group) { group.push(entry); } else { grouped.set(entry.type, [entry]); }
    }

    return {
        entries: merged,
        grouped,
        total: merged.length,
        usedLlm: existing.usedLlm,
    };
}

/**
 * Remove entries for the given sessionIds from an existing result.
 * Returns a new KbEngineResult (does not mutate the original).
 */
export function removeFromResult(
    existing: KbEngineResult,
    sessionIds: Set<string>,
): KbEngineResult {
    const filtered = existing.entries.filter(e => !sessionIds.has(e.sessionId));
    const grouped = new Map<KbEntryType, KbEntry[]>();
    for (const entry of filtered) {
        const group = grouped.get(entry.type);
        if (group) { group.push(entry); } else { grouped.set(entry.type, [entry]); }
    }
    return {
        entries: filtered,
        grouped,
        total: filtered.length,
        usedLlm: existing.usedLlm,
    };
}

/**
 * Strip common "User [verb]" prefixes from summary text.
 *
 * Examples:
 *   "User requested to continue a chat feature..." → "Continue a chat feature..."
 *   "User is troubleshooting a Copilot ext..."     → "Troubleshooting a Copilot ext..."
 *   "User wants to refactor the module..."         → "Refactor the module..."
 */
export function cleanSummary(summary: string): string {
    return summary.replace(
        /^User\s+(?:requested\s+to|is\s+|wants\s+to|asks?\s+to|asked\s+to)\s*/i,
        '',
    );
}

/**
 * Build KB entries from all sessions and their sidecar metadata.
 *
 * The 2-pass pipeline:
 *   1. Each session is classified into a **top-level folder** (broad topic).
 *      LLM is tried first, then embedding fallback, then "Other".
 *   2. All top-level folder labels are refined/deduplicated via a single LLM call.
 *
 * The 1st-pass prompt already reads the full conversation and returns both the
 * top-level folder (general) and the 2nd-level folder (particular) at once,
 * so there is no need for a separate 3rd LLM pass.
 *
 * @param sessions    All hydrated sessions (must have messages loaded).
 * @param cache       Sidecar metadata map (sessionId → SessionMetadata), or null.
 * @param categories  Optional list of valid categories for embedding fallback.
 * @param onProgress  Optional progress callback (done, total).
 * @param refineLabels  Whether to run the 2nd-pass label refinement. Default true.
 */
export async function buildKbEntries(
    sessions: Session[],
    cache: Map<string, SessionMetadata> | null,
    categories?: KbEntryType[],
    onProgress?: (done: number, total: number) => void,
    refineLabels?: boolean,
): Promise<KbEngineResult> {
    const entries: KbEntry[] = new Array(sessions.length);
    const grouped = new Map<KbEntryType, KbEntry[]>();
    let anyLlm = false;

    const useCategories = categories ?? ['Other'];
    let completed = 0;

    // Limit concurrency to avoid overwhelming the Copilot LM API with too many
    // simultaneous requests, which causes rate-limit / "not available" errors.
    const CONCURRENCY = 3;
    let nextIdx = 0;

    async function processNext(): Promise<void> {
        while (nextIdx < sessions.length) {
            const i = nextIdx++;
            const session = sessions[i];
            const meta = cache?.get(session.id);
            const tags = meta?.tags ?? [];
            const { type: entryType, usedLlm } = await classifySessionWithCategories(session, useCategories);
            if (usedLlm) { anyLlm = true; }
            const rawSummary = meta?.summary ?? session.title;
            const summary = cleanSummary(rawSummary);

            entries[i] = {
                sessionId: session.id,
                type: entryType,
                title: session.title,
                summary,
                tags,
                createdAt: session.createdAt,
                usedLlm,
            };

            completed++;
            onProgress?.(completed, sessions.length);
        }
    }

    // Start CONCURRENCY workers
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(processNext());
    }
    await Promise.all(workers);

    log.info(`[Pass 1/2] KB classification complete: ${completed} sessions, LLM used: ${anyLlm}`);

    // ── Pass 2: Refine/deduplicate top-level folder labels ────────────────
    if (refineLabels !== false) {
        const rawLabels = Array.from(new Set(entries.map(e => e.type)));
        log.info(`[Pass 2/2] Refining ${rawLabels.length} unique top-level folder labels`);
        const refineMap = await refineCategories(rawLabels).catch(() => null);
        if (refineMap && refineMap.size > 0) {
            let refinedCount = 0;
            for (const entry of entries) {
                const newType = refineMap.get(entry.type);
                if (newType && newType !== entry.type) {
                    entry.type = newType;
                    refinedCount++;
                }
            }
            log.info(`[Pass 2/2] Refined ${refinedCount} entries to canonical labels (${refineMap.size} mappings)`);
        } else {
            log.info(`[Pass 2/2] No refinement applied — LLM unavailable or all labels already canonical`);
        }
    }

    // Build grouped map from refined types
    for (const entry of entries) {
        const group = grouped.get(entry.type);
        if (group) {
            group.push(entry);
        } else {
            grouped.set(entry.type, [entry]);
        }
    }

    // No topLevelGrouping needed — types ARE the top-level folders.
    return { entries, grouped, total: entries.length, usedLlm: anyLlm };
}