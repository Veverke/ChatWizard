// src/prompts/similarityEngine.ts

import { PromptEntry } from './promptExtractor';

export interface PromptCluster {
    /** The variant with the highest frequency (canonical representative) */
    canonical: PromptEntry;
    /** All other variants (not including canonical) */
    variants: PromptEntry[];
    /** Sum of all frequencies in this cluster */
    totalFrequency: number;
    /** Deduplicated union of all projectIds across the cluster */
    allProjectIds: string[];
}

function buildTrigramSet(s: string): Set<string> {
    const trigrams = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) {
        trigrams.add(s.slice(i, i + 3));
    }
    return trigrams;
}

/**
 * Compute Jaccard similarity between two strings using character-level trigrams.
 * Returns a value in [0, 1] where 1 means identical trigram sets.
 */
export function trigramSimilarity(a: string, b: string): number {
    if (a.length === 0 || b.length === 0) {
        return 0.0;
    }
    if (a.length < 3 && b.length < 3) {
        return a === b ? 1.0 : 0.0;
    }
    if (a.length < 3 || b.length < 3) {
        return 0.0;
    }
    const setA = buildTrigramSet(a);
    const setB = buildTrigramSet(b);
    let intersectionSize = 0;
    for (const trigram of setA) {
        if (setB.has(trigram)) {
            intersectionSize++;
        }
    }
    const unionSize = setA.size + setB.size - intersectionSize;
    if (unionSize === 0) {
        return 1.0;
    }
    return intersectionSize / unionSize;
}

/**
 * Greedy single-pass clustering of PromptEntry objects by trigram similarity.
 * Each entry either joins the first cluster whose canonical text meets the
 * threshold, or seeds a new cluster. Results are sorted by totalFrequency desc.
 *
 * @param entries  Pre-sorted PromptEntry[] (frequency desc is ideal so the most
 *                 frequent prompt becomes each cluster's canonical naturally).
 * @param threshold  Minimum similarity to merge into an existing cluster (default 0.6).
 */
export function clusterPrompts(entries: PromptEntry[], threshold = 0.6): PromptCluster[] {
    const clusters: PromptCluster[] = [];

    for (const entry of entries) {
        let matched = false;
        for (const cluster of clusters) {
            if (trigramSimilarity(cluster.canonical.text, entry.text) >= threshold) {
                cluster.variants.push(entry);
                cluster.totalFrequency += entry.frequency;
                for (const pid of entry.projectIds) {
                    if (!cluster.allProjectIds.includes(pid)) {
                        cluster.allProjectIds.push(pid);
                    }
                }
                matched = true;
                break;
            }
        }
        if (!matched) {
            clusters.push({
                canonical: entry,
                variants: [],
                totalFrequency: entry.frequency,
                allProjectIds: [...entry.projectIds],
            });
        }
    }

    for (const cluster of clusters) {
        cluster.variants.sort((a, b) => b.frequency - a.frequency);
    }

    clusters.sort((a, b) => b.totalFrequency - a.totalFrequency);
    return clusters;
}
