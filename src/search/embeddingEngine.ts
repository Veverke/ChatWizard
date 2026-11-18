// src/search/embeddingEngine.ts

import * as path from 'path';
import { Worker } from 'worker_threads';
import { EmbeddingModelSource, IEmbeddingEngine, SEMANTIC_DIMS } from './semanticContracts';
import { createLogger, type BoundLogger, withTimeout } from '../utils/logger';

/**
 * How long the parent waits for a worker to report `init_done`.
 * Sits above the worker's own DOWNLOAD_TIMEOUT_MS (180s) so a worker that dies
 * silently, or never answers, still produces an error instead of a hung promise
 * — the cause of the "Downloading AI model…" notification that never closed.
 */
const INIT_TIMEOUT_MS = 240_000; // 4 minutes

/** How long (ms) before a pending embedBatch response is considered stuck. */
const EMBED_RPC_TIMEOUT_MS = 120_000;

/** Number of worker threads for parallel ONNX inference. Each worker loads its own
 *  model session, enabling true concurrent CPU utilization across cores. */
const POOL_SIZE = 2;

/** How long (ms) a worker sits idle before being terminated to free ~200 MB WASM memory.
 *  Workers are re-spawned lazily on the next embed call. */
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** Minimal callable shape returned by @xenova/transformers pipeline() */
type PipelineCallable = {
    (text: string, options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
    (texts: string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
};

/**
 * Injectable factory that loads the feature-extraction pipeline.
 * Receives cacheDir and an optional progress forwarder; returns the callable pipeline.
 * Swap this out in tests to avoid network I/O.
 */
export type PipelineFactory = (
    cacheDir: string,
    onProgress?: (message: string) => void,
    modelSource?: EmbeddingModelSource,
) => Promise<PipelineCallable>;

/** Default factory — delegates to a pool of worker threads for parallel ONNX inference. */
async function defaultPipelineFactory(
    cacheDir: string,
    onProgress?: (message: string) => void,
    parentLog?: BoundLogger,
    modelSource?: EmbeddingModelSource,
): Promise<PipelineCallable> {
    const workerPath = path.resolve(__dirname, 'embeddingWorker.js');
    const log: BoundLogger = parentLog?.withContext('EmbeddingWorker') ?? createLogger().withContext('EmbeddingWorker');
    log.info(
        'Loading the semantic model — %s (cache dir: %s)',
        modelSource?.localModelPath ? `local folder ${modelSource.localModelPath}` : 'remote/cached model',
        cacheDir,
    );
    log.debug('Spawning %d worker threads from %s', POOL_SIZE, workerPath);
    const startedAt = Date.now();

    interface WorkerHandle {
        worker: Worker;
        callable: (texts: string[]) => Promise<{ data: ArrayLike<number> }>;
        pending: Map<number, { resolve: (dataBuffer: ArrayBuffer, dims: number) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
        disposed: boolean;
    }

    function spawnSingleWorker(): Promise<WorkerHandle> {
        const worker = new Worker(workerPath);
        let nextId = 1;
        const pending = new Map<number, { resolve: (dataBuffer: ArrayBuffer, dims: number) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
        let resolveInit: (() => void) | undefined;
        let rejectInit: ((error: Error) => void) | undefined;
        let initSettled = false;
        const initDone = new Promise<void>((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
        /** Resolves or rejects the init promise exactly once. */
        const settleInit = (error?: Error): void => {
            if (initSettled) { return; }
            initSettled = true;
            if (error) { rejectInit?.(error); } else { resolveInit?.(); }
        };
        let disposed = false;

        worker.on('message', (msg: Record<string, unknown>) => {
            const type = String(msg['type'] ?? '');
            if (type === 'progress' && onProgress) {
                onProgress(String(msg['message'] ?? ''));
                return;
            }
            if (type === 'log') {
                // Worker diagnostics (model source, effective transformers env).
                const text = String(msg['message'] ?? '');
                const level = String(msg['level'] ?? 'info');
                if (level === 'error') {
                    log.error(text);
                } else if (level === 'warn') {
                    log.warn(text);
                } else {
                    log.info(text);
                }
                return;
            }
            if (type === 'init_done') {
                settleInit();
                return;
            }
            if (type === 'init_error') {
                // The model could not be loaded. Rejecting here is what closes the
                // "Downloading AI model…" progress notification instead of leaving
                // it on screen forever.
                const errorMsg = String(msg['error'] ?? 'The AI model could not be loaded');
                log.error('Model load failed: %s', errorMsg);
                settleInit(new Error(errorMsg));
                return;
            }
            if (type === 'result') {
                const id = msg['id'] as number;
                const dataBuffer = msg['dataBuffer'] as ArrayBuffer;
                const dims = msg['dims'] as number;
                const entry = pending.get(id);
                if (entry) {
                    clearTimeout(entry.timer);
                    pending.delete(id);
                    entry.resolve(dataBuffer, dims);
                }
                return;
            }
            if (type === 'error') {
                const id = msg['id'] as number | undefined;
                const errorMsg = String(msg['error'] ?? 'Unknown worker error');
                if (id !== undefined && id !== null) {
                    const entry = pending.get(id);
                    if (entry) {
                        clearTimeout(entry.timer);
                        pending.delete(id);
                        entry.reject(new Error(errorMsg));
                    }
                } else {
                    log.error('Worker error: %s', errorMsg);
                }
                return;
            }
        });

        worker.on('error', (err) => {
            for (const [, entry] of pending) {
                clearTimeout(entry.timer);
                entry.reject(err);
            }
            pending.clear();
            settleInit(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                log.warn('Worker exited with code %d', code);
            }
            for (const [, entry] of pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`Worker exited with code ${code}`));
            }
            pending.clear();
            settleInit(new Error(`Embedding worker exited with code ${code} before the AI model was ready`));
        });

        worker.postMessage({ type: 'init', cacheDir, modelSource });

        const callable = (texts: string[]): Promise<{ data: ArrayLike<number> }> => {
            const id = nextId++;
            return new Promise<{ data: ArrayLike<number> }>((resolve, reject) => {
                // Unref'd timer so it doesn't keep the process alive if everything else
                // is done — preventing a hidden Node.js process leak in VS Code.
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`embedBatch RPC timed out after ${EMBED_RPC_TIMEOUT_MS}ms`));
                }, EMBED_RPC_TIMEOUT_MS);
                timer.unref();
                pending.set(id, {
                    resolve: (dataBuffer: ArrayBuffer, dims: number) => {
                        const flat = new Float32Array(dataBuffer);
                        resolve({ data: flat });
                    },
                    reject,
                    timer,
                });
                worker.postMessage({ type: 'embedBatch', id, texts });
            });
        };

        const ready = withTimeout(initDone, INIT_TIMEOUT_MS, 'Loading the semantic-search AI model');
        return ready.then(
            () => ({ worker, callable, pending, disposed }),
            (err: Error) => {
                // Never leave a worker behind that failed (or never answered) its init.
                try { worker.terminate(); } catch { /* already gone */ }
                throw err;
            },
        );
    }

    // Spawn all workers and wait for init.
    // allSettled (not all) so a single failure still lets us tear the survivors
    // down — previously a half-initialised pool leaked its worker threads.
    const settled = await Promise.allSettled(
        Array.from({ length: POOL_SIZE }, () => spawnSingleWorker()),
    );
    const handles: WorkerHandle[] = [];
    const initFailures: Error[] = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') {
            handles.push(result.value);
        } else {
            initFailures.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
        }
    }
    if (initFailures.length > 0) {
        for (const handle of handles) {
            try { handle.worker.terminate(); } catch { /* already gone */ }
        }
        throw initFailures[0];
    }
    log.info('All %d workers ready in %dms', handles.length, Date.now() - startedAt);

    // Round-robin index — only the first worker forwards progress to avoid duplicates
    let rrIndex = 0;

    // Per-worker idle timers. When a worker has been idle for IDLE_TIMEOUT_MS,
    // it gets terminated to free its ~200 MB WASM memory. It will be re-spawned
    // lazily on the next invocation.
    const idleTimers: (ReturnType<typeof setTimeout> | undefined)[] = [undefined, undefined];

    function resetIdleTimer(index: number): void {
        if (idleTimers[index] !== undefined) {
            clearTimeout(idleTimers[index]!);
            idleTimers[index] = undefined;
        }
    }

    function scheduleIdleTimer(index: number): void {
        resetIdleTimer(index);
        if (handles[index].disposed) { return; }
        idleTimers[index] = setTimeout(() => {
            const handle = handles[index];
            if (handle.disposed) { return; }
            handle.disposed = true;
            idleTimers[index] = undefined;
            log.debug('Worker %d idle for %dms — terminating to free WASM memory', index, IDLE_TIMEOUT_MS);
            for (const [, entry] of handle.pending) {
                clearTimeout(entry.timer);
            }
            handle.pending.clear();
            try { handle.worker.postMessage({ type: 'terminate' }); } catch { /* ignore */ }
            setTimeout(() => {
                try { handle.worker.terminate(); } catch { /* ignore */ }
            }, 2_000).unref();
        }, IDLE_TIMEOUT_MS);
        idleTimers[index]!.unref();
    }

    // The returned callable acts as a PipelineFactory pipeline: round-robins across workers
    const callable = async (textOrTexts: string | string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }> => {
        const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];

        // Find the next available worker, re-spawning disposed ones lazily
        for (let attempt = 0; attempt < POOL_SIZE; attempt++) {
            const idx = rrIndex % POOL_SIZE;
            const handle = handles[idx];

            if (handle.disposed) {
                // Lazy re-spawn
                log.debug('Re-spawning disposed worker %d', idx);
                try {
                    const fresh = await spawnSingleWorker();
                    handles[idx] = fresh;
                    rrIndex++;
                    await new Promise<void>(r => setImmediate(r));
                    resetIdleTimer(idx);
                    return fresh.callable(texts);
                } catch (err) {
                    log.warn('Failed to re-spawn worker %d: %s', idx, String(err));
                    rrIndex++;
                    continue;
                }
            }

            rrIndex++;
            resetIdleTimer(idx);
            try {
                const result = await handle.callable(texts);
                scheduleIdleTimer(idx);
                return result;
            } catch (err) {
                // On failure, mark as disposed so next call re-spawns
                handle.disposed = true;
                log.warn('Worker %d call failed — marking for re-spawn: %s', idx, String(err));
                scheduleIdleTimer(idx);
                throw err; // let the caller handle the error
            }
        }

        // All workers failed
        throw new Error('All embedding workers are unavailable');
    };

    // Start idle timers after initial spawn
    for (let i = 0; i < POOL_SIZE; i++) {
        scheduleIdleTimer(i);
    }

    // Hang dispose + handles on the callable for clean-up
    (callable as unknown as Record<string, unknown>)._handles = handles;
    (callable as unknown as Record<string, unknown>)._poolSize = POOL_SIZE;

    return callable as unknown as PipelineCallable;
}

