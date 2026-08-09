// src/types/kb.ts
// Feature 23 — KB Entry Classification + KB Generation

/**
 * A knowledge-base entry type — a free-form category label.
 * Categories emerge from LLM analysis (or embedding fallback).
 */
export type KbEntryType = string;

/**
 * The five legacy built-in KB entry types, kept for backwards compatibility
 * with the embedding fallback classifier.
 */
export const DEFAULT_KB_TYPES: KbEntryType[] = ['decision', 'learning', 'pattern', 'gotcha', 'architecture'];

/**
 * Set of the five legacy KB entry types for fast lookup.
 */
export const DEFAULT_KB_TYPE_SET = new Set<KbEntryType>(DEFAULT_KB_TYPES);

/**
 * A single entry in the ChatWizard knowledge base.
 * Each entry corresponds to one session, classified by LLM or embedding model.
 */
export interface KbEntry {
    /** ID of the source session */
    sessionId: string;
    /** Top-level folder — classified by LLM (pass 1) */
    type: KbEntryType;
    /** Second-level subject within the top-level folder — classified by LLM (pass 1) */
    subtype?: string;
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
    /** Whether this entry was classified using the LLM (vs embedding fallback) */
    usedLlm?: boolean;
}