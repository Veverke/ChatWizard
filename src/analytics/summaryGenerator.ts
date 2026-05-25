// src/analytics/summaryGenerator.ts
// Three-tier session summary generator (Feature 18):
//   1. Chronicle checkpoints.overview (free, instant)
//   2. VS Code LM API via Copilot subscription (no extra key)
//   3. Offline TF-IDF keyword heuristic (always available)

import { Session } from '../types/index';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';

// ─── TF-IDF heuristic ─────────────────────────────────────────────────────────

/** Stop words to exclude from TF-IDF keyword extraction. */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'shall', 'that', 'this', 'these', 'those', 'it', 'its', 'i', 'we',
    'you', 'they', 'he', 'she', 'my', 'our', 'your', 'their', 'what', 'which',
    'who', 'how', 'when', 'where', 'why', 'not', 'also', 'just', 'so', 'as',
    'if', 'then', 'than', 'there', 'here', 'all', 'each', 'any', 'some',
    'use', 'using', 'used', 'make', 'need', 'want', 'let', 'get', 'like',
    'see', 'look', 'take', 'know', 'think', 'say', 'go', 'now', 'out',
    'no', 'yes', 'ok', 'okay', 'hi', 'hello', 'thanks', 'please',
]);

/**
 * Extracts top-N keywords from `text` using simple TF-IDF-like scoring.
 * Returns keywords sorted by frequency descending.
 */
function extractKeywords(text: string, topN = 3): string[] {
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s_]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    const freq = new Map<string, number>();
    for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
    }

    return Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([w]) => w);
}

/**
 * Generates a one-line TF-IDF summary from session content.
 * Never returns an empty string — falls back to the session title.
 */
export function generateTfidfSummary(session: Session): string {
    const text = session.messages
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join(' ')
        .slice(0, 4000);

    if (!text.trim()) {
        return session.title;
    }

    const keywords = extractKeywords(text, 3);
    if (keywords.length === 0) {
        return session.title;
    }

    return keywords.join(', ');
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

/** Limits concurrent LM API calls to avoid throttling. */
class RateLimiter {
    private readonly maxConcurrent: number;
    private active = 0;
    private queue: Array<() => void> = [];

    constructor(maxConcurrent = 5) {
        this.maxConcurrent = maxConcurrent;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this._acquire();
        try {
            return await fn();
        } finally {
            this._release();
        }
    }

    private _acquire(): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise(resolve => { this.queue.push(resolve); });
    }

    private _release(): void {
        this.active--;
        const next = this.queue.shift();
        if (next) {
            this.active++;
            next();
        }
    }
}

// ─── SummaryGenerator ─────────────────────────────────────────────────────────

export class SummaryGenerator {
    private readonly rateLimiter = new RateLimiter(5);

    /**
     * Generates a one-line summary for `session` using the three-tier strategy:
     * 1. Chronicle overview (free, instant)
     * 2. VS Code LM API (Copilot)
     * 3. TF-IDF heuristic fallback
     */
    async generate(session: Session): Promise<string> {
        // Tier 1: Chronicle overview
        if (session.chronicleData?.overview) {
            return session.chronicleData.overview.slice(0, 200).split('\n')[0].trim();
        }

        // Tier 2: LM API
        try {
            const summary = await this.rateLimiter.run(() => this._generateViaCopilot(session));
            if (summary) { return summary; }
        } catch {
            // Fall through to TF-IDF
        }

        // Tier 3: TF-IDF fallback
        return generateTfidfSummary(session);
    }

    /**
     * Calls the VS Code LM API to summarise the session in one sentence.
     * Returns `undefined` if the API is unavailable or returns an error.
     */
    private async _generateViaCopilot(session: Session): Promise<string | undefined> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as typeof import('vscode');

            // Select the cheapest available Copilot model
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' })
                ?? await vscode.lm.selectChatModels({ vendor: 'copilot' });

            if (!model) { return undefined; }

            // Build a short snippet of the session content
            const snippet = session.messages
                .slice(0, 6)
                .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
                .join('\n')
                .slice(0, 800);

            const request = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(
                    `Summarise this coding assistant session in one sentence (max 15 words):\n\n${snippet}`
                )],
                {},
                new vscode.CancellationTokenSource().token,
            );

            let result = '';
            for await (const part of request.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    result += part.value;
                }
            }

            const cleaned = result.trim().replace(/^["']|["']$/g, '');
            return cleaned || undefined;
        } catch {
            return undefined;
        }
    }
}

// ─── Background job ───────────────────────────────────────────────────────────

/**
 * Runs the summary generation background job.
 * Processes sessions without a cached summary in batches, with a small delay
 * between batches to avoid blocking the UI.
 *
 * @param getAllSessionIds  Function that returns all session IDs in the index.
 * @param getSession       Function that returns a session by ID.
 * @param store            Sidecar metadata store for reading/writing summaries.
 * @param channel          Output channel for progress logging.
 * @param generator        The summary generator instance to use.
 */
export async function runSummaryBackgroundJob(
    getAllSessionIds: () => string[],
    getSession: (id: string) => Session | undefined,
    store: SidecarMetadataStore,
    channel: { appendLine(msg: string): void },
    generator: SummaryGenerator,
): Promise<void> {
    // Yield to avoid blocking startup
    await delay(2000);

    const ids = getAllSessionIds();
    let processed = 0;
    let skipped = 0;
    const BATCH_SIZE = 20;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (id) => {
            const existing = await store.get(id);
            if (existing?.summary) {
                skipped++;
                return;
            }

            const session = getSession(id);
            if (!session) { return; }

            try {
                const summary = await generator.generate(session);
                await store.setSummary(id, summary);
                processed++;
            } catch (err) {
                channel.appendLine(`[summary] Failed to generate for ${id}: ${err}`);
            }
        }));

        // Small delay between batches to stay non-blocking
        await delay(50);
    }

    channel.appendLine(`[summary] Background job complete — generated: ${processed}, already cached: ${skipped}`);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
