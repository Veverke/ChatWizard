// src/analytics/chatSessionArranger.ts
//
// Background worker: maintains an automatically classified folder tree for the
// entire indexed chat history.
//
// Why a separate worker (and not part of the indexer)?
// The indexer reacts to every chat upsert — far too noisy for something whose
// input is "the whole history". A single chat change rarely means the overall
// topic structure changed, so this runs on a relaxed interval, and only does
// work when a fingerprint of the history (session IDs + updatedAt + message
// counts) actually differs from the last completed run.
//
// Its output is a *third* dimension of the Sessions view ("Group by Context"):
// a real folder tree (topic → sub-topic) stored in its own FolderStore file, so
// it can never clobber the user's manual folders.
//
// That tree **is** the shared classification structure. The knowledge base does
// not keep its own copy of the categories: it derives them from this tree
// (`classificationStructure.applyFolderStructure`), so the two views can never
// disagree — including folders the user created, renamed, moved or deleted by
// hand, and chats they re-placed. A re-classification never undoes those edits
// (they are stored as amendments and merged back in `reconcileAutoTree`).
// `chatwizard.autoClassify.categoryCount` / `.maxDepth` therefore shape what
// *both* views show; they are settings of the classification, not of a view.

import type { Session, SessionSummary, SessionFolder } from '../types/index';
import type { FolderTreeSpec } from '../index/folderStore';
import { FolderStore, normalizeFolderName } from '../index/folderStore';
import type { SessionIndex } from '../index/sessionIndex';
import { AutoClassifyStore, AUTO_CLASSIFY_STATE_VERSION } from './autoClassifyStore';
import type { AutoClassifyState, AutoClassifyCategorySummary } from './autoClassifyStore';
import type { ClassifyChatSessionsOptions, SessionClassification } from './chatSessionClassifier';
import { sanitizeLabel, DEFAULT_CATEGORY_COUNT, enforceCategoryCount } from './chatSessionClassifier';
import { classifySessionsShared } from './classificationService';
import type { ClassificationStore } from './classificationStore';
import type { AutoTreeAmendments, ClassificationPlacement } from './autoTreeReconciler';
import { emptyAmendments, reconcileAutoTree } from './autoTreeReconciler';
import { createLogger } from '../utils/logger';
import type { BoundLogger } from '../utils/logger';

/** Settings that drive the worker. */
export interface AutoClassifyConfig {
    /** When false the worker never runs on its own (a manual run still works). */
    enabled: boolean;
    /** Minutes between checks. */
    intervalMinutes: number;
    /**
     * How many top-level folders to show. `0` (the default) keeps the
     * classifier's own granularity. A positive number folds the smallest topics
     * into "Other" — part of the shared structure, so the knowledge base shows
     * the same top-level folders. Manual reorganisation can always override it.
     */
    categoryCount: number;
    /** Folder nesting depth to build (1–2; the classification carries two levels). */
    maxDepth: number;
}

/**
 * Deepest level a *classification* provides: the knowledge base's
 * `topic → sub-topic` pair. Deeper folder levels would need a different
 * classification prompt, which would change what the KB displays — so the
 * arranger never asks for more than this.
 */
export const MAX_CLASSIFIABLE_DEPTH = 2;

export const DEFAULT_AUTO_CLASSIFY_CONFIG: AutoClassifyConfig = {
    enabled: true,
    intervalMinutes: 10,
    categoryCount: DEFAULT_CATEGORY_COUNT,
    maxDepth: MAX_CLASSIFIABLE_DEPTH,
};

/** Delay before the very first automatic run, so indexing can settle. */
export const AUTO_CLASSIFY_INITIAL_DELAY_MS = 45_000;

export type AutoClassifyRunReason =
    | 'disabled'
    | 'no-sessions'
    | 'unchanged'
    | 'no-signal'
    | 'in-progress'
    | 'completed'
    | 'error';

export interface AutoClassifyRunResult {
    /** True only when folders were (re)built. */
    ran: boolean;
    reason: AutoClassifyRunReason;
    /** Sessions considered by this run. */
    sessionCount: number;
    /** Root folders produced. */
    categoryCount: number;
    /** Total folders created (all levels). */
    folderCount: number;
    /** Whether the free model produced at least one label. */
    usedLlm: boolean;
    durationMs: number;
    error?: string;
}

