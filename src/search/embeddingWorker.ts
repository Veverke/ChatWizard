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

const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes
const SEMANTIC_DIMS = 384;

type PipelineCallable = {
    (texts: string[], options: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
};

let pipelineFn: PipelineCallable | undefined;
let initDone = false;

if (!parentPort) {
    throw new Error('embeddingWorker must be run as a worker_threads Worker');
}

parentPort.on('message', async (msg: unknown) => {
    const request = msg as Record<string, unknown>;
    const type = String(request['type'] ?? '');

    try {
        switch (type) {
            case 'init': {
                const cacheDir = String(request['cacheDir'] ?? '');

                // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
                const xenovaModule = require('@xenova/transformers') as any;
                const { pipeline, env } = xenovaModule as { pipeline: Function; env: { cacheDir: string } };

                env.cacheDir = cacheDir;

                const progressCallback = (progress: Record<string, unknown>) => {
                    const status = progress['status'];
                    const file = String(progress['file'] ?? '');
                    if (status === 'progress') {
                        const pct = typeof progress['progress'] === 'number'
                            ? Math.round(progress['progress'] as number)
                            : 0;
                        parentPort!.postMessage({ type: 'progress', message: `Downloading ${file}: ${pct}%` });
                    } else if (status === 'done' && file) {
                        parentPort!.postMessage({ type: 'progress', message: `Loaded ${file}` });
                    }
                };

                pipelineFn = await withTimeout(
                    pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                        cache_dir: cacheDir,
                        progress_callback: progressCallback,
                    }),
                    DOWNLOAD_TIMEOUT_MS,
                    'ONNX model download / load',
                ) as unknown as PipelineCallable;

                initDone = true;
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
                initDone = false;
                process.exit(0);
                break;
            }

            default:
                parentPort!.postMessage({ type: 'error', error: `Unknown message type: ${type}` });
        }
    } catch (err) {
        parentPort!.postMessage({
            type: 'error',
            id: request['id'] as number | undefined,
            error: String(err),
        });
    }
});

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        task,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}
