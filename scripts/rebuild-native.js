/**
 * scripts/rebuild-native.js
 *
 * Rebuilds native Node.js modules (better-sqlite3) for the VS Code Electron ABI.
 *
 * Electron version resolution order:
 *   1. VSCODE_ELECTRON_VERSION environment variable
 *   2. Query the downloaded VS Code binary via ELECTRON_RUN_AS_NODE=1 — works
 *      for both stable and insiders because it reads process.versions.electron
 *      from the actual binary rather than the VS Code version string.
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
// VS Code stable release.  Check: https://github.com/microsoft/vscode/blob/main/cgmanifest.json
const FALLBACK_ELECTRON_VERSION = '39.8.8';

// ── Resolve Electron version ─────────────────────────────────────────────────

let electronVersion = process.env['VSCODE_ELECTRON_VERSION'];

if (!electronVersion) {
    electronVersion = queryElectronVersionFromVSCode();
}

if (!electronVersion) {
    console.warn(`[rebuild-native] Could not detect Electron version from VS Code binary; using fallback ${FALLBACK_ELECTRON_VERSION}`);
    electronVersion = FALLBACK_ELECTRON_VERSION;
}

// ── Helper: locate VS Code binary and query it ────────────────────────────────

/**
 * Walk .vscode-test/, find the downloaded VS Code binary, and query it for the
 * real Electron version via `ELECTRON_RUN_AS_NODE=1 <binary> -e "..."`.
 *
 * This is reliable for both stable and insiders because the Electron version
 * comes from the binary itself, not from a version-string file that only
 * contains the VS Code application version.
 *
 * @returns {string|null} Electron version string (e.g. "34.5.1") or null.
 */
function queryElectronVersionFromVSCode() {
    const vscodeTestDir = path.resolve(__dirname, '..', '.vscode-test');
    if (!fs.existsSync(vscodeTestDir)) { return null; }

    let dirs;
    try {
        dirs = fs.readdirSync(vscodeTestDir).filter(e =>
            fs.statSync(path.join(vscodeTestDir, e)).isDirectory()
        );
    } catch { return null; }

    // When VSCODE_VERSION is set (e.g. 'insiders'), sort matching directories
    // first so we don't accidentally rebuild against the wrong Electron ABI when
    // both stable and insiders copies are cached in .vscode-test/.
    const wantInsiders = (process.env['VSCODE_VERSION'] ?? 'stable') === 'insiders';
    dirs.sort((a, b) => {
        const aInsiders = a.includes('insiders');
        const bInsiders = b.includes('insiders');
        if (wantInsiders) { return aInsiders === bInsiders ? 0 : aInsiders ? -1 : 1; }
        return aInsiders === bInsiders ? 0 : aInsiders ? 1 : -1;
    });

    for (const dir of dirs) {
        const bin = findVSCodeBinary(path.join(vscodeTestDir, dir));
        if (!bin) { continue; }

        try {
            const ver = execSync(
                `"${bin}" -e "process.stdout.write(process.versions.electron)"`,
                {
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                    timeout: 15000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }
            ).toString().trim();

            if (/^\d+\.\d+\.\d+$/.test(ver)) {
                console.log(`[rebuild-native] Detected Electron ${ver} from ${bin}`);
                return ver;
            }
        } catch {
            // binary found but failed to execute — try next entry
        }
    }
    return null;
}

/**
 * Given a VS Code installation directory, return the path to the Electron
 * binary suitable for ELECTRON_RUN_AS_NODE=1, or null if not found.
 *
 * @param {string} installDir
 * @returns {string|null}
 */
function findVSCodeBinary(installDir) {
    if (process.platform === 'win32') {
        for (const name of ['Code.exe', 'Code - Insiders.exe']) {
            const p = path.join(installDir, name);
            if (fs.existsSync(p)) { return p; }
        }
    } else if (process.platform === 'darwin') {
        // The ELECTRON_RUN_AS_NODE binary lives inside the .app bundle.
        let apps;
        try { apps = fs.readdirSync(installDir).filter(e => e.endsWith('.app')); }
        catch { apps = []; }
        for (const app of apps) {
            const p = path.join(installDir, app, 'Contents', 'MacOS', 'Electron');
            if (fs.existsSync(p)) { return p; }
        }
    } else {
        // Linux — the binary sits directly in the install directory.
        for (const name of ['code', 'code-insiders', 'code-exploration']) {
            const p = path.join(installDir, name);
            if (fs.existsSync(p)) { return p; }
        }
    }
    return null;
}

// ── Run electron-rebuild ──────────────────────────────────────────────────────

console.log(`[rebuild-native] Rebuilding native modules for Electron ${electronVersion} (${process.platform}/${process.arch})`);

const repoRoot = path.resolve(__dirname, '..');
execSync(
    `npx @electron/rebuild -v ${electronVersion} -m "${repoRoot}"`,
    { stdio: 'inherit', cwd: repoRoot }
);

console.log('[rebuild-native] Done.');
