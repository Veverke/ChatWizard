// src/search/semanticIndexer.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ISemanticIndexer, IEmbeddingEngine, ISemanticIndex, SemanticScope, SEMANTIC_MIN_SCORE } from './semanticContracts';
import { SemanticSearchResult } from './types';
import { Session } from '../types/index';
import { createLogger, type BoundLogger, withTimeout } from '../utils/logger';

const EMBEDDINGS_FILENAME = 'semantic-embeddings.bin';
const SAVE_DEBOUNCE_MS = 5_000;
const MODEL_CACHE_SUBDIR = 'models';
/**
 * Lock file name (in global storage) for serialising bulk embedding across
 * VS Code instances.  Each instance tries to atomically create this directory
 * before running the queue; only one succeeds at a time.
 */
const GLOBAL_BULK_LOCK = '.semantic-bulk-lock';
/** Max delay (ms) before retrying the lock after a failed attempt. */
const LOCK_RETRY_MAX_MS = 30_000;
/**
 * How old (ms) a bulk lock directory must be before we consider it stale and
 * remove it.  Prevents a lock left behind by a crash / force-kill from
 * permanently blocking embedding.  30s is long enough to avoid races with
 * a simultaneous VS Code restart.
 */
const STALE_LOCK_MS = 30_000;
// How long to wait after the last scheduleSession() call before starting to embed.
// This lets the archive-restore batch (which arrives a second or two after the
// initial file-watcher batch) be collected before the queue runs, so the progress
// bar shows the correct total from the very first update.
const QUEUE_START_DEBOUNCE_MS = 1_500;
/** Max texts per single embedBatch call. 30 texts = ~3-4 sessions per chunk.
 *  Small enough for frequent progress updates (~every 400-600ms), large enough
 *  for efficient ONNX batch inference on CPU. */
const EMBED_CHUNK_SIZE = 30;
/** Yield to the event loop after every chunk so VS Code stays responsive and progress updates are immediate. */
const YIELD_INTERVAL = 1;
/** Max time to wait for embedBatch() before falling back to zero-vectors. */
const EMBED_TIMEOUT_MS = 30_000;

/**
 * Injectable VS Code interactions — replace in unit tests to avoid real UI dialogs.
 */
export interface SemanticIndexerVsCodeApi {
    /**
     * Ask the user for consent to download the model.
     * Return `true` to proceed, `false` to decline.
     */
    showConsentDialog(): Promise<boolean>;
    /**
     * Return `true` if this is the first time the user has run semantic search
     * (i.e. the model has never been downloaded).
     */
    isFirstUse(storagePath: string): boolean;
    /**
     * Run `task` wrapped in a visible loading-progress indicator (e.g. window progress bar).
     * `report` forwards incremental status messages to the indicator.
     */
    loadModelWithProgress(task: (report: (msg: string) => void) => Promise<void>): Promise<void>;
    /**
     * Run the embedding-queue task wrapped in a visible progress indicator.
     * `report(completed, total)` is called after each session finishes.
     */
    runIndexingProgress(task: (report: (completed: number, total: number) => void) => Promise<void>): Promise<void>;
    /** Notify the user that background indexing finished. */
    showIndexingComplete(count: number): void;
    /**
     * Called after the model has been successfully downloaded for the first time.
     * Implementations should persist a marker so `isFirstUse` returns `false` on
     * subsequent activations, independent of where Xenova stores its model files.
     */
    markModelDownloaded(storagePath: string): void;
    /** Notify the user that the model downloaded successfully and is ready. */
    showModelReady(): void;
}

/**
 * Minimal subset of vscode.Memento needed for cross-window consent persistence.
 * Structurally compatible with `vscode.ExtensionContext.globalState`.
 */
export interface SemanticGlobalState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

const CONSENT_KEY = 'chatwizard.semanticConsentGiven';

