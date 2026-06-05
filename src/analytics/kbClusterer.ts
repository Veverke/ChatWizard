// src/analytics/kbClusterer.ts
// Feature 23 — KB Entry Clustering

import type { KbEntry } from '../types/kb';

const SIMILARITY_THRESHOLD = 0.65;

/**
 * Compute the cosine similarity between two Float32Array embeddings.
 * Assumes vectors are already L2-normalized (dot product = cosine similarity).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

/**
 * Cluster KB entries by:
 * 1. Primary: group by the first tag from sidecar metadata.
 *    Sessions without tags form a 'general' bucket.
 * 2. Refinement: within each tag group, sub-cluster by cosine similarity
 *    of embeddings (threshold 0.65, greedy single-linkage).
 *
 * Returns a Map<clusterId, KbEntry[]> where clusterId is either the tag name
 * or 'general-N' for untagged sub-clusters.
 *
 * Also sets `clusterId` on each entry in-place.
 *
 * @param entries       KB entries to cluster (modified in-place to set clusterId).
 * @param embeddingFn   Function that produces a Float32Array embedding for a text string.
 */
export function clusterEntries(
    entries: KbEntry[],
    embeddingFn: (text: string) => Float32Array
): Map<string, KbEntry[]> {
    const clusters = new Map<string, KbEntry[]>();

    if (entries.length === 0) { return clusters; }

    // ── Step 1: Primary grouping by first tag ──────────────────────────────
    const tagGroups = new Map<string, KbEntry[]>();
    for (const entry of entries) {
        const primaryTag = entry.tags[0] ?? 'general';
        const group = tagGroups.get(primaryTag) ?? [];
        group.push(entry);
        tagGroups.set(primaryTag, group);
    }

    // ── Step 2: Within each tag group, sub-cluster by embedding similarity ─
    for (const [tag, group] of tagGroups.entries()) {
        if (tag !== 'general') {
            // Named tag group: all entries share this cluster ID
            const clusterId = tag;
            for (const entry of group) {
                entry.clusterId = clusterId;
            }
            clusters.set(clusterId, group);
            continue;
        }

        // 'general' group: sub-cluster by cosine similarity
        const subClusters = greedySingleLinkage(group, embeddingFn, SIMILARITY_THRESHOLD);
        let subIdx = 0;
        for (const subGroup of subClusters) {
            const clusterId = `general-${subIdx++}`;
            for (const entry of subGroup) {
                entry.clusterId = clusterId;
            }
            clusters.set(clusterId, subGroup);
        }
    }

    return clusters;
}

/**
 * Greedy single-linkage clustering of entries by embedding cosine similarity.
 *
 * Algorithm:
 * - For each entry (in order), find the first existing cluster where at least
 *   one member has similarity >= threshold with this entry.
 * - If found, add to that cluster; otherwise, start a new cluster.
 *
 * Time complexity: O(n² × d) where n = entries, d = embedding dimensions.
 * This is acceptable for KB generation (typically < 1000 sessions).
 */
function greedySingleLinkage(
    entries: KbEntry[],
    embeddingFn: (text: string) => Float32Array,
    threshold: number
): KbEntry[][] {
    if (entries.length === 0) { return []; }

    // Pre-compute embeddings for all entries
    const embeddings = entries.map(e =>
        embeddingFn(`${e.title} ${e.summary}`)
    );

    const subClusters: { entries: KbEntry[]; embeddings: Float32Array[] }[] = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const emb = embeddings[i];

        let assigned = false;
        for (const cluster of subClusters) {
            // Check if any existing member is similar enough
            for (const memberEmb of cluster.embeddings) {
                if (cosineSimilarity(emb, memberEmb) >= threshold) {
                    cluster.entries.push(entry);
                    cluster.embeddings.push(emb);
                    assigned = true;
                    break;
                }
            }
            if (assigned) { break; }
        }

        if (!assigned) {
            subClusters.push({ entries: [entry], embeddings: [emb] });
        }
    }

    return subClusters.map(c => c.entries);
}