/**
 * scripts/rebuild-native.js
 *
 * Rebuilds native Node.js modules (better-sqlite3) for the VS Code Electron ABI.
 *
 * WHY: Host Node.js and VS Code's Electron have different NODE_MODULE_VERSION
 * ABIs. `npm install` compiles for the host Node.js ABI. Tests run inside
 * Electron and need the Electron ABI.
 *
 * DETECTION: Writes a marker file `.rebuild-electron-version` next to the
 * compiled binary. If the marker matches the detected Electron version,
 * rebuild is skipped (~instant, no subprocess).
 *
 * Usage:
 *   node scripts/rebuild-native.js
 *   VSCODE_ELECTRON_VERSION=42.2.0 node scripts/rebuild-native.js
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FALLBACK_ELECTRON_VERSION = '42.2.0';
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release');
const MARKER_FILE = path.join(BUILD_DIR, '.rebuild-electron-version');

function main() {
    // 1. Resolve target Electron version
    const targetVersion = resolveElectronVersion();
    if (!targetVersion) {
        console.error('[rebuild-native] Could not determine Electron version');
        process.exit(1);
    }

    // 2. Check marker file — skip if already correct
    try {
        if (fs.existsSync(MARKER_FILE)) {
            const prev = fs.readFileSync(MARKER_FILE, 'utf8').trim();
            if (prev === targetVersion) {
                console.log(`[rebuild-native] already built for Electron ${targetVersion} — skipping`);
                return;
            }
            console.log(`[rebuild-native] marker changed: ${prev} → ${targetVersion}`);
        }
    } catch { /* ignore */ }

    // 3. Ensure build directory exists
    try { fs.mkdirSync(BUILD_DIR, { recursive: true }); } catch { /* ignore */ }

    // 4. Patch MSVC headers, then rebuild
    patchElectronHeadersForMSVC(targetVersion);
    const cmd = `npx @electron/rebuild --version ${targetVersion} -m "${REPO_ROOT}" -o better-sqlite3`;
    console.log(`[rebuild-native] Building for Electron ${targetVersion}...`);
    execSync(cmd, { stdio: 'inherit', cwd: REPO_ROOT, shell: true });

    // 5. Write marker
    try { fs.writeFileSync(MARKER_FILE, targetVersion, 'utf8'); } catch { /* ignore */ }
    console.log(`[rebuild-native] Done — built for Electron ${targetVersion}`);
}

function resolveElectronVersion() {
    const fromEnv = process.env['VSCODE_ELECTRON_VERSION'];
    if (fromEnv) { return fromEnv; }
    const fromTest = queryElectronVersionFromVSCode();
    if (fromTest) { return fromTest; }
    console.warn(`[rebuild-native] Using fallback Electron ${FALLBACK_ELECTRON_VERSION}`);
    return FALLBACK_ELECTRON_VERSION;
}

function queryElectronVersionFromVSCode() {
    const vscodeTestDir = path.resolve(REPO_ROOT, '.vscode-test');
    if (!fs.existsSync(vscodeTestDir)) { return null; }
    const dirs = safeReaddir(vscodeTestDir).filter(e => {
        try { return fs.statSync(path.join(vscodeTestDir, e)).isDirectory(); } catch { return false; }
    });
    const wantInsiders = (process.env['VSCODE_VERSION'] ?? 'stable') === 'insiders';
    dirs.sort((a, b) => {
        const aI = a.includes('insiders'), bI = b.includes('insiders');
        return wantInsiders ? (aI === bI ? 0 : aI ? -1 : 1) : (aI === bI ? 0 : aI ? 1 : -1);
    });
    for (const dir of dirs) {
        for (const child of safeReaddir(path.join(vscodeTestDir, dir))) {
            const p = path.join(vscodeTestDir, dir, child, 'resources', 'app', 'package.json');
            try {
                if (!fs.existsSync(p)) { continue; }
                const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
                const ver = pkg?.devDependencies?.electron;
                if (ver && /^\d+\.\d+\.\d+$/.test(ver)) {
                    console.log(`[rebuild-native] Detected Electron ${ver}`);
                    return ver;
                }
            } catch { /* ignore */ }
        }
    }
    return null;
}

function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

function patchElectronHeadersForMSVC(version) {
    if (process.platform !== 'win32') { return; }
    const heapHPath = path.join(os.homedir(), '.electron-gyp', version, 'include', 'node', 'cppgc', 'heap.h');
    if (!fs.existsSync(heapHPath)) { return; }
    let content = fs.readFileSync(heapHPath, 'utf8');
    if (content.includes('__builtin_frame_address_workaround') || !content.includes('__builtin_frame_address')) { return; }
    const patch = '\n#if defined(_MSC_VER) && !defined(__builtin_frame_address)\n  #define __builtin_frame_address(level) _AddressOfReturnAddress()\n#endif\n';
    const lines = content.split('\n');
    let idx = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        if (lines[i].startsWith('#define') || (lines[i].trim() === '' && i > 2)) { idx = i + 1; break; }
    }
    lines.splice(idx || 5, 0, patch);
    fs.writeFileSync(heapHPath, lines.join('\n'), 'utf8');
    console.log(`[rebuild-native] Patched ${heapHPath}`);
}

main();