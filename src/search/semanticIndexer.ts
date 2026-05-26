// src/search/semanticIndexer.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ISemanticIndexer, IEmbeddingEngine, ISemanticIndex, SemanticScope, SEMANTIC_MIN_SCORE } from './semanticContracts';
import { SemanticSearchResult } from './types';
import { Session } from '../types/index';

const EMBEDDINGS_FILENAME = 'semantic-embeddings.bin';
const SAVE_DEBOUNCE_MS = 5_000;
const MODEL_CACHE_SUBDIR = 'models';
// How long to wait after the last scheduleSession() call before starting to embed.
// This lets the archive-restore batch (which arrives a second or two after the
// initial file-watcher batch) be collected before the queue runs, so the progress
// bar shows the correct total from the very first update.
const QUEUE_START_DEBOUNCE_MS = 4_000;

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
            if (globalState) {
                // globalState is shared across all VS Code windows — reliable even when
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
                    // Use an indeterminate spinner with live count text.
                    // Determinate (increment) mode breaks when the total grows mid-run
                    // (archive restore adds sessions after the first batch starts), causing
                    // the percentage to go backwards and the bar to stall.
                    await task((completed, total) => {
                        if (total === 0) { return; }
                        progress.report({ message: `${completed} / ${total} sessions` });
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
            if (globalState) {
                // Persist consent in globalState — survives across windows and reloads.
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

    // Status bar for indexing progress
    // (progress is surfaced via vsCodeApi.runIndexingProgress — no local status bar item)

    // Debounced save timer
    private _saveTimer: ReturnType<typeof setTimeout> | undefined;

    // Debounced queue start timer.
    // Resets on every scheduleSession() call so embedding only begins after sessions
    // stop arriving — letting both the live batch and the archive-restore batch land
    // before the first embed, ensuring the progress total is correct from the start.
    private _queueStartTimer: ReturnType<typeof setTimeout> | undefined;

    // Debounced "indexing complete" notification timer.
    // Prevents a double notification when the archive-restore batch arrives shortly
    // after the first file-watcher batch (two _runQueue() runs → one notification).
    private _indexingCompleteTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly _queueStartDebounceMs: number;

    constructor(
        storagePath: string,
        engineFactory: (cacheDir: string) => IEmbeddingEngine,
        indexFactory: () => ISemanticIndex,
        vsCodeApi?: SemanticIndexerVsCodeApi,
        queueStartDebounceMs?: number,
    ) {
        this.storagePath = storagePath;
        this.engine = engineFactory(path.join(storagePath, MODEL_CACHE_SUBDIR));
        this.index = indexFactory();
        this.vsCodeApi = vsCodeApi ?? defaultVsCodeApi();
        this._queueStartDebounceMs = queueStartDebounceMs ?? QUEUE_START_DEBOUNCE_MS;
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

        // Load model, always wrapped in a progress indicator so the UI and tests
        // can observe the loading lifecycle regardless of whether it is a first download.
        await this.vsCodeApi.loadModelWithProgress(async (report) => {
            await this.engine.load(report);
        });

        // Persist the marker only after a successful download so that the popup
        // reappears if the download fails and the user opens VS Code again.
        if (isFirstDownload) {
            this.vsCodeApi.markModelDownloaded(this.storagePath);
            this.vsCodeApi.showModelReady();
        }

        // Restore persisted index
        await this.index.load(path.join(this.storagePath, EMBEDDINGS_FILENAME));

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
            return;
        }
        // Skip if this session is already queued but not yet processed — avoids
        // enqueuing duplicate work and inflating _totalSessionsQueued when repeated
        // upsert events fire for the same session.
        if (this._pendingBySession.has(session.id)) {
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

        // Final save (fire-and-forget — cannot await in dispose)
        if (this._isReady) {
            this.index.save(path.join(this.storagePath, EMBEDDINGS_FILENAME)).catch(() => { /* ignore */ });
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private async _runQueue(): Promise<void> {
        this._queueRunning = true;

        await this.vsCodeApi.runIndexingProgress(async (report) => {
            // Show the current cumulative state immediately when the notification opens
            // (important for the archive-restore second pass, which starts at e.g. "89/109").
            report(this._totalSessionsCompleted, this._totalSessionsQueued);

            while (this._queue.length > 0 && !this._disposed) {
                // Collect all entries for the session at the front of the queue.
                // scheduleSession() appends a session's entries contiguously, so entries
                // for the same session are always grouped together at the queue head.
                const currentSessionId = this._queue[0].sessionId;
                const sessionEntries: QueueEntry[] = [];
                while (this._queue.length > 0 && this._queue[0].sessionId === currentSessionId) {
                    sessionEntries.push(this._queue.shift()!);
                }

                // Embed every text chunk for this session.
                for (const entry of sessionEntries) {
                    try {
                        const embedding = await this.engine.embed(entry.text);
                        this.index.add(entry.sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding);
                        this._scheduleSave();
                    } catch {
                        // Skip failed embeddings — don't crash the queue.
                    }
                }

                // Session complete: update counters and report ONCE (not once per chunk).
                // Calling report() once per session means VS Code renders a meaningful
                // "N / total" update for each session instead of hundreds of identical
                // "0 / total" calls that get throttled away.
                // Guard: only count the session once — if it somehow appears in a second
                // block (e.g. a race between scheduleSession and _runQueue), skip the
                // counter update so the session is never double-counted.
                if (this._pendingBySession.has(currentSessionId)) {
                    this._pendingBySession.delete(currentSessionId);
                    this._totalSessionsCompleted++;
                    report(this._totalSessionsCompleted, this._totalSessionsQueued);
                }

                // Yield to the event loop so VS Code can render the progress update
                // before the next session's embeddings begin.
                await new Promise<void>(r => setImmediate(r));
            }
        });

        this._queueRunning = false;

        if (!this._disposed && this._totalSessionsCompleted > 0) {
            // Debounce: the archive-restore batch fires a second _runQueue() run a few
            // hundred ms after the first completes.  Wait before showing the notification
            // so both runs are reported as a single final count.
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
                .save(path.join(this.storagePath, EMBEDDINGS_FILENAME))
                .catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }
}
