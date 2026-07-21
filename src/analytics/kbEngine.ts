// src/analytics/kbEngine.ts
// Feature 23 — Shared KB engine: builds classified entries from sessions + sidecar.
// Used by both the dashboard (kbDashboardPanel.ts) and the exporter (extension.ts).

import type { Session, SessionMetadata } from '../types/index';
import type { KbEntry, KbEntryType } from '../types/kb';
import { classifySession } from './kbClassifier';

export interface KbEngineResult {
    /** Every session classified as a KB entry. */
    entries: KbEntry[];
    /** Entries grouped by type. */
    grouped: Map<KbEntryType, KbEntry[]>;
    /** Total entry count. */
    total: number;
}

/**
 * Build KB entries from all sessions and their sidecar metadata.
 *
 * @param sessions  All hydrated sessions (must have messages loaded).
 * @param cache     Sidecar metadata map (sessionId → SessionMetadata), or null.
 */
export function buildKbEntries(
    sessions: Session[],
    cache: Map<string, SessionMetadata> | null,
): KbEngineResult {
    const entries: KbEntry[] = [];
    const grouped = new Map<KbEntryType, KbEntry[]>();

    for (const session of sessions) {
        const meta = cache?.get(session.id);
        const tags = meta?.tags ?? [];
        const entryType = classifySession(session);
        const summary = meta?.summary ?? session.title;

        const entry: KbEntry = {
            sessionId: session.id,
            type: entryType,
            title: session.title,
            summary,
            tags,
            createdAt: session.createdAt,
        };
        entries.push(entry);

        const group = grouped.get(entryType);
        if (group) {
            group.push(entry);
        } else {
            grouped.set(entryType, [entry]);
        }
    }

    return { entries, grouped, total: entries.length };
}