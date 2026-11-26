/**
 * test/unit/classificationStructure.test.ts
 *
 * The shared structure is the auto-classified folder tree; both the Sessions view
 * and the Knowledge Base render it. These tests pin the rules that make the two
 * views agree: folder path → category/sub-category, `Unclassified` for chats the
 * tree does not place, deeper nesting folded into one sub-topic, and the label
 * fallback while no tree exists.
 */

import * as assert from 'assert';
import {
    UNCLASSIFIED_CATEGORY,
    applyFolderStructure,
    indexFolderStructure,
    isPlacedInStructure,
} from '../../src/analytics/classificationStructure';
import type { SessionFolder } from '../../src/types/index';
import type { SessionClassification } from '../../src/analytics/chatSessionClassifier';

const NOW = '2024-01-01T00:00:00Z';

function folder(overrides: Partial<SessionFolder> & { id: string; name: string }): SessionFolder {
    return {
        id: overrides.id,
        name: overrides.name,
        parentId: overrides.parentId ?? null,
        sessionIds: overrides.sessionIds ?? [],
        childFolderIds: overrides.childFolderIds ?? [],
        createdAt: overrides.createdAt ?? NOW,
        updatedAt: overrides.updatedAt ?? NOW,
        origin: overrides.origin ?? 'auto',
        ...(overrides.manual ? { manual: true } : {}),
    };
}

function classify(sessionId: string, category: string, subcategory?: string): SessionClassification {
    return { sessionId, category, subcategory, usedLlm: true };
}

/** Git (a) → Branching (b) → Rebase (c); Bugs (d); empty "Kubernetes". */
function tree(): Map<string, SessionFolder> {
    return new Map<string, SessionFolder>([
        ['git', folder({ id: 'git', name: 'Git', sessionIds: ['a'], childFolderIds: ['branching'] })],
        ['branching', folder({ id: 'branching', name: 'Branching', parentId: 'git', sessionIds: ['b'], childFolderIds: ['rebase'] })],
        ['rebase', folder({ id: 'rebase', name: 'Rebase', parentId: 'branching', sessionIds: ['c'] })],
        ['bugs', folder({ id: 'bugs', name: 'Bugs', sessionIds: ['d'] })],
        ['k8s', folder({ id: 'k8s', name: 'Kubernetes', manual: true })],
    ]);
}


suite('classificationStructure', () => {

    suite('indexFolderStructure', () => {
        test('returns an empty structure when there is no tree', () => {
            for (const input of [undefined, null, new Map<string, SessionFolder>()]) {
                const structure = indexFolderStructure(input);
                assert.deepStrictEqual(structure.roots, []);
                assert.strictEqual(structure.paths.size, 0);
            }
        });

        test('lists every root folder alphabetically, including empty ones', () => {
            const structure = indexFolderStructure(tree());
            assert.deepStrictEqual(structure.roots, ['Bugs', 'Git', 'Kubernetes']);
        });

        test('maps a chat to its full folder path', () => {
            const structure = indexFolderStructure(tree());
            assert.deepStrictEqual(structure.paths.get('a'), ['Git']);
            assert.deepStrictEqual(structure.paths.get('b'), ['Git', 'Branching']);
            assert.deepStrictEqual(structure.paths.get('c'), ['Git', 'Branching', 'Rebase']);
            assert.deepStrictEqual(structure.paths.get('d'), ['Bugs']);
        });

        test('keeps the shallowest placement when a chat is listed twice', () => {
            const folders = tree();
            folders.get('rebase')!.sessionIds.push('a');
            const structure = indexFolderStructure(folders);
            assert.deepStrictEqual(structure.paths.get('a'), ['Git']);
        });

        test('treats a folder with a missing parent as a root', () => {
            const folders = new Map<string, SessionFolder>([
                ['orphan', folder({ id: 'orphan', name: 'Orphan', parentId: 'gone', sessionIds: ['x'] })],
            ]);
            const structure = indexFolderStructure(folders);
            assert.deepStrictEqual(structure.roots, ['Orphan']);
            assert.deepStrictEqual(structure.paths.get('x'), ['Orphan']);
        });
    });


    suite('applyFolderStructure', () => {
        test('leaves the model labels alone while no tree exists', () => {
            const classifications = [classify('a', 'Git', 'Branching')];
            const applied = applyFolderStructure(classifications, new Map());
            assert.deepStrictEqual(applied.classifications, classifications);
            assert.strictEqual(applied.categoryOrder, undefined);
        });

        test('takes the category from the folder, not from the model label', () => {
            const applied = applyFolderStructure(
                [classify('a', 'Something Else', 'Whatever'), classify('d', 'Other')],
                tree(),
            );
            const byId = new Map(applied.classifications.map(c => [c.sessionId, c]));
            assert.strictEqual(byId.get('a')!.category, 'Git');
            assert.strictEqual(byId.get('a')!.subcategory, undefined);
            assert.strictEqual(byId.get('d')!.category, 'Bugs');
        });

        test('uses the sub-folder as the sub-topic', () => {
            const applied = applyFolderStructure([classify('b', 'Git', 'Old Label')], tree());
            assert.strictEqual(applied.classifications[0].category, 'Git');
            assert.strictEqual(applied.classifications[0].subcategory, 'Branching');
        });

        test('folds a hand-made third level into one sub-topic', () => {
            const applied = applyFolderStructure([classify('c', 'Git', 'Branching')], tree());
            assert.strictEqual(applied.classifications[0].category, 'Git');
            assert.strictEqual(applied.classifications[0].subcategory, 'Branching / Rebase');
        });

        test('places chats the tree does not hold in "Unclassified"', () => {
            const applied = applyFolderStructure(
                [classify('a', 'Git'), classify('new', 'Git', 'Branching')],
                tree(),
            );
            const newChat = applied.classifications.find(c => c.sessionId === 'new')!;
            assert.strictEqual(newChat.category, UNCLASSIFIED_CATEGORY);
            assert.strictEqual(newChat.subcategory, undefined);
            assert.strictEqual(isPlacedInStructure(newChat), false);
            assert.strictEqual(isPlacedInStructure(applied.classifications[0]), true);
        });

        test('reports the structure order and appends "Unclassified" last', () => {
            const placedOnly = applyFolderStructure([classify('a', 'Git')], tree());
            assert.deepStrictEqual(placedOnly.categoryOrder, ['Bugs', 'Git', 'Kubernetes']);

            const withUnplaced = applyFolderStructure([classify('a', 'Git'), classify('x', 'Git')], tree());
            assert.deepStrictEqual(
                withUnplaced.categoryOrder,
                ['Bugs', 'Git', 'Kubernetes', UNCLASSIFIED_CATEGORY],
            );
        });
    });
});
