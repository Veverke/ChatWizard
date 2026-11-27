// src/analytics/classificationService.ts
//
// The single entry point both views use to (re)classify chat history.
//
// It layers incremental behaviour on top of `classifyChatSessions`:
//   • sessions whose stored fingerprint is unchanged are seeded, not re-classified;
//   • only new/updated chats are sent to the model;
//   • the label-consolidation passes run only when something new was classified;
//   • results are written back into the shared `ClassificationStore`, which both
//     the knowledge base and the automatic folder tree read from.
//
// Because the store is shared, whichever feature runs first effectively provides
// the other's starting state — and neither re-does the other's work.

import type { Session } from '../types/index';
import type { ClassificationStore } from './classificationStore';
import { sessionFingerprint } from './classificationStore';
import type {
    ChatSessionClassifierDeps,
    ClassifyChatSessionsOptions,
    SeedClassification,
    SessionClassification,
} from './chatSessionClassifier';
import { classifyChatSessions } from './chatSessionClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('Classify');

export interface SharedClassificationOptions extends ClassifyChatSessionsOptions {
    /**
     * Reuse stored labels for sessions whose content is unchanged. Default: true.
     * Set to false to force a full re-classification (e.g. a "regenerate" action).
     */
    incremental?: boolean;
    /**
     * Drop stored classifications for sessions that are not in this batch
     * (the batch is expected to be the complete history). Default: false.
     */
    pruneMissing?: boolean;
}

export interface SharedClassificationResult {
    /** One entry per input session, in input order. */
    classifications: SessionClassification[];
    /** Sessions that were sent to a model in this call. */
    newlyClassified: number;
    /** Sessions reused from the shared store without a model call. */
    reused: number;
    /** Stored entries whose labels changed (new + refined + re-classified). */
    changed: number;
    /** Whether the free model produced at least one label. */
    usedLlm: boolean;
    /** Shared-store revision after this call. */
    revision: number;
}

/**
 * Classifies `sessions`, reusing the shared classification wherever possible and
 * writing the result back to the shared store.
 *
 * The classifications written are **canonical proposals** — one label pair per
 * chat, uncapped and two levels deep. They are not what the views show: the
 * auto-classified folder tree is built from them (plus the user's amendments) and
 * both the Sessions view and the Knowledge Base render *that* one structure
 * (`classificationStructure`). So there are no per-view projections to worry
 * about — whatever shapes the structure shapes both views.
 *
 * While it runs, the store reports itself busy (`beginWork`), so both views can
 * show a subtle "classifying" indicator rather than silently redrawing.
 */
export async function classifySessionsShared(
    sessions: Session[],
    store: ClassificationStore,
    options: SharedClassificationOptions = {},
    deps: ChatSessionClassifierDeps = {},
): Promise<SharedClassificationResult> {
    const data = await store.load();
    const incremental = options.incremental !== false;

    const fingerprints = new Map<string, string>();
    const seed = new Map<string, SeedClassification>();
    for (const session of sessions) {
        const fingerprint = sessionFingerprint(session);
        fingerprints.set(session.id, fingerprint);
        if (!incremental) { continue; }
        const stored = data.entries[session.id];
        if (stored && stored.fingerprint === fingerprint) {
            seed.set(session.id, {
                category: stored.category,
                subcategory: stored.subcategory ?? null,
                subSubcategory: stored.subSubcategory ?? null,
                usedLlm: stored.usedLlm,
            });
        }
    }

    const reused = seed.size;
    const pending = sessions.length - reused;

    if (sessions.length === 0) {
        return { classifications: [], newlyClassified: 0, reused: 0, changed: 0, usedLlm: false, revision: store.getRevision() };
    }

    // Consolidating labels is only worthwhile when new labels appeared — or when
    // the stored label set was never consolidated successfully (a failed pass must
    // not leave the history stuck with too many top-level categories).
    const needsConsolidation = pending > 0 || !data.labelsConsolidatedAt;

    // Announce the work only when a model will actually be called — a no-op run
    // finishes immediately and must not make the indicator flicker.
    const endWork = (pending > 0 || needsConsolidation)
        ? store.beginWork(pending > 0
            ? `Classifying ${pending} chat${pending === 1 ? '' : 's'}…`
            : 'Consolidating topics…')
        : () => { /* nothing to do */ };

    let classifications: SessionClassification[];
    try {
        classifications = await classifyChatSessions(
            sessions,
            {
                ...options,
                seed,
                refineLabels: options.refineLabels !== false && needsConsolidation,
            },
            deps,
        );
    } finally {
        endWork();
    }

    // ── Persist ─────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    let changed = 0;
    for (const classification of classifications) {
        const fingerprint = fingerprints.get(classification.sessionId);
        if (!fingerprint) { continue; }
        const previous = data.entries[classification.sessionId];
        const sameLabels = previous
            && previous.category === classification.category
            && (previous.subcategory ?? undefined) === (classification.subcategory ?? undefined)
            && (previous.subSubcategory ?? undefined) === (classification.subSubcategory ?? undefined)
            && previous.fingerprint === fingerprint;

        if (sameLabels) { continue; }

        data.entries[classification.sessionId] = {
            category: classification.category,
            subcategory: classification.subcategory,
            subSubcategory: classification.subSubcategory,
            usedLlm: classification.usedLlm,
            fingerprint,
            classifiedAt: now,
        };
        changed++;
    }

    if (options.pruneMissing) {
        const known = new Set(sessions.map(s => s.id));
        for (const id of Object.keys(data.entries)) {
            if (!known.has(id)) {
                delete data.entries[id];
                changed++;
            }
        }
    }

    // Remember that the labels are consolidated, so a periodic no-op run does not
    // keep spending model calls on the consolidation passes.
    let stamped = false;
    if (needsConsolidation && options.refineLabels !== false
        && classifications.some(c => c.usedLlm)
        && data.labelsConsolidatedAt !== now) {
        data.labelsConsolidatedAt = now;
        stamped = true;
    }

    if (changed > 0 || stamped) {
        data.lastUpdated = now;
        await store.save(data);
        log.info(
            `Shared classification updated — ${changed} changed ` +
            `(${pending} newly classified, ${reused} reused from store).`,
        );
    }

    return {
        classifications,
        newlyClassified: pending,
        reused,
        changed,
        usedLlm: classifications.some(c => c.usedLlm),
        revision: store.getRevision(),
    };
}

/**
 * Builds the seed map for a single session from the shared store (used by the
 * KB single-session refresh path).
 */
export function seedFromStore(
    store: ClassificationStore,
    session: Session,
): SeedClassification | undefined {
    const stored = store.get(session.id);
    if (!stored) { return undefined; }
    if (stored.fingerprint !== sessionFingerprint(session)) { return undefined; }
    return {
        category: stored.category,
        subcategory: stored.subcategory ?? null,
        subSubcategory: stored.subSubcategory ?? null,
        usedLlm: stored.usedLlm,
    };
}

