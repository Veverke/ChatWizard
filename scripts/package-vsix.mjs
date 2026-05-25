#!/usr/bin/env node
/**
 * scripts/package-vsix.mjs
 *
 * Wraps `vsce package` with two fixes that make @xenova/transformers load
 * correctly inside the VSIX, without adding the full 65 MB + 48 MB packages:
 *
 *  1. STUB PACKAGES — @xenova/transformers statically imports `onnxruntime-web`
 *     and `sharp` at the top of backends/onnx.js and utils/image.js.  In the
 *     VS Code extension host (Node.js), neither is ever *called*: the library
 *     always uses onnxruntime-NODE for inference, and ChatWizard only performs
 *     text embeddings so sharp is never invoked.  We create 2 KB stub packages
 *     nested inside node_modules/@xenova/transformers/node_modules/ so the
 *     static imports resolve without bundling the real packages.  The stubs are
 *     already covered by the existing `!node_modules/@xenova/transformers/**`
 *     glob in .vscodeignore, so no extra include lines are needed.
 *
 *  2. PLATFORM-SPECIFIC ONNXRUNTIME-NODE — onnxruntime-node ships pre-built
 *     binaries for all platforms (92 MB total).  We temporarily append entries
 *     to .vscodeignore that include only the current platform's binary (9–23 MB)
 *     and the shared JS dist/ folder.  All other platform binaries remain
 *     excluded by the top-level `node_modules/**` rule.
 *
 * Both changes are created immediately before `vsce package` runs and are
 * removed inside a `finally` block so the working tree is always left clean,
 * even if packaging fails.
 *
 * Usage (called via package.json scripts):
 *   node scripts/package-vsix.mjs <platform>
 *   Platforms: win32-x64 | linux-x64 | darwin-x64 | darwin-arm64
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Platform → onnxruntime-node binary sub-path ──────────────────────────────

const PLATFORM_BIN = {
    'win32-x64':    'win32/x64',
    'linux-x64':    'linux/x64',
    'darwin-x64':   'darwin/x64',
    'darwin-arm64': 'darwin/arm64',
};

const platform = process.argv[2];
if (!PLATFORM_BIN[platform]) {
    console.error(`\nUsage: node scripts/package-vsix.mjs <platform>`);
    console.error(`Valid platforms: ${Object.keys(PLATFORM_BIN).join(', ')}\n`);
    process.exit(1);
}

const vsixName = `chatwizard-${platform}.vsix`;

// ── 1. Stub packages ──────────────────────────────────────────────────────────
//
// Nested node_modules inside @xenova/transformers are resolved first by
// Node.js module resolution, so these stubs shadow the (absent) real packages
// without touching the root node_modules.

const STUBS = ['onnxruntime-web', 'sharp'];
const XENOVA_NM = join(ROOT, 'node_modules', '@xenova', 'transformers', 'node_modules');

function createStubs() {
    mkdirSync(XENOVA_NM, { recursive: true });
    for (const name of STUBS) {
        // Use the real installed version so npm's dep-tree version check passes
        // (the stub has version "1.14.0" / "0.32.6", matching @xenova/transformers' requirement).
        const realPkgJson = join(ROOT, 'node_modules', name, 'package.json');
        const version = existsSync(realPkgJson)
            ? JSON.parse(readFileSync(realPkgJson, 'utf8')).version
            : '0.0.0';
        const dir = join(XENOVA_NM, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name, version, main: 'index.js' }, null, 2) + '\n',
        );
        writeFileSync(
            join(dir, 'index.js'),
            '// stub: satisfies static ESM import; never called in Node.js extension host\nmodule.exports = {};\n',
        );
    }
    console.log(`  ✅ stubs created: ${STUBS.join(', ')}`);
}

function removeStubs() {
    for (const name of STUBS) {
        rmSync(join(XENOVA_NM, name), { recursive: true, force: true });
    }
    // Remove the node_modules dir only if it is now empty
    try { rmdirSync(XENOVA_NM); } catch { /* not empty — leave it */ }
    console.log('  ✅ stubs removed');
}

// ── 2. .vscodeignore patch ────────────────────────────────────────────────────
//
// Appends platform-specific onnxruntime-node entries, then reverts to the
// original content in the finally block.  The marker comment makes it easy
// to verify in CI logs that the patch was applied and reverted correctly.

const VSCODEIGNORE_PATH = join(ROOT, '.vscodeignore');
const ONNX_MARKER = '# --- onnxruntime-node (added by package-vsix.mjs, reverted after packaging) ---';
let originalVscodeignore = '';

function patchVscodeignore() {
    originalVscodeignore = readFileSync(VSCODEIGNORE_PATH, 'utf8');
    const binPath = PLATFORM_BIN[platform];
    const patch = [
        '',
        ONNX_MARKER,
        '# onnxruntime-node: native ONNX Runtime required by @xenova/transformers.',
        "# Only the current platform's binary is included (9-23 MB per VSIX).",
        '!node_modules/onnxruntime-node/dist/**',
        '!node_modules/onnxruntime-node/package.json',
        `!node_modules/onnxruntime-node/bin/napi-v3/${binPath}/**`,
    ].join('\n') + '\n';
    writeFileSync(VSCODEIGNORE_PATH, originalVscodeignore + patch);
    console.log(`  ✅ .vscodeignore patched for ${platform} (onnxruntime-node/bin/napi-v3/${binPath})`);
}

function revertVscodeignore() {
    if (originalVscodeignore) {
        writeFileSync(VSCODEIGNORE_PATH, originalVscodeignore);
        console.log('  ✅ .vscodeignore reverted');
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n── package-vsix.mjs ──────────────────────────────────────────────');
console.log(`  Platform : ${platform}`);
console.log(`  Output   : ${vsixName}`);
console.log('');

createStubs();
patchVscodeignore();

try {
    execSync(
        `npx @vscode/vsce package --target ${platform} --out ${vsixName}`,
        { cwd: ROOT, stdio: 'inherit' },
    );
} finally {
    removeStubs();
    revertVscodeignore();
}
