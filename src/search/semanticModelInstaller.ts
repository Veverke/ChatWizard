// src/search/semanticModelInstaller.ts

/**
 * Obtains the semantic-search embedding model on disk, from whichever source
 * the user's network allows:
 *
 *   1. an explicit local folder (setting `chatwizard.semanticModelPath`, or a
 *      model pre-staged by IT) — no network at all;
 *   2. the folder downloaded by a previous run — no network at all;
 *   3. a mirror host (`chatwizard.semanticModelMirror` / `HF_ENDPOINT`);
 *   4. the official Hugging Face Hub;
 *   5. the ChatWizard GitHub release asset built by
 *      `.github/workflows/model-assets.yml` (works where huggingface.co is blocked).
 *
 * The transformers.js loader is then pointed at the resulting folder with
 * remote models disabled, so it never performs a network request itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MODEL_DOWNLOAD_FILES,
    SEMANTIC_MODEL_ID,
    SEMANTIC_MODEL_ORG,
    describeMissingFiles,
    findExistingModelFolder,
    resolveLocalModel,
} from './localModelPath';
import { downloadModelFiles } from './modelDownloader';

/**
 * Minimal logging surface — keeps this module free of a `vscode` dependency so it
 * can run in plain Node (asset script, unit tests). `BoundLogger` satisfies it.
 */
export interface ModelInstallerLog {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

const SILENT_LOG: ModelInstallerLog = {
    info: () => { /* no-op */ },
    warn: () => { /* no-op */ },
    error: () => { /* no-op */ },
};

/**
 * GitHub release that hosts the 4 model files plus `manifest.json`.
 * Created/updated by `.github/workflows/model-assets.yml`.
 */
export const DEFAULT_FALLBACK_BASE_URL =
    'https://github.com/Veverke/ChatWizard/releases/download/semantic-model-v1/';

/** Tag the asset workflow publishes to by default. */
export const DEFAULT_MODEL_ASSET_TAG = 'semantic-model-v1';

export interface SemanticModelSourceOptions {
    /** Explicit local folder (setting or pre-staged). Wins over any download. */
    localModelPath?: string;
    /** Mirror host, e.g. `https://hf-mirror.com`. */
    mirrorHost?: string;
    /** Repo path appended to the hosts (default `Xenova/all-MiniLM-L6-v2`). */
    repoPath?: string;
    /** Revision (default `main`). */
    revision?: string;
    /** Base URL of the GitHub release asset fallback (`''` disables it). */
    fallbackBaseUrl?: string;
    /** Explicit proxy URL (defaults to HTTPS_PROXY/HTTP_PROXY). */
    proxyUrl?: string;
    /**
     * Also trust the operating system's CA store (default `true`). Wired to
     * VS Code's `http.systemCertificates`; required on TLS-inspecting networks.
     */
    useSystemCertificates?: boolean;
    /**
     * Complete override of the source list (tried in order). Intended for tests
     * and for advanced/air-gapped deployments pointing at an internal file server.
     */
    baseUrls?: readonly string[];
}

export interface InstalledModel {
    /** Folder to hand to transformers.js as the local model path. */
    folder: string;
    /** Human-readable source id, e.g. `huggingface.co`, `local-folder`, `cache`. */
    source: string;
    /** True when files were written during this call. */
    downloaded: boolean;
}

/** Injectable seam so `SemanticIndexer` can be unit-tested without any I/O. */
export interface IModelInstaller {
    /** Cheap synchronous check: are the required files already on disk? */
    isModelPresent(): boolean;
    /** Ensures a usable model folder exists, downloading it when necessary. */
    ensureModel(onProgress?: (message: string) => void): Promise<InstalledModel>;
}

export class SemanticModelInstaller implements IModelInstaller {
    private readonly storageDir: string;
    private readonly getOptions: () => SemanticModelSourceOptions;
    private readonly log: ModelInstallerLog;

    constructor(storageDir: string, getOptions: () => SemanticModelSourceOptions, log?: ModelInstallerLog) {
        this.storageDir = storageDir;
        this.getOptions = getOptions;
        this.log = log ?? SILENT_LOG;
    }

    /** `<storage>/Xenova/all-MiniLM-L6-v2` — kept apart from the transformers FS cache. */
    get modelFolder(): string {
        return path.join(this.storageDir, SEMANTIC_MODEL_ORG, SEMANTIC_MODEL_ID);
    }

    isModelPresent(): boolean {
        return resolveLocalModel(this.modelFolder).missing.length === 0;
    }