export function defaultVsCodeApi(globalState?: SemanticGlobalState): SemanticIndexerVsCodeApi {
    return {
        async showConsentDialog(): Promise<boolean> {
            const choice = await vscode.window.showInformationMessage(
                'Chat Wizard: Semantic search requires downloading a ~22 MB AI model (Xenova/all-MiniLM-L6-v2). Download now?',
                'Download',
                'Cancel',
            );
            return choice === 'Download';
        },
        isFirstUse(storagePath: string): boolean {
            // Check BOTH globalState AND the sentinel file.
            // globalState is the fast path (shared across windows), but its async
            // update() may not have completed before shutdown — the sentinel file
            // is written synchronously and is the reliable fallback.
            if (globalState) {
                const consented = globalState.get<boolean>(CONSENT_KEY) ?? false;
                if (consented) { return false; }
            }
            // Fallback (tests / no globalState / async update didn't persist):
            // check the sentinel file written synchronously by markModelDownloaded().
            return !fs.existsSync(path.join(storagePath, MODEL_CACHE_SUBDIR, '.chatwizard-ready'));
        },
        async loadModelWithProgress(task: (report: (msg: string) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Chat Wizard: Downloading AI model…', cancellable: false },
                async (progress) => {
                    await task(msg => progress.report({ message: msg }));
                },
            );
        },
        async runIndexingProgress(task: (report: (completed: number, total: number) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Chat Wizard: building vector embeddings for semantic search…', cancellable: false },
                async (progress) => {
                    // Determinate (increment) mode with live count text.
                    // NOTE: If the total grows mid-run (archive restore adds sessions after
                    // the first batch starts), the increment will be small or zero, but the
                    // bar will NOT go backwards — it simply pauses until the next batch.
                    // This is significantly better than an indeterminate spinner.
                    let lastPct = 0;
                    await task((completed, total) => {
                        if (total === 0) { return; }
                        const pct = Math.round((completed / total) * 100);
                        const increment = Math.max(0, pct - lastPct);
                        lastPct = pct;
                        progress.report({ increment, message: `${completed} / ${total} sessions` });
                    });
                },
            );
        },
        showIndexingComplete(count: number): void {
            void vscode.window.showInformationMessage(
                `Chat Wizard: Semantic search ready — ${count} session${count === 1 ? '' : 's'} have vector embeddings.`
            );
        },
        markModelDownloaded(storagePath: string): void {
            // Always write the sentinel file synchronously — this is the reliable
            // persistence mechanism that survives VS Code shutdown even if the
            // async globalState.update() hasn't completed yet.
            const dir = path.join(storagePath, MODEL_CACHE_SUBDIR);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            try {
                fs.writeFileSync(path.join(dir, '.chatwizard-ready'), '');
            } catch {
                // Non-critical: if writing fails the consent dialog may reappear on next reload.
            }

            if (globalState) {
                // Also persist consent in globalState — survives across windows and reloads.
                // This is fire-and-forget; the sentinel file above is the reliable source.
                void globalState.update(CONSENT_KEY, true);
            }
        },
        showModelReady(): void {
            void vscode.window.showInformationMessage(
                'Chat Wizard: AI model downloaded successfully — semantic search is ready.'
            );
        },
    };
}

interface QueueEntry {
    sessionId: string;
    role: 'user' | 'assistant';
    messageIndex: number;
    paragraphIndex: number;
    text: string;
}

/**
 * Orchestrates background embedding of sessions and exposes semantic search.
 *
 * Accepts factory functions for `IEmbeddingEngine` and `ISemanticIndex` so that
 * unit tests can inject stubs without real model downloads or file I/O.
 *
 * The optional `vsCodeApi` parameter enables injecting stub VS Code UI interactions
 * (consent dialog, status bar) in unit tests.
 */
export class SemanticIndexer implements ISemanticIndexer {
    private readonly storagePath: string;
    private readonly engine: IEmbeddingEngine;
    private readonly index: ISemanticIndex;
    private readonly vsCodeApi: SemanticIndexerVsCodeApi;
    private readonly log: BoundLogger;

    private _isReady = false;
    private _declined = false;
    private _disposed = false;

    // Embedding queue
    private _queue: QueueEntry[] = [];
    private _queueRunning = false;
    private _totalSessionsQueued = 0;
    private _totalSessionsCompleted = 0;
    /** Remaining queue entries per session; deleted when the session reaches 0. */
    private _pendingBySession = new Map<string, number>();

    /** Feature 43: Max age in days for sessions to be included in the semantic index. 0 = no limit. */
    private _maxAgeDays: number = 0;

