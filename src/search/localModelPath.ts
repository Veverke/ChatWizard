// src/search/localModelPath.ts

/**
 * Helpers for loading the semantic-search embedding model from disk.
 *
 * transformers.js resolves a local model as `<env.localModelPath>/<model id>/...`,
 * where the model id normally keeps its Hugging Face organisation prefix
 * (`Xenova/all-MiniLM-L6-v2`).  Users, however, point us at whatever folder they
 * extracted — the model folder itself, its `Xenova` parent, or the model root.
 * These helpers accept all of those layouts and report exactly what is missing,
 * so the failure message is actionable instead of a bare `ENOENT`.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Hugging Face repo id of the embedding model used for semantic search. */
export const SEMANTIC_MODEL_ID = 'all-MiniLM-L6-v2';

/** Organisation that publishes the model on the Hugging Face Hub. */
export const SEMANTIC_MODEL_ORG = 'Xenova';

/** Files required by `pipeline('feature-extraction', …)`. */
export const REQUIRED_MODEL_FILES: readonly string[] = ['config.json', 'tokenizer.json'];

/** ONNX weight files, most preferred first (quantized ≈22.7 MB vs ≈90 MB). */
export const ONNX_CANDIDATES: readonly string[] = ['onnx/model_quantized.onnx', 'onnx/model.onnx'];

/** Optional metadata — its absence only produces a warning, never a failure. */
export const OPTIONAL_MODEL_FILES: readonly string[] = ['tokenizer_config.json'];

/** Files the downloader fetches when building the model folder from scratch. */
export const MODEL_DOWNLOAD_FILES: readonly string[] = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
];

export interface LocalModelResolution {
    /** Folder that directly contains `config.json` — `''` when no model was found. */
    modelFolder: string;
    /** Value to assign to `env.localModelPath` (the parent of `modelFolder`). */
    root: string;
    /** Model id handed to `pipeline()` (the folder name relative to `root`). */
    modelId: string;
    /** ONNX file to load, relative to `modelFolder` — `''` when none exists. */
    onnxFile: string;
    /** True when the quantized ONNX weights should be loaded. */
    quantized: boolean;
    /** Required files that are missing (empty = the folder is usable). */
    missing: string[];
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function emptyResolution(missing: string[]): LocalModelResolution {
    return { modelFolder: '', root: '', modelId: '', onnxFile: '', quantized: true, missing };
}

/**
 * Folders to probe for a user-supplied path, most specific first:
 *   1. the path itself (user pointed at the model folder),
 *   2. `<path>/Xenova/all-MiniLM-L6-v2` (user pointed at a models root),
 *   3. `<path>/all-MiniLM-L6-v2` (user pointed at the Xenova folder).
 */
export function modelFolderCandidates(folder: string): string[] {
    const abs = path.resolve(folder);
    return [
        abs,
        path.join(abs, SEMANTIC_MODEL_ORG, SEMANTIC_MODEL_ID),
        path.join(abs, SEMANTIC_MODEL_ID),
    ];
}

/**
 * Resolves `folder` into everything needed to load the model from disk.
 * Never throws — inspect `missing` to find out why a folder is unusable.
 */
export function resolveLocalModel(folder: string): LocalModelResolution {
    const required = [...REQUIRED_MODEL_FILES, ONNX_CANDIDATES[0]];
    if (!folder || !folder.trim()) {
        return emptyResolution(required);
    }

    for (const candidate of modelFolderCandidates(folder)) {
        if (!isFile(path.join(candidate, 'config.json'))) {
            continue;
        }

        const missing: string[] = [];
        for (const file of REQUIRED_MODEL_FILES) {
            if (!isFile(path.join(candidate, file))) {
                missing.push(file);
            }
        }

        const onnxFile = ONNX_CANDIDATES.find(file => isFile(path.join(candidate, file))) ?? '';
        if (!onnxFile) {
            missing.push(ONNX_CANDIDATES[0]);
        }

        // transformers.js documents local models as `<localModelPath>/<repo id>`,
        // where the repo id keeps its organisation (`Xenova/all-MiniLM-L6-v2`).
        // Keeping that shape avoids depending on how the loader joins the pieces:
        // `root + modelId` always resolves back to `modelFolder`.
        const parent = path.dirname(candidate);
        const includeOrg = path.basename(parent) === SEMANTIC_MODEL_ORG;

        return {
            modelFolder: candidate,
            root: includeOrg ? path.dirname(parent) : parent,
            modelId: includeOrg ? `${SEMANTIC_MODEL_ORG}/${path.basename(candidate)}` : path.basename(candidate),
            onnxFile,
            quantized: onnxFile !== ONNX_CANDIDATES[1],
            missing,
        };
    }

    return emptyResolution(required);
}

/** True when `folder` (or one of its known layouts) holds a complete model. */
export function isLocalModelUsable(folder: string): boolean {
    return resolveLocalModel(folder).missing.length === 0;
}

/** Human-readable list of missing files, e.g. `config.json, onnx/model_quantized.onnx`. */
export function describeMissingFiles(missing: readonly string[]): string {
    return missing.length === 0 ? 'nothing' : missing.join(', ');
}

/**
 * Depth-first search for an existing, complete model folder under `root`.
 *
 * transformers.js has used different file-system cache layouts across releases
 * and the folder name is part of the repo id, so instead of guessing a path we
 * look for any folder that holds a complete model. This lets an upgraded install
 * reuse the model it already downloaded instead of downloading 23 MB again.
 *
 * Bounded on purpose (depth + inspected-directory cap) so a pathological models
 * directory cannot stall activation.
 */
export function findExistingModelFolder(root: string, maxDepth = 6, maxDirectories = 2000): string | undefined {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let inspected = 0;

    while (queue.length > 0 && inspected < maxDirectories) {
        const current = queue.shift();
        if (!current) {
            break;
        }
        inspected++;

        if (isFile(path.join(current.dir, 'config.json')) && isFile(path.join(current.dir, 'tokenizer.json'))) {
            const resolved = resolveLocalModel(current.dir);
            if (resolved.missing.length === 0) {
                return resolved.modelFolder;
            }
        }

        if (current.depth >= maxDepth) {
            continue;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
            }
        }
    }

    return undefined;
}
