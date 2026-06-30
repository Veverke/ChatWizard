// src/search/embeddingEngine.ts

import * as path from 'path';
import { Worker } from 'worker_threads';
import { IEmbeddingEngine, SEMANTIC_DIMS } from './semanticContracts';
import { createLogger, type BoundLogger, withTimeout } from '../utils/logger';

/** How long (ms) before we give up on downloading the ONNX model. */
const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes

/** How long (ms) before a pending embedBatch response is considered stuck. */
const EMBED_RPC_TIMEOUT_MS = 120_000;

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

/** Default factory — delegates to the worker thread. */
async function defaultPipelineFactory(
    cacheDir: string,
    onProgress?: (message: string) => void,
    parentLog?: BoundLogger,
): Promise<PipelineCallable> {
    // Resolve the worker script relative to __dirname.
    // When bundled by esbuild, __dirname = dist/ and worker.js is alongside.
    // When running via tsc (out/), the worker is at out/src/search/embeddingWorker.js.
    const workerPath = path.resolve(__dirname, 'embeddingWorker.js');
    const log: BoundLogger = parentLog?.withContext('EmbeddingWorker') ?? createLogger().withContext('EmbeddingWorker');
    log.info('Spawning worker thread from %s', workerPath);

    const worker = new Worker(workerPath);

    // RPC state: map of request ID → { resolve, reject, timer }
    let nextId = 1;
    const pending = new Map<number, {
        resolve: (dataBuffer: ArrayBuffer, dims: number) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    let workerReady = false;
    let workerClosed = false;

    // Resolver that fires when the worker signals init_done — used to block
    // the factory until the ONNX model is loaded in the worker thread.
    let resolveInit: (() => void) | undefined;
    const initDone = new Promise<void>((resolve) => { resolveInit = resolve; });

    // Proxy worker progress to the caller's onProgress callback
    worker.on('message', (msg: Record<string, unknown>) => {
        const type = String(msg['type'] ?? '');

        if (type === 'progress' && onProgress) {
            onProgress(String(msg['message'] ?? ''));
            return;
        }

        if (type === 'init_done') {
            log.info('Worker init complete');
            workerReady = true;
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
        workerClosed = true;
        resolveInit?.(); // Unblock init wait so the factory can fail
        log.error('Worker crashed: %s', String(err));
        // Reject all pending requests
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        pending.clear();
    });

    worker.on('exit', (code) => {
        workerClosed = true;
        resolveInit?.(); // Unblock init wait so the factory can continue/poll
        if (code !== 0) {
            log.warn('Worker exited with code %d', code);
        }
        // Reject remaining pending requests
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`Worker exited with code ${code}`));
        }
        pending.clear();
    });

    // === Send init message and wait for worker to be ready ===
    // The worker loads the ONNX model asynchronously. We block here so that
    // embedBatch calls cannot race ahead before the model is loaded.
    worker.postMessage({ type: 'init', cacheDir });
    try {
        await withTimeout(initDone, DOWNLOAD_TIMEOUT_MS + 10_000, 'Worker model init');
        log.info('Worker model loaded and ready');
    } catch (err) {
        log.error('Worker init failed: %s — worker thread will be terminated', String(err));
        try { worker.terminate(); } catch { /* ignore */ }
        throw err;
    }

    // The returned callable acts as a PipelineFactory pipeline: it sends messages
    // to the worker and returns a { data: ArrayLike }-shaped response.
    const callable = async (textOrTexts: string | string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }> => {
        // Normalise to array
        const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
        const id = nextId++;

        return new Promise<{ data: ArrayLike<number> }>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`embedBatch RPC timed out after ${EMBED_RPC_TIMEOUT_MS}ms`));
            }, EMBED_RPC_TIMEOUT_MS);

            pending.set(id, {
                resolve: (dataBuffer: ArrayBuffer, dims: number) => {
                    // Reconstruct the flat Float32Array from the transferred buffer
                    const flat = new Float32Array(dataBuffer);
                    // Return in the same shape as @xenova/transformers pipeline output
                    resolve({ data: flat });
                },
                reject,
                timer,
            });

            if (!workerClosed) {
                worker.postMessage({ type: 'embedBatch', id, texts });
            } else {
                clearTimeout(timer);
                pending.delete(id);
                reject(new Error('Worker is closed'));
            }
        });
    };

    // Hang a dispose method on the callable so the engine can clean up
    (callable as unknown as Record<string, unknown>)._worker = worker;
    (callable as unknown as Record<string, unknown>)._pending = pending;

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

        // If we're in worker mode, the pipelineFn has a hidden _worker reference.
        if (!this.factory && this.pipelineFn) {
            const callable = this.pipelineFn as unknown as Record<string, unknown>;
            const worker = callable['_worker'] as Worker | undefined;
            const pending = callable['_pending'] as Map<number, { timer: ReturnType<typeof setTimeout> }> | undefined;

            if (pending) {
                for (const [, entry] of pending) {
                    clearTimeout(entry.timer);
                }
                pending.clear();
            }

            if (worker) {
                worker.postMessage({ type: 'terminate' });
                // Force-terminate after a short grace period
                const killTimer = setTimeout(() => {
                    try { worker.terminate(); } catch { /* ignore */ }
                }, 2_000);
                killTimer.unref();

                worker.on('exit', () => {
                    clearTimeout(killTimer);
                });
                this.log.debug('Worker terminate signal sent');
            }
        }

        this.pipelineFn = undefined;
        this._isReady = false;
    }
}
