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

export interface ClusterResult {
    clusters: PromptCluster[];
    /** true when the input was capped at MAX_CLUSTER_ENTRIES */
    truncated: boolean;
}

/** Maximum entries processed by the clustering algorithm. */
export const MAX_CLUSTER_ENTRIES = 5000;

/** Chunk size for the setImmediate-based async clustering loop. */
const ASYNC_CHUNK_SIZE = 100;

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

// ── Module-level result cache (one slot) ──────────────────────────────────────

let _cacheKey: string = '';
let _cachedResult: ClusterResult | null = null;

/** Invalidate the module-level result cache (useful in tests). */
export function clearClusterCache(): void {
    _cacheKey = '';
    _cachedResult = null;
}

// ── Internal optimised clustering core ───────────────────────────────────────

/**
 * Compute Jaccard similarity between two pre-built trigram sets.
 * Avoids rebuilding sets inside the hot comparison loop.
 */
function jaccardFromSets(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 || setB.size === 0) { return 0.0; }
    let intersectionSize = 0;
    for (const tg of setA) {
        if (setB.has(tg)) { intersectionSize++; }
    }
    const unionSize = setA.size + setB.size - intersectionSize;
    return unionSize === 0 ? 1.0 : intersectionSize / unionSize;
}

/**
 * Process one entry against the current cluster set using the bucket index.
 * Mutates `clusters`, `canonicalTrigramSets`, and `buckets` in place.
 */
function _processEntry(
    entry: PromptEntry,
    entrySet: Set<string>,
    clusters: PromptCluster[],
    canonicalTrigramSets: Set<string>[],
    buckets: Map<string, number[]>,
    threshold: number,
): void {
    // Collect candidate cluster indices via bucket lookup (only clusters whose
    // canonical shares at least one trigram with the new entry)
    const candidateSet = new Set<number>();
    for (const tg of entrySet) {
        const bucket = buckets.get(tg);
        if (bucket) { for (const ci of bucket) { candidateSet.add(ci); } }
    }

    // When threshold <= 0, every entry matches; ensure cluster 0 is a candidate
    if (threshold <= 0 && clusters.length > 0 && candidateSet.size === 0) {
        candidateSet.add(0);
    }

    for (const ci of candidateSet) {
        if (jaccardFromSets(canonicalTrigramSets[ci], entrySet) >= threshold) {
            const cluster = clusters[ci];
            cluster.variants.push(entry);
            cluster.totalFrequency += entry.frequency;
            for (const pid of entry.projectIds) {
                if (!cluster.allProjectIds.includes(pid)) {
                    cluster.allProjectIds.push(pid);
                }
            }
            return; // matched
        }
    }

    // No match → seed a new cluster and register its trigrams in the bucket index
    const ci = clusters.length;
    clusters.push({
        canonical: entry,
        variants: [],
        totalFrequency: entry.frequency,
        allProjectIds: [...entry.projectIds],
    });
    canonicalTrigramSets.push(entrySet);
    for (const tg of entrySet) {
        let bucket = buckets.get(tg);
        if (!bucket) { bucket = []; buckets.set(tg, bucket); }
        bucket.push(ci);
    }
}

function _sortAndFinalize(clusters: PromptCluster[], truncated: boolean): ClusterResult {
    for (const cluster of clusters) {
        cluster.variants.sort((a, b) => b.frequency - a.frequency);
    }
    clusters.sort((a, b) => b.totalFrequency - a.totalFrequency);
    return { clusters, truncated };
}