    // Status bar for indexing progress
    // (progress is surfaced via vsCodeApi.runIndexingProgress — no local status bar item)

    // Debounced save timer
    private _saveTimer: ReturnType<typeof setTimeout> | undefined;

    // Debounced queue start timer.
    // Resets on every scheduleSession() call so embedding only begins after sessions
    // stop arriving — letting both the live batch and the archive-restore batch land
    // before the first embed, ensuring the progress total is correct from the start.
    private _queueStartTimer: ReturnType<typeof setTimeout> | undefined;
    // Retry timer for global bulk-lock acquisition — fires when another instance
    // is holding the lock, giving it another chance after a backoff.
    private _lockRetryTimer: ReturnType<typeof setTimeout> | undefined;
    // Debounced "indexing complete" notification timer.
    // Prevents a double notification when the archive-restore batch arrives shortly
    // after the first file-watcher batch (two _runQueue() runs → one notification).
    private _indexingCompleteTimer: ReturnType<typeof setTimeout> | undefined;

    /** Timestamp of the last progress report — used by the stall watchdog. */
    private _lastProgressTs: number = 0;
    /** Stall watchdog timer. Reset whenever _lastProgressTs is updated. */
    private _stallTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly _queueStartDebounceMs: number;
    private readonly embeddingsPath: string;
    /** Path to the global bulk-embedding lock directory. */
    private readonly _bulkLockPath: string;
    /** Whether this instance currently holds the bulk lock. */
    private _bulkLockHeld = false;

    constructor(
        storagePath: string,
        engineFactory: (cacheDir: string) => IEmbeddingEngine,
        indexFactory: () => ISemanticIndex,
        vsCodeApi?: SemanticIndexerVsCodeApi,
        queueStartDebounceMs?: number,
        parentLog?: BoundLogger,
        embeddingsFilePath?: string,
    ) {
        this.embeddingsPath = embeddingsFilePath ?? path.join(storagePath, EMBEDDINGS_FILENAME);
        this._bulkLockPath = path.join(storagePath, GLOBAL_BULK_LOCK);
        this.storagePath = storagePath;
        this.engine = engineFactory(path.join(storagePath, MODEL_CACHE_SUBDIR));
        this.index = indexFactory();
        this.vsCodeApi = vsCodeApi ?? defaultVsCodeApi();
        this._queueStartDebounceMs = queueStartDebounceMs ?? QUEUE_START_DEBOUNCE_MS;
        this.log = parentLog?.withContext('SemanticIndexer') ?? createLogger().withContext('SemanticIndexer');
    }

    /**
     * Feature 43: Set the maximum age (in days) for sessions to be included in the semantic index.
     * Sessions older than this threshold will be skipped during scheduleSession().
     * @param days Max age in days. 0 or negative = no limit.
     */
    setMaxAgeDays(days: number): void {
        this._maxAgeDays = days > 0 ? days : 0;
    }

    // ── Getters ─────────────────────────────────────────────────────────────

    get isReady(): boolean {
        return this._isReady;
    }

    get indexedCount(): number {
        return this.index.size;
    }

    get isIndexing(): boolean {
        return this._queueRunning;
    }

    /** Expose the embedding engine for downstream consumers (e.g. KB classification fallback). */
    get embeddingEngine(): IEmbeddingEngine {
        return this.engine;
    }

    // ── initialize() ────────────────────────────────────────────────────────

    /**
     * Loads the model (with optional first-use consent dialog) and restores the
     * persisted index from disk. Idempotent — resolves immediately if already ready.
     * On user decline, resolves without error and marks the session as declined.
     */
    async initialize(): Promise<void> {
        if (this._isReady || this._declined || this._disposed) {
            return;
        }

        // First-use consent
        const isFirstDownload = this.vsCodeApi.isFirstUse(this.storagePath);
        if (isFirstDownload) {
            const consented = await this.vsCodeApi.showConsentDialog();
            if (!consented) {
                this._declined = true;
                return;
            }
        }

        // Load model — only show the progress indicator on first download.
        // On subsequent reloads the model is cached locally, so a notification
        // would be misleading ("Downloading" = already on disk) and visually noisy.
        if (isFirstDownload) {
            await this.vsCodeApi.loadModelWithProgress(async (report) => {
                await this.engine.load(report);
            });
        } else {
            await this.engine.load();
        }

        // Persist the marker only after a successful download so that the popup
        // reappears if the download fails and the user opens VS Code again.
        if (isFirstDownload) {
            this.vsCodeApi.markModelDownloaded(this.storagePath);
            this.vsCodeApi.showModelReady();
        }

        // Restore persisted index with a 10-second timeout
        this.log.debug('Loading persisted index from %s', this.embeddingsPath);
        try {
            await withTimeout(this.index.load(this.embeddingsPath), 10_000, 'index.load');
            this.log.debug('Persisted index loaded — %d vectors restored', this.index.size);
        } catch (err) {
            this.log.warn('Could not load persisted index (will start fresh): %s', String(err));
        }

        this._isReady = true;
    }

