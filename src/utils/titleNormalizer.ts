// src/utils/titleNormalizer.ts
// Three-tier session title normalization: Chronicle → LM API → TF-IDF.

import { Message, ChronicleData } from '../types/index';
import type { Session } from '../types/index';

// ─── Stop words ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'the','and','for','are','but','not','you','all','can','her',
    'was','one','our','out','had','have','has','him','his','how',
    'its','let','may','she','who','use','that','this','with','from',
    'they','will','been','more','also','into','than','just','your',
    'what','when','where','which','while','about','would','could','should',
    'there','their','these','those','then','than','some','here','very',
    'been','were','like','only','want','need','make','take','get','set',
    'i','a','an','of','to','in','is','at','by','on','do','if','or','be',
    'up','no','as','so','me','my','we','us','it','he','am','go','did',
]);

// ─── Task 8-A — TF-IDF title heuristic ──────────────────────────────────────

const MAX_TITLE_CHARS = 120;
const MIN_TOKEN_COUNT = 3;

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Derives a human-readable title from session messages using a TF-IDF heuristic.
 * Returns a multi-topic string if the session spans multiple subjects.
 * Falls back to the first user message (truncated) if token count is too low.
 */
export function deriveTitleFromMessages(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) { return 'Untitled session'; }

    // Tokenize all user messages; compute TF per document (message)
    const msgTokens = userMessages.map(m => tokenize(m.content));
    const allTokens = msgTokens.flat();

    if (allTokens.length < MIN_TOKEN_COUNT) {
        // Not enough tokens — use first user message truncated
        return userMessages[0].content.slice(0, 80).replace(/\s+/g, ' ').trim();
    }

    // Global DF count (how many messages contain each token)
    const df = new Map<string, number>();
    for (const tokens of msgTokens) {
        const unique = new Set(tokens);
        for (const t of unique) {
            df.set(t, (df.get(t) ?? 0) + 1);
        }
    }

    // Global TF (raw count across all user messages)
    const tf = new Map<string, number>();
    for (const t of allTokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    const N = msgTokens.length || 1;
    // TF-IDF score
    const scores = new Map<string, number>();
    for (const [token, freq] of tf) {
        const idf = Math.log((N + 1) / ((df.get(token) ?? 0) + 1)) + 1;
        scores.set(token, freq * idf);
    }

    // Top 5 tokens by TF-IDF score
    const top5 = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t]) => t);

    if (top5.length === 0) {
        return userMessages[0].content.slice(0, 80).replace(/\s+/g, ' ').trim();
    }

    // Cluster by co-occurrence: tokens that appear in the same message share a cluster.
    // Simple greedy: group tokens together if they co-occur in at least one message.
    const clusters: string[][] = [];
    for (const token of top5) {
        let placed = false;
        for (const cluster of clusters) {
            // Check if this token co-occurs with any cluster member in any message
            for (const other of cluster) {
                for (const msgToks of msgTokens) {
                    if (msgToks.includes(token) && msgToks.includes(other)) {
                        cluster.push(token);
                        placed = true;
                        break;
                    }
                }
                if (placed) { break; }
            }
            if (placed) { break; }
        }
        if (!placed) { clusters.push([token]); }
    }

    const topClusters = clusters.slice(0, 3);
    if (topClusters.length === 1) {
        return topClusters[0].slice(0, 3).join(' ');
    }
    const count = topClusters.length;
    const parts = topClusters.map(c => c.slice(0, 2).join(' '));
    return `${count} topics: ${parts.join(' \u2192 ')}`;
}

// ─── Task 8-B — Chronicle-based title extractor ──────────────────────────────

/**
 * Returns a clean plain-text title derived from Chronicle overview text.
 * Strips Markdown headers and bold formatting before returning.
 * Returns `null` if the overview is absent or empty.
 */
export function deriveTitleFromChronicle(chronicleData: ChronicleData): string | null {
    const overview = chronicleData.overview;
    if (!overview || !overview.trim()) { return null; }
    // Strip Markdown headers (## Heading), bold (**text**), italics (*text*), backticks
    const stripped = overview
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (!stripped) { return null; }
    return stripped.slice(0, MAX_TITLE_CHARS);
}

// ─── Task 8-C — LM API title generator ──────────────────────────────────────

/**
 * Generates a session title by calling the VS Code Language Model API.
 * Returns `null` when no model is available or on any error.
 * Does not throw.
 */
export async function deriveTitleViaLmApi(messages: Message[]): Promise<string | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
        if (!model) { return null; }

        const userMessages = messages.filter(m => m.role === 'user').slice(0, 3);
        const excerpt = userMessages
            .map(m => m.content.slice(0, 200))
            .join('\n---\n')
            .slice(0, 600);

        const prompt = `Generate a short (10-word maximum) descriptive title for this chat session. Return ONLY the title, no punctuation or quotes.\n\nSession excerpt:\n${excerpt}`;

        const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prompt)],
            {},
            new vscode.CancellationTokenSource().token,
        );

        let result = '';
        for await (const chunk of response.text) { result += chunk; }
        result = result.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
        return result || null;
    } catch {
        return null;
    }
}

// ─── Task 8-D — Three-tier resolver ──────────────────────────────────────────

/**
 * Resolves the best available title for a session:
 * 1. Chronicle overview (free, no LLM).
 * 2. VS Code LM API (when `options.useLmApi` is true).
 * 3. TF-IDF heuristic (always available offline).
 *
 * Never throws.
 */
export async function resolveSessionTitle(
    session: Session,
    options?: { useLmApi?: boolean },
): Promise<string> {
    // Tier 1 — Chronicle data
    if (session.chronicleData) {
        const title = deriveTitleFromChronicle(session.chronicleData);
        if (title) { return title; }
    }

    // Tier 2 — LM API
    if (options?.useLmApi) {
        const title = await deriveTitleViaLmApi(session.messages);
        if (title) { return title; }
    }

    // Tier 3 — TF-IDF offline heuristic
    return deriveTitleFromMessages(session.messages);
}
