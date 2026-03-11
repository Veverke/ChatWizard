// test/suite/promptLibraryPanel.test.ts

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { PromptLibraryPanel } from '../../src/prompts/promptLibraryPanel';
import { PromptCluster } from '../../src/prompts/similarityEngine';
import { PromptEntry } from '../../src/prompts/promptExtractor';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(text: string, frequency = 1, projectIds: string[] = [], sessionMeta: PromptEntry['sessionMeta'] = []): PromptEntry {
    return { text, frequency, sessionIds: [], projectIds, firstSeen: undefined, sessionMeta };
}

function makeCluster(canonical: PromptEntry, variants: PromptEntry[] = []): PromptCluster {
    const totalFrequency = canonical.frequency + variants.reduce((s, v) => s + v.frequency, 0);
    const allProjectIds = [...new Set([...canonical.projectIds, ...variants.flatMap(v => v.projectIds)])];
    return { canonical, variants, totalFrequency, allProjectIds };
}

// ── getHtml — structure ───────────────────────────────────────────────────────

suite('PromptLibraryPanel.getHtml', () => {
    test('returns valid HTML with doctype', () => {
        const html = PromptLibraryPanel.getHtml([]);
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    });

    test('empty clusters renders empty-state message', () => {
        const html = PromptLibraryPanel.getHtml([]);
        assert.ok(html.includes('No prompts found'), 'should show empty state');
    });

    test('single cluster with no variants: no variants section present', () => {
        const cluster = makeCluster(makeEntry('Explain closures', 2));
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(!html.includes('similar variant'), 'no variants section expected');
    });

    test('cluster with variants: variants section is present', () => {
        const canonical = makeEntry('Write unit tests for parser', 4);
        const variant = makeEntry('Write unit tests for formatter', 2);
        const cluster = makeCluster(canonical, [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('variants-details'), 'should have variants-details element');
        assert.ok(html.includes('similar variant'), 'should show variant summary');
    });

    test('stats label shows correct frequency and project count', () => {
        const canonical = makeEntry('Debug this crash', 5, ['/proj/a', '/proj/b']);
        const cluster = makeCluster(canonical);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('Asked 5 times'), 'should show frequency');
        assert.ok(html.includes('across 2 projects'), 'should show project count');
    });

    test('stats label uses singular for frequency=1', () => {
        const cluster = makeCluster(makeEntry('Optimize query', 1, ['/proj/a']));
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('Asked 1 time'), 'should use singular "time"');
        assert.ok(!html.includes('Asked 1 times'), 'should not use plural "times"');
    });

    test('stats label uses singular for project count=1', () => {
        const cluster = makeCluster(makeEntry('Explain async', 3, ['/proj/a']));
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('1 project'), 'should use singular "project"');
    });

    test('HTML-special characters in prompt text are escaped', () => {
        const cluster = makeCluster(makeEntry('<script>alert("xss")</script>', 1));
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(!html.includes('<script>alert'), 'raw script tag must not appear');
        assert.ok(html.includes('&lt;script&gt;'), 'angle brackets should be escaped');
        assert.ok(html.includes('&quot;xss&quot;'), 'quotes should be escaped');
    });

    test('prompt count in toolbar reflects total entries', () => {
        const c1 = makeCluster(makeEntry('Alpha', 2), [makeEntry('Alpha variant', 1)]);
        const c2 = makeCluster(makeEntry('Beta', 1));
        const html = PromptLibraryPanel.getHtml([c1, c2]);
        // total entries = 2 (canonical c1) + 1 (variant c1) + 1 (canonical c2) = 3... wait
        // Actually: totalEntries = clusters.reduce((sum, c) => sum + 1 + c.variants.length, 0)
        // c1: 1 + 1 = 2, c2: 1 + 0 = 1 → total = 3
        assert.ok(html.includes('3 prompt'), 'should show total 3 prompts');
    });

    // ── variant session info ─────────────────────────────────────────────────

    test('variant with sessionMeta shows session title and date', () => {
        const meta = [{
            sessionId: 's1',
            title: 'My Session',
            updatedAt: '2024-06-15T10:00:00.000Z',
            source: 'copilot' as const,
        }];
        const variant = makeEntry('Refactor the function', 1, [], meta);
        const cluster = makeCluster(makeEntry('Refactor this function', 3), [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('My Session'), 'should show session title');
        assert.ok(html.includes('2024-06-15'), 'should show date (first 10 chars of updatedAt)');
        assert.ok(html.includes('variant-session'), 'should have variant-session class');
    });

    test('variant with no sessionMeta renders no variant-session span', () => {
        const variant = makeEntry('Refactor the function', 1, [], []);
        const cluster = makeCluster(makeEntry('Refactor this function', 3), [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        // variant-session span should NOT appear because sessionMeta is empty
        // (the conditional only emits it when sessionInfoParts.length > 0)
        assert.ok(!html.includes('variant-session'), 'should not show empty variant-session span');
    });

    test('variant with multiple sessionMeta entries shows all session titles', () => {
        const meta = [
            { sessionId: 's1', title: 'Session One', updatedAt: '2024-01-01T00:00:00.000Z', source: 'copilot' as const },
            { sessionId: 's2', title: 'Session Two', updatedAt: '2024-02-01T00:00:00.000Z', source: 'claude' as const },
        ];
        const variant = makeEntry('Refactor the function', 2, [], meta);
        const cluster = makeCluster(makeEntry('Refactor this function', 4), [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('Session One'), 'should show first session title');
        assert.ok(html.includes('Session Two'), 'should show second session title');
        assert.ok(html.includes('2024-01-01'), 'should show first session date');
        assert.ok(html.includes('2024-02-01'), 'should show second session date');
    });

    test('HTML-special characters in session title are escaped', () => {
        const meta = [{
            sessionId: 's1',
            title: '<b>Bold</b> & "quoted"',
            updatedAt: '2024-05-01T00:00:00.000Z',
            source: 'copilot' as const,
        }];
        const variant = makeEntry('Refactor the function', 1, [], meta);
        const cluster = makeCluster(makeEntry('Refactor this function', 3), [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(!html.includes('<b>Bold</b>'), 'raw HTML in session title must be escaped');
        assert.ok(html.includes('&lt;b&gt;Bold&lt;/b&gt;'), 'angle brackets in title must be escaped');
        assert.ok(html.includes('&amp;'), 'ampersand in title must be escaped');
    });

    // ── multiple clusters ────────────────────────────────────────────────────

    test('multiple clusters each render their own card', () => {
        const c1 = makeCluster(makeEntry('Write unit tests', 5));
        const c2 = makeCluster(makeEntry('Optimize SQL query', 3));
        const html = PromptLibraryPanel.getHtml([c1, c2]);
        assert.ok(html.includes('Write unit tests'), 'first cluster text present');
        assert.ok(html.includes('Optimize SQL query'), 'second cluster text present');
        // Count prompt-card divs
        const cardMatches = html.match(/class="prompt-card"/g) ?? [];
        assert.strictEqual(cardMatches.length, 2, 'should have 2 prompt-card elements');
    });

    test('cluster with two variants shows correct variant count in summary', () => {
        const canonical = makeEntry('Refactor this function', 5);
        const v1 = makeEntry('Refactor the function', 2);
        const v2 = makeEntry('Refactor that function', 1);
        const cluster = makeCluster(canonical, [v1, v2]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('2 similar variants'), 'should show "2 similar variants"');
    });

    test('cluster with exactly one variant shows singular "similar variant"', () => {
        const canonical = makeEntry('Explain async/await', 4);
        const variant = makeEntry('Explain async await', 1);
        const cluster = makeCluster(canonical, [variant]);
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('1 similar variant'), 'should show singular "1 similar variant"');
        assert.ok(!html.includes('1 similar variants'), 'should not use plural for 1 variant');
    });

    test('copy buttons include correct data-text attribute', () => {
        const cluster = makeCluster(makeEntry('Debug this function', 2));
        const html = PromptLibraryPanel.getHtml([cluster]);
        assert.ok(html.includes('data-text="Debug this function"'), 'copy button should have correct data-text');
    });

    test('search input is present in toolbar', () => {
        const html = PromptLibraryPanel.getHtml([]);
        assert.ok(html.includes('id="searchInput"'), 'search input should be present');
    });
});
