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
 * WINDOWS PREFLIGHT: node-gyp needs a VS installation that ships BOTH the MSVC
 * toolset and a Windows SDK registered as a VS component (a standalone SDK
 * download does not satisfy it). When either is missing node-gyp only reports
 * "Could not find any Visual Studio installation to use", so we check up front
 * and print the exact remediation instead.
 *
 * Usage:
 *   node scripts/rebuild-native.js
 *   VSCODE_ELECTRON_VERSION=42.2.0 node scripts/rebuild-native.js
 */

'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FALLBACK_ELECTRON_VERSION = '42.2.0';
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release');
const MARKER_FILE = path.join(BUILD_DIR, '.rebuild-electron-version');
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const VSWHERE = path.join(PROGRAM_FILES_X86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const WINDOWS_KITS_INCLUDE = path.join(PROGRAM_FILES_X86, 'Windows Kits', '10', 'Include');

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

    // 4. Fail fast (with actionable output) when the Windows toolchain is incomplete
    preflightWindowsToolchain();

    // 5. Patch MSVC headers, then rebuild
    patchElectronHeadersForMSVC(targetVersion);
    const cmd = `npx @electron/rebuild --version ${targetVersion} -m "${REPO_ROOT}" -o better-sqlite3`;
    console.log(`[rebuild-native] Building for Electron ${targetVersion}...`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd: REPO_ROOT, shell: true });
    } catch (err) {
        // The preflight passed but node-gyp still refused — still surface the fix.
        printWindowsToolchainHelp([]);
        throw err;
    }

    // 6. Write marker
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
        const installDir = path.join(vscodeTestDir, dir);
        const candidates = [installDir];

        // Windows archive builds may put the actual installation below a
        // commit-hash directory.  Probe those direct children as well.
        for (const child of safeReaddir(installDir)) {
            const childPath = path.join(installDir, child);
            try {
                if (fs.statSync(childPath).isDirectory()) {
                    candidates.push(childPath);
                }
            } catch { /* ignore inaccessible entries */ }
        }

        for (const candidate of candidates) {
            const bin = findVSCodeBinary(candidate);
            if (!bin) { continue; }

            try {
                // Query the binary itself instead of deriving Electron's
                // version from the VS Code release number.  The mapping is
                // not stable, and stale mappings produce ABI mismatches.
                const ver = execFileSync(
                    bin,
                    ['-e', 'process.stdout.write(process.versions.electron)'],
                    {
                        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                        timeout: 15_000,
                        windowsHide: true,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    }
                ).toString().trim();

                if (/^\d+\.\d+\.\d+$/.test(ver)) {
                    console.log(`[rebuild-native] Detected Electron ${ver} from ${bin}`);
                    return ver;
                }
            } catch {
                // A downloaded binary may not start in a headless environment;
                // try the next cached installation before using the fallback.
            }
        }
    }
    return null;
}

function findVSCodeBinary(installDir) {
    let names;
    if (process.platform === 'win32') {
        names = ['Code.exe', 'Code - Insiders.exe'];
    } else if (process.platform === 'darwin') {
        return safeReaddir(installDir)
            .filter(entry => entry.endsWith('.app'))
            .map(app => path.join(installDir, app, 'Contents', 'MacOS', 'Electron'))
            .find(fs.existsSync) ?? null;
    } else {
        names = ['code', 'code-insiders', 'code-exploration'];
    }

    return names.map(name => path.join(installDir, name)).find(fs.existsSync) ?? null;
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

function vswhere(args) {
    if (!fs.existsSync(VSWHERE)) { return ''; }
    try {
        return execSync(`"${VSWHERE}" ${args}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch { return ''; }
}

function hasVisualStudioCppTools() {
    return vswhere('-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath') !== '';
}

function hasWindowsSdk() {
    return safeReaddir(WINDOWS_KITS_INCLUDE).some(
        (version) => fs.existsSync(path.join(WINDOWS_KITS_INCLUDE, version, 'um', 'windows.h')));
}

/**
 * Returns the list of missing Windows build prerequisites (empty when complete).
 */
function windowsToolchainProblems() {
    const problems = [];
    if (!hasVisualStudioCppTools()) {
        problems.push('Visual Studio with the "Desktop development with C++" workload (MSVC toolset + MSBuild)');
    }
    if (!hasWindowsSdk()) {
        problems.push('Windows 10/11 SDK, installed as a Visual Studio component (a standalone SDK is not detected)');
    }
    return problems;
}

/**
 * Exits with an actionable message instead of node-gyp's generic
 * "Could not find any Visual Studio installation to use".
 * No-op on non-Windows platforms.
 */
function preflightWindowsToolchain() {
    if (process.platform !== 'win32') { return; }
    const problems = windowsToolchainProblems();
    if (problems.length === 0) { return; }
    printWindowsToolchainHelp(problems);
    process.exit(1);
}

function printWindowsToolchainHelp(problems) {
    if (process.platform !== 'win32') { return; }
    const missing = problems && problems.length ? problems : windowsToolchainProblems();
    if (missing.length === 0) { return; }

    const vsInstall = vswhere('-latest -products * -property installationPath');
    const setupExe = path.join(path.dirname(VSWHERE), 'setup.exe');

    console.error('');
    console.error('[rebuild-native] Cannot compile better-sqlite3 — the Windows C++ toolchain is incomplete:');
    for (const problem of missing) {
        console.error(`[rebuild-native]   - missing: ${problem}`);
    }
    console.error('[rebuild-native] Fix it with either:');
    console.error('[rebuild-native]   1. Visual Studio Installer -> Modify -> check "Desktop development with C++" (includes the Windows SDK)');
    if (vsInstall) {
        console.error('[rebuild-native]   2. Elevated PowerShell:');
        console.error(`[rebuild-native]        & "${setupExe}" modify --installPath "${vsInstall}" --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --quiet --norestart`);
    }
    console.error('[rebuild-native] Then re-run: npm run rebuild:native');
    console.error('');
}

main();
