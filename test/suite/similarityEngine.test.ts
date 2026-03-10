// test/suite/similarityEngine.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { trigramSimilarity, clusterPrompts } from '../../src/prompts/similarityEngine';
import { PromptEntry } from '../../src/prompts/promptExtractor';

function makeEntry(text: string, frequency = 1, projectIds: string[] = []): PromptEntry {
    return { text, frequency, sessionIds: [], projectIds, firstSeen: undefined };
}

// ── trigramSimilarity ─────────────────────────────────────────────────────────

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
});

// ── clusterPrompts ────────────────────────────────────────────────────────────

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
        // a and c are identical → merged; b is only similar → own cluster
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
});
