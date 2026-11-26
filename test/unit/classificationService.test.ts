/**
 * test/unit/classificationService.test.ts
 *
 * The shared classification service is what makes the KB view and the automatic
 * folder tree one classification instead of two: a stored label is reused, only
 * new/changed chats reach the model, and either feature can start from the
 * other's results.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClassificationStore } from '../../src/analytics/classificationStore';
import { sessionFingerprintFrom } from '../../src/analytics/classificationStore';
import { classifySessionsShared, seedFromStore } from '../../src/analytics/classificationService';
import type { LabelRefinementInput, SingleClassification } from '../../src/analytics/chatSessionClassifier';
import type { Message, Session } from '../../src/types/index';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-clssvc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function msg(content: string): Message {
    return { id: `m-${Math.random()}`, role: 'user', content, codeBlocks: [] };
}

function makeSession(id: string, updatedAt = '2024-01-01T00:00:00Z', messageCount = 1): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        messages: Array.from({ length: messageCount }, (_, i) => msg(`Prompt ${i} for ${id}`)),
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt,
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${id}.jsonl`,
    };
}

const LABELS: Record<string, SingleClassification> = {
    a: { category: 'Git', subcategory: 'Branching', usedLlm: true },
    b: { category: 'Bugs', subcategory: 'Crash', usedLlm: true },
};

suite('classificationService — shared, incremental classification', () => {
    let dir: string;
    let store: ClassificationStore;

    setup(() => {
        dir = tmpDir();
        store = new ClassificationStore(dir);
    });
    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    /** Classifier deps that count calls and return fixed labels. */
    function countingDeps() {
        const classified: string[] = [];
        const refinements: number[] = [];
        return {
            classified,
            refinements,
            deps: {
                classifyOne: async (session: Session) => {
                    classified.push(session.id);
                    return LABELS[session.id] ?? { category: 'Other', usedLlm: false };
                },
                refineCategories: async (labels: string[]) => {
                    refinements.push(labels.length);
                    return null;
                },
                refineLabelsUnderParent: async (_inputs: LabelRefinementInput[]) => null,
            },
        };
    }

    test('classifies new sessions and stores them', async () => {
        const { classified, deps } = countingDeps();
        const sessions = [makeSession('a'), makeSession('b')];

        const result = await classifySessionsShared(sessions, store, { levels: 2 }, deps);

        assert.strictEqual(result.newlyClassified, 2);
        assert.strictEqual(result.reused, 0);
        assert.strictEqual(result.changed, 2);
        assert.strictEqual(result.usedLlm, true);
        assert.deepStrictEqual(classified, ['a', 'b']);
        assert.deepStrictEqual(result.classifications.map(c => c.category), ['Git', 'Bugs']);

        assert.strictEqual(store.get('a')?.category, 'Git');
        assert.strictEqual(store.get('a')?.fingerprint, sessionFingerprintFrom('2024-01-01T00:00:00Z', 1));
        assert.strictEqual(store.getRevision(), 1);
    });

    test('reuses stored labels for unchanged sessions', async () => {
        const sessions = [makeSession('a'), makeSession('b')];
        await classifySessionsShared(sessions, store, { levels: 2 }, countingDeps().deps);

        const second = countingDeps();
        const result = await classifySessionsShared(sessions, store, { levels: 2 }, second.deps);

        assert.strictEqual(result.newlyClassified, 0);
        assert.strictEqual(result.reused, 2);
        assert.strictEqual(result.changed, 0);
        assert.deepStrictEqual(second.classified, [], 'no model call for unchanged chats');
        assert.strictEqual(store.getRevision(), 1, 'nothing changed → no write, no revision bump');
        assert.deepStrictEqual(result.classifications.map(c => c.category), ['Git', 'Bugs']);
    });

    test('re-classifies only the chats whose content changed', async () => {
        await classifySessionsShared([makeSession('a'), makeSession('b')], store, { levels: 2 }, countingDeps().deps);

        const second = countingDeps();
        const changed = [makeSession('a', '2024-05-05T00:00:00Z'), makeSession('b')];
        const result = await classifySessionsShared(changed, store, { levels: 2 }, second.deps);

        assert.strictEqual(result.newlyClassified, 1);
        assert.strictEqual(result.reused, 1);
        assert.deepStrictEqual(second.classified, ['a']);
        assert.strictEqual(store.getRevision(), 2);
    });

    test('skips the label-consolidation passes when nothing new was classified', async () => {
        const sessions = [makeSession('a'), makeSession('b')];
        const first = countingDeps();
        await classifySessionsShared(sessions, store, { levels: 2 }, first.deps);
        assert.deepStrictEqual(first.refinements, [2], 'consolidation runs when new labels appear');

        const second = countingDeps();
        await classifySessionsShared(sessions, store, { levels: 2 }, second.deps);
        assert.deepStrictEqual(second.refinements, [], 'no consolidation work on a no-op run');
    });

    test('consolidates once more when the stored labels were never consolidated', async () => {
        const sessions = [makeSession('a'), makeSession('b')];

        // First run with the consolidation disabled — as happens when the model is
        // rate-limited and the pass fails: the labels are stored raw.
        await classifySessionsShared(sessions, store, { levels: 2, refineLabels: false }, countingDeps().deps);

        // The next run must fix the granularity instead of reusing raw labels
        // forever (this is what made the KB show far too many top-level topics).
        const second = countingDeps();
        await classifySessionsShared(sessions, store, { levels: 2 }, second.deps);
        assert.deepStrictEqual(second.classified, [], 'still no model call per chat');
        assert.deepStrictEqual(second.refinements, [2], 'the labels are consolidated');

        // Once consolidated, a no-op run stops spending calls on it.
        const third = countingDeps();
        await classifySessionsShared(sessions, store, { levels: 2 }, third.deps);
        assert.deepStrictEqual(third.refinements, []);
    });


    test('the other feature\'s results are the starting state ("KB first")', async () => {
        const sessions = [makeSession('a'), makeSession('b')];
        // Simulates the KB having stored its classifications already.
        await store.importClassifications(
            [
                { sessionId: 'a', category: 'Version Control', subcategory: 'Branches', usedLlm: true },
                { sessionId: 'b', category: 'Defects', usedLlm: true },
            ],
            () => sessionFingerprintFrom('2024-01-01T00:00:00Z', 1),
        );

        const { classified, deps } = countingDeps();
        const result = await classifySessionsShared(sessions, store, { levels: 3 }, deps);

        assert.strictEqual(result.reused, 2);
        assert.strictEqual(result.newlyClassified, 0);
        assert.deepStrictEqual(classified, [], 'the shared labels are reused, not recomputed');
        assert.deepStrictEqual(result.classifications.map(c => c.category), ['Version Control', 'Defects']);
    });


    test('pruneMissing drops classifications for sessions no longer in the history', async () => {
        await store.importClassifications(
            [
                { sessionId: 'a', category: 'Git' },
                { sessionId: 'gone', category: 'Bugs' },
            ],
            id => (id === 'a' ? sessionFingerprintFrom('2024-01-01T00:00:00Z', 1) : 'fp'),
        );

        const result = await classifySessionsShared(
            [makeSession('a')],
            store,
            { levels: 2, pruneMissing: true },
            countingDeps().deps,
        );

        assert.strictEqual(result.newlyClassified, 0);
        assert.strictEqual(store.get('gone'), undefined);
        assert.ok(store.get('a'));
    });

    test('incremental: false re-classifies everything', async () => {
        const sessions = [makeSession('a')];
        await classifySessionsShared(sessions, store, { levels: 2 }, countingDeps().deps);

        const second = countingDeps();
        const result = await classifySessionsShared(
            sessions, store, { levels: 2, incremental: false }, second.deps,
        );

        assert.strictEqual(result.newlyClassified, 1);
        assert.strictEqual(result.reused, 0);
        assert.deepStrictEqual(second.classified, ['a']);
    });

    test('an empty history is a no-op', async () => {
        const result = await classifySessionsShared([], store, {}, countingDeps().deps);
        assert.deepStrictEqual(result.classifications, []);
        assert.strictEqual(result.newlyClassified, 0);
        assert.strictEqual(store.isEmpty(), true);
    });

    test('announces in-flight work so views can show a classifying indicator', async () => {
        const events: boolean[] = [];
        const sub = store.onDidChangeBusy(busy => events.push(busy));

        await classifySessionsShared([makeSession('a'), makeSession('b')], store, { levels: 2 }, countingDeps().deps);
        sub.dispose();

        assert.deepStrictEqual(events, [true, false]);
        assert.strictEqual(store.isBusy(), false);
    });

    test('a run that classifies nothing does not announce work', async () => {
        await classifySessionsShared([makeSession('a')], store, { levels: 2 }, countingDeps().deps);

        const events: boolean[] = [];
        const sub = store.onDidChangeBusy(busy => events.push(busy));
        await classifySessionsShared([makeSession('a')], store, { levels: 2 }, countingDeps().deps);
        sub.dispose();

        assert.deepStrictEqual(events, [], 'no indicator flicker for an incremental no-op');
    });

    test('releases the busy flag even when every session fails to classify', async () => {
        const result = await classifySessionsShared(
            [makeSession('boom')],
            store,
            { levels: 2 },
            { classifyOne: async () => { throw new Error('model exploded'); } },
        );

        assert.strictEqual(result.classifications[0].category, 'Other');
        assert.strictEqual(store.isBusy(), false, 'the busy flag is always released');
    });

    test('seedFromStore returns a label only while the chat is unchanged', async () => {
        const session = makeSession('a');
        await classifySessionsShared([session], store, { levels: 2 }, countingDeps().deps);

        const seed = seedFromStore(store, session);
        assert.ok(seed);
        assert.strictEqual(seed!.category, 'Git');

        const edited = makeSession('a', '2024-06-06T00:00:00Z');
        assert.strictEqual(seedFromStore(store, edited), undefined);
        assert.strictEqual(seedFromStore(new ClassificationStore(dir), edited), undefined);
    });
});

