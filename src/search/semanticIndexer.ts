// src/search/semanticIndexer.ts

import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { ISemanticIndexer, IEmbeddingEngine, ISemanticIndex, EmbeddingModelSource, SemanticScope, SEMANTIC_MIN_SCORE } from './semanticContracts';
import { SemanticSearchResult } from './types';
import { Session } from '../types/index';
import { createLogger, type BoundLogger, withTimeout } from '../utils/logger';
import type { IModelInstaller } from './semanticModelInstaller';
import {
    classifyModelError,
    modelFailureHint,
    modelFailureSummary,
    type ModelFailureKind,
} from './modelLoadDiagnostics';

const EMBEDDINGS_FILENAME = 'semantic-embeddings.bin';
const FINGERPRINTS_FILENAME_SUFFIX = '.meta.json';
const FINGERPRINTS_FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 5_000;
const MODEL_CACHE_SUBDIR = 'models';
/**
 * Records the last failed model load.  Its presence also means "the user already
 * consented to the download", which is what stops the consent dialog and the
 * "Downloading AI model…" notification from reappearing on every reload when the
 * network blocks the download.
 */
export const SEMANTIC_MODEL_FAILURE_MARKER = '.chatwizard-model-failed';
/** Written once the model is on disk and loadable. */
export const SEMANTIC_MODEL_READY_MARKER = '.chatwizard-ready';
/** Don't repeat the "semantic search unavailable" notice more often than this. */
const FAILURE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
 * Details handed to the UI when the AI model cannot be loaded.
 * The extension uses them for a single, actionable notification — after which it
 * keeps running without semantic search.
 */
export interface ModelUnavailableDetails {
    kind: ModelFailureKind;
    /** One-sentence reason, e.g. "the AI model could not be downloaded …". */
    summary: string;
    /** Multi-line, actionable guidance (logged and shown in the panel). */
    hint: string;
    /** Raw error message (already trimmed). */
    message: string;
}

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
    /**
     * Notify the user (once) that semantic search cannot run because the AI model
     * is unavailable. Implementations should offer a way to fix the source and to
     * disable the feature — never block or re-open the download progress UI.
     */
    showModelUnavailable(details: ModelUnavailableDetails): void;
}

/**
 * Minimal subset of vscode.Memento needed for cross-window consent persistence.
 * Structurally compatible with `vscode.ExtensionContext.globalState`.
 */
export interface SemanticGlobalState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

/** globalState key holding the one-time model-download consent. */
export const SEMANTIC_CONSENT_KEY = 'chatwizard.semanticConsentGiven';

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
                const consented = globalState.get<boolean>(SEMANTIC_CONSENT_KEY) ?? false;
                if (consented) { return false; }
            }
            // Fallback (tests / no globalState / async update didn't persist):
            // check the sentinel file written synchronously by markModelDownloaded().
            return !fs.existsSync(path.join(storagePath, MODEL_CACHE_SUBDIR, SEMANTIC_MODEL_READY_MARKER));
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
                fs.writeFileSync(path.join(dir, SEMANTIC_MODEL_READY_MARKER), '');
            } catch {
                // Non-critical: if writing fails the consent dialog may reappear on next reload.
            }

            if (globalState) {
                // Also persist consent in globalState — survives across windows and reloads.
                // This is fire-and-forget; the sentinel file above is the reliable source.
                void globalState.update(SEMANTIC_CONSENT_KEY, true);
            }
        },
        showModelReady(): void {
            void vscode.window.showInformationMessage(
                'Chat Wizard: AI model downloaded successfully — semantic search is ready.'
            );
        },
        showModelUnavailable(details: ModelUnavailableDetails): void {
            void vscode.window.showErrorMessage(
                `Chat Wizard: semantic search is unavailable — ${details.summary}. Keyword search still works.`,
                'Fix Model Source…',
                'Retry',
                'Disable',
            ).then(choice => {
                if (choice === 'Fix Model Source…') {
                    void vscode.commands.executeCommand('chatwizard.configureSemanticModel');
                } else if (choice === 'Retry') {
                    void vscode.commands.executeCommand('chatwizard.retrySemanticModel');
                } else if (choice === 'Disable') {
                    void vscode.workspace.getConfiguration('chatwizard')
                        .update('enableSemanticSearch', false, vscode.ConfigurationTarget.Global);
                }
            });
        },
    };
}

