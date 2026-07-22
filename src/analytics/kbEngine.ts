// src/analytics/kbEngine.ts
// Feature 23 — Shared KB engine: builds classified entries from sessions + sidecar.
// Used by both the dashboard (kbDashboardPanel.ts) and the exporter (extension.ts).

import type { Session, SessionMetadata } from '../types/index';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifySession, classifySessionWithCategories } from './kbClassifier';

export interface KbEngineResult {
    /** Every session classified as a KB entry. */
    entries: KbEntry[];
    /** Entries grouped by type. */
    grouped: Map<KbEntryType, KbEntry[]>;
    /** Total entry count. */
    total: number;
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
 * @param sessions    All hydrated sessions (must have messages loaded).
 * @param cache       Sidecar metadata map (sessionId → SessionMetadata), or null.
 * @param categories  Optional list of categories to classify into. When provided,
 *                    sessions are classified using the LLM (if custom categories
 *                    are present) or the heuristic classifier. Defaults to the
 *                    five built-in types.
 */
export async function buildKbEntries(
    sessions: Session[],
    cache: Map<string, SessionMetadata> | null,
    categories?: KbEntryType[],
    onProgress?: (done: number, total: number) => void,
): Promise<KbEngineResult> {
    const entries: KbEntry[] = new Array(sessions.length);
    const grouped = new Map<KbEntryType, KbEntry[]>();

    const useCategories = categories ?? ['decision', 'learning', 'pattern', 'gotcha', 'architecture'];
    let completed = 0;

    await Promise.all(sessions.map(async (session, i) => {
        const meta = cache?.get(session.id);
        const tags = meta?.tags ?? [];
        const entryType = await classifySessionWithCategories(session, useCategories);
        const rawSummary = meta?.summary ?? session.title;
        const summary = cleanSummary(rawSummary);

        entries[i] = {
            sessionId: session.id,
            type: entryType,
            title: session.title,
            summary,
            tags,
            createdAt: session.createdAt,
        };

        completed++;
        onProgress?.(completed, sessions.length);
    }));

    for (const entry of entries) {
        const group = grouped.get(entry.type);
        if (group) {
            group.push(entry);
        } else {
            grouped.set(entry.type, [entry]);
        }
    }

    return { entries, grouped, total: entries.length };
}