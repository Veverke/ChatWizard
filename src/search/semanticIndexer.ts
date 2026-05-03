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
}

function defaultVsCodeApi(): SemanticIndexerVsCodeApi {
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
            return !fs.existsSync(path.join(storagePath, MODEL_CACHE_SUBDIR));
        },
        async loadModelWithProgress(task: (report: (msg: string) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Chat Wizard: loading AI model…', cancellable: false },
                async (progress) => {
                    await task(msg => progress.report({ message: msg }));
                },
            );
        },
        async runIndexingProgress(task: (report: (completed: number, total: number) => void) => Promise<void>): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Chat Wizard: indexing…', cancellable: false },
                async (progress) => {
                    await task((completed, total) => {
                        progress.report({ message: `${completed} / ${total} sessions` });
                    });
                },
            );
        },
        showIndexingComplete(count: number): void {
            void vscode.window.showInformationMessage(
                `Chat Wizard: Semantic index ready — ${count} session${count === 1 ? '' : 's'} indexed.`
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

    constructor(
        storagePath: string,
        engineFactory: (cacheDir: string) => IEmbeddingEngine,
        indexFactory: () => ISemanticIndex,
        vsCodeApi?: SemanticIndexerVsCodeApi,
    ) {
        this.storagePath = storagePath;
        this.engine = engineFactory(path.join(storagePath, MODEL_CACHE_SUBDIR));
        this.index = indexFactory();
        this.vsCodeApi = vsCodeApi ?? defaultVsCodeApi();
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
        if (this.vsCodeApi.isFirstUse(this.storagePath)) {
            const consented = await this.vsCodeApi.showConsentDialog();
            if (!consented) {
                this._declined = true;
                return;
            }
        }

        // Load model via visible window progress (matches the session-file indexing style)
        await this.vsCodeApi.loadModelWithProgress(async (report) => {
            await this.engine.load(report);
        });

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

        let added = 0;
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
            this._runQueue();
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

        // Cancel pending debounced save and flush immediately
        if (this._saveTimer !== undefined) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
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
            while (this._queue.length > 0 && !this._disposed) {
                const entry = this._queue.shift()!;

                try {
                    const embedding = await this.engine.embed(entry.text);
                    this.index.add(entry.sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding);
                    this._scheduleSave();
                } catch {
                    // Skip failed embeddings — don't crash the queue
                } finally {
                    const remaining = (this._pendingBySession.get(entry.sessionId) ?? 1) - 1;
                    if (remaining === 0) {
                        this._pendingBySession.delete(entry.sessionId);
                        this._totalSessionsCompleted++;
                    } else {
                        this._pendingBySession.set(entry.sessionId, remaining);
                    }
                    report(this._totalSessionsCompleted, this._totalSessionsQueued);
                }
            }
        });

        this._queueRunning = false;

        if (!this._disposed && this._totalSessionsCompleted > 0) {
            this.vsCodeApi.showIndexingComplete(this._totalSessionsCompleted);
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
