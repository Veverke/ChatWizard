// src/analytics/classificationStore.ts
//
// One classification of the chat history, shared by both views.
//
// The automatic folder tree ("Group by Context" in the Sessions view) and the
// knowledge base are two renderings of the *same* topic classification — a
// folder tree and a pie chart. Previously each feature classified sessions on
// its own, so running one then the other re-classified everything and could
// produce different topics.
//
// This store keeps the canonical per-session classification (topic → sub-topic →
// sub-sub-topic) together with a fingerprint of the session content it was
// derived from. Both features:
//
//   • read it as their starting state (no model call), and
//   • only classify sessions that are new or whose content changed.
//
// A monotonic `revision` lets either feature notice that the other one updated
// the shared state and refresh accordingly.
//
// Two hard rules keep the two views in agreement:
//   1. This store holds the *proposal* layer only: one canonical label pair per
//      chat (topic → sub-topic, uncapped). The structure the user sees and edits
//      is the auto-classified folder tree, built from these labels by
//      `reconcileAutoTree`; the knowledge base derives its categories from that
//      same tree (`classificationStructure.applyFolderStructure`). So manual
//      folder edits are *shared* state, never a per-view projection: there are
//      no exceptions, both views always describe the same classification.
//   2. Anything that (re)classifies announces itself through `beginWork()`, so
//      views can show a "classifying" indicator instead of silently redrawing
//      a different pie chart.

import * as fs from 'fs';
import * as path from 'path';
import type { SessionClassification } from './chatSessionClassifier';

const STORE_FILENAME = 'chatwizard-classification.json';

/**
 * Current schema version — bump when the shape changes.
 *
 * 2 — canonical-only state: labels folded into "Other" by an old view-level
 *     category cap are dropped on load (they are re-classified on demand) and
 *     the third folder level is no longer part of the canonical classification.
 */
export const CLASSIFICATION_STORE_VERSION = 2;

/** A single session's stored classification. */
export interface StoredClassification {
    /** Top-level topic. */
    category: string;
    /** Sub-topic, when the model produced one. */
    subcategory?: string;
    /** Third level, when the model produced one. */
    subSubcategory?: string;
    /** Whether a free model produced the label. */
    usedLlm: boolean;
    /** Fingerprint of the session content this label was derived from. */
    fingerprint: string;
    /** ISO-8601 timestamp of the classification. */
    classifiedAt: string;
}

/** On-disk shape of the shared classification state. */
export interface ClassificationStoreData {
    version: number;
    /** Monotonic counter, bumped on every save that changed something. */
    revision: number;
    /** sessionId → classification */
    entries: Record<string, StoredClassification>;
    /** ISO-8601 timestamp of the last change. */
    lastUpdated?: string;
    /**
     * ISO-8601 timestamp of the last label-consolidation pass that ran over this
     * state. While it is missing the labels are known to be raw model output, so
     * the next classification run consolidates them — otherwise a consolidation
     * that failed once (rate limit, unparseable answer) would leave the KB stuck
     * with far too many top-level categories.
     */
    labelsConsolidatedAt?: string;
}

/** A classification that was produced elsewhere and should seed the store. */
export interface ImportedClassification {
    sessionId: string;
    category: string;
    subcategory?: string;
    subSubcategory?: string;
    usedLlm?: boolean;
}

/**
 * Content fingerprint used to decide whether a stored classification is still
 * valid: a chat's topic only needs re-deriving when it was edited.
 */
export function sessionFingerprint(session: { updatedAt: string; messages?: ArrayLike<unknown> }): string {
    return sessionFingerprintFrom(session.updatedAt, session.messages?.length ?? 0);
}