    // ── scheduleSession() ───────────────────────────────────────────────────

    /**
     * Queues all messages of a session for embedding.
     * - Each user message → one queue entry.
     * - Each assistant response → one entry per non-empty paragraph (split on `\n\n`).
     * Skips silently if the session is already in the index or the indexer is not ready.
     */
    scheduleSession(session: Session): void {
        if (!this._isReady || this._disposed) {
            return;
        }
        if (this.index.has(session.id)) {
            this.log.debug('scheduleSession: session %s already indexed — skipping', session.id);
            return;
        }
        // Skip if this session is already queued but not yet processed — avoids
        // enqueuing duplicate work and inflating _totalSessionsQueued when repeated
        // upsert events fire for the same session.
        if (this._pendingBySession.has(session.id)) {
            this.log.debug('scheduleSession: session %s already queued — skipping', session.id);
            return;
        }

        // Feature 43: Skip sessions older than the configured max age.
        if (this._maxAgeDays > 0) {
            const updatedAt = new Date(session.updatedAt).getTime();
            if (!isNaN(updatedAt)) {
                const cutoff = Date.now() - this._maxAgeDays * 24 * 60 * 60 * 1000;
                if (updatedAt < cutoff) {
                    return;
                }
            }
        }

        let added = 0;

        // Index the session title as a synthetic user entry (messageIndex = -1).
        // Titles are topic-level abstractions that match natural-language queries more
        // directly than verbose message content. The search aggregator keeps the best
        // score per session, so a strong title hit promotes the session without
        // displacing content-based matches.
        const titleText = session.title?.trim();
        if (titleText) {
            this._queue.push({ sessionId: session.id, role: 'user', messageIndex: -1, paragraphIndex: 0, text: titleText });
            added++;
        }

        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
            const msg = session.messages[msgIdx];
            const text = msg.content?.trim();
            if (!text) { continue; }

            if (msg.role === 'user') {
                this._queue.push({ sessionId: session.id, role: 'user', messageIndex: msgIdx, paragraphIndex: 0, text });
                added++;
            } else if (msg.role === 'assistant') {
                const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
                for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
                    this._queue.push({
                        sessionId: session.id,
                        role: 'assistant',
                        messageIndex: msgIdx,
                        paragraphIndex: paraIdx,
                        text: paragraphs[paraIdx],
                    });
                    added++;
                }
            }
        }

        if (added === 0) { return; }

        this._totalSessionsQueued++;
        this._pendingBySession.set(session.id, added);

        if (!this._queueRunning) {
            // Cancel any pending "indexing complete" notification — more sessions are
            // arriving, so the current run's completion toast must be suppressed.
            if (this._indexingCompleteTimer !== undefined) {
                clearTimeout(this._indexingCompleteTimer);
                this._indexingCompleteTimer = undefined;
            }
            // Debounce: reset the start timer on every new session so the queue only
            // begins once sessions stop arriving. This ensures both the live batch (85)
            // and the archive-restore batch (24 more) are collected before embedding
            // starts, giving a stable total (109) from the very first progress report.
            if (this._queueStartTimer !== undefined) {
                clearTimeout(this._queueStartTimer);
            }
            this._queueStartTimer = setTimeout(() => {
                this._queueStartTimer = undefined;
                if (!this._queueRunning && this._queue.length > 0 && !this._disposed) {
                    this._runQueue();
                }
            }, this._queueStartDebounceMs);
        }
    }

    // ── removeSession() ─────────────────────────────────────────────────────

    removeSession(sessionId: string): void {
        this.index.remove(sessionId);
        this._scheduleSave();
    }

    // ── search() ────────────────────────────────────────────────────────────

    async search(query: string, topK: number, minScore = SEMANTIC_MIN_SCORE, scope: SemanticScope = 'both'): Promise<SemanticSearchResult[]> {
        if (!this._isReady) {
            throw new Error('SemanticIndexer is not ready. Call initialize() first.');
        }
        const queryVector = await this.engine.embed(query);
        // Over-fetch so aggregation doesn't lose good sessions
        const hits = this.index.search(queryVector, topK * 10, minScore, scope);

        // Aggregate: keep best score per sessionId
        const bestBySession = new Map<string, SemanticSearchResult>();
        for (const hit of hits) {
            const existing = bestBySession.get(hit.sessionId);
            if (!existing || hit.score > existing.score) {
                bestBySession.set(hit.sessionId, { sessionId: hit.sessionId, score: hit.score });
            }
        }

        return [...bestBySession.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    // ── dispose() ───────────────────────────────────────────────────────────

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        // Drain the queue without embedding remaining items
        this._queue = [];

        // Cancel pending timers
        if (this._queueStartTimer !== undefined) {
            clearTimeout(this._queueStartTimer);
            this._queueStartTimer = undefined;
        }
        if (this._saveTimer !== undefined) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
        if (this._indexingCompleteTimer !== undefined) {
            clearTimeout(this._indexingCompleteTimer);
            this._indexingCompleteTimer = undefined;
        }
        if (this._stallTimer !== undefined) {
            clearTimeout(this._stallTimer);
            this._stallTimer = undefined;
        }
        if (this._lockRetryTimer !== undefined) {
            clearTimeout(this._lockRetryTimer);
            this._lockRetryTimer = undefined;
        }

        // Release the global bulk lock if we hold it — lets another instance start building.
        this._releaseBulkLock();

        // Synchronous final save — must complete before the process exits
        if (this._isReady) {
            try {
                this.index.saveSync(this.embeddingsPath);
                this.log.debug('Final save complete');
            } catch (err) {
                this.log.warn('Final save failed: %s', String(err));
            }
        }
    }

    // ── Global bulk lock ───────────────────────────────────────────────────
    //
    // The lock uses fs.mkdirSync which is atomic on every platform (including
    // Windows): only one process succeeds, the rest get an EEXIST / EACCES.
    // This prevents N VS Code instances from each building embeddings for their
    // respective workspaces simultaneously, which would saturate the CPU.
    //
    // If the lock cannot be acquired the instance shows a single info message
    // and defers to incremental per-session embedding.  Sessions that are never
    // bulk-built will be indexed normally the next time the workspace is opened
    // without contention.

    /**
     * Try to acquire the global bulk-embedding lock synchronously.
     * @returns `true` if the lock was acquired, `false` if another instance holds it.
     */
    private _tryAcquireBulkLock(): boolean {
        if (this._bulkLockHeld) { return true; }
        try {
            // Ensure the parent directory exists (global storage may not yet be created)
            fs.mkdirSync(path.dirname(this._bulkLockPath), { recursive: true });
            fs.mkdirSync(this._bulkLockPath, { recursive: false });
            this._bulkLockHeld = true;
            this.log.debug('Acquired global bulk lock at %s', this._bulkLockPath);
            return true;
        } catch {
            // Lock directory exists — check if it's stale (left over from a crash).
            try {
                const stat = fs.statSync(this._bulkLockPath);
                if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
                    this.log.warn(
                        'Bulk lock at %s is stale (age=%dms) — removing and retrying',
                        this._bulkLockPath,
                        Date.now() - stat.mtimeMs,
                    );
                    fs.rmdirSync(this._bulkLockPath);
                    // Retry once
                    try {
                        fs.mkdirSync(this._bulkLockPath, { recursive: false });
                        this._bulkLockHeld = true;
                        this.log.debug('Acquired (stale) global bulk lock at %s', this._bulkLockPath);
                        return true;
                    } catch {
                        this.log.debug('Global bulk lock still held after stale removal — deferring');
                        return false;
                    }
                }
            } catch {
                // stat/rmdir failed — lock directory probably vanished or is locked by
                // another process. Treat as genuinely held.
            }
            this.log.debug('Global bulk lock held by another instance — deferring');
            return false;
        }
    }

    /** Release the global bulk-embedding lock. */
    private _releaseBulkLock(): void {
        if (!this._bulkLockHeld) { return; }
        this._bulkLockHeld = false;
        try {
            fs.rmdirSync(this._bulkLockPath);
            this.log.debug('Released global bulk lock');
        } catch {
            // Non-critical — stale lock is harmless; next instance will overwrite.
        }
    }

    /**
     * Show a one-shot info message about the lock being held by another instance.
     */
    private _showLockContentionNotification(): void {
        // Use a flag in the vsCodeApi to avoid spamming the user on every retry.
        // This is best-effort — not persisted across restarts.
        if ((this as any).__lockNoticeShown) { return; }
        (this as any).__lockNoticeShown = true;
        void vscode.window.showInformationMessage(
            'Chat Wizard: Vector embeddings are being built in another VS Code ' +
            'instance. This workspace will index new sessions incrementally ' +
            'once the other instance finishes.'
        );
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Embed a batch of texts with a timeout.
     * Falls back to zero-vectors for the full batch if the call times out or throws.
     */
    private async _embedWithTimeout(texts: string[]): Promise<Float32Array[]> {
        const start = performance.now();
        try {
            const embeddings = await withTimeout(
                this.engine.embedBatch(texts),
                EMBED_TIMEOUT_MS,
                `embedBatch(${texts.length} texts)`,
            );
            this.log.debug('embedBatch(%d texts) OK in %dms', texts.length, Math.round(performance.now() - start));

            // Fast zero-vector check: a real embedding for all-MiniLM-L6-v2 should
            // have non-zero values; check the first 3 elements of each vector.
            let zeroCount = 0;
            for (const emb of embeddings) {
                if (emb.length < 3 || (emb[0] === 0 && emb[1] === 0 && emb[2] === 0)) {
                    zeroCount++;
                }
            }
            if (zeroCount > 0) {
                this.log.warn('embedBatch returned %d/%d zero vectors', zeroCount, embeddings.length);
            }
            return embeddings;
        } catch (err) {
            this.log.warn('embedBatch(%d texts) failed after %dms: %s — falling back to zero-vectors', texts.length, Math.round(performance.now() - start), String(err));
            // Fallback: return zero vectors for all texts so the queue drains instead of
            // getting stuck on a bad batch.
            return texts.map(() => new Float32Array(384));
        }
    }

    /** Start the stall watchdog — logs a warning if no progress is made within 120s. */
    private _startStallWatchdog(): void {
        this._clearStallWatchdog();
        this._lastProgressTs = Date.now();
        this._stallTimer = setTimeout(() => {
            const elapsed = Date.now() - this._lastProgressTs;
            if (elapsed >= 120_000 && this._queueRunning && !this._disposed) {
                this.log.warn('PROGRESS STALL — no progress for %dms (queue: %d entries, %d queued, %d completed)', elapsed, this._queue.length, this._totalSessionsQueued, this._totalSessionsCompleted);
                // Reset the watchdog for another cycle
                this._startStallWatchdog();
            }
        }, 120_000);
    }

    /** Clear the stall watchdog timer. */
    private _clearStallWatchdog(): void {
        if (this._stallTimer !== undefined) {
            clearTimeout(this._stallTimer);
            this._stallTimer = undefined;
        }
    }

    private async _runQueue(): Promise<void> {
        // Try the global lock first to serialise bulk embedding across instances.
        if (!this._tryAcquireBulkLock()) {
            this._showLockContentionNotification();
            // Don't set _queueRunning — the queue stays so the next scheduleSession
            // call will retry (with its 1.5s debounce).  If this is the initial bulk
            // batch, scheduleSession won't be called again until the next startup,
            // so schedule a retry with backoff.
            const delay = this._totalSessionsQueued > 0 ? LOCK_RETRY_MAX_MS : 15_000;
            this._lockRetryTimer = setTimeout(() => {
                this._lockRetryTimer = undefined;
                if (!this._disposed && this._queue.length > 0 && !this._queueRunning) {
                    this._queueStartTimer = setTimeout(() => {
                        this._queueStartTimer = undefined;
                        if (!this._disposed && this._queue.length > 0 && !this._queueRunning) {
                            this._runQueue();
                        }
                    }, 500);
                }
            }, delay);
            return;
        }

        this._queueRunning = true;
        this._startStallWatchdog();

        this.log.info('Queue started — %d entries across %d sessions', this._queue.length, this._pendingBySession.size);

        await this.vsCodeApi.runIndexingProgress(async (report) => {
            // Process the queue in an inline chunk loop.
            // This replaces the old _processQueueBatch approach that grouped entries by
            // session — the inline loop works directly on the flat queue, slicing off
            // EMBED_CHUNK_SIZE entries at a time, which is simpler and faster.
            let chunkCount = 0;
            while (this._queue.length > 0 && !this._disposed) {
                const chunk = this._queue.splice(0, EMBED_CHUNK_SIZE);
                const texts = chunk.map(e => e.text);
                const embeddings = await this._embedWithTimeout(texts);

                // Collect completed session IDs (deduped) for counter bookkeeping
                const completedSessions = new Set<string>();
                for (let i = 0; i < chunk.length; i++) {
                    const { sessionId, entry } = { sessionId: chunk[i].sessionId, entry: chunk[i] };
                    const embedding = embeddings[i];
                    if (embedding) {
                        this.index.add(sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding);
                    }
                    completedSessions.add(sessionId);
                }

                // Decrement pending counts; remove sessions that have no more pending entries
                for (const sid of completedSessions) {
                    const remaining = this._pendingBySession.get(sid);
                    if (remaining !== undefined) {
                        const updated = remaining - chunk.filter(e => e.sessionId === sid).length;
                        if (updated <= 0) {
                            this._pendingBySession.delete(sid);
                            this._totalSessionsCompleted++;
                        } else {
                            this._pendingBySession.set(sid, updated);
                        }
                    }
                }

                // Schedule save periodically
                if (chunkCount % 10 === 0) {
                    this._scheduleSave();
                }

                chunkCount++;

                // Update last-progress timestamp (resets the stall watchdog)
                this._lastProgressTs = Date.now();

                // Report progress
                report(this._totalSessionsCompleted, this._totalSessionsQueued);

                // Yield to the event loop every YIELD_INTERVAL chunks so VS Code stays
                // responsive during indexing. With YIELD_INTERVAL=1, we yield after every chunk
                // which gives the smoothest progress feedback.
                if (chunkCount % YIELD_INTERVAL === 0) {
                    await new Promise<void>(r => setImmediate(r));
                }
            }
        });

        // Final save after queue is drained
        this._scheduleSave();

        this._clearStallWatchdog();
        this._queueRunning = false;

        // Release the global lock so another instance can start building.
        this._releaseBulkLock();

        this.log.info('Queue finished — %d sessions completed out of %d queued', this._totalSessionsCompleted, this._totalSessionsQueued);

        // If more sessions were added while we were wrapping up, schedule a new queue
        // run via the debounce timer so it shows a single fresh progress bar.
        if (!this._disposed && this._queue.length > 0) {
            this.log.debug('Queue re-trigger — %d entries remaining', this._queue.length);
            this._queueStartTimer = setTimeout(() => {
                this._queueStartTimer = undefined;
                if (!this._queueRunning && this._queue.length > 0 && !this._disposed) {
                    this._runQueue();
                }
            }, this._queueStartDebounceMs);
            return;
        }

        if (!this._disposed && this._totalSessionsCompleted > 0) {
            if (this._indexingCompleteTimer !== undefined) {
                clearTimeout(this._indexingCompleteTimer);
            }
            this._indexingCompleteTimer = setTimeout(() => {
                this._indexingCompleteTimer = undefined;
                if (!this._disposed) {
                    this.vsCodeApi.showIndexingComplete(this._totalSessionsCompleted);
                }
            }, 5_000);
        }
    }

    private _scheduleSave(): void {
        if (this._saveTimer !== undefined) {
            clearTimeout(this._saveTimer);
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = undefined;
            this.index
                .save(this.embeddingsPath)
                .catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }
}