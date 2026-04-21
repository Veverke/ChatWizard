/**
 * scripts/rebuild-native.js
 *
 * Rebuilds native Node.js modules (better-sqlite3) for the VS Code Electron ABI.
 *
 * Electron version resolution order:
 *   1. VSCODE_ELECTRON_VERSION environment variable
 *   2. The `version` file written by @vscode/test-electron under .vscode-test/
 *   3. Hard-coded fallback constant below (update when VS Code ships a new Electron)
 *
 * This script must run on the target OS because better-sqlite3 compiles
 * a platform-specific native binary.  Do NOT cross-compile.
 *
 * Usage:
 *   node scripts/rebuild-native.js
 *   VSCODE_ELECTRON_VERSION=39.8.0 node scripts/rebuild-native.js
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Fallback Electron version ────────────────────────────────────────────────
// Keep this in sync with the Electron version shipped in the minimum required
// VS Code release.  Check: https://github.com/microsoft/vscode/blob/main/version
const FALLBACK_ELECTRON_VERSION = '39.8.8';

// ── Resolve Electron version ─────────────────────────────────────────────────

let electronVersion = process.env['VSCODE_ELECTRON_VERSION'];

if (!electronVersion) {
    // Try to read from a .vscode-test download (populated by `npm test`)
    const vscodeTestDir = path.resolve(__dirname, '..', '.vscode-test');
    try {
        const entries = fs.readdirSync(vscodeTestDir);
        for (const entry of entries) {
            // Each entry is either a version archive dir or an extracted dir.
            // Walk one level deep looking for a `version` file.
            for (const subEntry of [entry, path.join(entry, fs.readdirSync(path.join(vscodeTestDir, entry)).find(e => !e.includes('.')) || '')]) {
                const candidate = path.join(vscodeTestDir, subEntry, 'version');
                if (fs.existsSync(candidate)) {
                    const v = fs.readFileSync(candidate, 'utf8').trim();
                    if (/^\d+\.\d+\.\d+$/.test(v)) {
                        electronVersion = v;
                        break;
                    }
                }
            }
            if (electronVersion) { break; }
        }
    } catch {
        // .vscode-test does not exist (CI/CD fresh environment) — use fallback.
    }
}

if (!electronVersion) {
    electronVersion = FALLBACK_ELECTRON_VERSION;
}

// ── Run electron-rebuild ──────────────────────────────────────────────────────

console.log(`[rebuild-native] Rebuilding native modules for Electron ${electronVersion} (${process.platform}/${process.arch})`);

const repoRoot = path.resolve(__dirname, '..');
execSync(
    `npx @electron/rebuild -v ${electronVersion} -m "${repoRoot}"`,
    { stdio: 'inherit', cwd: repoRoot }
);

console.log('[rebuild-native] Done.');
