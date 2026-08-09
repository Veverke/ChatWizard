// src/analytics/kbEngine.ts
// Feature 23 — Shared KB engine: builds classified entries from sessions + sidecar.
// Used by both the dashboard (kbDashboardPanel.ts) and the exporter (extension.ts).

import type { Session, SessionMetadata } from '../types/index';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifySessionWithCategories } from './kbClassifier';
import { refineCategories, refineSubtypes } from './kbLlmClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB');

export interface KbEngineResult {
    /** Every session classified as a KB entry. */
    entries: KbEntry[];
    /** Entries grouped by type. */
    grouped: Map<KbEntryType, KbEntry[]>;
    /** Total entry count. */
    total: number;
    /** Whether the LLM was used for classification (vs embedding fallback). */
    usedLlm: boolean;
}

/**
 * Merge new entries into an existing result, replacing any entries with the same sessionId.
 * Preserves the existing top-level grouping structure. Only adds genuinely new
 * top-level groups when a new category type appears that doesn't fit any existing group.
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
 * The AI-first pipeline works as follows:
 * 1. Each session is sent to the free AI model (Copilot LM API) which freely
 *    generates a category label based on the conversation content — no predefined
 *    buckets are used.
 * 2. If the AI model is unavailable, the local ONNX embedding model
 *    (all-MiniLM-L6-v2) classifies the session by finding the closest category
 *    via cosine similarity.
 * 3. If neither is available, the first category is used as a safe default.
 *
 * @param sessions    All hydrated sessions (must have messages loaded).
 * @param cache       Sidecar metadata map (sessionId → SessionMetadata), or null.
 * @param categories  Optional list of valid categories. When the LLM is available,
 *                    categories emerge freely from content. Defaults to the five
 *                    built-in types for fallback compatibility.
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
            const { type: entryType, subtype, usedLlm } = await classifySessionWithCategories(session, useCategories);
            if (usedLlm) { anyLlm = true; }
            const rawSummary = meta?.summary ?? session.title;
            const summary = cleanSummary(rawSummary);

            entries[i] = {
                sessionId: session.id,
                type: entryType,
                subtype: subtype ?? undefined,
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

    log.info(`KB classification complete: ${completed} sessions, LLM used: ${anyLlm}`);

    // ── Pass 2: Refine/deduplicate raw labels across all sessions ──────────
    if (refineLabels !== false && anyLlm) {
        const rawLabels = Array.from(new Set(entries.map(e => e.type)));
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
            log.info(`Refined ${refinedCount} entries to canonical labels (${refineMap.size} mappings)`);
        }
    }

    // ── Pass 3: Consolidate subtypes across all entries per parent category ──
    if (anyLlm) {
        const subtypeMap = await refineSubtypes(entries).catch(() => null);
        if (subtypeMap && subtypeMap.size > 0) {
            let changedCount = 0;
            for (const entry of entries) {
                const key = entry.subtype ?? '(none)';
                const refined = subtypeMap.get(key);
                if (refined && refined !== key) {
                    entry.subtype = refined;
                    changedCount++;
                }
            }
            log.info(`Consolidated subtypes for ${changedCount} entries (${subtypeMap.size} mappings)`);
        }
    }

    // Build grouped map for consumers
    for (const entry of entries) {
        const group = grouped.get(entry.type);
        if (group) {
            group.push(entry);
        } else {
            grouped.set(entry.type, [entry]);
        }
    }

    return { entries, grouped, total: entries.length, usedLlm: anyLlm };
}