/** The classifier's folder tree plus where each session was placed in it. */
export interface FolderTreePlan {
    tree: FolderTreeSpec[];
    placements: ClassificationPlacement[];
}

/** Injection points — every dependency has a production default. */
export interface ChatSessionArrangerOptions {
    /** Source of the history to classify. Default: `index.getAllSummaries()`. */
    getSummaries?: () => SessionSummary[];
    /** Resolve a full session (with messages). Default: `index.get(id)`. */
    getSession?: (id: string) => Session | undefined;
    /**
     * Classification pipeline. Default: the shared, incremental classifier
     * ({@link classifySessionsShared}) writing to the shared classification store.
     */
    classify?: (
        sessions: Session[],
        options: ClassifyChatSessionsOptions,
    ) => Promise<SessionClassification[]>;
    /** Clock. Default: `() => new Date()`. */
    now?: () => Date;
    /** Logger. Default: the ChatWizard output channel. */
    log?: BoundLogger;
    /** Called after every run that reached a decision. */
    onDidUpdate?: (result: AutoClassifyRunResult) => void;
    /** Classification progress (done, total). */
    onProgress?: (done: number, total: number) => void;
    /**
     * Delay before the first automatic check. Default:
     * {@link AUTO_CLASSIFY_INITIAL_DELAY_MS}. Overridable so tests (and a future
     * "check soon after startup" path) do not wait 45 s.
     */
    initialDelayMs?: number;
}

export class ChatSessionArranger {
    private timer: ReturnType<typeof setInterval> | null = null;
    private initialTimer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<AutoClassifyRunResult> | null = null;
    private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
    private configProvider: () => AutoClassifyConfig = () => DEFAULT_AUTO_CLASSIFY_CONFIG;
    private lastState: AutoClassifyState | null = null;

    private readonly log: BoundLogger;

    constructor(
        private readonly index: SessionIndex,
        private readonly folderStore: FolderStore,
        private readonly stateStore: AutoClassifyStore,
        /** Shared classification state — the same one the knowledge base uses. */
        private readonly classificationStore: ClassificationStore,
        private readonly options: ChatSessionArrangerOptions = {},
    ) {
        this.log = options.log ?? createLogger().withContext('AutoClassify');
    }

    // ------------------------------------------------------------------
    // Scheduling
    // ------------------------------------------------------------------

    /**
     * Starts the relaxed background loop. Safe to call again after a settings
     * change — the previous timers are replaced.
     */
    start(getConfig: () => AutoClassifyConfig): void {
        this.stop();
        this.configProvider = getConfig;

        const config = getConfig();
        if (!config.enabled) {
            this.log.info('Automatic classification is disabled (chatwizard.autoClassify.enabled).');
            return;
        }

        this.initialTimer = setTimeout(() => {
            this.initialTimer = null;
            void this.tick();
            const periodMs = Math.max(1, config.intervalMinutes) * 60_000;
            this.timer = setInterval(() => void this.tick(), periodMs);
            this.unrefTimer(this.timer);
        }, Math.max(0, this.options.initialDelayMs ?? AUTO_CLASSIFY_INITIAL_DELAY_MS));
        this.unrefTimer(this.initialTimer);

        this.log.info(
            `Automatic classification scheduled — first check in ${Math.round((this.options.initialDelayMs ?? AUTO_CLASSIFY_INITIAL_DELAY_MS) / 1000)}s, ` +
            `then every ${Math.max(1, config.intervalMinutes)} min.`,
        );
    }