function _runClustering(
    entries: PromptEntry[],
    threshold: number,
): ClusterResult {
    const truncated = entries.length > MAX_CLUSTER_ENTRIES;
    const workEntries = truncated ? entries.slice(0, MAX_CLUSTER_ENTRIES) : entries;

    // Pre-build trigram sets for all entries once (avoids rebuilding inside the hot loop)
    const trigramSets: Set<string>[] = workEntries.map(e => buildTrigramSet(e.text));

    const clusters: PromptCluster[] = [];
    const canonicalTrigramSets: Set<string>[] = [];
    const buckets = new Map<string, number[]>(); // trigram → cluster indices

    for (let i = 0; i < workEntries.length; i++) {
        _processEntry(workEntries[i], trigramSets[i], clusters, canonicalTrigramSets, buckets, threshold);
    }

    return _sortAndFinalize(clusters, truncated);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Greedy single-pass clustering of PromptEntry objects by trigram similarity.
 * Each entry either joins the first cluster whose canonical text meets the
 * threshold, or seeds a new cluster. Results are sorted by totalFrequency desc.
 *
 * Optimisations vs the naïve O(n²) implementation:
 *  - Trigram sets are built once per entry upfront.
 *  - A bucket index (trigram → cluster indices) limits candidate comparisons
 *    to clusters that share at least one trigram with the incoming entry.
 *
 * @param entries    Pre-sorted PromptEntry[] (frequency desc is ideal).
 * @param threshold  Minimum similarity to merge (default 0.6).
 */
export function clusterPrompts(entries: PromptEntry[], threshold = 0.6): PromptCluster[] {
    return _runClustering(entries, threshold).clusters;
}

/**
 * Extended version of `clusterPrompts` that also reports truncation and
 * supports a result cache keyed on `(cacheKey, threshold)`.
 *
 * @param entries    Pre-sorted PromptEntry[].
 * @param threshold  Minimum similarity to merge (default 0.6).
 * @param cacheKey   Optional stable key; pass the same key when the underlying
 *                   data has not changed to get an O(1) cache hit.
 */
export function clusterPromptsExt(
    entries: PromptEntry[],
    threshold = 0.6,
    cacheKey?: string,
): ClusterResult {
    if (cacheKey !== undefined) {
        const key = `${cacheKey}:${threshold}`;
        if (key === _cacheKey && _cachedResult !== null) { return _cachedResult; }
    }

    const result = _runClustering(entries, threshold);

    if (cacheKey !== undefined) {
        _cacheKey = `${cacheKey}:${threshold}`;
        _cachedResult = result;
    }

    return result;
}

/**
 * Async variant of `clusterPromptsExt` that yields to the event loop every
 * ASYNC_CHUNK_SIZE entries via `setImmediate`, preventing the extension host
 * from stalling during large clustering runs.
 */
export function clusterPromptsAsync(
    entries: PromptEntry[],
    threshold = 0.6,
    cacheKey?: string,
): Promise<ClusterResult> {
    if (cacheKey !== undefined) {
        const key = `${cacheKey}:${threshold}`;
        if (key === _cacheKey && _cachedResult !== null) {
            return Promise.resolve(_cachedResult);
        }
    }

    return new Promise<ClusterResult>((resolve) => {
        const truncated = entries.length > MAX_CLUSTER_ENTRIES;
        const workEntries = truncated ? entries.slice(0, MAX_CLUSTER_ENTRIES) : entries;
        const trigramSets: Set<string>[] = workEntries.map(e => buildTrigramSet(e.text));

        const clusters: PromptCluster[] = [];
        const canonicalTrigramSets: Set<string>[] = [];
        const buckets = new Map<string, number[]>();

        let i = 0;

        function processChunk(): void {
            const end = Math.min(i + ASYNC_CHUNK_SIZE, workEntries.length);
            while (i < end) {
                _processEntry(
                    workEntries[i], trigramSets[i],
                    clusters, canonicalTrigramSets, buckets, threshold,
                );
                i++;
            }

            if (i < workEntries.length) {
                setImmediate(processChunk);
                return;
            }

            const result = _sortAndFinalize(clusters, truncated);

            if (cacheKey !== undefined) {
                _cacheKey = `${cacheKey}:${threshold}`;
                _cachedResult = result;
            }

            resolve(result);
        }

        setImmediate(processChunk);
    });
}