/**
 * Thin wrapper that produces normalized 384-dim embeddings.
 *
 * TWO MODES:
 * 1. **Worker mode** (default) — spawns a `worker_threads` Worker running
 *    `embeddingWorker.ts`. All ONNX inference runs off the main thread, so the
 *    extension host stays responsive across ALL VS Code windows.
 *
 * 2. **Factory mode** (tests/DI) — when a `pipelineFactory` is provided, runs
 *    the pipeline directly on the main thread (same as the old behaviour).
 *
 * Accepts an optional `pipelineFactory` for dependency injection in tests.
 * When omitted, automatically uses a worker thread.
 */
export class EmbeddingEngine implements IEmbeddingEngine {
    private readonly cacheDir: string;
    private readonly factory: PipelineFactory | undefined;
    private pipelineFn: PipelineCallable | undefined;
    private _isReady = false;
    private loadPromise: Promise<void> | undefined;
    private _disposed = false;
    private _loadError: string | undefined;
    private readonly log: BoundLogger;

    constructor(cacheDir: string, pipelineFactory?: PipelineFactory, parentLog?: BoundLogger) {
        this.cacheDir = cacheDir;
        this.factory = pipelineFactory;
        this.log = parentLog?.withContext('EmbeddingEngine') ?? createLogger().withContext('EmbeddingEngine');
    }

