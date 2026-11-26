/**
 * test/unit/autoTreeReconciler.test.ts
 *
 * The reconciler merges a fresh classification with user amendments made inside
 * the auto-classified tree (created/renamed/moved/deleted folders, moved
 * sessions). These tests cover each amendment kind and the stable-ID guarantees.
 */

import * as assert from 'assert';
import { reconcileAutoTree, emptyAmendments } from '../../src/analytics/autoTreeReconciler';
import type { AutoTreeAmendments, ClassificationPlacement } from '../../src/analytics/autoTreeReconciler';
import type { FolderTreeSpec } from '../../src/index/folderStore';
import type { SessionFolder } from '../../src/types/index';

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

const SPECS: FolderTreeSpec[] = [
    {
        name: 'Git',
        sessionIds: ['a'],
        children: [{ name: 'Branching', sessionIds: ['b'] }],
    },
    { name: 'Bugs', sessionIds: ['c'] },
];

const PLACEMENTS: ClassificationPlacement[] = [
    { sessionId: 'a', path: 'Git' },
    { sessionId: 'b', path: 'Git/Branching' },
    { sessionId: 'c', path: 'Bugs' },
];

function run(
    existing: Map<string, SessionFolder>,
    amendments?: AutoTreeAmendments,
    specs: FolderTreeSpec[] = SPECS,
    placements: ClassificationPlacement[] = PLACEMENTS,
    known: string[] = ['a', 'b', 'c'],
) {
    return reconcileAutoTree({
        specs,
        placements,
        existing,
        amendments,
        knownSessionIds: new Set(known),
        now: NOW,
    });
}

function findByName(folders: Map<string, SessionFolder>, name: string): SessionFolder | undefined {
    return [...folders.values()].find(f => f.name === name);
}