/** Fingerprint from the two summary fields that matter (used when only a summary is at hand). */
export function sessionFingerprintFrom(updatedAt: string, messageCount: number): string {
    // djb2 over the parts that change when a chat evolves.
    const raw = `${updatedAt}\u0001${messageCount}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = (((hash * 33) ^ raw.charCodeAt(i)) >>> 0);
    }
    return hash.toString(36);
}

/**
 * Repairs state written by an older build.
 *
 * Older builds let view projections leak into the shared state: the automatic
 * folder tree's category cap folded the smallest topics into `Other` *and
 * persisted that*, and the arranger asked the model for a third folder level.
 * Both changed what the knowledge base displayed, so:
 *   • entries folded into `Other` by that cap are dropped — the KB prompt can
 *     never produce `Other` *together with* a sub-topic, so this is a safe
 *     signature — and are re-classified on the next run;
 *   • the third level is cleared (the canonical classification is 2 levels).
 */
export function migrateEntries(
    entries: Record<string, StoredClassification>,
): Record<string, StoredClassification> {
    const migrated: Record<string, StoredClassification> = {};
    for (const [id, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object' || !entry.category) { continue; }
        const foldedByViewCap = entry.category === 'Other' && !!entry.subcategory;
        if (foldedByViewCap) { continue; }
        migrated[id] = { ...entry, subSubcategory: undefined };
    }
    return migrated;
}

/**
 * File-backed store for the shared classification, cached in memory after the
 * first load. Never throws; a missing/corrupt file reads as empty state.
 */
export class ClassificationStore {
    private readonly filePath: string;
    private data: ClassificationStoreData | null = null;
    private readonly listeners = new Set<(revision: number) => void>();
    private readonly busyListeners = new Set<(busy: boolean, label?: string) => void>();
    /** Ref-counted in-flight classification work (so callers can nest safely). */
    private workDepth = 0;
    private workLabel: string | undefined;

    constructor(storageDir: string) {
        this.filePath = path.join(storageDir, STORE_FILENAME);
    }

    // ------------------------------------------------------------------
    // Load / save
    // ------------------------------------------------------------------

    /** Loads the state from disk (once), migrating older schemas in place. */
    async load(): Promise<ClassificationStoreData> {
        if (this.data) { return this.data; }
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as ClassificationStoreData;
            if (parsed && typeof parsed === 'object'
                && parsed.entries && typeof parsed.entries === 'object'
                && (parsed.version === CLASSIFICATION_STORE_VERSION || parsed.version === 1)) {
                const migrated = parsed.version !== CLASSIFICATION_STORE_VERSION;
                this.data = {
                    version: CLASSIFICATION_STORE_VERSION,
                    revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
                    entries: migrated ? migrateEntries(parsed.entries) : parsed.entries,
                    lastUpdated: parsed.lastUpdated,
                    // A v1 state was consolidated by the old (capped) pipeline: the
                    // repair above changes the label set, so ask for one fresh pass.
                    labelsConsolidatedAt: migrated ? undefined : parsed.labelsConsolidatedAt,
                };
                if (migrated) {
                    // Persist the repair without notifying anyone: the labels did not
                    // change, only the view-specific rubbish was dropped.
                    await this.save(this.data, false);
                }
                return this.data;
            }
        } catch {
            // Missing or corrupt — start empty
        }
        this.data = {
            version: CLASSIFICATION_STORE_VERSION,
            revision: 0,
            entries: {},
        };
        return this.data;
    }

    /**
     * Persists the state. When `bumpRevision` is true (the default) other
     * features are notified that the shared classification changed.
     */
    async save(data: ClassificationStoreData, bumpRevision = true): Promise<void> {
        const previousRevision = this.data?.revision ?? 0;
        const next: ClassificationStoreData = {
            version: CLASSIFICATION_STORE_VERSION,
            revision: bumpRevision ? previousRevision + 1 : previousRevision,
            entries: data.entries,
            lastUpdated: data.lastUpdated ?? new Date().toISOString(),
            labelsConsolidatedAt: data.labelsConsolidatedAt,
        };
        this.data = next;
        try {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            const tmpPath = this.filePath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (err) {
            console.error('[chatwizard] ClassificationStore.save() failed:', err);
        }
        if (bumpRevision) { this.emit(next.revision); }
    }

    // ------------------------------------------------------------------
    // Read helpers
    // ------------------------------------------------------------------

    /** Current revision (0 before the first change). */
    getRevision(): number {
        return this.data?.revision ?? 0;
    }

    /** True when nothing was classified yet. */
    isEmpty(): boolean {
        return !this.data || Object.keys(this.data.entries).length === 0;
    }

    /** The stored classification for a session, if any. */
    get(sessionId: string): StoredClassification | undefined {
        return this.data?.entries[sessionId];
    }

    /** All stored entries as a plain map (read-only use). */
    getEntries(): Readonly<Record<string, StoredClassification>> {
        return this.data?.entries ?? {};
    }

    /** Snapshot of every stored classification, in `SessionClassification` shape. */
    toClassifications(): SessionClassification[] {
        if (!this.data) { return []; }
        return Object.entries(this.data.entries).map(([sessionId, entry]) => ({
            sessionId,
            category: entry.category,
            subcategory: entry.subcategory,
            subSubcategory: entry.subSubcategory,
            usedLlm: entry.usedLlm,
        }));
    }


    // ------------------------------------------------------------------
    // Mutation helpers
    // ------------------------------------------------------------------

    /**
     * Imports classifications produced before this store existed (e.g. a KB
     * result persisted by an older ChatWizard build) so the automatic tree can
     * start from them without re-classifying.
     *
     * @param fingerprintFor Resolves the *current* session fingerprint; imported
     *                       entries are treated as valid for that content.
     * @returns Number of entries actually imported.
     */
    async importClassifications(
        entries: ImportedClassification[],
        fingerprintFor: (sessionId: string) => string | undefined,
    ): Promise<number> {
        const data = await this.load();
        let imported = 0;
        const now = new Date().toISOString();
        for (const entry of entries) {
            if (!entry?.sessionId || !entry.category) { continue; }
            if (data.entries[entry.sessionId]) { continue; }
            const fingerprint = fingerprintFor(entry.sessionId);
            if (!fingerprint) { continue; }
            data.entries[entry.sessionId] = {
                category: entry.category,
                subcategory: entry.subcategory,
                subSubcategory: entry.subSubcategory,
                usedLlm: entry.usedLlm === true,
                fingerprint,
                classifiedAt: now,
            };
            imported++;
        }
        if (imported > 0) {
            data.lastUpdated = now;
            await this.save(data);
        }
        return imported;
    }

    /** Drops entries for sessions that no longer exist. */
    async prune(knownSessionIds: Set<string>): Promise<number> {
        const data = await this.load();
        let removed = 0;
        for (const id of Object.keys(data.entries)) {
            if (!knownSessionIds.has(id)) {
                delete data.entries[id];
                removed++;
            }
        }
        if (removed > 0) {
            data.lastUpdated = new Date().toISOString();
            await this.save(data);
        }
        return removed;
    }

    /** Removes a single session's stored classification (e.g. session deleted). */
    async remove(sessionId: string): Promise<void> {
        const data = await this.load();
        if (!data.entries[sessionId]) { return; }
        delete data.entries[sessionId];
        data.lastUpdated = new Date().toISOString();
        await this.save(data);
    }

    /** Wipes the shared state (used by tests and reset flows). */
    async clear(): Promise<void> {
        this.data = {
            version: CLASSIFICATION_STORE_VERSION,
            revision: (this.data?.revision ?? 0) + 1,
            entries: {},
            lastUpdated: new Date().toISOString(),
        };
        try {
            await fs.promises.unlink(this.filePath);
        } catch {
            // Nothing to remove
        }
        this.emit(this.data.revision);
    }

    // ------------------------------------------------------------------
    // Change notifications
    // ------------------------------------------------------------------

    /**
     * Subscribes to changes of the shared classification (either view may cause
     * them). Returns a disposable subscription.
     */
    onDidChange(listener: (revision: number) => void): { dispose: () => void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private emit(revision: number): void {
        for (const listener of [...this.listeners]) {
            try { listener(revision); } catch { /* listeners must not break the store */ }
        }
    }

    // ------------------------------------------------------------------
    // In-flight work (used by the views to show a "classifying" indicator)
    // ------------------------------------------------------------------

    /**
     * Marks the start of a (re)classification. Returns the matching `end`
     * function — always call it (e.g. in a `finally`). Calls nest: listeners are
     * told `busy = true` on the first call and `busy = false` when the last one
     * ends, so several concurrent runs never flicker the indicator.
     *
     * @param label Short human-readable reason, e.g. "Classifying 12 chats…".
     */
    beginWork(label?: string): () => void {
        this.workDepth++;
        if (this.workDepth === 1) {
            this.workLabel = label;
            this.emitBusy(true, label);
        }

        let ended = false;
        return () => {
            if (ended) { return; }
            ended = true;
            this.workDepth = Math.max(0, this.workDepth - 1);
            if (this.workDepth === 0) {
                this.workLabel = undefined;
                this.emitBusy(false, undefined);
            }
        };
    }

    /** True while a classification is in flight. */
    isBusy(): boolean {
        return this.workDepth > 0;
    }

    /** The label of the in-flight classification, when known. */
    getBusyLabel(): string | undefined {
        return this.workLabel;
    }

    /**
     * Subscribes to the "is something being classified right now" signal.
     * Only fired on transitions (idle → busy, busy → idle).
     */
    onDidChangeBusy(listener: (busy: boolean, label?: string) => void): { dispose: () => void } {
        this.busyListeners.add(listener);
        return { dispose: () => { this.busyListeners.delete(listener); } };
    }

    private emitBusy(busy: boolean, label?: string): void {
        for (const listener of [...this.busyListeners]) {
            try { listener(busy, label); } catch { /* listeners must not break the store */ }
        }
    }
}

