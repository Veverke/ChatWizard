// src/analytics/kbEmbeddingClassifier.ts
// Fallback classifier using the local ONNX embedding model (Xenova/all-MiniLM-L6-v2).
// When no LLM provider is available, we embed the session content and pick the
// KB category whose embedding is most similar (cosine similarity).
//
// This requires the semantic-search model to have been downloaded (via
// SemanticIndexer).  If the engine is not ready, returns null.

import type { Session } from '../types/index';
import type { IEmbeddingEngine } from '../search/semanticContracts';
import { createLogger } from '../utils/logger';

const log = createLogger().withContext('KB-EMBED');

// ── KB-specific embedding threshold ────────────────────────────────────────

/**
 * Minimum cosine similarity for KB embedding classification.
 * Lower than SEMANTIC_MIN_SCORE (0.35) because KB categories are short
 * (1-3 words) while session text is long, producing naturally lower scores.
 * Uses richer category descriptions (multi-word phrases) to improve match.
 */
const KB_EMBEDDING_MIN_SCORE = 0.20;

// ── Richer category descriptions for embedding ────────────────────────────

/**
 * Maps each category name to a richer description phrase used for embedding.
 * The display name stays short, but the embedding vector is computed from
 * the description — giving the model more semantic surface to match against
 * long session text.
 *
 * Categories without an entry here use their raw name for embedding.
 */
const CATEGORY_EMBEDDING_DESCRIPTIONS: Record<string, string> = {
    'Git': 'Git — version control, branching, merging, commits, pull requests',
    'Docker': 'Docker — containers, images, dockerfiles, compose, dockerization',
    'React': 'React — components, hooks, JSX, state, props, React framework',
    'Python': 'Python — Python programming, scripts, modules, pip, virtualenv',
    'Vs Code': 'Vs Code — VS Code editor, extensions, settings, configuration, IDE',
    'CSS': 'CSS — styling, layout, responsive design, Tailwind, SASS, themes',
    'API': 'API — REST, GraphQL, endpoints, requests, responses, web services',
    'Database': 'Database — SQL, queries, schema, migrations, data modeling',
    'Deployment': 'Deployment — CI/CD, pipelines, hosting, release, production',
    'Bugs': 'Bugs — fixing errors, debugging issues, troubleshooting problems, crashes',
    'Testing': 'Testing — unit tests, integration tests, test setup, assertions, mocks',
    'Architecture': 'Architecture — design decisions, system design, planning, brainstorming',
    'Refactoring': 'Refactoring — code restructuring, cleanup, optimization, modernization',
    'Features': 'Features — new capabilities, planned features, feature requests, enhancements',
    'Best Practices': 'Best Practices — coding conventions, patterns, recommendations, standards',
    'Configuration': 'Configuration — settings, environment variables, config files, setup',
};

/**
 * Get the embedding text for a category.
 * Uses the richer description if available, otherwise the raw name.
 */
function getCategoryEmbeddingText(category: string): string {
    return CATEGORY_EMBEDDING_DESCRIPTIONS[category] ?? category;
}

// ── Cached category embeddings ─────────────────────────────────────────────

/**
 * Lightweight in-memory cache of pre-computed category embeddings.
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
 * @param threshold   Minimum cosine similarity (0-1). Default 0.20 — lower than
 *                    the semantic search threshold (0.35) because KB categories
 *                    are short (1-3 words) while session text is long, so
 *                    cosine similarity is naturally lower.
 */
export async function classifySessionWithEmbedding(
    engine: IEmbeddingEngine | undefined | null,
    session: Session,
    categories: string[],
    threshold = KB_EMBEDDING_MIN_SCORE,
): Promise<string | null> {
    if (!engine) {
        log.debug(`Embedding fallback skipped — no embedding engine registered`);
        return null;
    }
    if (!engine.isReady) {
        log.debug(`Embedding fallback skipped — engine not ready (model still loading?)`);
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
        //    Build a map of category → embedding text for categories not yet cached.
        const uncached = new Map<string, string>();
        for (const cat of categories) {
            if (!categoryEmbeddingCache.has(cat)) {
                uncached.set(cat, getCategoryEmbeddingText(cat));
            }
        }
        if (uncached.size > 0) {
            const texts = [...uncached.values()];
            const catEmbeddings = await engine.embedBatch(texts);
            let idx = 0;
            for (const cat of uncached.keys()) {
                categoryEmbeddingCache.set(cat, catEmbeddings[idx++]);
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

        if (bestCat) {
            log.debug(`Embedding no match for "${session.id}" — best="${bestCat}" score=${bestScore.toFixed(3)} < threshold=${threshold}`);
        } else {
            log.warn(`Embedding produced no match at all for "${session.id}" — all categories scored 0`);
        }
        return null;
    } catch (err) {
        log.warn(`Embedding classification failed for "${session.id}": ${err}`);
        return null;
    }
}