// src/prompts/promptExtractor.ts

import { SessionIndex } from '../index/sessionIndex';

/** A deduplicated, aggregated entry in the Prompt Library. */
export interface PromptEntry {
    /** Normalized prompt text (trimmed, collapsed internal whitespace) */
    text: string;
    /** How many times this exact normalized prompt appeared */
    frequency: number;
    /** Unique session IDs containing this prompt (deduped) */
    sessionIds: string[];
    /** Unique workspace paths for projects containing this prompt (deduped, undefined paths excluded) */
    projectIds: string[];
    /** ISO timestamp of the earliest occurrence across all duplicates */
    firstSeen?: string;
}

/**
 * Normalize prompt text: trim leading/trailing whitespace and collapse
 * any run of internal whitespace (spaces, tabs, newlines) to a single space.
 */
export function normalizePromptText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

/**
 * Build a deduplicated Prompt Library from all user-turn prompts in the index.
 *
 * - Prompts are normalized before comparison (case-sensitive exact match after normalization).
 * - Empty strings after normalization are skipped.
 * - Results are sorted by frequency descending, then text ascending as a tiebreaker.
 */
export function buildPromptLibrary(index: SessionIndex): PromptEntry[] {
    const raw = index.getAllPrompts();

    const map = new Map<string, {
        frequency: number;
        sessionIds: Set<string>;
        projectIds: Set<string>;
        firstSeen: string | undefined;
    }>();

    for (const prompt of raw) {
        const normalized = normalizePromptText(prompt.content);
        if (normalized.length === 0) {
            continue;
        }

        const session = index.get(prompt.sessionId);
        const workspacePath = session?.workspacePath;

        let entry = map.get(normalized);
        if (entry === undefined) {
            entry = {
                frequency: 0,
                sessionIds: new Set(),
                projectIds: new Set(),
                firstSeen: undefined,
            };
            map.set(normalized, entry);
        }

        entry.frequency += 1;
        entry.sessionIds.add(prompt.sessionId);

        if (workspacePath !== undefined) {
            entry.projectIds.add(workspacePath);
        }

        if (prompt.timestamp !== undefined) {
            if (entry.firstSeen === undefined || prompt.timestamp < entry.firstSeen) {
                entry.firstSeen = prompt.timestamp;
            }
        }
    }

    const result: PromptEntry[] = [];
    for (const [text, entry] of map) {
        result.push({
            text,
            frequency: entry.frequency,
            sessionIds: Array.from(entry.sessionIds),
            projectIds: Array.from(entry.projectIds),
            firstSeen: entry.firstSeen,
        });
    }

    result.sort((a, b) => {
        if (b.frequency !== a.frequency) {
            return b.frequency - a.frequency;
        }
        return a.text.localeCompare(b.text);
    });

    return result;
}
