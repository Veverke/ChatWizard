/**
 * prepare-model-assets.ts
 *
 * Downloads the semantic-search embedding model and produces a verified asset set
 * — the 4 model files plus `manifest.json` — ready to attach to a GitHub release.
 *
 * Used by `.github/workflows/model-assets.yml`; runnable locally too:
 *
 *   npx tsx scripts/prepare-model-assets.ts --out .model-assets
 *   npx tsx scripts/prepare-model-assets.ts --source https://hf-mirror.com --tag semantic-model-v2
 *
 * The downloader is the same one the extension uses, so a CI run also smoke-tests
 * the production code path (redirects, retries, checksum verification).
 */

import * as fs from 'fs';
import * as path from 'path';
import { downloadModelFiles, sha256File } from '../src/search/modelDownloader';
import { SEMANTIC_MODEL_ID, SEMANTIC_MODEL_ORG } from '../src/search/localModelPath';

/** Files transformers.js needs for `feature-extraction`. */
const DEFAULT_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
];

interface Options {
    /** Hub or mirror base URL (no repo path). */
    source: string;
    /** Model repo id. */
    repo: string;
    /** Git revision of the model repo. */
    revision: string;
    /** Files to publish, relative to the model folder. */
    files: string[];
    /** Output folder for the assets. */
    out: string;
    /** Release tag the assets will be published to (metadata only). */
    tag: string;
}

const DEFAULTS: Options = {
    source: 'https://huggingface.co',
    repo: `${SEMANTIC_MODEL_ORG}/${SEMANTIC_MODEL_ID}`,
    revision: 'main',
    files: DEFAULT_FILES,
    out: '.model-assets',
    tag: 'semantic-model-v1',
};

export function parseArgs(argv: readonly string[]): Options {
    const options: Options = { ...DEFAULTS };
    for (let index = 0; index < argv.length; index++) {
        const raw = argv[index];
        if (!raw.startsWith('--')) {
            continue;
        }
        const equals = raw.indexOf('=');
        const key = (equals === -1 ? raw.slice(2) : raw.slice(2, equals)).trim();
        const value = equals === -1 ? argv[++index] : raw.slice(equals + 1);
        if (value === undefined) {
            throw new Error(`Missing value for --${key}`);
        }
        switch (key) {
            case 'source':
                options.source = value;
                break;
            case 'repo':
                options.repo = value;
                break;
            case 'revision':
                options.revision = value;
                break;
            case 'files':
                options.files = value.split(',').map(item => item.trim()).filter(Boolean);
                break;
            case 'out':
                options.out = value;
                break;
            case 'tag':
                options.tag = value;
                break;
            default:
                throw new Error(`Unknown option --${key}`);
        }
    }
    if (options.files.length === 0) {
        throw new Error('No files selected');
    }
    return options;
}

function megabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const baseUrl = `${options.source.replace(/\/+$/, '')}/${options.repo}/resolve/${options.revision}/`;
    const outDir = path.resolve(options.out);

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`Model:    ${options.repo} @ ${options.revision}`);
    console.log(`Source:   ${baseUrl}`);
    console.log(`Output:   ${outDir}`);
    console.log(`Tag:      ${options.tag}`);
    console.log(`Files:    ${options.files.join(', ')}`);

    const result = await downloadModelFiles({
        baseUrls: [baseUrl],
        files: options.files,
        destDir: outDir,
        attempts: 3,
        onProgress: message => console.log(`  ${message}`),
    });
    console.log(`Downloaded ${megabytes(result.bytes)} from ${result.baseUrl}`);

    type ManifestEntry = { size: number; sha256: string; asset: string };
    const files: Record<string, ManifestEntry> = {};

    for (const file of options.files) {
        const filePath = path.join(outDir, ...file.split('/'));
        const stat = await fs.promises.stat(filePath);
        files[file] = {
            size: stat.size,
            sha256: await sha256File(filePath),
            // GitHub release assets are flat, so `onnx/model_quantized.onnx`
            // is published as `model_quantized.onnx`.
            asset: path.basename(file),
        };

        const flatPath = path.join(outDir, path.basename(file));
        if (flatPath !== filePath) {
            await fs.promises.rename(filePath, flatPath);
        }
    }

    // Drop the now-empty nested folders (onnx/) so the release upload is flat.
    for (const entry of await fs.promises.readdir(outDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            await fs.promises.rm(path.join(outDir, entry.name), { recursive: true, force: true });
        }
    }

    const manifest = {
        version: 1,
        model: options.repo,
        revision: options.revision,
        tag: options.tag,
        createdAt: new Date().toISOString(),
        files,
    };
    await fs.promises.writeFile(
        path.join(outDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
    );

    console.log(`\nAssets written to ${outDir}:`);
    for (const [file, entry] of Object.entries(files)) {
        console.log(`  ${file} -> ${entry.asset} (${megabytes(entry.size)}) sha256=${entry.sha256.slice(0, 12)}...`);
    }
    console.log('  manifest.json');
    console.log(`\nAttach all files to a release tagged "${options.tag}"; the extension then fetches them from`);
    console.log(`https://github.com/<owner>/<repo>/releases/download/${options.tag}/manifest.json`);
}

main().catch((err: unknown) => {
    console.error(`Failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
});
