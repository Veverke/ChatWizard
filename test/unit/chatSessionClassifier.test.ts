/**
 * test/unit/chatSessionClassifier.test.ts
 *
 * Unit tests for the shared "group chats into topical categories" component.
 * The single-session classifier and the label-consolidation passes are injected,
 * so these tests exercise the orchestration (ordering, sanitising, refinement,
 * category cap, progress) without any model call.
 */

import * as assert from 'assert';
import {
    classifyChatSessions,
    enforceCategoryCount,
    sanitizeLabel,
    DEFAULT_CATEGORY_COUNT,
} from '../../src/analytics/chatSessionClassifier';
import type {
    SessionClassification,
    SingleClassification,
    LabelRefinementInput,
} from '../../src/analytics/chatSessionClassifier';
import type { Message, Session } from '../../src/types/index';

function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, title = `Session ${id}`): Session {
    return {
        id,
        title,
        source: 'copilot',
        messages: [msg('user', `Prompt for ${id}`)],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${id}.jsonl`,
    };
}

function classification(overrides: Partial<SessionClassification> & { sessionId: string }): SessionClassification {
    return {
        sessionId: overrides.sessionId,
        category: overrides.category ?? 'Git',
        subcategory: overrides.subcategory,
        subSubcategory: overrides.subSubcategory,
        usedLlm: overrides.usedLlm ?? true,
    };
}

suite('chatSessionClassifier', () => {

    suite('classifyChatSessions', () => {

        test('returns one entry per session, in input order', async () => {
            const sessions = [makeSession('a'), makeSession('b'), makeSession('c')];
            const labels: Record<string, SingleClassification> = {
                a: { category: 'Git', subcategory: 'Branching', usedLlm: true },
                b: { category: 'Bugs', subcategory: 'Crash', usedLlm: true },
                c: { category: 'Testing', subcategory: 'Fixtures', usedLlm: false },
            };

            const result = await classifyChatSessions(
                sessions,
                { levels: 2, refineLabels: false },
                { classifyOne: async s => labels[s.id] },
            );

            assert.deepStrictEqual(result.map(r => r.sessionId), ['a', 'b', 'c']);
            assert.deepStrictEqual(result.map(r => r.category), ['Git', 'Bugs', 'Testing']);
            assert.deepStrictEqual(result.map(r => r.usedLlm), [true, true, false]);
        });

        test('reports the requested label depth', async () => {
            const session = makeSession('deep');
            const raw: SingleClassification = {
                category: 'Git',
                subcategory: 'Branching',
                subSubcategory: 'Merge Conflicts',
                usedLlm: true,
            };

            const three = await classifyChatSessions(
                [session], { levels: 3, refineLabels: false }, { classifyOne: async () => raw },
            );
            assert.strictEqual(three[0].subSubcategory, 'Merge Conflicts');

            const two = await classifyChatSessions(
                [session], { levels: 2, refineLabels: false }, { classifyOne: async () => raw },
            );
            assert.strictEqual(two[0].subcategory, 'Branching');
            assert.strictEqual(two[0].subSubcategory, undefined);
        });

        test('defaults the depth to the knowledge base\'s two levels', async () => {
            let askedForLevels: number | undefined;
            await classifyChatSessions(
                [makeSession('x')],
                { refineLabels: false },
                {
                    classifyOne: async (_session, levels) => {
                        askedForLevels = levels;
                        return { category: 'Git', usedLlm: true };
                    },
                },
            );
            assert.strictEqual(askedForLevels, 2, 'the canonical classification is 2 levels (KB parity)');
        });

        test('never caps the number of categories', async () => {
            // The category cap is a *view* projection (enforceCategoryCount) and
            // must never change the canonical classification — that is what made
            // the KB pie chart lose detail.
            const sessions = Array.from({ length: 6 }, (_, i) => makeSession(`c${i}`));
            const result = await classifyChatSessions(
                sessions,
                { levels: 2, refineLabels: false },
                { classifyOne: async s => ({ category: `Topic ${s.id}`, usedLlm: true }) },
            );
            assert.strictEqual(result.length, 6);
            assert.strictEqual(new Set(result.map(r => r.category)).size, 6);
            assert.ok(result.every(r => r.category !== 'Other'));
        });

        test('never throws â€” a failing classifier becomes "Other"', async () => {
            const result = await classifyChatSessions(
                [makeSession('boom')],
                { refineLabels: false },
                { classifyOne: async () => { throw new Error('model exploded'); } },
            );
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].category, 'Other');
            assert.strictEqual(result[0].usedLlm, false);
        });

        test('handles a null classification as "Other"', async () => {
            const result = await classifyChatSessions(
                [makeSession('null')],
                { refineLabels: false },
                { classifyOne: async () => null },
            );
            assert.strictEqual(result[0].category, 'Other');
        });

        test('calls onProgress once per session', async () => {
            let calls = 0;
            const totals: number[] = [];
            await classifyChatSessions(
                [makeSession('a'), makeSession('b')],
                {
                    refineLabels: false,
                    onProgress: (done, total) => { calls++; totals.push(total); },
                },
                { classifyOne: async () => ({ category: 'Git', usedLlm: true }) },
            );
            assert.strictEqual(calls, 2);
            assert.deepStrictEqual(totals, [2, 2]);
        });

        test('returns an empty array for an empty history', async () => {
            const result = await classifyChatSessions([], {});
            assert.deepStrictEqual(result, []);
        });
    });


    suite('label consolidation', () => {

        test('applies the category mapping', async () => {
            const sessions = [makeSession('a'), makeSession('b')];
            const result = await classifyChatSessions(
                sessions,
                { levels: 2 },
                {
                    classifyOne: async s => ({
                        category: s.id === 'a' ? 'Git Pull' : 'Git Push',
                        usedLlm: true,
                    }),
                    refineCategories: async () => new Map([
                        ['Git Pull', 'Git'],
                        ['Git Push', 'Git'],
                    ]),
                },
            );
            assert.deepStrictEqual(result.map(r => r.category), ['Git', 'Git']);
        });

        test('consolidates sub-topics per parent', async () => {
            const sessions = [makeSession('a'), makeSession('b')];
            const seen: LabelRefinementInput[] = [];
            const result = await classifyChatSessions(
                sessions,
                { levels: 2 },
                {
                    classifyOne: async s => ({
                        category: 'Git',
                        subcategory: s.id === 'a' ? 'Git Pull' : 'Git Push',
                        usedLlm: true,
                    }),
                    refineLabelsUnderParent: async inputs => {
                        seen.push(...inputs);
                        return new Map([['Git Pull', 'Remotes'], ['Git Push', 'Remotes']]);
                    },
                },
            );
            assert.deepStrictEqual(result.map(r => r.subcategory), ['Remotes', 'Remotes']);
            assert.ok(seen.every(i => i.parent === 'Git'));
        });

        test('skips consolidation when refineLabels is false', async () => {
            let called = false;
            const result = await classifyChatSessions(
                [makeSession('a'), makeSession('b')],
                { levels: 2, refineLabels: false },
                {
                    classifyOne: async s => ({ category: s.id, usedLlm: true }),
                    refineCategories: async () => { called = true; return null; },
                },
            );
            assert.strictEqual(called, false);
            assert.deepStrictEqual(result.map(r => r.category), ['a', 'b']);
        });

        test('skips consolidation when no session was labelled by the model', async () => {
            let called = false;
            await classifyChatSessions(
                [makeSession('a'), makeSession('b')],
                { levels: 2 },
                {
                    classifyOne: async s => ({ category: s.id, usedLlm: false }),
                    refineCategories: async () => { called = true; return null; },
                },
            );
            assert.strictEqual(called, false);
        });
    });

    suite('enforceCategoryCount', () => {

        const entries: SessionClassification[] = [
            classification({ sessionId: '1', category: 'Git' }),
            classification({ sessionId: '2', category: 'Git' }),
            classification({ sessionId: '3', category: 'Git' }),
            classification({ sessionId: '4', category: 'Docker' }),
            classification({ sessionId: '5', category: 'Docker' }),
            classification({ sessionId: '6', category: 'Bugs' }),
            classification({ sessionId: '7', category: 'Testing' }),
        ];

        test('keeps everything when the cap is omitted', () => {
            const result = enforceCategoryCount(entries);
            assert.strictEqual(new Set(result.map(e => e.category)).size, 4);
        });

        test('keeps everything when already within the cap', () => {
            const result = enforceCategoryCount(entries, 4);
            assert.strictEqual(result.length, entries.length);
            assert.strictEqual(new Set(result.map(e => e.category)).size, 4);
        });

        test('keeps the largest categories and folds the rest into "Other"', () => {
            const result = enforceCategoryCount(entries, 3);
            assert.strictEqual(result.length, entries.length);
            assert.deepStrictEqual(
                [...new Set(result.map(e => e.category))].sort(),
                ['Docker', 'Git', 'Other'],
            );
            // The two smallest categories (1 session each) are merged.
            assert.strictEqual(result.filter(e => e.category === 'Other').length, 2);
        });

        test('the default top-level count is "no cap" (KB parity)', () => {
            assert.strictEqual(DEFAULT_CATEGORY_COUNT, 0);
            const result = enforceCategoryCount(entries, DEFAULT_CATEGORY_COUNT);
            assert.strictEqual(new Set(result.map(e => e.category)).size, 4);
        });

        test('limit of 1 folds everything into "Other"', () => {
            const result = enforceCategoryCount(entries, 1);
            assert.deepStrictEqual([...new Set(result.map(e => e.category))], ['Other']);
        });

        test('an existing "Other" bucket absorbs the merged sessions', () => {
            const withOther: SessionClassification[] = [
                classification({ sessionId: '1', category: 'Git' }),
                classification({ sessionId: '2', category: 'Git' }),
                classification({ sessionId: '3', category: 'Docker' }),
                classification({ sessionId: '4', category: 'Bugs' }),
                classification({ sessionId: '5', category: 'Other' }),
            ];
            const result = enforceCategoryCount(withOther, 2);
            assert.deepStrictEqual(
                [...new Set(result.map(e => e.category))].sort(),
                ['Git', 'Other'],
            );
            assert.strictEqual(result.filter(e => e.category === 'Other').length, 3);
        });
    });

    suite('sanitizeLabel', () => {

        test('trims whitespace and surrounding punctuation', () => {
            assert.strictEqual(sanitizeLabel('  "Merge Conflicts"  '), 'Merge Conflicts');
        });

        test('collapses newlines into spaces', () => {
            assert.strictEqual(sanitizeLabel('Merge\nConflicts'), 'Merge Conflicts');
        });

        test('rejects blanks and placeholders', () => {
            assert.strictEqual(sanitizeLabel(''), undefined);
            assert.strictEqual(sanitizeLabel('   '), undefined);
            assert.strictEqual(sanitizeLabel('Other'), undefined);
            assert.strictEqual(sanitizeLabel('general'), undefined);
            assert.strictEqual(sanitizeLabel('n/a'), undefined);
            assert.strictEqual(sanitizeLabel(undefined), undefined);
        });

        test('caps very long labels', () => {
            const result = sanitizeLabel('x'.repeat(120));
            assert.strictEqual(result?.length, 60);
        });
    });

    suite('deeper levels and defaults', () => {

        test('consolidates third-level labels under their category|sub-topic parent', async () => {
            const sessions = [makeSession('a'), makeSession('b')];
            const parents: string[] = [];
            const result = await classifyChatSessions(
                sessions,
                { levels: 3 },
                {
                    classifyOne: async s => ({
                        category: 'Git',
                        subcategory: 'Branching',
                        subSubcategory: s.id === 'a' ? 'Merge Conflicts' : 'Cleanup',
                        usedLlm: true,
                    }),
                    refineLabelsUnderParent: async inputs => {
                        parents.push(...inputs.map(i => i.parent));
                        return new Map([['Merge Conflicts', 'Conflicts'], ['Cleanup', 'Tidying']]);
                    },
                },
            );

            assert.deepStrictEqual(result.map(r => r.subSubcategory), ['Conflicts', 'Tidying']);
            // Consolidation runs per level: sub-topics under "Git", then
            // sub-sub-topics under "Git|Branching".
            assert.ok(parents.includes('Git'));
            assert.ok(parents.includes('Git|Branching'));
        });

        test('does not consolidate a level when only one entry carries a label', async () => {
            let called = false;
            const result = await classifyChatSessions(
                [makeSession('a'), makeSession('b')],
                { levels: 2 },
                {
                    classifyOne: async s => ({
                        category: 'Git',
                        subcategory: s.id === 'a' ? 'Branching' : undefined,
                        usedLlm: true,
                    }),
                    refineLabelsUnderParent: async () => { called = true; return null; },
                },
            );
            assert.strictEqual(called, false);
            assert.deepStrictEqual(result.map(r => r.subcategory), ['Branching', undefined]);
        });

        test('the default classifier falls back to "Other" when no model answers', async () => {
            // No injected classifyOne â†’ production path: LLM (unavailable in tests)
            // â†’ embedding engine (not registered) â†’ "Other".
            const result = await classifyChatSessions(
                [makeSession('fallback')],
                { levels: 2, refineLabels: false },
            );
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].category, 'Other');
            assert.strictEqual(result[0].usedLlm, false);
        });

        test('honours an explicit concurrency factor', async () => {
            const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`s${i}`));
            const result = await classifyChatSessions(
                sessions,
                { levels: 2, refineLabels: false, concurrency: 1 },
                { classifyOne: async s => ({ category: 'Git', usedLlm: true }) },
            );
            assert.strictEqual(result.length, 5);
        });

        test('consolidation falls back to the KB refinement when no injection is given', async () => {
            // Seeded labels (as the shared store supplies) with the production
            // refinement path: the free model is unavailable in tests, so the
            // default refinement returns null and the labels are kept as-is.
            const sessions = [makeSession('a'), makeSession('b')];
            const result = await classifyChatSessions(
                sessions,
                {
                    levels: 2,
                    seed: {
                        a: { category: 'Git', subcategory: 'Pull', usedLlm: true },
                        b: { category: 'Git', subcategory: 'Push', usedLlm: true },
                    },
                },
            );

            assert.deepStrictEqual(result.map(r => r.category), ['Git', 'Git']);
            assert.deepStrictEqual(result.map(r => r.subcategory), ['Pull', 'Push']);
        });
    });
});
