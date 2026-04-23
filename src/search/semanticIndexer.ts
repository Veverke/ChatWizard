// src/search/semanticIndexer.ts

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ISemanticIndexer, IEmbeddingEngine, ISemanticIndex } from './semanticContracts';
import { SemanticSearchResult } from './types';

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
    /** Create a left-aligned status bar item for indexing progress. */
    createStatusBarItem(): vscode.StatusBarItem;
    /** Notify the user that the model loaded and indexing has started. */
    showModelReady(isFirstUse: boolean): void;
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
        createStatusBarItem(): vscode.StatusBarItem {
            return vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        },
        showModelReady(_isFirstUse: boolean): void {
            void vscode.window.showInformationMessage(
                'Chat Wizard: Semantic search model loaded. Indexing your sessions in the background…'
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
    private _totalQueued = 0;
    private _totalProcessed = 0;

    // Status bar for indexing progress
    private _indexingStatusBar: vscode.StatusBarItem | undefined;

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

        // Load model with a status bar progress message
        const isFirstUse = this.vsCodeApi.isFirstUse(this.storagePath);
        const loadBar = this.vsCodeApi.createStatusBarItem();
        loadBar.text = '$(loading~spin) Chat Wizard: loading model…';
        loadBar.show();

        try {
            await this.engine.load(msg => {
                loadBar.text = `$(loading~spin) Chat Wizard: ${msg}`;
            });
        } finally {
            loadBar.dispose();
        }

        this.vsCodeApi.showModelReady(isFirstUse);

        // Restore persisted index
        await this.index.load(path.join(this.storagePath, EMBEDDINGS_FILENAME));

        this._isReady = true;
    }

    // ── scheduleSession() ───────────────────────────────────────────────────

    /**
     * Queues a session for embedding. Skips silently if the session is already
     * in the index or the indexer is not ready.
     */
    scheduleSession(sessionId: string, text: string): void {
        if (!this._isReady || this._disposed) {
            return;
        }
        if (this.index.has(sessionId)) {
            return;
        }

        this._queue.push({ sessionId, text });
        this._totalQueued++;
        this._refreshStatusBar();

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

    async search(query: string, topK: number, minScore = 0): Promise<SemanticSearchResult[]> {
        if (!this._isReady) {
            throw new Error('SemanticIndexer is not ready. Call initialize() first.');
        }
        const queryVector = await this.engine.embed(query);
        return this.index.search(queryVector, topK, minScore);
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

        // Dispose indexing status bar
        this._indexingStatusBar?.dispose();
        this._indexingStatusBar = undefined;

        // Final save (fire-and-forget — cannot await in dispose)
        if (this._isReady) {
            this.index.save(path.join(this.storagePath, EMBEDDINGS_FILENAME)).catch(() => { /* ignore */ });
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private async _runQueue(): Promise<void> {
        this._queueRunning = true;

        while (this._queue.length > 0 && !this._disposed) {
            const entry = this._queue.shift()!;

            try {
                const embedding = await this.engine.embed(entry.text);
                this.index.add(entry.sessionId, embedding);
                this._totalProcessed++;
                this._refreshStatusBar();
                this._scheduleSave();
            } catch {
                // Skip failed embeddings — don't crash the queue
                this._totalProcessed++;
                this._refreshStatusBar();
            }
        }

        this._queueRunning = false;

        // Queue drained — remove the status bar and notify if any sessions were embedded
        this._indexingStatusBar?.dispose();
        this._indexingStatusBar = undefined;

        if (!this._disposed && this._totalProcessed > 0) {
            this.vsCodeApi.showIndexingComplete(this._totalProcessed);
        }
    }

    private _refreshStatusBar(): void {
        if (this._queue.length === 0) {
            return;
        }

        if (!this._indexingStatusBar) {
            this._indexingStatusBar = this.vsCodeApi.createStatusBarItem();
        }

        this._indexingStatusBar.text =
            `$(loading~spin) Chat Wizard: semantic indexing\u2026 ${this._totalProcessed}/${this._totalQueued}`;
        this._indexingStatusBar.show();
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