interface QueueEntry {
    sessionId: string;
    fingerprint: string;
    role: 'user' | 'assistant';
    messageIndex: number;
    paragraphIndex: number;
    text: string;
}

/** Persisted record of the last failed model load (see FAILURE_MARKER_FILENAME). */
interface ModelFailureRecord {
    /** ISO timestamp of the failed attempt. */
    at: string;
    kind: ModelFailureKind;
    message: string;
    /** ISO timestamp of the last user notification (suppresses repeat toasts). */
    noticeAt?: string;
}

/** Hash only the content that contributes entries to the semantic index. */
function sessionFingerprint(session: Session): string {
    const hash = createHash('sha256');
    hash.update(session.title ?? '');
    // Feature 51 — a removal changes the indexed content without changing any
    // message text, so the removed count participates in the fingerprint.
    hash.update(`\0removed:${session.messages.filter(m => m.removed).length}`);
    for (const message of session.messages) {
        hash.update('\0');
        hash.update(message.role);
        hash.update('\0');
        hash.update(message.content ?? '');
    }
    return hash.digest('hex');
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
    /** Message of the failure that left semantic search unavailable (undefined = fine). */
    private _modelLoadError: string | undefined;
    /** Optional model provisioner (download/local folder). Null ⇒ legacy in-worker fetch. */
    private readonly _modelInstaller: IModelInstaller | undefined;
    /** `<storage>/models/.chatwizard-model-failed` */
    private readonly _failureMarkerPath: string;

    // Embedding queue
    private _queue: QueueEntry[] = [];
    private _queueRunning = false;
    private _totalSessionsQueued = 0;
    private _totalSessionsCompleted = 0;
    /** Remaining queue entries per session; deleted when the session reaches 0. */
    private _pendingBySession = new Map<string, number>();
    /** Fingerprint for each session currently queued, used to replace stale queued work. */
    private _pendingFingerprints = new Map<string, string>();
    /** Fingerprints for sessions whose embeddings have been persisted successfully. */
    private _sessionFingerprints = new Map<string, string>();

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
    /** Sidecar containing content fingerprints for persisted session embeddings. */
    private readonly fingerprintsPath: string;
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
        modelInstaller?: IModelInstaller,
    ) {
        this.embeddingsPath = embeddingsFilePath ?? path.join(storagePath, EMBEDDINGS_FILENAME);
        this._bulkLockPath = path.join(storagePath, GLOBAL_BULK_LOCK);
        this._failureMarkerPath = path.join(storagePath, MODEL_CACHE_SUBDIR, SEMANTIC_MODEL_FAILURE_MARKER);
        this.storagePath = storagePath;
        this.engine = engineFactory(path.join(storagePath, MODEL_CACHE_SUBDIR));
        this.index = indexFactory();
        this.vsCodeApi = vsCodeApi ?? defaultVsCodeApi();
        this._queueStartDebounceMs = queueStartDebounceMs ?? QUEUE_START_DEBOUNCE_MS;
        this._modelInstaller = modelInstaller;
        this.log = parentLog?.withContext('SemanticIndexer') ?? createLogger().withContext('SemanticIndexer');
        this.fingerprintsPath = `${this.embeddingsPath}${FINGERPRINTS_FILENAME_SUFFIX}`;
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

    /** Set when the AI model could not be loaded — semantic search is then unavailable. */
    get modelLoadError(): string | undefined {
        return this._modelLoadError;
    }

    /** Expose the embedding engine for downstream consumers (e.g. KB classification fallback). */
    get embeddingEngine(): IEmbeddingEngine {
        return this.engine;
    }

    // ── initialize() ────────────────────────────────────────────────────────

    /**
     * Loads the model (with optional first-use consent dialog) and restores the
     * persisted index from disk. Idempotent — resolves immediately if already ready.
     *
     * Never throws for model problems: semantic search is optional, so a failure
     * is reported once, recorded, and the extension continues without it (keyword
     * search, tree, analytics, MCP keyword tools are unaffected).
     */
    async initialize(): Promise<void> {
        if (this._isReady || this._declined || this._disposed) {
            return;
        }

        // `isFirstUse` === "the model has never been provisioned on this machine".
        const modelReadyOnDisk = !this.vsCodeApi.isFirstUse(this.storagePath);
        // A recorded failure means consent was already given — never ask again and
        // never re-open the "Downloading AI model…" notification on every reload.
        const previousFailure = this._readFailureMarker();
        const needsConsent = !modelReadyOnDisk && previousFailure === undefined;
        if (previousFailure) {
            this.log.warn(
                'Previous model load failed at %s (%s): %s — retrying silently, no notification',
                previousFailure.at,
                previousFailure.kind,
                previousFailure.message,
            );
        } else {
            this.log.info(
                'Model state: %s, consent: %s',
                modelReadyOnDisk ? 'available on disk' : 'not on disk',
                needsConsent ? 'needed' : 'already given',
            );
        }

        if (needsConsent) {
            const consented = await this.vsCodeApi.showConsentDialog();
            if (!consented) {
                this.log.info('User declined the AI model download — semantic search stays off (keyword search unaffected).');
                this._declined = true;
                return;
            }
            this.log.info('User accepted the AI model download.');
        }

        try {
            await this._provisionAndLoadModel(needsConsent);
        } catch (err) {
            this._handleModelUnavailable(err, previousFailure);
            return;
        }

        this._modelLoadError = undefined;
        this._clearFailureMarker();
        this.log.info('AI model loaded successfully%s.', previousFailure ? ' (recovered from a previous failure)' : '');

        // Persist the marker only after a successful load.
        if (!modelReadyOnDisk) {
            this.vsCodeApi.markModelDownloaded(this.storagePath);
            this.vsCodeApi.showModelReady();
        }

        // Restore persisted index with a 60-second timeout.
        // 11 MB with ~7200 entries takes ~15-30s to decode on first load;
        // subsequent loads are faster due to OS page cache.
        this.log.debug('Loading persisted index from %s', this.embeddingsPath);
        try {
            await withTimeout(this.index.load(this.embeddingsPath), 60_000, 'index.load');
            this.log.debug('Persisted index loaded — %d vectors restored', this.index.size);
        } catch (err) {
            this.log.warn('Could not load persisted index (will start fresh): %s', String(err));
        }
        await this._loadSessionFingerprints();

        this._isReady = true;
        this.log.info(
            'Semantic search is ACTIVE — %d vector(s) indexed, %d session fingerprint(s).',
            this.index.size,
            this._sessionFingerprints.size,
        );
    }

    /**
     * Acquires the model (download or local folder) and loads it.
     *
     * The progress notification is shown only for an expected, first download.
     * Retries after a recorded failure stay silent — the user already saw the
     * failure notice, and a notification on every reload is exactly what made
     * this feature feel broken.
     */
    private async _provisionAndLoadModel(showProgress: boolean): Promise<void> {
        const run = async (report: (msg: string) => void): Promise<void> => {
            let source: EmbeddingModelSource | undefined;
            if (this._modelInstaller) {
                const installed = await this._modelInstaller.ensureModel(report);
                this.log.info('Model provisioned from %s (%s)', installed.source, installed.folder);
                source = { localModelPath: installed.folder };
            } else {
                this.log.warn('No model installer wired — falling back to the transformers.js loader.');
            }
            await this.engine.load(report, source);
        };

        if (showProgress) {
            this.log.info('Acquiring the AI model (download progress is shown to the user).');
            await this.vsCodeApi.loadModelWithProgress(run);
        } else {
            this.log.info('Acquiring the AI model silently (cached model or a retry — no notification).');
            await run(() => { /* silent */ });
        }
    }

    /**
     * Records a failed model load and tells the user once. The indexer stays
     * not-ready, so every caller degrades gracefully instead of blocking.
     */
    private _handleModelUnavailable(error: unknown, previousFailure: ModelFailureRecord | undefined): void {
        const failure = classifyModelError(error);
        const hint = modelFailureHint(failure.kind);
        this._modelLoadError = failure.message;

        this.log.error('Semantic search unavailable (%s): %s', failure.kind, failure.message);
        this.log.info(hint);

        const now = Date.now();
        const lastNotice = previousFailure?.noticeAt ? Date.parse(previousFailure.noticeAt) : Number.NaN;
        const notify = Number.isNaN(lastNotice) || (now - lastNotice) > FAILURE_NOTICE_INTERVAL_MS;

        this._writeFailureMarker({
            at: new Date(now).toISOString(),
            kind: failure.kind,
            message: failure.message,
            noticeAt: notify ? new Date(now).toISOString() : previousFailure?.noticeAt,
        });

        if (notify) {
            this.vsCodeApi.showModelUnavailable({
                kind: failure.kind,
                summary: modelFailureSummary(failure.kind),
                hint,
                message: failure.message,
            });
        }

        // Release worker threads / WASM memory — nothing else will use the engine.
        this.engine.dispose();
    }

    private _readFailureMarker(): ModelFailureRecord | undefined {
        try {
            const parsed = JSON.parse(fs.readFileSync(this._failureMarkerPath, 'utf8')) as ModelFailureRecord;
            return parsed && typeof parsed === 'object' && typeof parsed.at === 'string' ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    private _writeFailureMarker(record: ModelFailureRecord): void {
        try {
            fs.mkdirSync(path.dirname(this._failureMarkerPath), { recursive: true });
            fs.writeFileSync(this._failureMarkerPath, JSON.stringify(record));
        } catch {
            // Non-critical: worst case the user is asked/notified once more.
        }
    }

    private _clearFailureMarker(): void {
        try {
            fs.rmSync(this._failureMarkerPath, { force: true });
        } catch {
            // Non-critical.
        }
    }

    // ── scheduleSession() ───────────────────────────────────────────────────

    /**
     * Queues all messages of a session for embedding.
     * - Each user message → one queue entry.
     * - Each assistant response → one entry per non-empty paragraph (split on `\n\n`).
     * Skips unchanged sessions while replacing entries whose content fingerprint changed.
     */
    scheduleSession(session: Session): void {
        if (!this._isReady || this._disposed) {
            return;
        }
        const fingerprint = sessionFingerprint(session);
        let removedStaleIndex = false;
        if (this.index.has(session.id)) {
            const knownFingerprint = this._sessionFingerprints.get(session.id);
            if (knownFingerprint === undefined) {
                const pendingFingerprint = this._pendingFingerprints.get(session.id);
                if (pendingFingerprint === undefined) {
                    // Index files from before fingerprints were introduced have no way to
                    // reconstruct their source text. Treat those entries as current and
                    // seed the sidecar; future edits will then be detected incrementally.
                    this._sessionFingerprints.set(session.id, fingerprint);
                    this._scheduleSave();
                    this.log.debug('scheduleSession: seeded fingerprint for cached session %s', session.id);
                    return;
                }
                if (pendingFingerprint !== fingerprint) {
                    // A partial in-flight embedding may already have written old entries.
                    // Remove them before the queued replacement is built below.
                    this.index.remove(session.id);
                    removedStaleIndex = true;
                    this.log.debug('scheduleSession: session %s changed while embedding — replacing partial entries', session.id);
                }
            }
            if (knownFingerprint !== undefined && knownFingerprint === fingerprint) {
                this.log.debug('scheduleSession: session %s unchanged — skipping', session.id);
                return;
            }
            if (knownFingerprint !== undefined && knownFingerprint !== fingerprint) {
                this.index.remove(session.id);
                this._sessionFingerprints.delete(session.id);
                removedStaleIndex = true;
                this.log.debug('scheduleSession: session %s changed — replacing embeddings', session.id);
            }
        }

        const queuedFingerprint = this._pendingFingerprints.get(session.id);
        if (queuedFingerprint !== undefined) {
            if (queuedFingerprint === fingerprint) {
                this.log.debug('scheduleSession: session %s already queued — skipping', session.id);
                return;
            }
            this._queue = this._queue.filter(entry => entry.sessionId !== session.id);
            this._pendingBySession.delete(session.id);
            this._pendingFingerprints.delete(session.id);
            this.log.debug('scheduleSession: replaced stale queued work for session %s', session.id);
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
            this._queue.push({ sessionId: session.id, fingerprint, role: 'user', messageIndex: -1, paragraphIndex: 0, text: titleText });
            added++;
        }

        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
            const msg = session.messages[msgIdx];
            // Feature 51 — turns removed from the conversation are not embedded.
            if (msg.removed) { continue; }
            const text = msg.content?.trim();
            if (!text) { continue; }

            if (msg.role === 'user') {
                this._queue.push({ sessionId: session.id, fingerprint, role: 'user', messageIndex: msgIdx, paragraphIndex: 0, text });
                added++;
            } else if (msg.role === 'assistant') {
                const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
                for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
                    this._queue.push({
                        sessionId: session.id,
                        fingerprint,
                        role: 'assistant',
                        messageIndex: msgIdx,
                        paragraphIndex: paraIdx,
                        text: paragraphs[paraIdx],
                    });
                    added++;
                }
            }
        }

        if (added === 0) {
            if (removedStaleIndex) {
                this._scheduleSave();
            }
            return;
        }

        this._totalSessionsQueued++;
        this._pendingBySession.set(session.id, added);
        this._pendingFingerprints.set(session.id, fingerprint);

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
        this._queue = this._queue.filter(entry => entry.sessionId !== sessionId);
        this._pendingBySession.delete(sessionId);
        this._pendingFingerprints.delete(sessionId);
        this.index.remove(sessionId);
        this._sessionFingerprints.delete(sessionId);
        this._scheduleSave();
    }

    // ── search() ────────────────────────────────────────────────────────────

    async search(query: string, topK: number, minScore = SEMANTIC_MIN_SCORE, scope: SemanticScope = 'both'): Promise<SemanticSearchResult[]> {
        if (!this._isReady) {
            if (this._modelLoadError) {
                throw new Error(
                    'Semantic search is unavailable — the AI model could not be loaded '
                    + `(${this._modelLoadError}). Keyword search still works.`,
                );
            }
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

        // Synchronous final save — must complete before the process exits.
        // Only write if the index has entries, so we never replace a valid
        // on-disk file with an empty one (which would trigger a full re-embed
        // on the next startup).
        if (this._isReady && this.index.size > 0) {
            this._saveNowSync();
        } else {
            // If the index is empty (no chunks completed yet), explicitly save
            // the previous on-disk file's content by re-loading it, ensuring
            // we don't lose data from a previous complete run.  If the file
            // doesn't exist or is corrupt, this is a no-op.
            this.log.debug('dispose: index empty, preserving on-disk file at %s', this.embeddingsPath);
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
                const completedFingerprints = new Map<string, string>();
                for (let i = 0; i < chunk.length; i++) {
                    const { sessionId, entry } = { sessionId: chunk[i].sessionId, entry: chunk[i] };
                    // A session can be updated while its previous embedding batch is
                    // in flight. Do not let that stale batch put old entries back.
                    if (this._pendingFingerprints.get(sessionId) !== entry.fingerprint) {
                        continue;
                    }
                    const embedding = embeddings[i];
                    if (embedding) {
                        this.index.add(sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding);
                    }
                    completedSessions.add(sessionId);
                    completedFingerprints.set(sessionId, entry.fingerprint);
                }

                // Decrement pending counts; remove sessions that have no more pending entries
                for (const sid of completedSessions) {
                    const remaining = this._pendingBySession.get(sid);
                    if (remaining !== undefined) {
                        const updated = remaining - chunk.filter(e => e.sessionId === sid).length;
                        if (updated <= 0) {
                            this._pendingBySession.delete(sid);
                            this._pendingFingerprints.delete(sid);
                            const fingerprint = completedFingerprints.get(sid);
                            if (fingerprint !== undefined) {
                                this._sessionFingerprints.set(sid, fingerprint);
                            }
                            this._totalSessionsCompleted++;
                        } else {
                            this._pendingBySession.set(sid, updated);
                        }
                    }
                }

                // Save after EVERY chunk — synchronous so partial progress
                // survives a reload at any point. The file grows to ~16MB max,
                // so a sync write every ~30 entries is cheap enough and guarantees
                // that even a reload a few seconds into the run keeps the progress
                // already made (no more "start from scratch" on every reload).
                this._saveNowSync();

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

        // Final save after queue is drained — use synchronous save so that
        // data reaches disk immediately. Only write if there's actual data,
        // so we never replace a valid on-disk file with an empty one (which
        // would trigger a full re-embed on the next startup). This guard is
        // critical when dispose() fires mid-batch: the while loop exits, but
        // no chunks may have completed yet, so the index is still empty.
        if (this.index.size > 0 || this._sessionFingerprints.size > 0) {
            this._saveNowSync();
        }

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
            this._saveAll().catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }

    /** Load the fingerprint sidecar; it is absent for pre-fingerprint cache files. */
    private async _loadSessionFingerprints(): Promise<void> {
        try {
            const raw = await fs.promises.readFile(this.fingerprintsPath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') { return; }
            const record = parsed as { version?: unknown; fingerprints?: unknown };
            if (
                record.version !== FINGERPRINTS_FILE_VERSION ||
                !record.fingerprints ||
                typeof record.fingerprints !== 'object'
            ) {
                return;
            }
            for (const [sessionId, fingerprint] of Object.entries(record.fingerprints as Record<string, unknown>)) {
                if (typeof fingerprint === 'string') {
                    this._sessionFingerprints.set(sessionId, fingerprint);
                }
            }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
                this.log.warn('Could not load semantic session fingerprints: %s', String(err));
            }
        }
    }

    private _fingerprintsPayload(): string {
        return JSON.stringify({
            version: FINGERPRINTS_FILE_VERSION,
            fingerprints: Object.fromEntries(this._sessionFingerprints),
        });
    }

    private async _saveAll(): Promise<void> {
        await this.index.save(this.embeddingsPath);
        await fs.promises.mkdir(path.dirname(this.fingerprintsPath), { recursive: true });
        const tmpPath = `${this.fingerprintsPath}.tmp`;
        await fs.promises.writeFile(tmpPath, this._fingerprintsPayload(), 'utf8');
        await fs.promises.rename(tmpPath, this.fingerprintsPath);
    }

    private _saveSessionFingerprintsSync(): void {
        const dir = path.dirname(this.fingerprintsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${this.fingerprintsPath}.tmp.sync`;
        fs.writeFileSync(tmpPath, this._fingerprintsPayload(), 'utf8');
        fs.renameSync(tmpPath, this.fingerprintsPath);
    }

    /** Synchronous save — used at the end of _runQueue() so the index is
     *  guaranteed on disk before the user can reload VS Code.  Also used in
     *  dispose() as the final synchronous save. */
    private _saveNowSync(): void {
        if (this._saveTimer !== undefined) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
        try {
            const size = this.index.size;
            this.index.saveSync(this.embeddingsPath);
            this._saveSessionFingerprintsSync();
            this.log.debug('saveNowSync: %d entries saved to %s', size, this.embeddingsPath);
        } catch (err) {
            this.log.warn('saveNowSync: failed to save %d entries: %s', this.index.size, String(err));
        }
    }
}
