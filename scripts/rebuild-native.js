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
 *   3. Read from resources/app/product.json (electronVersion field) — the
 *      canonical source in VS Code release archives.
 *   4. Hard-coded fallback constant below (update when VS Code ships a new Electron)
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
const os   = require('os');

// ── Fallback Electron version ────────────────────────────────────────────────
// Keep this in sync with the Electron version shipped in the minimum required
// VS Code stable release.  Check: https://github.com/microsoft/vscode/blob/main/cgmanifest.json
const FALLBACK_ELECTRON_VERSION = '42.2.0';

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
            const p = path.join(app, 'Contents', 'MacOS', 'Electron');
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

// ── Patch Electron headers for MSVC compatibility ────────────────────────────

/**
 * Electron 42's cppgc/heap.h uses __builtin_frame_address() which is a
 * GCC/Clang built-in not available in MSVC.  This function patches the header
 * to provide a MSVC-compatible fallback _before_ node-gyp tries to compile.
 *
 * The Electron headers live under ~/.electron-gyp/<version>/include/node/.
 */
function patchElectronHeadersForMSVC(version) {
    if (process.platform !== 'win32') {
        return; // MSVC is Windows-only; nothing to patch on macOS or Linux.
    }

    const headersDir = path.join(
        os.homedir(),
        '.electron-gyp',
        version,
        'include',
        'node'
    );
    const heapHPath = path.join(headersDir, 'cppgc', 'heap.h');

    if (!fs.existsSync(heapHPath)) {
        console.log(`[rebuild-native] heap.h not found at ${heapHPath} — skipping patch`);
        return;
    }

    // Read the current content and check if it already has the workaround.
    let content = fs.readFileSync(heapHPath, 'utf8');
    if (content.includes('__builtin_frame_address_workaround')) {
        console.log('[rebuild-native] heap.h already patched — skipping');
        return;
    }

    if (!content.includes('__builtin_frame_address')) {
        console.log('[rebuild-native] heap.h does not contain __builtin_frame_address — skipping');
        return;
    }

    // Insert a MSVC compatibility block right after the include guards / top of file.
    // The fix uses _AddressOfReturnAddress() on MSVC, which serves the same purpose
    // as __builtin_frame_address(0) — getting the return address of the current function.
    const patchBlock = `
// ── MSVC compatibility patch (applied by rebuild-native.js) ──────────────────
// __builtin_frame_address is a GCC/Clang built-in not available in MSVC.
// _AddressOfReturnAddress() is the MSVC equivalent for frame address level 0,
// which is the only use case in this header.
#if defined(_MSC_VER) && !defined(__builtin_frame_address)
  #define __builtin_frame_address(level) _AddressOfReturnAddress()
  #pragma message("heap.h: __builtin_frame_address patched via _AddressOfReturnAddress()")
#endif
// ── End of MSVC compatibility patch ──────────────────────────────────────────

`;

    // Insert after the first line (which is typically a comment or include guard).
    const lines = content.split('\n');
    // Find a good insertion point: after the first #define line if it's an include guard,
    // otherwise after the first blank line following the initial block.
    let insertIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        if (lines[i].startsWith('#define') || (lines[i].trim() === '' && i > 2)) {
            insertIdx = i + 1;
            break;
        }
    }
    if (insertIdx === 0) {
        // Fallback: insert after the first few lines.
        insertIdx = Math.min(lines.length, 5);
    }

    lines.splice(insertIdx, 0, patchBlock);
    fs.writeFileSync(heapHPath, lines.join('\n'), 'utf8');
    console.log(`[rebuild-native] Patched ${heapHPath} for MSVC compatibility`);
}

// ── Run electron-rebuild ──────────────────────────────────────────────────────

console.log(`[rebuild-native] Rebuilding native modules for Electron ${electronVersion} (${process.platform}/${process.arch})`);

// Patch Electron headers before rebuilding (fixes MSVC build on Windows CI).
patchElectronHeadersForMSVC(electronVersion);

const repoRoot = path.resolve(__dirname, '..');
execSync(
    `npx @electron/rebuild -v ${electronVersion} -m "${repoRoot}"`,
    { stdio: 'inherit', cwd: repoRoot }
);

console.log('[rebuild-native] Done.');