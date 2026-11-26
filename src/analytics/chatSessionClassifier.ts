// src/analytics/chatSessionClassifier.ts
//
// Shared "group a set of chats into topical categories" component.
//
// This is the knowledge-base classification pipeline extracted verbatim into a
// reusable unit: it takes a group of sessions, asks the free model (with the
// local embedding model as fallback) for a topic / sub-topic label per session
// and consolidates the raw labels across the whole group.
//
// The output is the **canonical** classification — exactly what the KB has
// always displayed. It is deliberately independent of any view:
//   • no category cap / "Other" folding (that is a view projection — see
//     {@link enforceCategoryCount}, which callers apply to a *copy* and must
//     never persist);
//   • two label levels by default (the KB prompt), three only when a caller
//     explicitly asks for them.
//
// Two callers use it today:
//   • `kbEngine.buildKbEntries` — the KB pie chart (all categories, 2 levels).
//   • `chatSessionArranger`     — the auto-classified folder tree, derived from
//                                 the very same labels so both views agree.

import type { Session } from '../types/index';
import type { KbEntry } from '../types/kb';
import type { IEmbeddingEngine } from '../search/semanticContracts';
import { classifySessionWithCategories } from './kbClassifier';
import { refineCategories, refineSubtypes } from './kbLlmClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('Classifier');

/**
 * Default number of top-level folders a *view* asks for.
 *
 * `0` means "keep the classification's own granularity" — the automatic folder
 * tree then has exactly the same root folders as the knowledge base's pie
 * slices. A positive number is a view-only projection (see
 * {@link enforceCategoryCount}) and is never written to the shared store.
 */
export const DEFAULT_CATEGORY_COUNT = 0;

/** Parallel classification requests — matches the KB engine's budget. */
export const DEFAULT_CLASSIFY_CONCURRENCY = 3;

/** How many folder levels a classification may carry (topic, sub-topic, sub-sub-topic). */
export const MAX_LABEL_LEVELS = 3;

export type LabelLevels = 2 | 3;

/** One session's place in the classified hierarchy. */
export interface SessionClassification {
    sessionId: string;
    /** Top-level category — the "main topic". */
    category: string;
    /** Second-level category — the "sub topic", when the model produced one. */
    subcategory?: string;
    /** Third-level category, only when `levels === 3`. */
    subSubcategory?: string;
    /** Whether the free model produced this label (vs the embedding fallback). */
    usedLlm: boolean;
}

export interface ClassifyChatSessionsOptions {
    /**
     * Label depth requested from the model. Default: 2 — the knowledge base's
     * prompt, so both views share one canonical label set.
     */
    levels?: LabelLevels;
    /** Run the label-consolidation passes. Default: true. */
    refineLabels?: boolean;
    /** Parallel requests. Default: {@link DEFAULT_CLASSIFY_CONCURRENCY}. */
    concurrency?: number;
    /** Embedding fallback engine. Omitted → the globally registered KB engine. */
    embeddingEngine?: IEmbeddingEngine | null;
    /**
     * Category vocabulary handed to the classifier (used by the embedding
     * fallback path). Default: `['Other']`, matching the KB engine.
     */
    embeddingCategories?: string[];
    /**
     * Already-classified sessions, keyed by session ID. Seeded sessions are not
     * sent to a model (used to share one classification between the KB and the
     * automatic folder tree). Consolidation still considers them.
     */
    seed?: Record<string, SeedClassification> | Map<string, SeedClassification>;
    /** Progress callback — `done` counts processed sessions (1-based at each call). */
    onProgress?: (done: number, total: number) => void;
}

/** A label supplied by the caller instead of the model. */
export interface SeedClassification {
    category: string;
    subcategory?: string | null;
    subSubcategory?: string | null;
    usedLlm?: boolean;
}

/** Raw single-session classifier output (injectable for tests). */
export interface SingleClassification {
    category: string;
    subcategory?: string | null;
    subSubcategory?: string | null;
    usedLlm: boolean;
}

/** A label to consolidate under its parent category. */
export interface LabelRefinementInput {
    /** Parent label (category for level 2, `category|subcategory` for level 3). */
    parent: string;
    /** The current label to consolidate. */
    label: string;
    title: string;
    summary: string;
}

