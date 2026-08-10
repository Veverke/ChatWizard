// src/analytics/kbClassifier.ts
// Feature 23 — KB Entry Classification
// Supports embedding-based (local ONNX model) and LLM-based classification.
//
// Priority: LLM → embedding → default category.
// Heuristic phrase-matching has been removed — the local ONNX embedding model
// (all-MiniLM-L6-v2) provides far better semantic understanding.

import type { Session } from '../types/index';
import type { KbEntryType } from '../types/kb';
import type { IEmbeddingEngine } from '../search/semanticContracts';
import { classifySessionWithLlm } from './kbLlmClassifier';
import { classifySessionWithEmbedding } from './kbEmbeddingClassifier';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB');

// ── Module-level embedding engine (set during extension activation) ─────────
let _globalEmbeddingEngine: IEmbeddingEngine | null | undefined;

/**
 * Register the embedding engine for use as a classification fallback.
 * Call once during extension activation from extension.ts.
 */
export function setKbEmbeddingEngine(engine: IEmbeddingEngine | null | undefined): void {
    _globalEmbeddingEngine = engine;
}

/** Resolve the effective embedding engine: explicit param wins over global. */
function resolveEngine(explicit?: IEmbeddingEngine | null): IEmbeddingEngine | null | undefined {
    return explicit !== undefined ? explicit : _globalEmbeddingEngine;
}

/**
 * Classify a session using the given categories.
 *
 * Tries the free AI model (Copilot LM API) first — the LLM generates a
 * free-form category label from the conversation content with no predefined
 * buckets. Falls back to embedding-based classification (local ONNX model)
 * when the model is unavailable. If neither is available, returns "Other"
 * as a safe default.
 *
 * @param session    The session to classify.
 * @param categories The list of valid category names used for embedding fallback.
 * @param embeddingEngine Optional. If provided and ready, used as fallback
 *                        when LLM is unavailable.
 * @returns An object with the best-matching category, optional subtype, and whether the LLM was used.
 */
export async function classifySessionWithCategories(
    session: Session,
    categories: string[],
    embeddingEngine?: IEmbeddingEngine | null,
): Promise<{ type: KbEntryType; subtype: string | null; usedLlm: boolean }> {
    // Resolve which embedding engine to use
    const engine = resolveEngine(embeddingEngine);

    // Try LLM first — no predefined categories, it invents a label freely
    const llmResult = await classifySessionWithLlm(session);
    if (llmResult) {
        return { type: llmResult.folder, subtype: llmResult.subtype, usedLlm: true };
    }

    log.debug(`LLM returned null for session ${session.id} — trying embedding fallback`);

    // Embedding fallback — uses local ONNX model when available
    const embeddingResult = await classifySessionWithEmbedding(engine, session, categories);
    if (embeddingResult) {
        log.info(`KB: embedding fallback classified ${session.id} as "${embeddingResult}"`);
        return { type: embeddingResult, subtype: null, usedLlm: false };
    }

    log.warn(`LLM and embedding both unavailable for session ${session.id} — using "Other"`);

    // No LLM, no embedding — label as Other instead of leaking a heuristic type name
    return { type: 'Other', subtype: null, usedLlm: false };
}