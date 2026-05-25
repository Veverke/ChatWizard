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
 * Walk .vscode-test/, find the downloaded VS Code installation, and read the
 * Electron version from resources/app/package.json.  Falls back to querying
 * the binary with ELECTRON_RUN_AS_NODE=1 if the file is not found.
 *
 * @returns {string|null} Electron version string (e.g. "39.8.8") or null.
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
        const installDir = path.join(vscodeTestDir, dir);

        // Fast path: read the Electron version from the VS Code package.json.
        // This avoids executing the binary (which can fail on headless Linux CI
        // due to sandbox restrictions).
        const fromPkg = readElectronVersionFromInstallDir(installDir);
        if (fromPkg) { return fromPkg; }

        // Slow path: run the binary with ELECTRON_RUN_AS_NODE=1.
        const bin = findVSCodeBinary(installDir);
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
 * Read the Electron version from `resources/app/package.json` inside a VS Code
 * installation directory, without executing the binary.
 *
 * On Windows archive builds the layout has an extra hash sub-directory:
 *   <installDir>/<hash>/resources/app/package.json
 * On macOS and Linux the layout is flat:
 *   <installDir>/resources/app/package.json
 *
 * VS Code's internal package.json stores the Electron version in devDependencies.
 *
 * @param {string} installDir
 * @returns {string|null} Electron version string (e.g. "39.8.8") or null.
 */
function readElectronVersionFromInstallDir(installDir) {
    const candidates = [
        path.join(installDir, 'resources', 'app', 'package.json'),
    ];
    // Windows archive builds add a hash sub-directory; probe each direct child.
    try {
        for (const child of fs.readdirSync(installDir)) {
            candidates.push(path.join(installDir, child, 'resources', 'app', 'package.json'));
        }
    } catch { /* ignore */ }

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) { continue; }
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            const ver = pkg?.devDependencies?.electron;
            if (ver && /^\d+\.\d+\.\d+$/.test(ver)) {
                console.log(`[rebuild-native] Detected Electron ${ver} from ${candidate}`);
                return ver;
            }
        } catch { /* ignore */ }
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