/** Injection points — production defaults are the KB classifier + refinement passes. */
export interface ChatSessionClassifierDeps {
    classifyOne?: (session: Session, levels: LabelLevels) => Promise<SingleClassification | null>;
    refineCategories?: (labels: string[]) => Promise<Map<string, string> | null>;
    refineLabelsUnderParent?: (inputs: LabelRefinementInput[]) => Promise<Map<string, string> | null>;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify `sessions` into a topical hierarchy.
 *
 * The result is the **canonical** classification: exactly the labels the
 * knowledge base displays (all categories, consolidated). No view projection
 * (category cap / "Other" folding) is applied here — see
 * {@link enforceCategoryCount} for that.
 *
 * Never throws: an individual session that fails to classify is reported as
 * "Other" with `usedLlm: false`, so the caller always receives one entry per
 * input session (in input order).
 */
export async function classifyChatSessions(
    sessions: Session[],
    options: ClassifyChatSessionsOptions = {},
    deps: ChatSessionClassifierDeps = {},
): Promise<SessionClassification[]> {
    if (sessions.length === 0) { return []; }

    // Two levels by default — the knowledge-base prompt. Asking for a third
    // level changes how the model labels the first two, which would silently
    // change what the KB shows, so callers must opt in explicitly.
    const levels: LabelLevels = options.levels === 3 ? 3 : 2;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CLASSIFY_CONCURRENCY, sessions.length));
    const classifyOne = deps.classifyOne
        ?? ((session: Session, lv: LabelLevels) =>
            defaultClassifyOne(session, lv, options.embeddingEngine, options.embeddingCategories));

    const collected: (SessionClassification | undefined)[] = new Array(sessions.length);
    let nextIdx = 0;
    let done = 0;
    let anyLlm = false;

    /** Normalises the two accepted seed shapes into one lookup. */
    const seededFor = (sessionId: string): SeedClassification | undefined => {
        const seed = options.seed;
        if (!seed) { return undefined; }
        return seed instanceof Map ? seed.get(sessionId) : seed[sessionId];
    };

    const worker = async (): Promise<void> => {
        while (nextIdx < sessions.length) {
            const i = nextIdx++;
            const session = sessions[i];
            const seed = seededFor(session.id);
            let raw: SingleClassification | null = null;
            if (seed) {
                // Already classified elsewhere (KB ↔ automatic tree share one state).
                raw = {
                    category: seed.category,
                    subcategory: seed.subcategory ?? null,
                    subSubcategory: seed.subSubcategory ?? null,
                    usedLlm: seed.usedLlm === true,
                };
            } else {
                try {
                    raw = await classifyOne(session, levels);
                } catch (err) {
                    log.warn(`classification failed for ${session.id}: ${err}`);
                }
            }

            if (raw?.usedLlm) { anyLlm = true; }
            collected[i] = {
                sessionId: session.id,
                category: sanitizeLabel(raw?.category) ?? 'Other',
                subcategory: sanitizeLabel(raw?.subcategory),
                subSubcategory: levels === 3 ? sanitizeLabel(raw?.subSubcategory) : undefined,
                usedLlm: raw?.usedLlm === true,
            };

            done++;
            options.onProgress?.(done, sessions.length);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    let entries = collected.filter((e): e is SessionClassification => e !== undefined);

    // ── Consolidation passes ────────────────────────────────────────────────
    // Only meaningful when the free model produced the labels; embedding labels
    // come from a fixed vocabulary and are already canonical.
    if (options.refineLabels !== false && anyLlm) {
        entries = await refineTopLevel(entries, deps);
        entries = await refineLevel(entries, 2, sessions, deps);
        if (levels === 3) {
            entries = await refineLevel(entries, 3, sessions, deps);
        }
    }

    // No category cap here: `enforceCategoryCount` is a *view* projection and
    // must never leak into the shared classification.
    return entries;
}

/**
 * Merge the smallest categories into an "Other" bucket until at most
 * `categoryCount` top-level categories remain.
 *
 * **View projection only.** Apply this to a copy of the classifications when
 * *rendering* a folder tree, and never persist the result into the shared
 * classification — the KB pie chart and the auto folder tree must keep showing
 * the classifier's own granularity.
 *
 * The `categoryCount - 1` largest categories are kept as-is; everything else is
 * folded into "Other" (an existing "Other" bucket absorbs them). Sub-topics are
 * preserved so the merged bucket still shows what it contains.
 *
 * `categoryCount` omitted or `<= 0` disables the cap.
 */
export function enforceCategoryCount(
    entries: SessionClassification[],
    categoryCount?: number,
): SessionClassification[] {
    const limit = categoryCount === undefined ? 0 : Math.floor(categoryCount);
    if (limit <= 0) { return entries; }

    const counts = new Map<string, number>();
    for (const entry of entries) {
        counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    if (counts.size <= limit) { return entries; }

    if (limit === 1) {
        return entries.map(e => ({ ...e, category: 'Other' }));
    }

    const ranked = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
    const kept = new Set(ranked.slice(0, limit - 1));

    let merged = 0;
    const capped = entries.map(entry => {
        if (kept.has(entry.category)) { return entry; }
        merged++;
        return { ...entry, category: 'Other' };
    });
    log.info(`Capped ${counts.size} categories to ${limit} (${merged} sessions folded into "Other")`);
    return capped;
}

/**
 * Normalises a raw model label into something usable as a folder name.
 * Returns `undefined` for blanks and placeholder values.
 */
export function sanitizeLabel(raw: string | null | undefined): string | undefined {
    const cleaned = (raw ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/^["'`*_#-]+/, '')
        .replace(/["'`*_#.:;,-]+$/, '')
        .trim();
    if (!cleaned) { return undefined; }
    if (/^(other|none|n\/a|general|unknown)$/i.test(cleaned)) { return undefined; }
    return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Production single-session classifier: free model → embedding → "Other". */
async function defaultClassifyOne(
    session: Session,
    levels: LabelLevels,
    embeddingEngine?: IEmbeddingEngine | null,
    embeddingCategories?: string[],
): Promise<SingleClassification> {
    const result = await classifySessionWithCategories(
        session,
        embeddingCategories ?? ['Other'],
        embeddingEngine,
        levels,
    );
    return {
        category: result.type,
        subcategory: result.subtype,
        subSubcategory: result.subSubtype,
        usedLlm: result.usedLlm,
    };
}

/** Consolidate the top-level category labels across the whole group. */
async function refineTopLevel(
    entries: SessionClassification[],
    deps: ChatSessionClassifierDeps,
): Promise<SessionClassification[]> {
    const labels = [...new Set(entries.map(e => e.category))];
    if (labels.length < 2) { return entries; }

    const refine = deps.refineCategories ?? refineCategories;
    const mapping = await refine(labels).catch(() => null);
    if (!mapping || mapping.size === 0) { return entries; }

    let changed = 0;
    const refined = entries.map(entry => {
        const next = sanitizeLabel(mapping.get(entry.category));
        if (!next || next === entry.category) { return entry; }
        changed++;
        return { ...entry, category: next };
    });
    log.info(
        `Consolidated ${labels.length} top-level labels → ` +
        `${new Set(refined.map(e => e.category)).size} (${changed} entries moved)`,
    );
    return refined;
}

/**
 * Consolidate the labels at `level` (2 = sub-topic under a category,
 * 3 = sub-sub-topic under a category|sub-topic pair).
 */
async function refineLevel(
    entries: SessionClassification[],
    level: 2 | 3,
    sessions: Session[],
    deps: ChatSessionClassifierDeps,
): Promise<SessionClassification[]> {
    const summaries = new Map(sessions.map(s => [s.id, s]));
    const inputs: LabelRefinementInput[] = [];

    for (const entry of entries) {
        const label = level === 2 ? entry.subcategory : entry.subSubcategory;
        if (!label) { continue; }
        const parent = level === 2
            ? entry.category
            : `${entry.category}|${entry.subcategory ?? ''}`;
        const session = summaries.get(entry.sessionId);
        inputs.push({
            parent,
            label,
            title: session?.title ?? entry.sessionId,
            summary: session?.messages.find(m => m.role === 'user')?.content.slice(0, 300) ?? '',
        });
    }

    // Nothing to consolidate unless at least two entries share a parent.
    const byParent = new Map<string, number>();
    for (const input of inputs) {
        byParent.set(input.parent, (byParent.get(input.parent) ?? 0) + 1);
    }
    if (![...byParent.values()].some(n => n >= 2)) { return entries; }

    const refine = deps.refineLabelsUnderParent ?? refineLabelsUnderParentDefault;
    const mapping = await refine(inputs).catch(() => null);
    if (!mapping || mapping.size === 0) { return entries; }

    let changed = 0;
    const refined = entries.map(entry => {
        const current = level === 2 ? entry.subcategory : entry.subSubcategory;
        if (!current) { return entry; }
        const next = sanitizeLabel(mapping.get(current));
        if (!next || next === current) { return entry; }
        changed++;
        return level === 2
            ? { ...entry, subcategory: next }
            : { ...entry, subSubcategory: next };
    });
    log.info(`Consolidated ${inputs.length} level-${level} labels (${changed} entries moved)`);
    return refined;
}

/**
 * Default consolidation: reuse the KB sub-topic refinement (one LLM pass per
 * parent group) by presenting each input as a KB entry.
 */
async function refineLabelsUnderParentDefault(
    inputs: LabelRefinementInput[],
): Promise<Map<string, string> | null> {
    const entries: KbEntry[] = inputs.map(input => ({
        sessionId: input.title,
        type: input.parent,
        subtype: input.label,
        title: input.title,
        summary: input.summary,
        tags: [],
        createdAt: '',
    }));
    return refineSubtypes(entries);
}

