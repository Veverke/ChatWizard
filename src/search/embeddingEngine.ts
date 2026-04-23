// src/search/embeddingEngine.ts

import { IEmbeddingEngine, SEMANTIC_DIMS, SEMANTIC_MAX_CHARS } from './semanticContracts';

/** Minimal callable shape returned by @xenova/transformers pipeline() */
type PipelineCallable = (text: string, options: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;

/**
 * Injectable factory that loads the feature-extraction pipeline.
 * Receives cacheDir and an optional progress forwarder; returns the callable pipeline.
 * Swap this out in tests to avoid network I/O.
 */
export type PipelineFactory = (
    cacheDir: string,
    onProgress?: (message: string) => void,
) => Promise<PipelineCallable>;

/** Default factory — delegates to @xenova/transformers (imported lazily so it stays external to the bundle) */
async function defaultPipelineFactory(
    cacheDir: string,
    onProgress?: (message: string) => void,
): Promise<PipelineCallable> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const xenovaModule = require('@xenova/transformers') as any;
    const { pipeline, env } = xenovaModule as { pipeline: Function; env: { cacheDir: string } };

    env.cacheDir = cacheDir;

    const progressCallback = onProgress
        ? (progress: Record<string, unknown>) => {
              const status = progress['status'];
              const file = String(progress['file'] ?? '');
              if (status === 'progress') {
                  const pct = typeof progress['progress'] === 'number'
                      ? Math.round(progress['progress'] as number)
                      : 0;
                  onProgress(`Downloading ${file}: ${pct}%`);
              } else if (status === 'done' && file) {
                  onProgress(`Loaded ${file}`);
              }
          }
        : undefined;

    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        cache_dir: cacheDir,
        progress_callback: progressCallback,
    });

    return extractor as unknown as PipelineCallable;
}

/**
 * Thin wrapper around @xenova/transformers that loads the ONNX model and
 * produces normalized 384-dim embeddings.
 *
 * Accepts an optional `pipelineFactory` for dependency injection in tests.
 */
export class EmbeddingEngine implements IEmbeddingEngine {
    private readonly cacheDir: string;
    private readonly factory: PipelineFactory;
    private pipelineFn: PipelineCallable | undefined;
    private _isReady = false;
    private loadPromise: Promise<void> | undefined;

    constructor(cacheDir: string, pipelineFactory?: PipelineFactory) {
        this.cacheDir = cacheDir;
        this.factory = pipelineFactory ?? defaultPipelineFactory;
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
        this.pipelineFn = await this.factory(this.cacheDir, onProgress);
        this._isReady = true;
    }

    /**
     * Embeds the given text and returns a normalized Float32Array of length SEMANTIC_DIMS.
     * Throws if the engine is not ready.
     */
    async embed(text: string): Promise<Float32Array> {
        if (!this._isReady || !this.pipelineFn) {
            throw new Error('EmbeddingEngine is not ready. Call load() first.');
        }
        const clipped = text.slice(0, SEMANTIC_MAX_CHARS);
        const output = await this.pipelineFn(clipped, { pooling: 'mean', normalize: true });
        const data = output.data;
        const result = data instanceof Float32Array
            ? data
            : Float32Array.from(data as ArrayLike<number>);
        if (result.length !== SEMANTIC_DIMS) {
            throw new Error(`Expected ${SEMANTIC_DIMS}-dim embedding, got ${result.length}`);
        }
        return result;
    }
}