    get isReady(): boolean {
        return this._isReady;
    }

    /** Message of the last failed load (`undefined` when nothing failed / after success). */
    get loadError(): string | undefined {
        return this._loadError;
    }

    /**
     * Loads the model. Idempotent — resolves immediately if already loaded.
     * Concurrent calls await the same underlying promise.
     * Does not catch errors; callers are responsible for error handling.
     * A failed load clears the cached promise, so a later call retries.
     */
    async load(onProgress?: (message: string) => void, modelSource?: EmbeddingModelSource): Promise<void> {
        if (this._isReady) {
            return;
        }
        if (!this.loadPromise) {
            this.loadPromise = this.doLoad(onProgress, modelSource);
        }
        return this.loadPromise;
    }

    private async doLoad(
        onProgress?: (message: string) => void,
        modelSource?: EmbeddingModelSource,
    ): Promise<void> {
        try {
            if (this.factory) {
                // Test / DI mode — use the injected factory directly on this thread.
                this.pipelineFn = await this.factory(this.cacheDir, onProgress, modelSource);
            } else {
                // Production mode — spawn a worker thread for ONNX inference.
                this.pipelineFn = await defaultPipelineFactory(this.cacheDir, onProgress, this.log, modelSource);
            }
            this._loadError = undefined;
            this._isReady = true;
        } catch (err) {
            this._loadError = err instanceof Error ? err.message : String(err);
            this.pipelineFn = undefined;
            this._isReady = false;
            this.loadPromise = undefined; // allow a later retry (e.g. after the user fixes the source)
            throw err;
        }
    }