    /** Stops the background loop (an in-flight run is allowed to finish). */
    stop(): void {
        if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); this.scheduleTimer = null; }
    }

    /**
     * Requests a (debounced) refresh outside the periodic schedule — used when
     * the knowledge base updates the shared classification.
     */
    scheduleRun(delayMs = 1_500): void {
        if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); }
        this.scheduleTimer = setTimeout(() => {
            this.scheduleTimer = null;
            void this.run();
        }, delayMs);
        this.unrefTimer(this.scheduleTimer);
    }

    /** Restarts the loop with the current settings. */
    restart(getConfig: () => AutoClassifyConfig): void {
        this.start(getConfig);
    }

    /** Last persisted run state, when known. */
    getState(): AutoClassifyState | null {
        return this.lastState;
    }

    // ------------------------------------------------------------------
    // User amendments on top of the classification
    // ------------------------------------------------------------------

    /** Current amendments (empty until the user changes something). */
    getAmendments(): AutoTreeAmendments {
        return this.lastState?.amendments ?? emptyAmendments();
    }

    /** Remembers that the user moved a session into an auto-classified folder. */
    async recordSessionOverride(sessionId: string, folderId: string): Promise<void> {
        const state = await this.ensureState();
        const amendments = state.amendments ?? (state.amendments = emptyAmendments());
        amendments.sessionFolders[sessionId] = folderId;
        await this.persistState(state);
    }

    /**
     * Drops a user's session placement. Returns the folder the classifier had
     * assigned the session to (when known), so the caller can put it back now.
     */
    async releaseSessionOverride(sessionId: string): Promise<string | undefined> {
        const state = await this.ensureState();
        const amendments = state.amendments ?? (state.amendments = emptyAmendments());
        const classified = amendments.classifiedFolders[sessionId];
        if (!amendments.sessionFolders[sessionId]) { return classified; }
        delete amendments.sessionFolders[sessionId];
        await this.persistState(state);
        return classified;
    }

    /**
     * Remembers that the user deleted an auto-classified folder so the next
     * classification does not recreate it. Must be called **before** the folder
     * is removed (descendant paths are read from the current tree).
     */
    async recordFolderRemoval(folderId: string): Promise<void> {
        const state = await this.ensureState();
        const amendments = state.amendments ?? (state.amendments = emptyAmendments());

        const removedIds = new Set<string>([folderId, ...this.folderStore.getDescendantFolderIds(folderId)]);
        const suppressed = new Set(amendments.suppressedPaths.map(p => p.toLowerCase()));
        for (const [path, id] of Object.entries(amendments.pathToFolderId)) {
            if (removedIds.has(id)) { suppressed.add(path.toLowerCase()); }
        }
        // A folder the user created by hand has no classification path — nothing to suppress.
        amendments.suppressedPaths = [...suppressed];

        for (const [sessionId, id] of Object.entries(amendments.sessionFolders)) {
            if (removedIds.has(id)) { delete amendments.sessionFolders[sessionId]; }
        }
        for (const [sessionId, id] of Object.entries(amendments.classifiedFolders)) {
            if (removedIds.has(id)) { delete amendments.classifiedFolders[sessionId]; }
        }
        await this.persistState(state);
    }

    /** Clears a deletion suppression (the user re-created that folder by hand). */
    async clearSuppressedPath(path: string): Promise<void> {
        const state = await this.ensureState();
        const amendments = state.amendments ?? (state.amendments = emptyAmendments());
        const lower = path.toLowerCase();
        if (!amendments.suppressedPaths.some(p => p.toLowerCase() === lower)) { return; }
        amendments.suppressedPaths = amendments.suppressedPaths.filter(p => p.toLowerCase() !== lower);
        await this.persistState(state);
    }

    /** Loads the run state, creating an amendment-only one when no run happened yet. */
    private async ensureState(): Promise<AutoClassifyState> {
        const existing = this.lastState ?? await this.stateStore.load();
        if (existing) {
            this.lastState = existing;
            return existing;
        }
        const fresh: AutoClassifyState = {
            version: AUTO_CLASSIFY_STATE_VERSION,
            lastRunAt: '',
            fingerprint: '',
            sessionCount: 0,
            categoryCount: 0,
            maxDepth: 0,
            usedLlm: false,
            categories: [],
            amendments: emptyAmendments(),
        };
        this.lastState = fresh;
        return fresh;
    }

    private async persistState(state: AutoClassifyState): Promise<void> {
        await this.stateStore.save(state);
        this.lastState = state;
    }

    private async tick(): Promise<void> {
        const config = this.configProvider();
        if (!config.enabled) { return; }
        try {
            const result = await this.run({ config });
            if (result.reason !== 'unchanged' && result.reason !== 'in-progress') {
                this.log.info(
                    `Automatic classification ${result.reason} — ${result.sessionCount} sessions, ` +
                    `${result.categoryCount} categories, ${result.folderCount} folders (${result.durationMs} ms).`,
                );
            }
        } catch (err) {
            // run() already converts failures into a result; this is belt-and-braces.
            this.log.warn(`Automatic classification failed: ${err}`);
        }
    }

    private unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
        // Do not keep the extension host alive just for this timer.
        (timer as unknown as { unref?: () => void }).unref?.();
    }

    // ------------------------------------------------------------------
    // Run
    // ------------------------------------------------------------------

    /**
     * Classifies the history and rebuilds the auto folder tree.
     *
     * `force: false` (default) skips the run when the history fingerprint and
     * the settings match the last completed run.
     */
    async run(options: { force?: boolean; config?: AutoClassifyConfig } = {}): Promise<AutoClassifyRunResult> {
        // A run is already in progress — share its result instead of piling up work.
        if (this.running) { return this.running; }

        const startedAt = Date.now();
        const task = this.execute(options, startedAt).finally(() => { this.running = null; });
        this.running = task;

        const result = await task;
        this.options.onDidUpdate?.(result);
        return result;
    }


    private async execute(
        options: { force?: boolean; config?: AutoClassifyConfig },
        startedAt: number,
    ): Promise<AutoClassifyRunResult> {
        const config = options.config ?? this.configProvider();
        const summaries = this.options.getSummaries
            ? this.options.getSummaries()
            : this.index.getAllSummaries();

        const base = {
            ran: false,
            sessionCount: summaries.length,
            categoryCount: 0,
            folderCount: 0,
            usedLlm: false,
        };

        try {
            if (!config.enabled && !options.force) {
                return { ...base, reason: 'disabled', durationMs: Date.now() - startedAt };
            }

            if (summaries.length === 0) {
                await this.clearTree();
                return { ...base, reason: 'no-sessions', durationMs: Date.now() - startedAt };
            }

            const maxDepth = Math.min(MAX_CLASSIFIABLE_DEPTH, clampDepth(config.maxDepth));
            const categoryCount = Math.max(0, Math.floor(config.categoryCount ?? DEFAULT_CATEGORY_COUNT));
            const fingerprint = computeHistoryFingerprint(summaries);
            const classificationRevision = (await this.classificationStore.load(), this.classificationStore.getRevision());

            const previous = this.lastState ?? await this.stateStore.load();
            this.lastState = previous;

            if (!options.force && previous
                && previous.fingerprint === fingerprint
                && previous.categoryCount === categoryCount
                && previous.maxDepth === maxDepth
                && previous.classificationRevision === classificationRevision) {
                return {
                    ...base,
                    reason: 'unchanged',
                    categoryCount: previous.categories.length,
                    durationMs: Date.now() - startedAt,
                };
            }

            const sessions = this.hydrate(summaries);
            if (sessions.length === 0) {
                return { ...base, reason: 'no-sessions', durationMs: Date.now() - startedAt };
            }

            let classifications: SessionClassification[];
            let revision = classificationRevision;
            if (this.options.classify) {
                // Injected pipeline (tests / custom callers) — no shared store writes.
                classifications = await this.options.classify(sessions, {
                    levels: 2,
                    onProgress: this.options.onProgress,
                });
            } else {
                // Exactly the classification the knowledge base uses: same prompt
                // depth, same consolidation, no view projection. Because both sides
                // ask for the same labels, a run over already-classified chats
                // changes nothing and the KB pie chart stays exactly as it is.
                const shared = await classifySessionsShared(sessions, this.classificationStore, {
                    levels: 2,
                    onProgress: this.options.onProgress,
                    pruneMissing: true,
                });
                classifications = shared.classifications;
                revision = shared.revision;
            }

            // Neither the free model nor the embedding model produced a real topic:
            // keep the previous tree (and the previous state) instead of flattening
            // everything into a single "Other" folder. A later run retries.
            if (!classifications.some(c => c.category !== 'Other')) {
                this.log.warn(
                    'Automatic classification produced no topic labels ' +
                    '(no free model and no embedding model available) — keeping the previous tree.',
                );
                return { ...base, reason: 'no-signal', durationMs: Date.now() - startedAt };
            }

            // The category cap shapes the *shared* structure: it is applied while
            // the tree is built, and the knowledge base derives its categories
            // from that tree — so capping here caps both views. The proposal
            // labels in the classification store stay uncapped, which is what
            // lets a later run raise the cap again without re-classifying.
            const treeClassifications = categoryCount > 0
                ? enforceCategoryCount(classifications, categoryCount)
                : classifications;

            const plan = buildFolderTreePlan(treeClassifications, maxDepth);
            const existing = this.folderStore.getCached() ?? await this.folderStore.load();

            // Rebuild the classifier's structure *around* the user's amendments
            // (manually created/renamed/moved folders, manually placed sessions,
            // deleted folders) instead of overwriting them.
            const reconciled = reconcileAutoTree({
                specs: plan.tree,
                placements: plan.placements,
                existing,
                amendments: previous?.amendments,
                knownSessionIds: new Set(sessions.map(s => s.id)),
            });
            await this.folderStore.save(reconciled.folders);

            const state: AutoClassifyState = {
                version: AUTO_CLASSIFY_STATE_VERSION,
                lastRunAt: (this.options.now?.() ?? new Date()).toISOString(),
                fingerprint,
                sessionCount: sessions.length,
                categoryCount,
                maxDepth,
                usedLlm: classifications.some(c => c.usedLlm),
                categories: summarizeTree(plan.tree),
                amendments: reconciled.amendments,
                classificationRevision: revision,
            };
            await this.stateStore.save(state);
            this.lastState = state;

            return {
                ran: true,
                reason: 'completed',
                sessionCount: sessions.length,
                categoryCount: plan.tree.length,
                folderCount: reconciled.folders.size,
                usedLlm: state.usedLlm,
                durationMs: Date.now() - startedAt,
            };
        } catch (err) {
            this.log.warn(`Automatic classification failed: ${err}`);
            return {
                ...base,
                reason: 'error',
                error: String(err),
                durationMs: Date.now() - startedAt,
            };
        }
    }

    /** Fetches the full sessions (with messages) for the given summaries. */
    private hydrate(summaries: SessionSummary[]): Session[] {
        const getSession = this.options.getSession ?? ((id: string) => this.index.get(id));
        const sessions: Session[] = [];
        for (const summary of summaries) {
            const session = getSession(summary.id);
            if (session) { sessions.push(session); }
        }
        return sessions;
    }

    /** Drops the auto tree and its state (used when the history becomes empty). */
    private async clearTree(): Promise<void> {
        const hadFolders = (this.folderStore.getCached()?.size ?? 0) > 0;
        const hadState = (this.lastState ?? await this.stateStore.load()) !== null;
        if (!hadFolders && !hadState) { return; }
        await this.folderStore.replaceTree([]);
        await this.stateStore.clear();
        this.lastState = null;
    }
}


// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Clamps the configured depth to the supported 1–3 range. */
export function clampDepth(depth: number | undefined): number {
    const value = Math.floor(depth ?? 3);
    if (!Number.isFinite(value)) { return 3; }
    return Math.max(1, Math.min(3, value));
}

/**
 * Stable fingerprint of the chat history. Two histories with the same sessions,
 * timestamps and message counts produce the same fingerprint — that is the
 * signal the arranger uses to decide whether re-classification is worthwhile.
 */
export function computeHistoryFingerprint(
    summaries: Pick<SessionSummary, 'id' | 'updatedAt' | 'messageCount'>[],
): string {
    const parts = summaries
        .map(s => `${s.id}\u0001${s.updatedAt}\u0001${s.messageCount}`)
        .sort();
    let hash = 5381;
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
            hash = (((hash * 33) ^ part.charCodeAt(i)) >>> 0);
        }
        hash = ((hash ^ 0x1f) >>> 0);
    }
    return `${parts.length}:${hash.toString(36)}`;
}

/**
 * Turns flat classifications into a nested folder tree specification plus the
 * path each session was placed on.
 *
 * Sessions whose label for a level is missing stay in the closest existing
 * parent folder, so no chat is dropped or duplicated. Depth is capped at
 * `maxDepth` (1–3); deeper labels are flattened into the deepest folder.
 */
