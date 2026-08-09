// src/analytics/kbEmbeddingClassifier.ts
// Fallback classifier using the local ONNX embedding model (Xenova/all-MiniLM-L6-v2).
// When no LLM provider is available, we embed the session content and pick the
// KB category whose embedding is most similar (cosine similarity).
//
// This requires the semantic-search model to have been downloaded (via
// SemanticIndexer).  If the engine is not ready, returns null.

import type { Session } from '../types/index';
import type { IEmbeddingEngine } from '../search/semanticContracts';
import { SEMANTIC_MIN_SCORE } from '../search/semanticContracts';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB-EMBED');

// ── Cached category embeddings ─────────────────────────────────────────────

/**
 * Lightweight in-memory cache of pre-computed category name embeddings.
 * Populated lazily on first use.
 */
const categoryEmbeddingCache = new Map<string, Float32Array>();

// ── Cosine similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const mag = Math.sqrt(normA) * Math.sqrt(normB);
    return mag === 0 ? 0 : dot / mag;
}

// ── Session text builder ───────────────────────────────────────────────────

/**
 * Build a flat text representation of a session for embedding.
 * Shorter than the LLM prompt — we only need ~1k chars for embedding signal.
 */
export function buildSessionText(session: Session): string {
    const MAX_CHARS = 4_000;

    let text = `Title: ${session.title}\n\n`;
    for (const msg of session.messages) {
        const block = `[${msg.role.toUpperCase()}]\n${msg.content}\n\n`;
        if (text.length + block.length > MAX_CHARS) {
            const remaining = MAX_CHARS - text.length;
            if (remaining > 50) {
                text += `[${msg.role.toUpperCase()}]\n${msg.content.slice(0, remaining - 12)}...[truncated]\n\n`;
            }
            break;
        }
        text += block;
    }
    return text;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a session by finding the closest known category via embedding
 * similarity.  Returns null when:
 *  - The embedding engine is not ready/not provided
 *  - No categories are provided
 *  - No category exceeds the minimum similarity threshold
 *
 * @param engine   The local ONNX embedding engine (must be loaded).
 * @param session  The session to classify.
 * @param categories  The list of known category names to match against.
 * @param threshold   Minimum cosine similarity (0-1). Default 0.35.
 */
export async function classifySessionWithEmbedding(
    engine: IEmbeddingEngine | undefined | null,
    session: Session,
    categories: string[],
    threshold = SEMANTIC_MIN_SCORE,
): Promise<string | null> {
    if (!engine?.isReady) {
        return null;
    }
    if (categories.length === 0) {
        return null;
    }

    try {
        // 1) Build session text and embed it
        const sessionText = buildSessionText(session);
        const sessionEmbedding = await engine.embed(sessionText);

        // 2) Pre-compute category embeddings (cached)
        //    Build an array of categories that need embedding.
        const toEmbed: string[] = [];
        for (const cat of categories) {
            if (!categoryEmbeddingCache.has(cat)) {
                toEmbed.push(cat);
            }
        }
        if (toEmbed.length > 0) {
            const catEmbeddings = await engine.embedBatch(toEmbed);
            for (let i = 0; i < toEmbed.length; i++) {
                categoryEmbeddingCache.set(toEmbed[i], catEmbeddings[i]);
            }
        }

        // 3) Find closest category by cosine similarity
        let bestCat: string | null = null;
        let bestScore = 0;

        for (const cat of categories) {
            const catEmb = categoryEmbeddingCache.get(cat);
            if (!catEmb) continue; // should not happen
            const score = cosineSimilarity(sessionEmbedding, catEmb);
            if (score > bestScore) {
                bestScore = score;
                bestCat = cat;
            }
        }

        if (bestCat && bestScore >= threshold) {
            log.info(`Embedding classified "${session.id}" as "${bestCat}" (score=${bestScore.toFixed(3)})`);
            return bestCat;
        }

        log.debug(`Embedding no match for "${session.id}" — best="${bestCat}" score=${bestScore.toFixed(3)}`);
        return null;
    } catch (err) {
        log.warn(`Embedding classification failed for "${session.id}": ${err}`);
        return null;
    }
}