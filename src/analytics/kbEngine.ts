// src/analytics/kbEngine.ts
// Feature 23 — Shared KB engine: builds classified entries from sessions + sidecar.
// Used by both the dashboard (kbDashboardPanel.ts) and the exporter (extension.ts).
//
// The categories an entry gets are the *shared structure* the Sessions view shows
// (`classificationStructure.applyFolderStructure`), falling back to the model
// labels only while no structure exists. One classification, two views.

import type { Session, SessionFolder, SessionMetadata } from '../types/index';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifyChatSessions } from './chatSessionClassifier';
import { classifySessionsShared } from './classificationService';
import type { ClassificationStore } from './classificationStore';
import { applyFolderStructure } from './classificationStructure';
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
    /**
     * Root categories in the shared structure's display order (the Sessions
     * view's folder order), including folders that hold no chats yet. Absent
     * when no structure exists and the model labels are rendered as-is.
     */
    categoryOrder?: string[];
    /** ISO-8601 timestamp of the last KB update (generation or incremental refresh). */
    lastUpdated?: string;
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
        lastUpdated: existing.lastUpdated,
        ...(existing.categoryOrder ? { categoryOrder: existing.categoryOrder } : {}),
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
        lastUpdated: existing.lastUpdated,
        ...(existing.categoryOrder ? { categoryOrder: existing.categoryOrder } : {}),
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
 * The pipeline is the *shared* classification (the same one the automatic
 * folder tree renders): each session gets a topic label from the free model
 * (local embedding model as fallback), consolidated across the history.
 *
 * When a {@link ClassificationStore} is supplied, the classification is
 * **incremental**: only new or changed chats are sent to a model, everything
 * else is reused from the shared state. This is what makes "KB first, then
 * auto-classification" (and vice versa) free of duplicate work.
 *
 * The KB asks for two levels and does not cap the number of categories.
 *
 * @param sessions    All hydrated sessions (must have messages loaded).
 * @param cache       Sidecar metadata map (sessionId → SessionMetadata), or null.
 * @param categories  Optional list of valid categories. When the LLM is available,
 *                    categories emerge freely from content. Defaults to the five
 *                    built-in types for fallback compatibility.
 * @param onProgress  Progress callback.
 * @param refineLabels Run the label-consolidation passes. Default: true.
 * @param store       Optional shared classification store (incremental mode).
 * @param folders     Optional shared *structure* (the auto-classified folder
 *                    tree). When supplied, each entry's type/subtype is the
 *                    folder the chat sits in — the same structure the Sessions
 *                    view shows, including manual reorganisation.
 */
export async function buildKbEntries(
    sessions: Session[],
    cache: Map<string, SessionMetadata> | null,
    categories?: KbEntryType[],
    onProgress?: (done: number, total: number) => void,
    refineLabels?: boolean,
    store?: ClassificationStore,
    folders?: Map<string, SessionFolder> | null,
): Promise<KbEngineResult> {
    const classifications = store
        ? (await classifySessionsShared(sessions, store, {
            levels: 2,
            refineLabels,
            onProgress,
            embeddingCategories: categories,
            pruneMissing: true,
        })).classifications
        : await classifyChatSessions(sessions, {
            levels: 2,
            refineLabels,
            onProgress,
            embeddingCategories: categories,
        });

    return buildKbEntriesFromClassifications(sessions, cache, classifications, folders);
}

/**
 * Materialise KB entries from already-known classifications — no model call.
 *
 * Used to render the KB from the shared classification state (e.g. the automatic
 * classifier ran first, so the KB view can show the same topics immediately).
 *
 * `folders` is the shared structure: when it exists it wins over the model
 * labels, so a folder the user created/renamed/moved/deleted in the Sessions
 * view is reflected here too.
 */
export function buildKbEntriesFromClassifications(
    sessions: Session[],
    cache: Map<string, SessionMetadata> | null,
    classifications: { sessionId: string; category: string; subcategory?: string; usedLlm: boolean }[],
    folders?: Map<string, SessionFolder> | null,
): KbEngineResult {
    const resolved = applyFolderStructure(classifications, folders);
    const byId = new Map(sessions.map(s => [s.id, s]));
    const entries: KbEntry[] = [];
    const grouped = new Map<KbEntryType, KbEntry[]>();
    let anyLlm = false;

    for (const classification of resolved.classifications) {
        const session = byId.get(classification.sessionId);
        if (!session) { continue; }

        const meta = cache?.get(session.id);
        const entry: KbEntry = {
            sessionId: session.id,
            type: classification.category,
            subtype: classification.subcategory,
            title: session.title,
            summary: cleanSummary(meta?.summary ?? session.title),
            tags: meta?.tags ?? [],
            createdAt: session.createdAt,
            usedLlm: classification.usedLlm,
        };
        if (classification.usedLlm) { anyLlm = true; }

        entries.push(entry);
        const group = grouped.get(entry.type);
        if (group) {
            group.push(entry);
        } else {
            grouped.set(entry.type, [entry]);
        }
    }

    log.info(`KB classification complete: ${entries.length} sessions, LLM used: ${anyLlm}`);
    return {
        entries,
        grouped,
        total: entries.length,
        usedLlm: anyLlm,
        ...(resolved.categoryOrder ? { categoryOrder: resolved.categoryOrder } : {}),
    };
}