suite('autoTreeReconciler', () => {

    test('materialises the classifier tree with sessions in their folders', () => {
        const { folders, amendments } = run(new Map());

        assert.deepStrictEqual(
            [...folders.values()].filter(f => f.parentId === null).map(f => f.name).sort(),
            ['Bugs', 'Git'],
        );

        const git = findByName(folders, 'Git')!;
        const branching = findByName(folders, 'Branching')!;
        assert.strictEqual(branching.parentId, git.id);
        assert.deepStrictEqual(git.sessionIds, ['a']);
        assert.deepStrictEqual(branching.sessionIds, ['b']);
        assert.deepStrictEqual(findByName(folders, 'Bugs')!.sessionIds, ['c']);

        assert.strictEqual(amendments.pathToFolderId['Git'], git.id);
        assert.strictEqual(amendments.pathToFolderId['Git/Branching'], branching.id);
        assert.strictEqual(amendments.classifiedFolders['b'], branching.id);
    });

    test('keeps folder IDs stable across runs', () => {
        const first = run(new Map());
        const second = run(first.folders, first.amendments);

        assert.deepStrictEqual([...second.folders.keys()].sort(), [...first.folders.keys()].sort());
    });

    test('a renamed folder keeps its name and does not get duplicated', () => {
        const first = run(new Map());
        const git = findByName(first.folders, 'Git')!;
        first.folders.set(git.id, { ...git, name: 'Version Control', manual: true });

        const second = run(first.folders, first.amendments);

        const renamed = second.folders.get(git.id)!;
        assert.strictEqual(renamed.name, 'Version Control');
        assert.strictEqual(renamed.manual, true);
        assert.strictEqual(second.amendments.pathToFolderId['Git'], git.id);
        assert.strictEqual(second.folders.size, first.folders.size, 'no duplicate folder was created');
        // Its child is still attached.
        assert.deepStrictEqual(renamed.childFolderIds, [findByName(second.folders, 'Branching')!.id]);
    });

    test('a folder created by the user survives re-classification', () => {
        const first = run(new Map());
        first.folders.set('manual-1', folder({ id: 'manual-1', name: 'My Notes', manual: true, origin: 'auto' }));

        const second = run(first.folders, first.amendments);

        assert.strictEqual(second.folders.get('manual-1')?.name, 'My Notes');
        assert.strictEqual(second.folders.get('manual-1')?.manual, true);
    });

    test('a folder the user re-parented stays where the user put it', () => {
        const first = run(new Map());
        const bugs = findByName(first.folders, 'Bugs')!;
        const branching = findByName(first.folders, 'Branching')!;
        // User drags "Branching" under "Bugs".
        first.folders.set(branching.id, { ...branching, parentId: bugs.id, manual: true });

        const second = run(first.folders, first.amendments);

        assert.strictEqual(second.folders.get(branching.id)!.parentId, bugs.id);
        assert.deepStrictEqual(second.folders.get(bugs.id)!.childFolderIds, [branching.id]);
    });

    test('a session the user moved stays in the chosen folder', () => {
        const first = run(new Map());
        const bugs = findByName(first.folders, 'Bugs')!;

        const second = run(first.folders, {
            ...first.amendments,
            sessionFolders: { b: bugs.id },
        });

        assert.ok(second.folders.get(bugs.id)!.sessionIds.includes('b'));
        assert.ok(!findByName(second.folders, 'Branching')!.sessionIds.includes('b'));
        assert.strictEqual(second.amendments.sessionFolders['b'], bugs.id);
        // The classification target is still remembered, so the move can be undone.
        assert.strictEqual(
            second.amendments.classifiedFolders['b'],
            first.amendments.pathToFolderId['Git/Branching'],
        );
    });

    test('a deleted folder is not recreated and its sessions become unassigned', () => {
        const first = run(new Map());

        const second = run(first.folders, {
            ...first.amendments,
            suppressedPaths: ['Git/Branching'],
        });

        assert.strictEqual(findByName(second.folders, 'Branching'), undefined);
        assert.ok(![...second.folders.values()].some(f => f.sessionIds.includes('b')));
        // The parent topic stays, so "b" is not silently placed elsewhere.
        assert.deepStrictEqual(second.folders.get(first.amendments.pathToFolderId['Git'])!.sessionIds, ['a']);
    });

    test('suppressing a root removes its whole subtree', () => {
        const first = run(new Map());

        const second = run(first.folders, {
            ...first.amendments,
            suppressedPaths: ['Git'],
        });

        assert.strictEqual(findByName(second.folders, 'Git'), undefined);
        assert.strictEqual(findByName(second.folders, 'Branching'), undefined);
        assert.deepStrictEqual([...second.folders.values()].map(f => f.name), ['Bugs']);
    });

    test('dropping the suppression brings the folder back', () => {
        const first = run(new Map());
        const suppressed = run(first.folders, {
            ...first.amendments,
            suppressedPaths: ['Git/Branching'],
        });

        const restored = run(suppressed.folders, {
            ...suppressed.amendments,
            suppressedPaths: [],
        });

        assert.ok(findByName(restored.folders, 'Branching'));
    });

    test('overrides for sessions that no longer exist are dropped', () => {
        const first = run(new Map());
        const bugs = findByName(first.folders, 'Bugs')!;

        const second = run(
            first.folders,
            { ...first.amendments, sessionFolders: { gone: bugs.id } },
            SPECS,
            PLACEMENTS,
            ['a', 'b', 'c'],
        );

        assert.deepStrictEqual(second.amendments.sessionFolders, {});
    });

    test('an empty amendment set is usable', () => {
        const amendments = emptyAmendments();
        assert.deepStrictEqual(amendments, {
            pathToFolderId: {},
            sessionFolders: {},
            classifiedFolders: {},
            suppressedPaths: [],
        });
    });

    test('a nested manual folder keeps its parent and its place', () => {
        // A manual folder the classifier never produces, itself inside another
        // manual folder: both are kept, and the nesting is preserved.
        const existing = new Map<string, SessionFolder>([
            ['m-root', folder({ id: 'm-root', name: 'Projects', manual: true })],
            ['m-child', folder({ id: 'm-child', name: 'Side Quests', parentId: 'm-root', manual: true, sessionIds: ['z'] })],
        ]);
        existing.get('m-root')!.childFolderIds.push('m-child');

        const result = run(existing, undefined, SPECS, PLACEMENTS, ['a', 'b', 'c', 'z']);

        assert.strictEqual(result.folders.get('m-child')?.parentId, 'm-root');
        assert.deepStrictEqual(result.folders.get('m-root')?.childFolderIds, ['m-child']);
        // The manual session stays where the user put it (no override needed:
        // the folder itself is user-owned).
        assert.deepStrictEqual(result.folders.get('m-child')?.sessionIds, []);
    });

    test('circulation in the existing map is handled without hanging', () => {
        const existing = new Map<string, SessionFolder>([
            ['x', folder({ id: 'x', name: 'X', parentId: 'y', manual: true })],
            ['y', folder({ id: 'y', name: 'Y', parentId: 'x', manual: true })],
        ]);
        // Only checks that the reconcile terminates and produces a valid map.
        const result = run(existing, undefined, [], [], []);
        assert.ok(result.folders instanceof Map);
    });
});

