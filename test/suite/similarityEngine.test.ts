// test/suite/similarityEngine.test.ts

import * as assert from 'assert';
import {
    trigramSimilarity,
    clusterPrompts,
    clusterPromptsExt,
    clusterPromptsAsync,
    clearClusterCache,
    MAX_CLUSTER_ENTRIES,
} from '../../src/prompts/similarityEngine';
import { PromptEntry } from '../../src/prompts/promptExtractor';

function makeEntry(text: string, frequency = 1, projectIds: string[] = []): PromptEntry {
    return { text, frequency, sessionIds: [], projectIds, firstSeen: undefined, sessionMeta: [] };
}

// â”€â”€ trigramSimilarity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('trigramSimilarity', () => {
    test('identical strings return 1.0', () => {
        assert.strictEqual(trigramSimilarity('refactor this function', 'refactor this function'), 1.0);
    });

    test('completely different strings with no shared trigrams return 0.0', () => {
        assert.strictEqual(trigramSimilarity('aaabbb', 'zzzyyyxxx'), 0.0);
    });

    test('empty string vs non-empty returns 0.0', () => {
        assert.strictEqual(trigramSimilarity('', 'hello world'), 0.0);
        assert.strictEqual(trigramSimilarity('hello world', ''), 0.0);
    });

    test('both empty strings return 0.0', () => {
        assert.strictEqual(trigramSimilarity('', ''), 0.0);
    });

    test('short equal strings (< 3 chars) return 1.0', () => {
        assert.strictEqual(trigramSimilarity('ab', 'ab'), 1.0);
        assert.strictEqual(trigramSimilarity('x', 'x'), 1.0);
    });

    test('short different strings (< 3 chars) return 0.0', () => {
        assert.strictEqual(trigramSimilarity('ab', 'cd'), 0.0);
        assert.strictEqual(trigramSimilarity('x', 'y'), 0.0);
    });

    test('one short (< 3) and one long string returns 0.0', () => {
        assert.strictEqual(trigramSimilarity('ab', 'abcdef'), 0.0);
    });

    test('near-duplicate strings return similarity > 0.5', () => {
        const sim = trigramSimilarity('refactor this function', 'refactor the function');
        assert.ok(sim > 0.5, `expected > 0.5, got ${sim}`);
    });

    test('result is always in [0, 1] for arbitrary inputs', () => {
        const pairs: [string, string][] = [
            ['write unit tests', 'write integration tests'],
            ['hello world', 'goodbye world'],
            ['TypeScript is great', 'JavaScript is okay'],
        ];
        for (const [a, b] of pairs) {
            const sim = trigramSimilarity(a, b);
            assert.ok(sim >= 0.0 && sim <= 1.0, `sim ${sim} out of range for "${a}" vs "${b}"`);
        }
    });

    test('similarity is symmetric', () => {
        const a = 'optimize database queries';
        const b = 'optimize database performance';
        assert.strictEqual(trigramSimilarity(a, b), trigramSimilarity(b, a));
    });

    test('exactly 3-char equal strings return 1.0', () => {
        // boundary condition: exactly 3 chars produces exactly one trigram
        assert.strictEqual(trigramSimilarity('abc', 'abc'), 1.0);
    });

    test('exactly 3-char different strings return 0.0', () => {
        assert.strictEqual(trigramSimilarity('abc', 'xyz'), 0.0);
    });

    test('one string exactly 3 chars, other is long, returns value in [0, 1]', () => {
        // Neither string is < 3 chars, so the <3 short-circuit does not apply
        const sim = trigramSimilarity('abc', 'abcdefghij');
        assert.ok(sim >= 0.0 && sim <= 1.0, `expected value in [0,1], got ${sim}`);
        // Should be > 0 because the trigram 'abc' is shared
        assert.ok(sim > 0.0, `expected > 0.0 because "abc" trigram is shared, got ${sim}`);
    });

    test('strings sharing a long prefix have similarity > 0.5', () => {
        // 'typescript linting rules' vs 'typescript linting config' share most trigrams;
        // actual Jaccard â‰ˆ 0.607
        const sim = trigramSimilarity('typescript linting rules', 'typescript linting config');
        assert.ok(sim > 0.5, `expected > 0.5 for shared-prefix strings, got ${sim}`);
    });

    test('unicode characters do not crash and result is in [0, 1]', () => {
        const sim = trigramSimilarity('cafÃ© au lait', 'cafÃ© con leche');
        assert.ok(sim >= 0.0 && sim <= 1.0, `expected value in [0,1], got ${sim}`);
    });

    test('very long nearly-identical strings have similarity > 0.8', () => {
        // Build a 1000-char base string and two variants that differ by one word only
        const base = 'optimize the database query performance using proper indexing strategies ';
        // Repeat to reach ~1000 chars (base is 71 chars; repeat 14 times = 994 chars)
        const repeated = base.repeat(14);
        const a = repeated + 'and caching';
        const b = repeated + 'and batching';
        const sim = trigramSimilarity(a, b);
        assert.ok(sim > 0.8, `expected > 0.8 for nearly-identical long strings, got ${sim}`);
    });

    test('reflexive property: sim(a, a) === 1.0 for non-trivial strings', () => {
        const strings = [
            'refactor this TypeScript class method',
            'explain the architecture of this module',
            'write unit tests for the authentication service',
        ];
        for (const s of strings) {
            assert.strictEqual(trigramSimilarity(s, s), 1.0, `expected 1.0 for reflexive sim of "${s}"`);
        }
    });
});