    /**
     * Embeds a single text and returns a normalized Float32Array(384).
     */
    async embed(text: string): Promise<Float32Array> {
        if (!this._isReady || !this.pipelineFn) {
            throw new Error('EmbeddingEngine is not ready. Call load() first.');
        }
        const output = await this.pipelineFn(text, { pooling: 'mean', normalize: true });
        const data = output.data;
        const result = data instanceof Float32Array
            ? data
            : Float32Array.from(data as ArrayLike<number>);
        if (result.length !== SEMANTIC_DIMS) {
            throw new Error(`Expected ${SEMANTIC_DIMS}-dim embedding, got ${result.length}`);
        }
        return result;
    }

    /**
     * Embeds multiple texts in a single pipeline call.
     * Falls back to sequential embed() if the batch path fails.
     */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (!this._isReady || !this.pipelineFn) {
            throw new Error('EmbeddingEngine is not ready. Call load() first.');
        }
        if (texts.length === 0) { return []; }
        if (texts.length === 1) { return [await this.embed(texts[0])]; }

        const output = await this.pipelineFn(texts, { pooling: 'mean', normalize: true });
        const flat = output.data;
        const batchSize = texts.length;
        const dims = SEMANTIC_DIMS;
        const expectedLen = batchSize * dims;
        if (flat.length !== expectedLen) {
            throw new Error(`Expected batch embedding length ${expectedLen}, got ${flat.length}`);
        }
        // Convert flat tensor data into per-row Float32Arrays.
        // Avoid Array.from() + Array.slice() double-copy — use subarray view + copy.
        const flatArr = flat instanceof Float32Array ? flat : Float32Array.from(flat);
        const results: Float32Array[] = new Array(batchSize);
        for (let i = 0; i < batchSize; i++) {
            results[i] = new Float32Array(flatArr.subarray(i * dims, (i + 1) * dims));
        }
        return results;
    }

    /**
     * Terminates the worker thread (if in worker mode) and releases resources.
     */
    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;

        // If we're in worker mode, the pipelineFn has hidden _handles with workers.
        if (!this.factory && this.pipelineFn) {
            const callable = this.pipelineFn as unknown as Record<string, unknown>;
            const handles = callable['_handles'] as Array<{ worker: Worker; pending: Map<number, { timer: ReturnType<typeof setTimeout> }> }> | undefined;

            if (handles) {
                for (const handle of handles) {
                    // Clear all pending RPC timers so they don't fire after disposal
                    for (const [, entry] of handle.pending) {
                        clearTimeout(entry.timer);
                    }
                    handle.pending.clear();

                    // Send graceful terminate signal
                    try {
                        handle.worker.postMessage({ type: 'terminate' });
                    } catch { /* worker may already be closed */ }

                    // Force-terminate after a short grace period
                    const killTimer = setTimeout(() => {
                        try { handle.worker.terminate(); } catch { /* ignore */ }
                    }, 2_000);
                    killTimer.unref();

                    handle.worker.on('exit', () => {
                        clearTimeout(killTimer);
                    });
                }
                this.log.debug('All %d workers terminated', handles.length);
            }
        }

        this.pipelineFn = undefined;
        this._isReady = false;
    }
}
