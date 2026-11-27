/**
 * test/unit/chatSessionArranger.test.ts
 *
 * Unit tests for the automatic chat-history arranger: tree building, depth
 * handling, the "history didn't change" gate, and the isolation of the
 * auto-classified tree from the user's own folders.
 *
 * The classifier is injected, so nothing here reaches a model.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FolderStore } from '../../src/index/folderStore';
import type { SessionIndex } from '../../src/index/sessionIndex';
import { AutoClassifyStore } from '../../src/analytics/autoClassifyStore';
import { ClassificationStore, sessionFingerprintFrom } from '../../src/analytics/classificationStore';
import {
    ChatSessionArranger,
    buildFolderTreeSpec,
    computeHistoryFingerprint,
    clampDepth,
    summarizeTree,
    DEFAULT_AUTO_CLASSIFY_CONFIG,
} from '../../src/analytics/chatSessionArranger';
import type { AutoClassifyConfig } from '../../src/analytics/chatSessionArranger';
import type { SessionClassification } from '../../src/analytics/chatSessionClassifier';
import type { BoundLogger } from '../../src/utils/logger';
import type { Message, Session, SessionSummary } from '../../src/types/index';

const AUTO_FOLDER_FILE = 'chatwizard-auto-folders.json';

/** No-op logger — the arranger only needs the interface. */
const silentLog = {
    debug: () => { /* no-op */ },
    info: () => { /* no-op */ },
    warn: () => { /* no-op */ },
    error: () => { /* no-op */ },
    withContext: () => silentLog,
    getChannel: () => { throw new Error('not available in tests'); },
    setLevel: () => { /* no-op */ },
} as unknown as BoundLogger;

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-arranger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function msg(content: string): Message {
    return { id: `m-${Math.random()}`, role: 'user', content, codeBlocks: [] };
}

