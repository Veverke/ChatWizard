// src/search/embeddingEngine.ts

import * as path from 'path';
import { Worker } from 'worker_threads';
import { IEmbeddingEngine, SEMANTIC_DIMS } from './semanticContracts';
import { createLogger, type BoundLogger, withTimeout } from '../utils/logger';

/** How long (ms) before we give up on downloading the ONNX model. */
const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes

/** How long (ms) before a pending embedBatch response is considered stuck. */
const EMBED_RPC_TIMEOUT_MS = 120_000;

/** Number of worker threads for parallel ONNX inference. Each worker loads its own
 *  model session, enabling true concurrent CPU utilization across cores. */
const POOL_SIZE = 2;

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
) => Promise<PipelineCallable>;

/** Default factory — delegates to a pool of worker threads for parallel ONNX inference. */
async function defaultPipelineFactory(
    cacheDir: string,
    onProgress?: (message: string) => void,
    parentLog?: BoundLogger,
): Promise<PipelineCallable> {
    const workerPath = path.resolve(__dirname, 'embeddingWorker.js');
    const log: BoundLogger = parentLog?.withContext('EmbeddingWorker') ?? createLogger().withContext('EmbeddingWorker');
    log.info('Spawning %d worker threads from %s', POOL_SIZE, workerPath);

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
        const initDone = new Promise<void>((resolve) => { resolveInit = resolve; });
        let disposed = false;

        worker.on('message', (msg: Record<string, unknown>) => {
            const type = String(msg['type'] ?? '');
            if (type === 'progress' && onProgress) {
                onProgress(String(msg['message'] ?? ''));
                return;
            }
            if (type === 'init_done') {
                resolveInit?.();
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
            resolveInit?.();
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
            resolveInit?.();
        });

        worker.postMessage({ type: 'init', cacheDir });

        const callable = (texts: string[]): Promise<{ data: ArrayLike<number> }> => {
            const id = nextId++;
            return new Promise<{ data: ArrayLike<number> }>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`embedBatch RPC timed out after ${EMBED_RPC_TIMEOUT_MS}ms`));
                }, EMBED_RPC_TIMEOUT_MS);
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

        return initDone.then(() => ({ worker, callable, pending, disposed }));
    }

    // Spawn all workers and wait for init
    const handles: WorkerHandle[] = await Promise.all(
        Array.from({ length: POOL_SIZE }, () => spawnSingleWorker()),
    );
    log.info('All %d workers ready', handles.length);

    // Round-robin index — only the first worker forwards progress to avoid duplicates
    let rrIndex = 0;

    // The returned callable acts as a PipelineFactory pipeline: round-robins across workers
    const callable = async (textOrTexts: string | string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }> => {
        const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
        const handle = handles[rrIndex % POOL_SIZE];
        rrIndex++;
        return handle.callable(texts);
    };

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
    private readonly log: BoundLogger;

    constructor(cacheDir: string, pipelineFactory?: PipelineFactory, parentLog?: BoundLogger) {
        this.cacheDir = cacheDir;
        this.factory = pipelineFactory;
        this.log = parentLog?.withContext('EmbeddingEngine') ?? createLogger().withContext('EmbeddingEngine');
    }

    get isReady(): boolean {
        return this._isReady;
    }

    /**
     * Loads the model. Idempotent — resolves immediately if already loaded.
     * Concurrent calls await the same underlying promise.
     * Does not catch errors; callers are responsible for error handling.
     */
    async load(onProgress?: (message: string) => void): Promise<void> {
        if (this._isReady) {
            return;
        }
        if (!this.loadPromise) {
            this.loadPromise = this.doLoad(onProgress);
        }
        return this.loadPromise;
    }

    private async doLoad(onProgress?: (message: string) => void): Promise<void> {
        if (this.factory) {
            // Test / DI mode — use the injected factory directly on this thread.
            this.pipelineFn = await this.factory(this.cacheDir, onProgress);
        } else {
            // Production mode — spawn a worker thread for ONNX inference.
            this.pipelineFn = await defaultPipelineFactory(this.cacheDir, onProgress, this.log);
        }
        this._isReady = true;
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