    async ensureModel(onProgress?: (message: string) => void): Promise<InstalledModel> {
        const options = this.getOptions();
        const mirrorOption = options.mirrorHost?.trim()
            || (process.env['HF_ENDPOINT'] ? `HF_ENDPOINT=${process.env['HF_ENDPOINT']}` : '(not set)');
        this.log.info(
            'Model source options — local folder: '
            + `${options.localModelPath?.trim() || '(not set)'} | mirror: ${mirrorOption} `
            + `| fallback: ${options.fallbackBaseUrl?.trim() || '(disabled)'}`,
        );

        // 1. Explicit local folder — never touched by the network.
        const explicit = options.localModelPath?.trim();
        if (explicit) {
            const local = resolveLocalModel(explicit);
            if (local.missing.length > 0) {
                this.log.error(`Local model folder is incomplete: ${explicit} (missing: ${describeMissingFiles(local.missing)})`);
                throw new Error(
                    `Local model folder "${explicit}" is incomplete — missing ${describeMissingFiles(local.missing)}`,
                );
            }
            this.log.info(`Using local model folder (no download): ${local.modelFolder}`);
            return { folder: local.modelFolder, source: 'local-folder', downloaded: false };
        }

        // 2. Already downloaded by a previous run (this version or an older one,
        //    whose transformers.js FS cache used a different layout).
        if (this.isModelPresent()) {
            this.log.info(`Model already on disk — reusing ${this.modelFolder}`);
            return { folder: this.modelFolder, source: 'cache', downloaded: false };
        }
        const reused = findExistingModelFolder(path.dirname(this.storageDir));
        if (reused) {
            this.log.info(`Reusing a model downloaded by an earlier Chat Wizard version: ${reused}`);
            return { folder: reused, source: 'cache', downloaded: false };
        }

        // 3./4./5. Download, trying each source in order.
        const missing = MODEL_DOWNLOAD_FILES
            .filter(file => !isFile(path.join(this.modelFolder, ...file.split('/'))));
        const baseUrls = buildBaseUrls(options);
        this.log.info(
            `Model not on disk — downloading ${missing.length} file(s) into ${this.modelFolder} `
            + `(${baseUrls.length} source(s) queued)`,
        );
        onProgress?.(`Fetching the AI model from ${hostLabel(baseUrls[0])}…`);

        const startedAt = Date.now();
        const result = await downloadModelFiles({
            baseUrls,
            files: missing,
            destDir: this.modelFolder,
            onProgress,
            onLog: message => this.log.info(message),
            proxyUrl: options.proxyUrl,
            useSystemCertificates: options.useSystemCertificates,
        });

        const resolved = resolveLocalModel(this.modelFolder);
        if (resolved.missing.length > 0) {
            this.log.error(`Download finished but the model folder is incomplete: ${describeMissingFiles(resolved.missing)}`);
            throw new Error(
                `The AI model was downloaded but the folder is incomplete — missing ${describeMissingFiles(resolved.missing)}`,
            );
        }
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        this.log.info(
            `Model download complete from ${hostLabel(result.baseUrl)} — `
            + `${(result.bytes / (1024 * 1024)).toFixed(1)} MB in ${seconds}s`,
        );
        return { folder: resolved.modelFolder, source: hostLabel(result.baseUrl), downloaded: true };
    }
}

/** Sources in priority order: explicit override → mirror → official Hub → GitHub asset. */
export function buildBaseUrls(options: SemanticModelSourceOptions): string[] {
    if (options.baseUrls && options.baseUrls.length > 0) {
        return [...options.baseUrls];
    }
    const repo = (options.repoPath ?? `${SEMANTIC_MODEL_ORG}/${SEMANTIC_MODEL_ID}`)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
    const revision = options.revision?.trim() || 'main';
    const mirror = (options.mirrorHost?.trim() || process.env['HF_ENDPOINT']?.trim() || '')
        .replace(/\/+$/, '');

    const urls: string[] = [];
    if (mirror) {
        urls.push(`${mirror}/${repo}/resolve/${revision}/`);
    }
    urls.push(`https://huggingface.co/${repo}/resolve/${revision}/`);
    const fallback = options.fallbackBaseUrl?.trim();
    if (fallback) {
        urls.push(fallback.endsWith('/') ? fallback : `${fallback}/`);
    }
    return [...new Set(urls)];
}

/** Short label for logs/UI, e.g. `huggingface.co` or `github.com`. */
export function hostLabel(baseUrl: string): string {
    try {
        return new URL(baseUrl).host || baseUrl;
    } catch {
        return baseUrl || 'unknown';
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}