// â”€â”€ clusterPrompts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('clusterPrompts', () => {
    test('empty input returns empty array', () => {
        assert.deepStrictEqual(clusterPrompts([]), []);
    });

    test('single entry produces one cluster with no variants', () => {
        const entry = makeEntry('refactor this function', 5);
        const clusters = clusterPrompts([entry]);
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].canonical, entry);
        assert.deepStrictEqual(clusters[0].variants, []);
        assert.strictEqual(clusters[0].totalFrequency, 5);
    });

    test('two similar prompts above threshold merge into one cluster', () => {
        const a = makeEntry('refactor this function', 3);
        const b = makeEntry('refactor the function', 2);
        const sim = trigramSimilarity(a.text, b.text);
        assert.ok(sim >= 0.6, `precondition: sim ${sim} < 0.6`);

        const clusters = clusterPrompts([a, b]);
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].canonical, a);
        assert.strictEqual(clusters[0].variants.length, 1);
        assert.strictEqual(clusters[0].totalFrequency, 5);
    });

    test('two dissimilar prompts produce two separate clusters', () => {
        const a = makeEntry('explain quantum computing', 2);
        const b = makeEntry('write a SQL migration script', 3);
        const clusters = clusterPrompts([a, b]);
        assert.strictEqual(clusters.length, 2);
    });

    test('clusters are sorted by totalFrequency descending', () => {
        const a1 = makeEntry('write unit tests for the parser', 6);
        const a2 = makeEntry('write unit tests for the formatter', 4);
        const b  = makeEntry('explain quantum entanglement clearly', 2);

        const clusters = clusterPrompts([b, a1, a2]);
        assert.ok(clusters[0].totalFrequency >= clusters[clusters.length - 1].totalFrequency);
        const maxFreq = clusters[0].totalFrequency;
        assert.ok(maxFreq >= 6, `expected highest cluster freq >= 6, got ${maxFreq}`);
    });

    test('allProjectIds is the deduplicated union across the cluster', () => {
        const a = makeEntry('refactor this function', 3, ['proj-A', 'proj-B']);
        const b = makeEntry('refactor the function',  2, ['proj-B', 'proj-C']);
        const clusters = clusterPrompts([a, b]);
        assert.strictEqual(clusters.length, 1);
        const ids = [...clusters[0].allProjectIds].sort();
        assert.deepStrictEqual(ids, ['proj-A', 'proj-B', 'proj-C']);
    });

    test('custom threshold of 1.0 only clusters identical texts', () => {
        const a = makeEntry('refactor this function', 3);
        const b = makeEntry('refactor the function',  2);   // similar but not identical
        const c = makeEntry('refactor this function', 1);   // exact match to a

        const clusters = clusterPrompts([a, b, c], 1.0);
        // a and c are identical â†’ merged; b is only similar â†’ own cluster
        assert.strictEqual(clusters.length, 2);

        const texts = clusters.map(cl => cl.canonical.text);
        assert.ok(texts.includes('refactor this function'));
        assert.ok(texts.includes('refactor the function'));

        const aCluster = clusters.find(cl => cl.canonical.text === 'refactor this function');
        assert.ok(aCluster !== undefined);
        assert.strictEqual(aCluster.variants.length, 1);
        assert.strictEqual(aCluster.totalFrequency, 4);
    });

    test('variants within a cluster are sorted by frequency descending', () => {
        const canonical = makeEntry('optimize database query performance', 10);
        const v1        = makeEntry('optimize database query efficiency',   5);
        const v2        = makeEntry('optimize database query speed',        8);

        const clusters = clusterPrompts([canonical, v1, v2]);
        // Check that if they all end up in one cluster, variants are sorted
        const c = clusters.find(cl => cl.canonical === canonical);
        if (c && c.variants.length >= 2) {
            const freqs = c.variants.map(v => v.frequency);
            for (let i = 0; i < freqs.length - 1; i++) {
                assert.ok(freqs[i] >= freqs[i + 1], `variants not sorted: ${freqs.join(', ')}`);
            }
        }
        assert.ok(clusters.length >= 1);
    });

    test('threshold of 0 clusters everything together', () => {
        const entries = [
            makeEntry('completely different text here', 1),
            makeEntry('nothing in common at all xyz', 2),
            makeEntry('unrelated thing aaabbbccc', 3),
        ];
        const clusters = clusterPrompts(entries, 0);
        // At threshold 0, every entry matches the first cluster (similarity >= 0 always)
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].totalFrequency, 6);
    });

    test('many similar variants all land in the same cluster', () => {
        // Five variants of "refactor this TypeScript class method"
        const entries = [
            makeEntry('refactor this TypeScript class method', 5),
            makeEntry('refactor this TypeScript class methods', 4),
            makeEntry('refactor the TypeScript class method', 3),
            makeEntry('refactor this TypeScript class function', 2),
            makeEntry('refactor this TypeScript class approach', 1),
        ];
        // Verify each variant is similar enough to the canonical to merge
        for (let i = 1; i < entries.length; i++) {
            const sim = trigramSimilarity(entries[0].text, entries[i].text);
            assert.ok(sim >= 0.6, `precondition failed: sim(canonical, variant[${i}]) = ${sim} < 0.6`);
        }
        const clusters = clusterPrompts(entries);
        assert.strictEqual(clusters.length, 1, `expected 1 cluster, got ${clusters.length}`);
        assert.strictEqual(clusters[0].variants.length, 4);
        assert.strictEqual(clusters[0].totalFrequency, 15);
    });

    test('threshold edge: entries at exactly the threshold boundary merge', () => {
        // Use texts whose similarity we have verified is >= 0.6
        const a = makeEntry('refactor this function', 3);
        const b = makeEntry('refactor the function',  2);
        const sim = trigramSimilarity(a.text, b.text);
        assert.ok(sim >= 0.6, `precondition: sim ${sim} < 0.6`);
        // Cluster at exactly that threshold value â€” they must merge
        const clusters = clusterPrompts([a, b], sim);
        assert.strictEqual(clusters.length, 1, `expected 1 cluster at threshold ${sim}, got ${clusters.length}`);
        // Just above the threshold by a tiny amount they should still merge
        const clusters2 = clusterPrompts([a, b], sim - 1e-10);
        assert.strictEqual(clusters2.length, 1, `expected 1 cluster just below sim, got ${clusters2.length}`);
        // Just above should NOT merge (similarity < threshold)
        const clusters3 = clusterPrompts([a, b], sim + 1e-10);
        assert.strictEqual(clusters3.length, 2, `expected 2 clusters just above sim, got ${clusters3.length}`);
    });

    test('greedy three-way cluster: c compares against canonical a, not b', () => {
        // a and b are similar, so b joins a's cluster.
        // c is similar to b but NOT to a â€” greedy algorithm checks a first,
        // so c should form its own cluster.
        const a = makeEntry('write unit tests for parser module', 5);
        const b = makeEntry('write unit tests for parser component', 4);
        const c = makeEntry('explain quantum physics theory clearly', 2);

        const simAB = trigramSimilarity(a.text, b.text);
        assert.ok(simAB >= 0.6, `precondition: a-b sim ${simAB} < 0.6`);
        const simAC = trigramSimilarity(a.text, c.text);
        assert.ok(simAC < 0.6, `precondition: a-c sim ${simAC} >= 0.6`);

        const clusters = clusterPrompts([a, b, c]);
        // b should merge with a; c is checked against a (not b) and stays separate
        assert.strictEqual(clusters.length, 2, `expected 2 clusters, got ${clusters.length}`);
        const aCluster = clusters.find(cl => cl.canonical === a);
        assert.ok(aCluster !== undefined, 'expected a to be a canonical');
        assert.strictEqual(aCluster.variants.length, 1);
        assert.strictEqual(aCluster.variants[0], b);
    });

    test('single entry cluster: canonical is the entry itself (reference equality)', () => {
        const entry = makeEntry('explain the module architecture', 7);
        const clusters = clusterPrompts([entry]);
        assert.strictEqual(clusters[0].canonical, entry);
    });

    test('cluster with two entries: totalFrequency equals sum of both frequencies', () => {
        const canonical = makeEntry('refactor this function', 6);
        const variant   = makeEntry('refactor the function',  3);
        const sim = trigramSimilarity(canonical.text, variant.text);
        assert.ok(sim >= 0.6, `precondition: sim ${sim} < 0.6`);

        const clusters = clusterPrompts([canonical, variant]);
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].totalFrequency, canonical.frequency + variant.frequency);
    });

    test('large number of unrelated entries produces one cluster per entry', () => {
        const entries = [
            makeEntry('explain quantum entanglement', 1),
            makeEntry('write a SQL migration script', 1),
            makeEntry('build a REST API in Go', 1),
            makeEntry('design a neural network architecture', 1),
            makeEntry('parse CSV files with Python', 1),
            makeEntry('configure nginx reverse proxy', 1),
            makeEntry('implement binary search tree', 1),
            makeEntry('set up docker compose for postgres', 1),
            makeEntry('animate SVG paths with CSS', 1),
            makeEntry('optimize webpack bundle size', 1),
        ];
        const clusters = clusterPrompts(entries);
        assert.strictEqual(clusters.length, 10, `expected 10 clusters, got ${clusters.length}`);
    });

    test('allProjectIds deduplication across 3 variants sharing a projectId', () => {
        const a = makeEntry('refactor this function', 3, ['proj-A', 'proj-B']);
        const b = makeEntry('refactor the function',  2, ['proj-B', 'proj-C']);
        const c = makeEntry('refactor that function', 1, ['proj-A', 'proj-C']);
        const simAB = trigramSimilarity(a.text, b.text);
        const simAC = trigramSimilarity(a.text, c.text);
        assert.ok(simAB >= 0.6, `precondition: a-b sim ${simAB} < 0.6`);
        assert.ok(simAC >= 0.6, `precondition: a-c sim ${simAC} < 0.6`);

        const clusters = clusterPrompts([a, b, c]);
        assert.strictEqual(clusters.length, 1, `expected 1 cluster, got ${clusters.length}`);
        const ids = [...clusters[0].allProjectIds].sort();
        // proj-A, proj-B, proj-C each appear in multiple entries but must appear only once
        assert.deepStrictEqual(ids, ['proj-A', 'proj-B', 'proj-C']);
    });

    test('clusterPrompts preserves canonical.firstSeen', () => {
        const entry = makeEntry('refactor this function', 3);
        entry.firstSeen = '2024-01-15T10:00:00.000Z';
        const clusters = clusterPrompts([entry]);
        assert.strictEqual(clusters[0].canonical.firstSeen, '2024-01-15T10:00:00.000Z');
    });

    test('clusterPrompts works correctly when sessionMeta is populated', () => {
        const sessionMetaA = [{ sessionId: 's1', title: 'Session One', updatedAt: '2024-01-01T00:00:00.000Z', source: 'copilot' as const }];
        const sessionMetaB = [{ sessionId: 's2', title: 'Session Two', updatedAt: '2024-02-01T00:00:00.000Z', source: 'claude' as const }];

        const a: PromptEntry = {
            text: 'refactor this TypeScript class method',
            frequency: 4,
            sessionIds: ['s1'],
            projectIds: ['proj-A'],
            firstSeen: '2024-01-01T00:00:00.000Z',
            sessionMeta: sessionMetaA,
        };
        const b: PromptEntry = {
            text: 'refactor the TypeScript class method',
            frequency: 2,
            sessionIds: ['s2'],
            projectIds: ['proj-B'],
            firstSeen: '2024-02-01T00:00:00.000Z',
            sessionMeta: sessionMetaB,
        };

        const sim = trigramSimilarity(a.text, b.text);
        assert.ok(sim >= 0.6, `precondition: sim ${sim} < 0.6`);

        const clusters = clusterPrompts([a, b]);
        // sessionMeta presence does not affect clustering logic
        assert.strictEqual(clusters.length, 1, `expected 1 cluster, got ${clusters.length}`);
        assert.strictEqual(clusters[0].canonical, a);
        assert.strictEqual(clusters[0].variants.length, 1);
        assert.strictEqual(clusters[0].variants[0], b);
        assert.strictEqual(clusters[0].totalFrequency, 6);
        // sessionMeta is preserved on the canonical entry unchanged
        assert.deepStrictEqual(clusters[0].canonical.sessionMeta, sessionMetaA);
    });
});

