/**
 * test/unit/classificationStore.test.ts
 *
 * Unit tests for the shared classification state used by both the knowledge
 * base and the automatic folder tree.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ClassificationStore,
    CLASSIFICATION_STORE_VERSION,
    sessionFingerprint,
    sessionFingerprintFrom,
} from '../../src/analytics/classificationStore';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-clsstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

suite('ClassificationStore', () => {
    let dir: string;

    setup(() => { dir = tmpDir(); });
    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('loads empty state when the file is missing', async () => {
        const store = new ClassificationStore(dir);
        const data = await store.load();
        assert.strictEqual(data.version, CLASSIFICATION_STORE_VERSION);
        assert.strictEqual(data.revision, 0);
        assert.deepStrictEqual(data.entries, {});
        assert.strictEqual(store.isEmpty(), true);
        assert.strictEqual(store.getRevision(), 0);
    });

    test('loads empty state on corrupt JSON', async () => {
        fs.writeFileSync(path.join(dir, 'chatwizard-classification.json'), 'not json', 'utf-8');
        const store = new ClassificationStore(dir);
        assert.strictEqual(store.isEmpty(), true);
    });

    test('persists entries and bumps the revision', async () => {
        const store = new ClassificationStore(dir);
        const data = await store.load();
        data.entries['s1'] = {
            category: 'Git',
            subcategory: 'Branching',
            usedLlm: true,
            fingerprint: 'fp1',
            classifiedAt: '2024-01-01T00:00:00Z',
        };
        await store.save(data);

        assert.strictEqual(store.getRevision(), 1);
        assert.strictEqual(store.get('s1')?.category, 'Git');
        assert.strictEqual(store.isEmpty(), false);

        // A second instance reads the same data from disk.
        const reloaded = new ClassificationStore(dir);
        await reloaded.load();
        assert.strictEqual(reloaded.getRevision(), 1);
        assert.strictEqual(reloaded.get('s1')?.subcategory, 'Branching');
    });

    test('save without bumpRevision keeps the revision', async () => {
        const store = new ClassificationStore(dir);
        const data = await store.load();
        await store.save(data);
        await store.save(data, false);
        assert.strictEqual(store.getRevision(), 1);
    });

    test('toClassifications returns every entry in classifier shape', async () => {
        const store = new ClassificationStore(dir);
        await store.importClassifications(
            [
                { sessionId: 'a', category: 'Git', subcategory: 'Branching', usedLlm: true },
                { sessionId: 'b', category: 'Bugs', usedLlm: false },
            ],
            id => `fp-${id}`,
        );

        const all = store.toClassifications();
        assert.deepStrictEqual(all.map(c => c.sessionId).sort(), ['a', 'b']);
        assert.deepStrictEqual(
            all.find(c => c.sessionId === 'a'),
            { sessionId: 'a', category: 'Git', subcategory: 'Branching', subSubcategory: undefined, usedLlm: true },
        );
    });

    test('importClassifications skips unknown sessions and existing entries', async () => {
        const store = new ClassificationStore(dir);
        const imported = await store.importClassifications(
            [
                { sessionId: 'known', category: 'Git' },
                { sessionId: 'unknown', category: 'Bugs' },
                { sessionId: 'known', category: 'Testing' },
                { sessionId: '', category: 'Nothing' },
            ],
            id => (id === 'unknown' ? undefined : 'fp'),
        );

        assert.strictEqual(imported, 1);
        assert.strictEqual(store.get('known')?.category, 'Git');
        assert.strictEqual(store.get('unknown'), undefined);

        // A second import does not overwrite what is already there.
        const again = await store.importClassifications(
            [{ sessionId: 'known', category: 'Changed' }],
            () => 'fp',
        );
        assert.strictEqual(again, 0);
        assert.strictEqual(store.get('known')?.category, 'Git');
    });

    test('prune drops sessions that no longer exist', async () => {
        const store = new ClassificationStore(dir);
        await store.importClassifications(
            [
                { sessionId: 'keep', category: 'Git' },
                { sessionId: 'gone', category: 'Bugs' },
            ],
            () => 'fp',
        );

        const removed = await store.prune(new Set(['keep']));
        assert.strictEqual(removed, 1);
        assert.strictEqual(store.get('gone'), undefined);
        assert.ok(store.get('keep'));

        assert.strictEqual(await store.prune(new Set(['keep'])), 0);
    });

    test('remove deletes a single entry', async () => {
        const store = new ClassificationStore(dir);
        await store.importClassifications([{ sessionId: 'a', category: 'Git' }], () => 'fp');

        await store.remove('a');
        assert.strictEqual(store.get('a'), undefined);
        // Removing a missing entry is a no-op (no extra revision bump).
        await store.remove('a');
        assert.strictEqual(store.getRevision(), 2);
    });

    test('clear wipes the state and bumps the revision', async () => {
        const store = new ClassificationStore(dir);
        await store.importClassifications([{ sessionId: 'a', category: 'Git' }], () => 'fp');
        await store.clear();

        assert.strictEqual(store.isEmpty(), true);
        assert.strictEqual(store.getRevision(), 2);

        // Clearing again is a no-op (the file is already gone).
        await store.clear();
        assert.strictEqual(store.getRevision(), 3);
        assert.strictEqual(store.isEmpty(), true);
    });

    test('notifies listeners, and a disposed listener is not called', async () => {
        const store = new ClassificationStore(dir);
        const revisions: number[] = [];
        const sub = store.onDidChange(r => revisions.push(r));

        await store.importClassifications([{ sessionId: 'a', category: 'Git' }], () => 'fp');
        sub.dispose();
        await store.importClassifications([{ sessionId: 'b', category: 'Bugs' }], () => 'fp');

        assert.deepStrictEqual(revisions, [1]);
    });

    test('a throwing listener does not break the store', async () => {
        const store = new ClassificationStore(dir);
        store.onDidChange(() => { throw new Error('boom'); });
        const seen: number[] = [];
        store.onDidChange(r => seen.push(r));

        await store.importClassifications([{ sessionId: 'a', category: 'Git' }], () => 'fp');
        assert.deepStrictEqual(seen, [1]);
    });

    test('getEntries exposes the current map', async () => {
        const store = new ClassificationStore(dir);
        await store.importClassifications([{ sessionId: 'a', category: 'Git' }], () => 'fp');
        assert.deepStrictEqual(Object.keys(store.getEntries()), ['a']);
        assert.deepStrictEqual(new ClassificationStore(dir).getEntries(), {});
    });

    test('migrates a v1 state: drops labels folded by the old view cap', async () => {
        // A v1 file is what the previous build wrote: the auto-tree's category cap
        // folded the smallest topics into "Other" (keeping their sub-topic) and a
        // third folder level was stored. Both changed what the KB displayed.
        const file = path.join(dir, 'chatwizard-classification.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            revision: 4,
            entries: {
                kept: {
                    category: 'Git', subcategory: 'Branching', subSubcategory: 'Merge Conflicts',
                    usedLlm: true, fingerprint: 'fp', classifiedAt: '2024-01-01T00:00:00Z',
                },
                folded: {
                    category: 'Other', subcategory: 'Docker Compose',
                    usedLlm: true, fingerprint: 'fp', classifiedAt: '2024-01-01T00:00:00Z',
                },
                genuinelyOther: {
                    category: 'Other', usedLlm: false, fingerprint: 'fp', classifiedAt: '2024-01-01T00:00:00Z',
                },
            },
        }), 'utf-8');

        const store = new ClassificationStore(dir);
        await store.load();

        assert.strictEqual(store.get('folded'), undefined, 'folded labels are re-classified');
        assert.strictEqual(store.get('kept')?.category, 'Git');
        assert.strictEqual(store.get('kept')?.subcategory, 'Branching');
        assert.strictEqual(store.get('kept')?.subSubcategory, undefined, 'canonical state has two levels');
        assert.strictEqual(store.get('genuinelyOther')?.category, 'Other', 'a real "Other" survives');
        assert.strictEqual(store.getRevision(), 4, 'a repair is not a change: no revision bump');

        // The repair is persisted, so the next start does not redo it.
        const persisted = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.strictEqual(persisted.version, CLASSIFICATION_STORE_VERSION);
        assert.strictEqual(persisted.entries.folded, undefined);
    });

    test('busy notifications are ref-counted transitions', async () => {
        const store = new ClassificationStore(dir);
        const events: Array<[boolean, string | undefined]> = [];
        const sub = store.onDidChangeBusy((busy, label) => events.push([busy, label]));

        assert.strictEqual(store.isBusy(), false);
        const endOuter = store.beginWork('Classifying 3 chats…');
        const endInner = store.beginWork('Classifying 1 chat…');
        assert.strictEqual(store.isBusy(), true);
        assert.strictEqual(store.getBusyLabel(), 'Classifying 3 chats…');

        endInner();
        assert.strictEqual(store.isBusy(), true, 'still busy while the outer run continues');
        endInner(); // double end is ignored
        endOuter();
        assert.strictEqual(store.isBusy(), false);
        assert.strictEqual(store.getBusyLabel(), undefined);

        sub.dispose();
        store.beginWork()();
        assert.strictEqual(events.length, 2, 'a disposed listener is not called');
        assert.deepStrictEqual(events, [
            [true, 'Classifying 3 chats…'],
            [false, undefined],
        ]);
    });

    test('a write failure keeps the in-memory state and never throws', async () => {
        // A file where the store expects a directory makes mkdir/write fail.
        const bogusDir = path.join(dir, 'not-a-directory');
        fs.writeFileSync(bogusDir, 'x', 'utf-8');
        const store = new ClassificationStore(bogusDir);

        const data = await store.load();
        data.entries['a'] = {
            category: 'Git', usedLlm: false, fingerprint: 'fp', classifiedAt: '2024-01-01T00:00:00Z',
        };
        await store.save(data);

        assert.strictEqual(store.get('a')?.category, 'Git', 'memory stays authoritative');
        assert.strictEqual(store.getRevision(), 1);
    });

    test('session fingerprints are stable and content-sensitive', () => {
        assert.strictEqual(
            sessionFingerprint({ updatedAt: '2024-01-01T00:00:00Z', messages: [{ length: 1 }, { length: 1 }] }),
            sessionFingerprintFrom('2024-01-01T00:00:00Z', 2),
        );
        assert.notStrictEqual(
            sessionFingerprintFrom('2024-01-01T00:00:00Z', 2),
            sessionFingerprintFrom('2024-02-02T00:00:00Z', 2),
        );
        assert.notStrictEqual(
            sessionFingerprintFrom('2024-01-01T00:00:00Z', 2),
            sessionFingerprintFrom('2024-01-01T00:00:00Z', 3),
        );
    });
});

