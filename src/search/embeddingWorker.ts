/**
 * embeddingWorker.ts
 *
 * Runs inside a Node.js worker_threads Worker.
 * Handles all ONNX inference via @xenova/transformers — the main thread
 * stays free to process VS Code events across ALL windows.
 *
 * Messages understood (from parent):
 *   { type: 'init', cacheDir: string }
 *   { type: 'embedBatch', id: number, texts: string[] }
 *   { type: 'terminate' }
 *
 * Messages sent (to parent):
 *   { type: 'progress', message: string }
 *   { type: 'init_done' }
 *   { type: 'result', id: number, dataBuffer: ArrayBuffer, dims: number }
 *   { type: 'error', id?: number, error: string }
 */

import { parentPort } from 'worker_threads';
import { resolveLocalModel } from './localModelPath';

/** How long to wait for the model to load (a local/cached folder returns instantly). */
const DOWNLOAD_TIMEOUT_MS = 180_000; // 3 minutes
const SEMANTIC_DIMS = 384;
/** Throttle progress messages to at most one per 200ms to avoid flooding
 *  the main thread's message queue during model download. */
const PROGRESS_THROTTLE_MS = 200;

type PipelineCallable = {
    (texts: string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
};

/** Subset of the transformers.js `env` object we configure. */
type TransformersEnv = {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    localModelPath?: string;
    remoteHost?: string;
};

/** Model source supplied by the parent (`EmbeddingModelSource`). */
type ModelSource = {
    localModelPath?: string;
    mirrorHost?: string;
};

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let pipelineFn: PipelineCallable | undefined;

if (!parentPort) {
    throw new Error('embeddingWorker must be run as a worker_threads Worker');
}

/** Collapses any thrown value into a single-line message. */
function errorMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.replace(/\s+/g, ' ').trim();
}

/** Ensures a usable `remoteHost` value (scheme + trailing slash). */
function normaliseHost(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
        return '';
    }
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** Sends a diagnostic line to the parent, which writes it to the output channel. */
function postLog(level: 'info' | 'warn' | 'error', message: string): void {
    parentPort?.postMessage({ type: 'log', level, message });
}


parentPort.on('message', async (msg: unknown) => {
    const request = msg as Record<string, unknown>;
    const type = String(request['type'] ?? '');

    try {
        switch (type) {
            case 'init': {
                const cacheDir = String(request['cacheDir'] ?? '');
                const source = (request['modelSource'] ?? {}) as ModelSource;

                // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
                const xenovaModule = require('@xenova/transformers') as any;
                const pipeline = xenovaModule.pipeline as (
                    task: string,
                    model: string,
                    options: Record<string, unknown>,
                ) => Promise<unknown>;
                const env = xenovaModule.env as TransformersEnv;

                env.cacheDir = cacheDir;

                // Throttled progress callback — at most one postMessage per 200ms
                // to prevent flooding the main thread during model download.
                let lastProgressTs = 0;
                const progressCallback = (progress: Record<string, unknown>) => {
                    const status = progress['status'];
                    const file = String(progress['file'] ?? '');
                    if (status === 'progress') {
                        const now = Date.now();
                        if (now - lastProgressTs < PROGRESS_THROTTLE_MS) { return; }
                        lastProgressTs = now;
                        const pct = typeof progress['progress'] === 'number'
                            ? Math.round(progress['progress'] as number)
                            : 0;
                        parentPort!.postMessage({ type: 'progress', message: `Downloading ${file}: ${pct}%` });
                    } else if (status === 'done' && file) {
                        parentPort!.postMessage({ type: 'progress', message: `Loaded ${file}` });
                    }
                };

                pipelineFn = await withTimeout(
                    loadPipeline(pipeline, env, source, cacheDir, progressCallback),
                    DOWNLOAD_TIMEOUT_MS,
                    'ONNX model download / load',
                ) as unknown as PipelineCallable;

                parentPort!.postMessage({ type: 'init_done' });
                break;
            }

            case 'embedBatch': {
                if (!pipelineFn) {
                    parentPort!.postMessage({ type: 'error', id: request['id'], error: 'Worker not initialized' });
                    break;
                }
                const texts = request['texts'] as string[];
                const id = request['id'] as number;

                const output = await pipelineFn(texts, { pooling: 'mean', normalize: true });
                const flat: Float32Array = output.data instanceof Float32Array
                    ? output.data
                    : Float32Array.from(output.data as ArrayLike<number>);

                // Transfer the ArrayBuffer directly — zero-copy to the main thread.
                parentPort!.postMessage(
                    { type: 'result', id, dataBuffer: flat.buffer, dims: SEMANTIC_DIMS } as Record<string, unknown>,
                    [flat.buffer] as unknown as readonly ArrayBuffer[],
                );
                break;
            }

            case 'terminate': {
                // Flush any remaining work and exit.
                pipelineFn = undefined;
                process.exit(0);
                break;
            }

            default:
                parentPort!.postMessage({ type: 'error', error: `Unknown message type: ${type}` });
        }
    } catch (err) {
        // An init failure must be distinguishable from a failed embedBatch:
        // the parent settles its `init` promise on `init_error` and would
        // otherwise wait forever (that was the "Downloading AI model…" hang).
        parentPort!.postMessage({
            type: type === 'init' ? 'init_error' : 'error',
            id: request['id'] as number | undefined,
            error: errorMessage(err),
        });
    }
});

/**
 * Builds the feature-extraction pipeline.
 *
 * A local folder (prepared by `SemanticModelInstaller`) is always preferred and
 * disables remote models, so transformers.js performs no network I/O at all.
 * The mirror/remote branch remains for the legacy path (no installer wired).
 */
async function loadPipeline(
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>,
    env: TransformersEnv,
    source: ModelSource,
    cacheDir: string,
    progressCallback: (progress: Record<string, unknown>) => void,
): Promise<unknown> {
    const localPath = String(source.localModelPath ?? '').trim();
    if (localPath) {
        const local = resolveLocalModel(localPath);
        if (local.missing.length > 0) {
            throw new Error(
                `Local model folder "${localPath}" is incomplete — missing ${local.missing.join(', ')}`,
            );
        }
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        env.localModelPath = local.root;
        postLog(
            'info',
            `Loading model from disk — folder=${local.modelFolder} modelId=${local.modelId} `
            + `onnx=${local.onnxFile} quantized=${local.quantized} allowRemoteModels=false`,
        );
        const created = await pipeline('feature-extraction', local.modelId, {
            cache_dir: cacheDir,
            progress_callback: progressCallback,
            quantized: local.quantized,
        });
        postLog('info', 'feature-extraction pipeline ready (local files only — no network access)');
        return created;
    }

    const mirror = normaliseHost(String(source.mirrorHost ?? process.env['HF_ENDPOINT'] ?? ''));
    if (mirror) {
        env.remoteHost = mirror;
    }
    postLog(
        'warn',
        `No local model folder — loading from ${mirror || 'https://huggingface.co/'} (cache dir: ${cacheDir})`,
    );
    const created = await pipeline('feature-extraction', MODEL_ID, {
        cache_dir: cacheDir,
        progress_callback: progressCallback,
    });
    postLog('info', 'feature-extraction pipeline ready (remote/cached model)');
    return created;
}

/**
 * Wraps a promise with a timeout. The timer is properly cleaned up when the
 * promise settles, preventing the timer's closure from keeping memory alive
 * for the full timeout duration.
 */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        timer.unref();
        task.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}
