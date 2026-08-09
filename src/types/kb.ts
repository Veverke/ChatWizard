// src/types/kb.ts
// Feature 23 — KB Entry Classification + KB Generation

/**
 * A knowledge-base entry type — one of the five default types, or a user-defined
 * custom category.
 */
export type KbEntryType = string;

/**
 * The five built-in KB entry types.
 */
export const DEFAULT_KB_TYPES: KbEntryType[] = ['decision', 'learning', 'pattern', 'gotcha', 'architecture'];

/**
 * Set of the five built-in KB entry types for fast lookup.
 */
export const DEFAULT_KB_TYPE_SET = new Set<KbEntryType>(DEFAULT_KB_TYPES);

/**
 * A single entry in the ChatWizard knowledge base.
 * Each entry corresponds to one session, classified into one of the five types.
 */
export interface KbEntry {
    /** ID of the source session */
    sessionId: string;
    /** Entry type, classified by heuristic rules */
    type: KbEntryType;
    /** Human-readable title — derived from session title or first user message */
    title: string;
    /** 1–3 sentence summary of the knowledge */
    summary: string;
    /** Tags from sidecar metadata */
    tags: string[];
    /** Cluster ID assigned during the clustering pass */
    clusterId?: string;
    /** When true, this entry will be skipped on incremental re-runs */
    locked?: boolean;
    /** ISO-8601 creation timestamp */
    createdAt: string;
    /** Whether this entry was classified using the LLM (vs heuristic fallback) */
    usedLlm?: boolean;
}