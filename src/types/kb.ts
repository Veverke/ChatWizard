// src/types/kb.ts
// Feature 23 — KB Entry Classification + KB Generation

/**
 * The five knowledge-base entry types, classified by heuristic rules
 * applied to session content.
 */
export type KbEntryType = 'decision' | 'learning' | 'pattern' | 'gotcha' | 'architecture';

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
}