export function buildFolderTreePlan(
    classifications: SessionClassification[],
    maxDepth = 3,
): FolderTreePlan {
    const depth = clampDepth(maxDepth);
    const roots = new Map<string, {
        node: FolderTreeSpec;
        sub: Map<string, { node: FolderTreeSpec; leaf: Map<string, FolderTreeSpec> }>;
    }>();
    const placements: ClassificationPlacement[] = [];

    /** Folder-name normalisation shared with the folder store / reconciler. */
    const nameOf = (raw: string | undefined, fallback?: string): string =>
        normalizeFolderName(sanitizeLabel(raw) ?? '') || (fallback ?? '');

    for (const classification of classifications) {
        const rootName = nameOf(classification.category, 'Other');
        let root = roots.get(rootName);
        if (!root) {
            root = { node: { name: rootName, sessionIds: [], children: [] }, sub: new Map() };
            roots.set(rootName, root);
        }

        if (depth === 1) {
            root.node.sessionIds!.push(classification.sessionId);
            placements.push({ sessionId: classification.sessionId, path: rootName });
            continue;
        }

        const subName = nameOf(classification.subcategory);
        if (!subName) {
            root.node.sessionIds!.push(classification.sessionId);
            placements.push({ sessionId: classification.sessionId, path: rootName });
            continue;
        }

        let sub = root.sub.get(subName);
        if (!sub) {
            sub = { node: { name: subName, sessionIds: [], children: [] }, leaf: new Map() };
            root.sub.set(subName, sub);
            root.node.children!.push(sub.node);
        }

        if (depth === 2) {
            sub.node.sessionIds!.push(classification.sessionId);
            placements.push({ sessionId: classification.sessionId, path: `${rootName}/${subName}` });
            continue;
        }

        const leafName = nameOf(classification.subSubcategory);
        if (!leafName) {
            sub.node.sessionIds!.push(classification.sessionId);
            placements.push({ sessionId: classification.sessionId, path: `${rootName}/${subName}` });
            continue;
        }

        let leaf = sub.leaf.get(leafName);
        if (!leaf) {
            leaf = { name: leafName, sessionIds: [], children: [] };
            sub.leaf.set(leafName, leaf);
            sub.node.children!.push(leaf);
        }
        leaf.sessionIds!.push(classification.sessionId);
        placements.push({ sessionId: classification.sessionId, path: `${rootName}/${subName}/${leafName}` });
    }

    return { tree: sortTree([...roots.values()].map(r => r.node)), placements };
}