function makeSession(id: string, updatedAt = '2024-01-01T00:00:00Z'): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        messages: [msg(`Prompt ${id}`)],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt,
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${id}.jsonl`,
    };
}

function makeSummary(session: Session, updatedAt = session.updatedAt): SessionSummary {
    return {
        id: session.id,
        title: session.title,
        source: session.source,
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        filePath: session.filePath,
        messageCount: session.messages.length,
        userMessageCount: 1,
        assistantMessageCount: 0,
        createdAt: session.createdAt,
        updatedAt,
    };
}

/** SessionIndex stand-in — every access goes through the injected options. */
const stubIndex = {} as unknown as SessionIndex;

/** A label per session id, so tests can assert placement precisely. */
const DEFAULT_LABELS: Record<string, SessionClassification> = {
    git1: { sessionId: 'git1', category: 'Git', subcategory: 'Branching', subSubcategory: 'Merge Conflicts', usedLlm: true },
    git2: { sessionId: 'git2', category: 'Git', subcategory: 'Branching', subSubcategory: 'Cleanup', usedLlm: true },
    git3: { sessionId: 'git3', category: 'Git', usedLlm: true },
    bug1: { sessionId: 'bug1', category: 'Bugs', subcategory: 'Crash', usedLlm: true },
};

interface Harness {
    arranger: ChatSessionArranger;
    autoStore: FolderStore;
    stateStore: AutoClassifyStore;
    classificationStore: ClassificationStore;
    dir: string;
    classifyCalls: () => number;
}

function makeHarness(
    sessions: Session[],
    options: {
        summaries?: SessionSummary[];
        labels?: Record<string, SessionClassification>;
        config?: Partial<AutoClassifyConfig>;
    } = {},
): Harness {
    const dir = tmpDir();
    const autoStore = new FolderStore(dir, AUTO_FOLDER_FILE);
    const stateStore = new AutoClassifyStore(dir);
    const classificationStore = new ClassificationStore(dir);
    const labels = options.labels ?? DEFAULT_LABELS;
    let calls = 0;

    const config: AutoClassifyConfig = { ...DEFAULT_AUTO_CLASSIFY_CONFIG, ...options.config };

    const arranger = new ChatSessionArranger(stubIndex, autoStore, stateStore, classificationStore, {
        getSummaries: () => options.summaries ?? sessions.map(s => makeSummary(s)),
        getSession: id => sessions.find(s => s.id === id),
        classify: async (toClassify) => {
            calls++;
            return toClassify.map(s => labels[s.id] ?? { sessionId: s.id, category: 'Other', usedLlm: false });
        },
        log: silentLog,
    });
    arranger.start(() => config);

    return { arranger, autoStore, stateStore, classificationStore, dir, classifyCalls: () => calls };
}

suite('chatSessionArranger', () => {
    const createdDirs: string[] = [];

    teardown(() => {
        for (const dir of createdDirs.splice(0)) {
            try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
        }
    });

    /** Runs the harness and registers its directory for cleanup. */
    function harness(sessions: Session[], options?: Parameters<typeof makeHarness>[1]): Harness {
        const h = makeHarness(sessions, options);
        createdDirs.push(h.dir);
        return h;
    }

    async function stopAll(...hs: Harness[]): Promise<void> {
        for (const h of hs) { h.arranger.stop(); }
    }

    suite('folder tree building', () => {

        test('builds topic → sub-topic → sub-sub-topic folders', () => {
            const tree = buildFolderTreeSpec(Object.values(DEFAULT_LABELS), 3);

            assert.deepStrictEqual(tree.map(n => n.name), ['Git', 'Bugs']);

            const git = tree[0];
            assert.deepStrictEqual(git.sessionIds, ['git3'], 'sessions without a sub-topic stay in the topic folder');
            assert.strictEqual(git.children?.length, 1);

            const branching = git.children![0];
            assert.strictEqual(branching.name, 'Branching');
            assert.deepStrictEqual(
                branching.children?.map(n => n.name).sort(),
                ['Cleanup', 'Merge Conflicts'],
            );
            assert.deepStrictEqual(branching.children!.find(n => n.name === 'Merge Conflicts')!.sessionIds, ['git1']);
        });

        test('depth 2 flattens the third level into the sub-topic', () => {
            const tree = buildFolderTreeSpec(Object.values(DEFAULT_LABELS), 2);
            const branching = tree[0].children![0];
            assert.deepStrictEqual(branching.sessionIds?.sort(), ['git1', 'git2']);
            assert.strictEqual(branching.children, undefined);
        });

        test('depth 1 keeps only topic folders', () => {
            const tree = buildFolderTreeSpec(Object.values(DEFAULT_LABELS), 1);
            assert.deepStrictEqual(tree.map(n => n.name), ['Git', 'Bugs']);
            assert.deepStrictEqual(tree[0].sessionIds?.sort(), ['git1', 'git2', 'git3']);
            assert.strictEqual(tree[0].children, undefined);
        });

        test('clamps the depth into the supported 1–3 range', () => {
            assert.strictEqual(clampDepth(0), 1);
            assert.strictEqual(clampDepth(9), 3);
            assert.strictEqual(clampDepth(undefined), 3);
            assert.strictEqual(clampDepth(2), 2);
        });

        test('summarizes each root folder for the run state', () => {
            const summary = summarizeTree(buildFolderTreeSpec(Object.values(DEFAULT_LABELS), 3));
            assert.deepStrictEqual(summary, [
                { name: 'Git', sessionCount: 3, subcategoryCount: 1 },
                { name: 'Bugs', sessionCount: 1, subcategoryCount: 1 },
            ]);
        });
    });

    suite('history fingerprint', () => {

        test('is stable regardless of summary order', () => {
            const a = makeSummary(makeSession('a'));
            const b = makeSummary(makeSession('b'), '2024-02-02T00:00:00Z');
            assert.strictEqual(
                computeHistoryFingerprint([a, b]),
                computeHistoryFingerprint([b, a]),
            );
        });

        test('changes when a session is updated', () => {
            const a = makeSummary(makeSession('a'));
            const updated = makeSummary(makeSession('a', '2024-03-03T00:00:00Z'));
            assert.notStrictEqual(
                computeHistoryFingerprint([a]),
                computeHistoryFingerprint([updated]),
            );
        });

        test('changes when the session count changes', () => {
            const a = makeSummary(makeSession('a'));
            const b = makeSummary(makeSession('b'));
            assert.notStrictEqual(
                computeHistoryFingerprint([a]),
                computeHistoryFingerprint([a, b]),
            );
        });
    });


    suite('runs', () => {

        test('builds the folder tree and persists the run state', async () => {
            const sessions = Object.keys(DEFAULT_LABELS).map(id => makeSession(id));
            const h = harness(sessions);

            const result = await h.arranger.run({ force: true });

            assert.strictEqual(result.ran, true);
            assert.strictEqual(result.reason, 'completed');
            assert.strictEqual(result.sessionCount, 4);
            assert.strictEqual(result.categoryCount, 2);
            // 2 topics + 2 sub-topics (Branching, Crash) — the classification
            // carries two levels, exactly like the KB pie chart's slices/drill.
            assert.strictEqual(result.folderCount, 4);

            const folders = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            const roots = [...folders.values()].filter(f => f.parentId === null);
            assert.deepStrictEqual(roots.map(f => f.name).sort(), ['Bugs', 'Git']);
            assert.ok(roots.every(f => f.origin === 'auto'));

            const state = await h.stateStore.load();
            assert.ok(state, 'run state should be persisted');
            assert.strictEqual(state!.sessionCount, 4);
            assert.strictEqual(state!.categoryCount, DEFAULT_AUTO_CLASSIFY_CONFIG.categoryCount);
            assert.strictEqual(state!.maxDepth, DEFAULT_AUTO_CLASSIFY_CONFIG.maxDepth);
            assert.deepStrictEqual(state!.categories.map(c => c.name), ['Git', 'Bugs']);

            await stopAll(h);
        });

        test('skips the run when the history did not change', async () => {
            const sessions = Object.keys(DEFAULT_LABELS).map(id => makeSession(id));
            const h = harness(sessions);

            const first = await h.arranger.run({ force: true });
            const second = await h.arranger.run();

            assert.strictEqual(first.ran, true);
            assert.strictEqual(second.ran, false);
            assert.strictEqual(second.reason, 'unchanged');
            assert.strictEqual(h.classifyCalls(), 1, 'the classifier must not run twice');

            await stopAll(h);
        });

        test('re-runs after a session changes', async () => {
            const sessions = ['git1', 'git2', 'git3', 'bug1'].map(id => makeSession(id));
            const summaries = sessions.map(s => makeSummary(s));
            const h = harness(sessions, { summaries });

            await h.arranger.run({ force: true });
            assert.strictEqual(h.classifyCalls(), 1);

            // Simulate an edit: one session's updatedAt moves forward.
            summaries[0] = makeSummary(sessions[0], '2024-05-05T00:00:00Z');

            const result = await h.arranger.run();
            assert.strictEqual(result.ran, true);
            assert.strictEqual(result.reason, 'completed');
            assert.strictEqual(h.classifyCalls(), 2);

            await stopAll(h);
        });

        test('re-runs when a setting changed', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);

            await h.arranger.run({ force: true });
            const result = await h.arranger.run({
                config: { ...DEFAULT_AUTO_CLASSIFY_CONFIG, categoryCount: 1 },
            });

            assert.strictEqual(result.reason, 'completed');
            assert.strictEqual(h.classifyCalls(), 2);

            await stopAll(h);
        });

        test('applies the category cap to the tree only', async () => {
            // Three topics, cap of two: the smallest one is folded into "Other" in
            // this tree — the classifications the classifier returned are untouched
            // (that is what keeps the KB pie chart at full detail).
            const sessions = ['git1', 'git2', 'bug1', 'docker1'].map(id => makeSession(id));
            const labels: Record<string, SessionClassification> = {
                ...DEFAULT_LABELS,
                docker1: { sessionId: 'docker1', category: 'Docker', usedLlm: true },
            };
            const h = harness(sessions, { labels, config: { categoryCount: 2 } });

            const result = await h.arranger.run({ force: true });
            assert.strictEqual(result.ran, true);
            assert.strictEqual(result.categoryCount, 2);

            const folders = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            const roots = [...folders.values()].filter(f => f.parentId === null);
            assert.deepStrictEqual(roots.map(f => f.name).sort(), ['Git', 'Other']);

            await stopAll(h);
        });

        test('force re-runs an unchanged history', async () => {
            const sessions = Object.keys(DEFAULT_LABELS).map(id => makeSession(id));
            const h = harness(sessions);

            await h.arranger.run({ force: true });
            const forced = await h.arranger.run({ force: true });

            assert.strictEqual(forced.reason, 'completed');
            assert.strictEqual(h.classifyCalls(), 2);

            await stopAll(h);
        });

        test('respects the configured depth', async () => {
            const sessions = Object.keys(DEFAULT_LABELS).map(id => makeSession(id));
            const h = harness(sessions, { config: { maxDepth: 2 } });

            const result = await h.arranger.run({ force: true });
            assert.strictEqual(result.ran, true);

            const folders = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            // 2 roots + 2 sub-topic folders (Branching, Crash) — no third level.
            assert.strictEqual(folders.size, 4);
            assert.ok([...folders.values()].every(f => f.origin === 'auto'));

            await stopAll(h);
        });

        test('does nothing when disabled and not forced', async () => {
            const sessions = [makeSession('git1')];
            const h = harness(sessions, { config: { enabled: false } });
            h.arranger.stop();

            const result = await h.arranger.run({ config: { ...DEFAULT_AUTO_CLASSIFY_CONFIG, enabled: false } });

            assert.strictEqual(result.ran, false);
            assert.strictEqual(result.reason, 'disabled');
            assert.strictEqual(h.classifyCalls(), 0);

            await stopAll(h);
        });

        test('clears the auto tree when the history becomes empty', async () => {
            const sessions = [makeSession('git1')];
            const h = harness(sessions);
            await h.arranger.run({ force: true });
            assert.ok((await new FolderStore(h.dir, AUTO_FOLDER_FILE).load()).size > 0);

            // Same storage, but now the index reports no sessions at all.
            const store = new FolderStore(h.dir, AUTO_FOLDER_FILE);
            await store.load();
            const arranger = new ChatSessionArranger(stubIndex, store, h.stateStore, new ClassificationStore(h.dir), {
                getSummaries: () => [],
                getSession: () => undefined,
                classify: async () => [],
                log: silentLog,
            });
            const result = await arranger.run({ force: true });

            assert.strictEqual(result.reason, 'no-sessions');
            assert.strictEqual((await new FolderStore(h.dir, AUTO_FOLDER_FILE).load()).size, 0);

            await stopAll(h);
        });

        test('never touches the user folder tree', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);

            // A user folder lives in its own file in the same directory.
            const userStore = new FolderStore(h.dir);
            await userStore.load();
            const userFolder = await userStore.createFolder('My Own Folder');
            await userStore.moveSessionToFolder('git1', userFolder.id);

            await h.arranger.run({ force: true });

            const reloadedUserStore = new FolderStore(h.dir);
            const userFolders = await reloadedUserStore.load();
            assert.strictEqual(userFolders.size, 1);
            const only = [...userFolders.values()][0];
            assert.strictEqual(only.name, 'My Own Folder');
            assert.strictEqual(only.origin, 'user');
            assert.deepStrictEqual(only.sessionIds, ['git1']);

            // The auto tree exists in parallel and also groups git1.
            const autoFolders = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            assert.ok([...autoFolders.values()].some(f => f.sessionIds.includes('git1')));

            await stopAll(h);
        });

        test('keeps the previous tree when no model produced a topic', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            await h.arranger.run({ force: true });
            const before = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            assert.ok(before.size > 0);

            const store = new FolderStore(h.dir, AUTO_FOLDER_FILE);
            await store.load();
            const arranger = new ChatSessionArranger(stubIndex, store, h.stateStore, new ClassificationStore(h.dir), {
                getSummaries: () => sessions.map(s => makeSummary(s)),
                getSession: id => sessions.find(s => s.id === id),
                classify: async toClassify =>
                    toClassify.map(s => ({ sessionId: s.id, category: 'Other', usedLlm: false })),
                log: silentLog,
            });

            const result = await arranger.run({ force: true });

            assert.strictEqual(result.ran, false);
            assert.strictEqual(result.reason, 'no-signal');
            const after = await new FolderStore(h.dir, AUTO_FOLDER_FILE).load();
            assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort());

            await stopAll(h);
        });

        test('keeps a folder the user renamed inside the auto tree', async () => {
            const sessions = ['git1', 'git2', 'git3', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            await h.arranger.run({ force: true });

            const git = [...h.autoStore.getCached()!.values()].find(f => f.name === 'Git')!;
            await h.autoStore.renameFolder(git.id, 'Version Control');
            await h.autoStore.markManual(git.id);

            const result = await h.arranger.run({ force: true });
            assert.strictEqual(result.reason, 'completed');

            const after = h.autoStore.getCached()!;
            assert.strictEqual(after.get(git.id)?.name, 'Version Control');
            assert.ok(![...after.values()].some(f => f.name === 'Git'), 'the classifier must not add a duplicate');

            await stopAll(h);
        });

        test('keeps a folder the user deleted out of the next classification', async () => {
            const sessions = ['git1', 'git2', 'git3', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            await h.arranger.run({ force: true });

            const branching = [...h.autoStore.getCached()!.values()].find(f => f.name === 'Branching')!;
            await h.arranger.recordFolderRemoval(branching.id);
            await h.autoStore.deleteFolder(branching.id);

            const result = await h.arranger.run({ force: true });
            assert.strictEqual(result.reason, 'completed');
            assert.ok(![...h.autoStore.getCached()!.values()].some(f => f.name === 'Branching'));

            // A parent topic that is not suppressed stays.
            assert.ok([...h.autoStore.getCached()!.values()].some(f => f.name === 'Git'));

            await stopAll(h);
        });

        test('keeps a session the user moved, and can release it again', async () => {
            const sessions = ['git1', 'git2', 'git3', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            await h.arranger.run({ force: true });

            const folders = h.autoStore.getCached()!;
            const bugs = [...folders.values()].find(f => f.name === 'Bugs')!;
            const branching = [...folders.values()].find(f => f.name === 'Branching')!;

            await h.arranger.recordSessionOverride('git2', bugs.id);
            await h.autoStore.moveSessionToFolder('git2', bugs.id);

            await h.arranger.run({ force: true });

            const after = h.autoStore.getCached()!;
            assert.ok(after.get(bugs.id)!.sessionIds.includes('git2'), 'the user placement wins');
            assert.ok(!after.get(branching.id)!.sessionIds.includes('git2'));

            // Releasing the override reports the classification target back.
            const classified = await h.arranger.releaseSessionOverride('git2');
            assert.strictEqual(classified, branching.id, 'git2 is classified as Git/Branching');
            assert.deepStrictEqual(h.arranger.getAmendments().sessionFolders, {});

            await stopAll(h);
        });

        test('builds the tree from classifications another feature stored (KB → AC)', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);

            // The knowledge base classified first: the shared store already holds
            // the labels, so the arranger must not touch a model at all.
            await h.classificationStore.importClassifications(
                [
                    { sessionId: 'git1', category: 'Git', subcategory: 'Branching' },
                    { sessionId: 'bug1', category: 'Bugs' },
                ],
                () => sessionFingerprintFrom('2024-01-01T00:00:00Z', 1),
            );

            // No injected classifier → the real shared classification path.
            const arranger = new ChatSessionArranger(
                stubIndex, h.autoStore, h.stateStore, h.classificationStore,
                {
                    getSummaries: () => sessions.map(s => makeSummary(s)),
                    getSession: id => sessions.find(s => s.id === id),
                    log: silentLog,
                },
            );

            const result = await arranger.run({ force: true });
            assert.strictEqual(result.reason, 'completed');
            assert.strictEqual(result.categoryCount, 2);

            const folders = [...h.autoStore.getCached()!.values()];
            assert.deepStrictEqual(folders.filter(f => f.parentId === null).map(f => f.name).sort(), ['Bugs', 'Git']);
            assert.ok(folders.find(f => f.name === 'Branching')?.sessionIds.includes('git1'));

            // It rendered the existing shared classification instead of redoing it.
            assert.strictEqual(h.classificationStore.getRevision(), 1);

            await stopAll(h);
        });
    });

    suite('scheduling and amendments', () => {

        test('start() with the worker disabled schedules nothing, restart() re-enables it', () => {
            const h = harness([makeSession('git1')]);
            h.arranger.stop();

            // Disabled: no timers are armed.
            h.arranger.start(() => ({ ...DEFAULT_AUTO_CLASSIFY_CONFIG, enabled: false }));
            h.arranger.stop();

            // Re-enabled: scheduling is allowed again (timers are unref'd, so no leak).
            h.arranger.restart(() => ({ ...DEFAULT_AUTO_CLASSIFY_CONFIG, enabled: true, intervalMinutes: 1 }));
            h.arranger.stop();
            h.arranger.stop(); // idempotent

            assert.strictEqual(h.arranger.getState(), null);
        });

        test('scheduleRun() triggers a run outside the periodic timetable', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            h.arranger.stop();

            h.arranger.scheduleRun(0);
            // The scheduled run is asynchronous; give it a moment to finish.
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.ok(h.classifyCalls() >= 1);
            assert.strictEqual(h.arranger.getState()?.sessionCount, 2);

            await stopAll(h);
        });

        test('amendments are usable before the first classification run', async () => {
            const h = harness([makeSession('git1')]);
            h.arranger.stop();

            // No run yet → empty amendments, and nothing throws.
            assert.deepStrictEqual(h.arranger.getAmendments().sessionFolders, {});
            assert.strictEqual(await h.arranger.releaseSessionOverride('git1'), undefined);

            await h.arranger.recordSessionOverride('git1', 'folder-1');
            assert.strictEqual(h.arranger.getAmendments().sessionFolders['git1'], 'folder-1');
            assert.strictEqual(await h.arranger.releaseSessionOverride('git1'), undefined);

            await stopAll(h);
        });

        test('clearSuppressedPath only writes when the path is suppressed', async () => {
            const sessions = ['git1', 'git2', 'git3', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            await h.arranger.run({ force: true });

            const git = [...h.autoStore.getCached()!.values()].find(f => f.name === 'Git')!;
            await h.arranger.recordFolderRemoval(git.id);
            const suppressed = h.arranger.getAmendments().suppressedPaths;
            assert.ok(suppressed.includes('git'));
            assert.ok(suppressed.includes('git/branching'), 'descendants are suppressed as well');

            const revision = h.classificationStore.getRevision();
            await h.arranger.clearSuppressedPath('not-suppressed');
            assert.strictEqual(h.arranger.getAmendments().suppressedPaths.length, suppressed.length);

            await h.arranger.clearSuppressedPath('Git');
            const remaining = h.arranger.getAmendments().suppressedPaths;
            assert.ok(!remaining.includes('git'), 'the folder path itself is released');
            assert.ok(remaining.includes('git/branching'), 'deeper suppressions are untouched');
            assert.strictEqual(h.classificationStore.getRevision(), revision, 'the classification itself is untouched');

            await stopAll(h);
        });

        test('a history whose sessions cannot be hydrated is reported, not crashed', async () => {
            const h = harness([makeSession('git1')]);
            h.arranger.stop();

            const arranger = new ChatSessionArranger(
                stubIndex, h.autoStore, h.stateStore, h.classificationStore,
                {
                    getSummaries: () => [makeSummary(makeSession('ghost'))],
                    getSession: () => undefined,
                    classify: async () => [],
                    log: silentLog,
                },
            );
            const result = await arranger.run({ force: true });
            assert.strictEqual(result.reason, 'no-sessions');

            await stopAll(h);
        });

        test('the background timer performs the periodic check', async () => {
            const sessions = ['git1', 'bug1'].map(id => makeSession(id));
            const h = harness(sessions);
            h.arranger.stop();

            const config = { ...DEFAULT_AUTO_CLASSIFY_CONFIG, intervalMinutes: 1 };
            const arranger = new ChatSessionArranger(
                stubIndex, h.autoStore, h.stateStore, h.classificationStore,
                {
                    getSummaries: () => sessions.map(s => makeSummary(s)),
                    getSession: id => sessions.find(s => s.id === id),
                    classify: async toClassify =>
                        toClassify.map(s => ({ sessionId: s.id, category: 'Git', usedLlm: true })),
                    log: silentLog,
                    initialDelayMs: 5,
                },
            );
            arranger.start(() => config);
            await new Promise(resolve => setTimeout(resolve, 60));

            assert.ok(h.autoStore.getCached()!.size > 0, 'the timer built the tree');
            arranger.stop();

            await stopAll(h);
        });

        test('a tick after the setting is disabled does nothing', async () => {
            const sessions = [makeSession('git1')];
            const h = harness(sessions);
            h.arranger.stop();

            const config = { ...DEFAULT_AUTO_CLASSIFY_CONFIG, enabled: false };
            let calls = 0;
            const arranger = new ChatSessionArranger(
                stubIndex, h.autoStore, h.stateStore, h.classificationStore,
                {
                    getSummaries: () => sessions.map(s => makeSummary(s)),
                    getSession: id => sessions.find(s => s.id === id),
                    classify: async toClassify => {
                        calls++;
                        return toClassify.map(s => ({ sessionId: s.id, category: 'Git', usedLlm: true }));
                    },
                    log: silentLog,
                    initialDelayMs: 5,
                },
            );
            // `start()` bails out when disabled; flip it enabled for scheduling,
            // then disable before the timer fires.
            const enabled = { ...DEFAULT_AUTO_CLASSIFY_CONFIG, enabled: true };
            arranger.start(() => enabled);
            (enabled as { enabled: boolean }).enabled = config.enabled;
            await new Promise(resolve => setTimeout(resolve, 60));

            assert.strictEqual(calls, 0);
            arranger.stop();

            await stopAll(h);
        });

        test('reports an error result instead of throwing', async () => {
            const sessions = [makeSession('git1')];
            const h = harness(sessions);
            h.arranger.stop();

            const arranger = new ChatSessionArranger(
                stubIndex, h.autoStore, h.stateStore, h.classificationStore,
                {
                    getSummaries: () => sessions.map(s => makeSummary(s)),
                    getSession: id => sessions.find(s => s.id === id),
                    classify: async () => { throw new Error('model exploded'); },
                    log: silentLog,
                },
            );

            const result = await arranger.run({ force: true });

            assert.strictEqual(result.ran, false);
            assert.strictEqual(result.reason, 'error');
            assert.ok(result.error?.includes('model exploded'));

            await stopAll(h);
        });
    });
});

