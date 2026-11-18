#!/usr/bin/env node
/**
 * scripts/hash-model-assets.mjs
 *
 * Writes the `manifest.json` that Chat Wizard uses to verify model downloads,
 * from files you already have on disk.
 *
 * Use this when the 4 model files were fetched by hand (e.g. on a machine with
 * internet access) and will be published somewhere the extension can reach — an
 * internal file server, a Hugging Face mirror, or a GitHub release. The manifest
 * makes the extension verify size + SHA-256 instead of trusting the bytes, and
 * it records the flat `asset` name GitHub uses for `onnx/model_quantized.onnx`.
 *
 * It only hashes; it never downloads. To fetch *and* hash (what CI does) use:
 *   npx tsx scripts/prepare-model-assets.ts --out .model-assets
 *
 * Usage:
 *   node scripts/hash-model-assets.mjs C:\path\to\all-MiniLM-L6-v2
 *   node scripts/hash-model-assets.mjs ./model --tag semantic-model-v2 --out ./manifest.json
 *   node scripts/hash-model-assets.mjs ./model --files config.json,tokenizer.json
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat, writeFile } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';

/** Files transformers.js needs; `onnx/model.onnx` is optional (4× larger). */
const DEFAULT_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
];

const USAGE = `Usage: node scripts/hash-model-assets.mjs <model folder> [options]

Options:
  --out <file>       Manifest path (default: <folder>/manifest.json)
  --files <a,b,c>    Files to hash, relative to the folder (default: the 4 model files)
  --tag <tag>        Release tag recorded in the manifest (default: semantic-model-v1)
  --repo <repo>      Model repo id recorded in the manifest
  --revision <rev>   Model revision recorded in the manifest (default: main)
  -h, --help         Show this message`;

function parseArgs(argv) {
    const options = {
        folder: '',
        out: '',
        files: [...DEFAULT_FILES],
        tag: 'semantic-model-v1',
        repo: 'Xenova/all-MiniLM-L6-v2',
        revision: 'main',
        help: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const raw = argv[index];
        if (!raw.startsWith('--')) {
            if (!options.folder) {
                options.folder = raw;
                continue;
            }
            throw new Error(`Unexpected argument: ${raw}`);
        }
        if (raw === '-h' || raw === '--help') {
            options.help = true;
            continue;
        }
        const equals = raw.indexOf('=');
        const key = (equals === -1 ? raw.slice(2) : raw.slice(2, equals)).trim();
        const value = equals === -1 ? argv[++index] : raw.slice(equals + 1);
        if (value === undefined) {
            throw new Error(`Missing value for --${key}`);
        }
        switch (key) {
            case 'out':
                options.out = value;
                break;
            case 'files':
                options.files = value.split(',').map(item => item.trim()).filter(Boolean);
                break;
            case 'tag':
                options.tag = value;
                break;
            case 'repo':
                options.repo = value;
                break;
            case 'revision':
                options.revision = value;
                break;
            default:
                throw new Error(`Unknown option --${key}`);
        }
    }
    return options;
}

/** Streams a file through SHA-256 so a 23 MB ONNX file is never fully buffered. */
function sha256File(filePath) {
    return new Promise((resolveHash, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolveHash(hash.digest('hex')));
    });
}

function megabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return;
    }
    if (!options.folder) {
        console.error(USAGE);
        throw new Error('No model folder given');
    }

    const folder = resolve(options.folder);
    const folderStat = await stat(folder).catch(() => undefined);
    if (!folderStat || !folderStat.isDirectory()) {
        throw new Error(`Not a folder: ${folder}`);
    }

    const files = {};
    const missing = [];
    for (const file of options.files) {
        const absolute = join(folder, ...file.split('/'));
        const fileStat = await stat(absolute).catch(() => undefined);
        if (!fileStat || !fileStat.isFile()) {
            missing.push(file);
            continue;
        }
        files[file] = {
            size: fileStat.size,
            sha256: await sha256File(absolute),
            // GitHub release assets are flat, so `onnx/model_quantized.onnx`
            // is published as `model_quantized.onnx`.
            asset: basename(file.split('/').join(sep)),
        };
        console.log(`  ${file} -> ${files[file].asset}  ${megabytes(fileStat.size)}  ${files[file].sha256}`);
    }

    if (Object.keys(files).length === 0) {
        throw new Error(
            `None of the expected files were found in ${folder} (looked for: ${options.files.join(', ')})`,
        );
    }
    if (missing.length > 0) {
        console.warn(`\nWarning: missing (skipped): ${missing.join(', ')}`);
        console.warn('A manifest without every file only verifies the files it lists.');
    }

    const manifest = {
        version: 1,
        model: options.repo,
        revision: options.revision,
        tag: options.tag,
        createdAt: new Date().toISOString(),
        files,
    };
    const outPath = options.out ? resolve(options.out) : join(folder, 'manifest.json');
    await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`\nWrote ${outPath}`);
    console.log(`Publish these ${Object.keys(files).length + 1} files flat (same folder) so the`);
    console.log('extension can fetch <base-url>/<asset> next to <base-url>/manifest.json.');
}

main().catch(err => {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