/** Convenience wrapper returning only the folder tree. */
export function buildFolderTreeSpec(
    classifications: SessionClassification[],
    maxDepth = 3,
): FolderTreeSpec[] {
    return buildFolderTreePlan(classifications, maxDepth).tree;
}

/** Counts every session in a tree node, including its descendants. */
export function countSessionsInSpec(node: FolderTreeSpec): number {
    let count = node.sessionIds?.length ?? 0;
    for (const child of node.children ?? []) { count += countSessionsInSpec(child); }
    return count;
}

/** Sorts siblings by session count (desc) then name, and drops empty child lists. */
function sortTree(nodes: FolderTreeSpec[]): FolderTreeSpec[] {
    return nodes
        .map(node => ({
            ...node,
            children: node.children && node.children.length > 0 ? sortTree(node.children) : undefined,
        }))
        .sort((a, b) => countSessionsInSpec(b) - countSessionsInSpec(a) || a.name.localeCompare(b.name));
}

/** Builds the per-root summary persisted in the run state (and shown in tooltips). */
export function summarizeTree(tree: FolderTreeSpec[]): AutoClassifyCategorySummary[] {
    return tree.map(node => ({
        name: node.name,
        sessionCount: countSessionsInSpec(node),
        subcategoryCount: node.children?.length ?? 0,
    }));
}

