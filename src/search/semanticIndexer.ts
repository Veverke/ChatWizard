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
// How long to wait after the last scheduleSession() call before starting to embed.
// This lets the archive-restore batch (which arrives a second or two after the
// initial file-watcher batch) be collected before the queue runs, so the progress
// bar shows the correct total from the very first update.
const QUEUE_START_DEBOUNCE_MS = 1_500;
/** Max time to wait for the ONNX model to download / load before showing an error. */
const MODEL_LOAD_TIMEOUT_MS = 120_000;
/** Max time to wait for embedBatch() before falling back to zero-vectors. */
const EMBED_TIMEOUT_MS = 30_000;
/**
 * Max quiet period between progress reports before the queue is considered
 * stalled. If no progress is reported within this window, a stall-timeout is
 * logged and the queue is restarted to recover from a stuck ONNX call.
 */
const STALL_TIMEOUT_MS = 120_000;
/** Max texts per single embedBatch call. Worker-thread ONNX handles large batches efficiently. */
const EMBED_CHUNK_SIZE = 200;
/** Yield to the event loop every N chunks so VS Code stays responsive during indexing. */
const YIELD_INTERVAL = 5;
/**
 * Injectable VS Code interactions ΓÇö replace in unit tests to avoid real UI dialogs.
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
            if (globalState) {
                // globalState is shared across all VS Code windows ΓÇö reliable even when
                // multiple windows are open simultaneously.
                return !(globalState.get<boolean>(CONSENT_KEY) ?? false);
            }
            // Fallback (tests / no globalState): check the sentinel file written by
            // markModelDownloaded(). Checking only the directory is unreliable:
            // @xenova/transformers may load the model from its own OS-level cache
            // without creating this directory.
            return !fs.existsSync(path.join(storagePath, MODEL_CACHE_SUBDIR, '.chatwizard-ready'));
        },
        async loadModelWithProgress(task: (report: (msg: string) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Chat Wizard: Downloading AI model...', cancellable: false },
                async (progress) => {
                    await task(msg => progress.report({ message: msg }));
                },
            );
        },
        async runIndexingProgress(task: (report: (completed: number, total: number) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Chat Wizard: building vector embeddings for semantic search...',
                    cancellable: false,
                },
                async (progress) => {
                    // Use a numeric (determinate) progress bar so the user sees
                    // concrete progress. If the total grows mid-run (archive-restore
                    // batch arriving after the first batch), the percentage may dip
                    // briefly — this is preferable to an indeterminate spinner that
                    // offers no visual feedback at all.
                    await task((completed, total) => {
                        if (total === 0) { return; }
                        const pct = Math.min(100, Math.round((completed / total) * 100));
                        progress.report({ message: `${completed} / ${total} sessions (${pct}%)`, increment: undefined });
                    });
                },
            );
        },
        showIndexingComplete(count: number): void {
            void vscode.window.showInformationMessage(
                `Chat Wizard: Semantic search ready: ${count} session${count === 1 ? '' : 's'} have vector embeddings.`
            );
        },
        markModelDownloaded(storagePath: string): void {
            if (globalState) {
                // Persist consent in globalState ΓÇö survives across windows and reloads.
                void globalState.update(CONSENT_KEY, true);
                return;
            }
            // Fallback: write sentinel file.
            const dir = path.join(storagePath, MODEL_CACHE_SUBDIR);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            try {
                fs.writeFileSync(path.join(dir, '.chatwizard-ready'), '');
            } catch {
                // Non-critical: if writing fails the consent dialog may reappear on next reload.
            }
        },
        showModelReady(): void {
            void vscode.window.showInformationMessage(
                'Chat Wizard: AI model downloaded successfully ΓÇö semantic search is ready.'
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
    private readonly embeddingsPath: string;
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
    /** Tracks last progress report timestamp for stall detection. */
    private _lastProgressTs = 0;
    /** Stall watchdog timer. */
    private _stallTimer: ReturnType<typeof setTimeout> | undefined;

    // Status bar for indexing progress
    // (progress is surfaced via vsCodeApi.runIndexingProgress ΓÇö no local status bar item)

    // Debounced save timer
    private _saveTimer: ReturnType<typeof setTimeout> | undefined;

    // Debounced queue start timer.
    // Resets on every scheduleSession() call so embedding only begins after sessions
    // stop arriving ΓÇö letting both the live batch and the archive-restore batch land
    // before the first embed, ensuring the progress total is correct from the start.
    private _queueStartTimer: ReturnType<typeof setTimeout> | undefined;

    // Debounced "indexing complete" notification timer.
    // Prevents a double notification when the archive-restore batch arrives shortly
    // after the first file-watcher batch (two _runQueue() runs ΓåÆ one notification).
    private _indexingCompleteTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly _queueStartDebounceMs: number;

    // Max session age in days (0 = no limit). Sessions older than this are skipped.
    private _maxAgeDays = 0;

    constructor(
        storagePath: string,
        engineFactory: (cacheDir: string) => IEmbeddingEngine,
        indexFactory: () => ISemanticIndex,
        vsCodeApi?: SemanticIndexerVsCodeApi,
        queueStartDebounceMs?: number,
        parentLog?: BoundLogger,
        embeddingsFilePath?: string,
    ) {
        this.storagePath = storagePath;
        this.embeddingsPath = embeddingsFilePath ?? path.join(storagePath, EMBEDDINGS_FILENAME);
        this.engine = engineFactory(path.join(storagePath, MODEL_CACHE_SUBDIR));
        this.index = indexFactory();
        this.vsCodeApi = vsCodeApi ?? defaultVsCodeApi();
        this._queueStartDebounceMs = queueStartDebounceMs ?? QUEUE_START_DEBOUNCE_MS;
        this.log = parentLog?.withContext('SemanticIndexer') ?? createLogger().withContext('SemanticIndexer');
        this.log.debug('Constructed — storagePath=%s', storagePath);
    }

    // ΓöÇΓöÇ Getters ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

    get isReady(): boolean {
        return this._isReady;
    }

    get indexedCount(): number {
        return this.index.size;
    }

    get isIndexing(): boolean {
        return this._queueRunning;
    }

    /**
     * Sets the maximum age (in days) for sessions to be indexed.
     * Sessions whose updatedAt timestamp is older than this threshold are skipped.
     * Pass 0 to remove the limit.
     */
    setMaxAgeDays(days: number): void {
        this._maxAgeDays = Math.max(0, days);
        this.log.info('Max age set to %d days', this._maxAgeDays);
    }

    // ΓöÇΓöÇ initialize() ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

    /**
     * Loads the model (with optional first-use consent dialog) and restores the
     * persisted index from disk. Idempotent ΓÇö resolves immediately if already ready.
     * On user decline, resolves without error and marks the session as declined.
     */
    async initialize(): Promise<void> {
        if (this._isReady || this._declined || this._disposed) {
            this.log.debug('initialize() skipped — ready=%s declined=%s disposed=%s',
                this._isReady, this._declined, this._disposed);
            return;
        }

        this.log.info('Initialize started');

        // First-use consent
        const isFirstDownload = this.vsCodeApi.isFirstUse(this.storagePath);
        if (isFirstDownload) {
            this.log.info('First use detected — showing consent dialog');
            const consented = await this.vsCodeApi.showConsentDialog();
            if (!consented) {
                this._declined = true;
                this.log.info('User declined consent — semantic search disabled');
                return;
            }
            this.log.info('User granted consent — proceeding with model download');
        } else {
            this.log.debug('Already consented — skipping consent dialog');
        }

        // Load model, always wrapped in a progress indicator so the UI and tests
        // can observe the loading lifecycle regardless of whether it is a first download.
        try {
            await this.vsCodeApi.loadModelWithProgress(async (report) => {
                await withTimeout(
                    this.engine.load(report),
                    MODEL_LOAD_TIMEOUT_MS,
                    'ONNX model download/load',
                );
            });
            this.log.info('Model loaded successfully');
        } catch (err) {
            this.log.error('Model download/load failed after %dms: %s', MODEL_LOAD_TIMEOUT_MS, String(err));
            throw err; // let caller handle the error
        }

        // Persist the marker only after a successful download so that the popup
        // reappears if the download fails and the user opens VS Code again.
        if (isFirstDownload) {
            this.vsCodeApi.markModelDownloaded(this.storagePath);
            this.vsCodeApi.showModelReady();
            this.log.info('Model download marker persisted');
        }

        // Restore persisted index
        try {
            await withTimeout(
                this.index.load(this.embeddingsPath),
                10_000,
                'embedding index load from disk',
            );
            this.log.info('Persisted index loaded from cache — %d sessions restored, new sessions will be indexed as they arrive', this.index.size);
        } catch (err) {
            this.log.warn('Could not load persisted index (will start fresh): %s', String(err));
        }

        this._isReady = true;
        this.log.info('SemanticIndexer is now ready');
    }

    // ΓöÇΓöÇ scheduleSession() ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

    /**
     * Queues all messages of a session for embedding.
     * - Each user message ΓåÆ one queue entry.
     * - Each assistant response ΓåÆ one entry per non-empty paragraph (split on `\n\n`).
     * Skips silently if the session is already in the index or the indexer is not ready.
     */
    scheduleSession(session: Session): void {
        if (!this._isReady || this._disposed) {
            this.log.debug('scheduleSession skipped — ready=%s disposed=%s', this._isReady, this._disposed);
            return;
        }
        if (this.index.has(session.id)) {
            this.log.debug('scheduleSession skipped — session %s already indexed (restored from cache)', session.id);
            return;
        }
        // Enforce max age filter — skip sessions whose last update is older than the threshold.
        if (this._maxAgeDays > 0) {
            const cutoff = Date.now() - this._maxAgeDays * 24 * 60 * 60 * 1000;
            const updated = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
            if (updated > 0 && updated < cutoff) {
                this.log.debug('scheduleSession skipped — session %s is older than %d days', session.id, this._maxAgeDays);
                return; // session is too old — skip it
            }
        }
        // Skip if this session is already queued but not yet processed — avoids
        // enqueuing duplicate work and inflating _totalSessionsQueued when repeated
        // upsert events fire for the same session.
        if (this._pendingBySession.has(session.id)) {
            this.log.debug('scheduleSession skipped — session %s already queued', session.id);
            return;
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
        this.log.debug('Queued session %s — %d entries (total queued: %d)', session.id, added, this._totalSessionsQueued);

        if (!this._queueRunning) {
            if (this._indexingCompleteTimer !== undefined) {
                clearTimeout(this._indexingCompleteTimer);
                this._indexingCompleteTimer = undefined;
            }
            if (this._queueStartTimer !== undefined) {
                clearTimeout(this._queueStartTimer);
            }
            this._queueStartTimer = setTimeout(() => {
                this._queueStartTimer = undefined;
                this.log.debug('Queue start debounce elapsed — starting _runQueue (%d entries)', this._queue.length);
                if (!this._queueRunning && this._queue.length > 0 && !this._disposed) {
                    this._runQueue();
                }
            }, this._queueStartDebounceMs);
        }
    }

    // ΓöÇΓöÇ removeSession() ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

    removeSession(sessionId: string): void {
        this.index.remove(sessionId);
        this._scheduleSave();
        this.log.debug('Removed session %s from semantic index', sessionId);
    }

    // ΓöÇΓöÇ search() ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

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

    // ΓöÇΓöÇ dispose() ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this.log.info('Dispose called');

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

        // Final save (fire-and-forget - cannot await in dispose)
        if (this._isReady) {
            this.index.save(this.embeddingsPath).catch(() => { /* ignore */ });
            this.log.debug('Final save triggered');
        }

        // Terminate the embedding worker thread so ONNX inference stops immediately
        try {
            this.engine.dispose();
            this.log.debug('Embedding engine disposed');
        } catch {
            // Non-critical
        }
    }

    // --- Private helpers --------------------------------------------------------

    /**
     * Starts a watchdog timer that fires if no progress report arrives within
     * `STALL_TIMEOUT_MS`. The watchdog logs a warning but does not kill the queue
     * (the embed timeout will eventually trigger).
     */
    private _startStallWatchdog(): void {
        this._clearStallWatchdog();
        this._stallTimer = setTimeout(() => {
            const elapsed = Date.now() - this._lastProgressTs;
            if (elapsed >= STALL_TIMEOUT_MS && this._queueRunning && !this._disposed) {
                this.log.warn(
                    'Queue appears stalled — no progress for %dms (timeout=%dms). ' +
                    'The ONNX embedding call may be stuck. Waiting for embed timeout (%dms).',
                    elapsed, STALL_TIMEOUT_MS, EMBED_TIMEOUT_MS,
                );
            }
        }, STALL_TIMEOUT_MS);
    }

    private _clearStallWatchdog(): void {
        if (this._stallTimer !== undefined) {
            clearTimeout(this._stallTimer);
            this._stallTimer = undefined;
        }
    }

    private async _runQueue(): Promise<void> {
        this._queueRunning = true;
        this.log.info('Queue started — %d entries across %d sessions', this._queue.length, this._totalSessionsQueued);
        this._lastProgressTs = Date.now();

        // Start a stall watchdog: if no progress report arrives within STALL_TIMEOUT_MS,
        // log a warning (the queue may be stuck on ONNX).
        this._startStallWatchdog();

        await this.vsCodeApi.runIndexingProgress(async (report) => {
            // Work on a snapshot — new sessions arriving during processing stay
            // in _queue and trigger a restart at the end.
            const allEntries = this._queue.splice(0);
            this._queue = [];

            if (allEntries.length === 0) { return; }

            const sessionIds = new Set(allEntries.map(e => e.sessionId));
            const totalSessions = sessionIds.size;
            this.log.info('Embedding %d text entries across %d sessions (chunk size=%d)',
                allEntries.length, totalSessions, EMBED_CHUNK_SIZE);

            report(0, totalSessions);
            this._lastProgressTs = Date.now();

            // Process in large chunks — ONNX runs in a worker thread so the main
            // thread is never blocked by inference. Large batches minimise RPC
            // round-trips and structured-clone overhead.
            let completedSessions = new Set<string>();
            let failedChunks = 0;
            let totalZeroVec = 0;
            let anyTimeout = false;

            for (let offset = 0; offset < allEntries.length; offset += EMBED_CHUNK_SIZE) {
                if (this._disposed) { break; }

                // Yield occasionally so VS Code can paint UI updates
                const chunkIndex = Math.floor(offset / EMBED_CHUNK_SIZE);
                if (chunkIndex > 0 && chunkIndex % YIELD_INTERVAL === 0) {
                    await new Promise<void>(r => setImmediate(r));
                }

                const chunk = allEntries.slice(offset, offset + EMBED_CHUNK_SIZE);
                const chunkTexts = chunk.map(e => e.text);

                const embeddings = await this._embedWithTimeout(chunkTexts);

                // Store results
                let chunkZeroVec = 0;
                for (let i = 0; i < chunk.length; i++) {
                    const entry = chunk[i];
                    const embedding = embeddings[i];
                    if (embedding) {
                        this.index.add(entry.sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding);
                        // Quick zero-vector test — check first element only; full scan
                        // only when we know timeouts occurred.
                        const isZero = embedding[0] === 0 && embedding[1] === 0 && embedding[2] === 0;
                        if (isZero) { chunkZeroVec++; totalZeroVec++; }
                        completedSessions.add(entry.sessionId);
                    }
                }

                // Report progress after every chunk so the user sees movement
                const sessionsDone = completedSessions.size;
                this._totalSessionsCompleted = sessionsDone;
                report(sessionsDone, totalSessions);
                this._lastProgressTs = Date.now();

                if (chunkZeroVec > EMBED_CHUNK_SIZE / 2) {
                    anyTimeout = true;
                    this.log.warn('Chunk %d had %d/%d zero-vectors (probable timeout)', chunkIndex, chunkZeroVec, chunk.length);
                }
            }

            this._scheduleSave();

            // Mark completed sessions (remove from pending)
            for (const sid of completedSessions) {
                this._pendingBySession.delete(sid);
            }

            this.log.info('Embedding complete — %d sessions done, %d chunks failed, %d zero-vector fallbacks',
                completedSessions.size, failedChunks, totalZeroVec);
        });

        this._queueRunning = false;
        this._clearStallWatchdog();
        this.log.info('Queue finished — %d sessions completed', this._totalSessionsCompleted);

        // If more sessions were added while we were running, restart seamlessly
        if (!this._disposed && this._queue.length > 0) {
            this.log.debug('More sessions queued during run — restarting queue (%d remaining)', this._queue.length);
            this._queueRunning = true;
            setImmediate(() => {
                if (!this._disposed && this._queue.length > 0) {
                    this._runQueue().catch((err) => { this.log.error('Queue restart failed: %s', String(err)); });
                }
            });
            return;
        }

        if (!this._disposed && this._totalSessionsCompleted > 0) {
            if (this._indexingCompleteTimer !== undefined) {
                clearTimeout(this._indexingCompleteTimer);
            }
            this._indexingCompleteTimer = setTimeout(() => {
                this._indexingCompleteTimer = undefined;
                if (!this._disposed) {
                    this.log.info('Showing indexing complete notification (%d sessions)', this._totalSessionsCompleted);
                    this.vsCodeApi.showIndexingComplete(this._totalSessionsCompleted);
                }
            }, 5_000);
        }
    }

    /**
     * Calls engine.embedBatch() with a timeout guard.
     * If the call times out, returns zero-vectors so the queue doesn't stall.
     */
    private async _embedWithTimeout(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) { return []; }
        this.log.debug('Embedding %d texts with timeout of %dms', texts.length, EMBED_TIMEOUT_MS);
        const startTime = Date.now();
        try {
            const result = await Promise.race([
                this.engine.embedBatch(texts),
                new Promise<null>((_, reject) => {
                    setTimeout(() => reject(new Error('embedBatch timed out')), EMBED_TIMEOUT_MS);
                }),
            ]);
            const elapsed = Date.now() - startTime;
            this.log.debug('embedBatch succeeded in %dms', elapsed);
            if (result === null) {
                this.log.warn('embedBatch returned null — using zero-vectors');
                const dims = 384;
                return texts.map(() => new Float32Array(dims));
            }
            return result;
        } catch (err) {
            const elapsed = Date.now() - startTime;
            this.log.warn('embedBatch failed after %dms: %s — falling back to zero-vectors', elapsed, String(err));
            const dims = 384;
            return texts.map(() => new Float32Array(dims));
        }
    }

    private _scheduleSave(): void {
        if (this._saveTimer !== undefined) {
            clearTimeout(this._saveTimer);
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = undefined;
            this.log.debug('Saving embedding index to disk');
            this.index
                .save(this.embeddingsPath)
                .then(() => this.log.debug('Embedding index saved successfully'))
                .catch((err) => this.log.warn('Failed to save embedding index: %s', String(err)));
        }, SAVE_DEBOUNCE_MS);
    }
}