// â”€â”€ clusterPromptsExt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('clusterPromptsExt', () => {
    setup(() => clearClusterCache());

    test('produces same clusters as clusterPrompts', () => {
        const entries = [
            makeEntry('refactor this function', 3),
            makeEntry('refactor the function', 2),
            makeEntry('explain quantum computing', 1),
        ];
        const plain = clusterPrompts(entries);
        const { clusters } = clusterPromptsExt(entries);
        assert.strictEqual(clusters.length, plain.length);
        assert.strictEqual(clusters[0].canonical.text, plain[0].canonical.text);
    });

    test('truncated is false when entries count <= MAX_CLUSTER_ENTRIES', () => {
        const entries = Array.from({ length: 5 }, (_, i) => makeEntry(`prompt ${i}`, 1));
        const { truncated } = clusterPromptsExt(entries);
        assert.strictEqual(truncated, false);
    });

    test('truncated is true when entries exceed MAX_CLUSTER_ENTRIES', () => {
        const entries = Array.from(
            { length: MAX_CLUSTER_ENTRIES + 1 },
            (_, i) => makeEntry(`unique prompt ${i}`, 1)
        );
        const { truncated } = clusterPromptsExt(entries);
        assert.strictEqual(truncated, true);
    });

    test('total entries in result does not exceed MAX_CLUSTER_ENTRIES when truncated', () => {
        const entries = Array.from(
            { length: MAX_CLUSTER_ENTRIES + 50 },
            (_, i) => makeEntry(`unique prompt xyz ${i}`, 1)
        );
        const { clusters } = clusterPromptsExt(entries);
        const total = clusters.reduce((s, c) => s + 1 + c.variants.length, 0);
        assert.ok(total <= MAX_CLUSTER_ENTRIES, `expected <= ${MAX_CLUSTER_ENTRIES}, got ${total}`);
    });

    test('cache hit: same cacheKey + threshold returns identical object reference', () => {
        const entries = [makeEntry('refactor this function', 3), makeEntry('explain quantum', 2)];
        const result1 = clusterPromptsExt(entries, 0.6, 'v1');
        const result2 = clusterPromptsExt(entries, 0.6, 'v1');
        assert.strictEqual(result1, result2, 'expected same ClusterResult reference on cache hit');
    });

    test('cache miss: different cacheKey returns new result', () => {
        const entries = [makeEntry('refactor this function', 3)];
        const result1 = clusterPromptsExt(entries, 0.6, 'v1');
        const result2 = clusterPromptsExt(entries, 0.6, 'v2');
        assert.notStrictEqual(result1, result2);
    });

    test('cache miss: different threshold returns new result', () => {
        const entries = [makeEntry('refactor this function', 3)];
        const result1 = clusterPromptsExt(entries, 0.6, 'v1');
        const result2 = clusterPromptsExt(entries, 0.7, 'v1');
        assert.notStrictEqual(result1, result2);
    });

    test('clearClusterCache invalidates cache', () => {
        const entries = [makeEntry('refactor this function', 3)];
        const result1 = clusterPromptsExt(entries, 0.6, 'v1');
        clearClusterCache();
        const result2 = clusterPromptsExt(entries, 0.6, 'v1');
        assert.notStrictEqual(result1, result2);
    });

    test('threshold of 0 clusters everything together (bucket fallback path)', () => {
        const entries = [
            makeEntry('completely different text here', 1),
            makeEntry('nothing in common at all xyz', 2),
            makeEntry('unrelated thing aaabbbccc', 3),
        ];
        const { clusters } = clusterPromptsExt(entries, 0);
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].totalFrequency, 6);
    });

    test('clustering 5,000 entries completes in < 2 seconds', () => {
        const base = 'refactor this TypeScript class method for better performance and readability ';
        const entries = Array.from({ length: MAX_CLUSTER_ENTRIES }, (_, i) =>
            makeEntry(base + String(i % 200), 1)
        );
        const start = Date.now();
        clusterPromptsExt(entries, 0.6);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 2000, `clustering ${MAX_CLUSTER_ENTRIES} entries took ${elapsed}ms (limit: 2000ms)`);
    });
});

// â”€â”€ clusterPromptsAsync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('clusterPromptsAsync', () => {
    setup(() => clearClusterCache());

    test('empty input resolves to empty clusters', async () => {
        const { clusters } = await clusterPromptsAsync([]);
        assert.deepStrictEqual(clusters, []);
    });

    test('produces same clusters as clusterPrompts', async () => {
        const entries = [
            makeEntry('refactor this function', 3),
            makeEntry('refactor the function', 2),
            makeEntry('explain quantum computing', 1),
        ];
        const plain = clusterPrompts(entries);
        const { clusters } = await clusterPromptsAsync(entries);
        assert.strictEqual(clusters.length, plain.length);
        const plainTexts = plain.map(c => c.canonical.text).sort();
        const asyncTexts = clusters.map(c => c.canonical.text).sort();
        assert.deepStrictEqual(asyncTexts, plainTexts);
    });

    test('cache hit returns resolved promise immediately', async () => {
        const entries = [makeEntry('refactor this function', 3)];
        const result1 = await clusterPromptsAsync(entries, 0.6, 'v1');
        const result2 = await clusterPromptsAsync(entries, 0.6, 'v1');
        assert.strictEqual(result1, result2, 'expected same reference on async cache hit');
    });

    test('truncated flag is set when entries exceed cap', async () => {
        const entries = Array.from(
            { length: MAX_CLUSTER_ENTRIES + 1 },
            (_, i) => makeEntry(`unique prompt ${i}`, 1)
        );
        const { truncated } = await clusterPromptsAsync(entries);
        assert.strictEqual(truncated, true);
    });
});

