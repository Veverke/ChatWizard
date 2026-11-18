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
 * PYTHON PREFLIGHT: node-gyp also needs a CPython 3 interpreter, and its own
 * discovery is narrow: --python / PYTHON / NODE_GYP_FORCE_PYTHON, then `py.exe`,
 * then `python3` / `python` on PATH, then
 * %LOCALAPPDATA%\Programs\Python\Python3*. That misses two very common setups:
 *   - a uv-managed interpreter (%APPDATA%\uv\python\cpython-*), which same as
 *     never lives on PATH;
 *   - the Microsoft Store "python.exe" alias in ...\WindowsApps, a stub that
 *     exits with code 9009 ("Python was not found") and shadows a real install
 *     placed later in PATH.
 * Both end in node-gyp's opaque "Could not find any Python installation to use".
 * We therefore resolve the interpreter ourselves (including `uv python find`),
 * export it as PYTHON/npm_config_python for the @electron/rebuild child, and
 * print the remediation when nothing usable exists.
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

const FALLBACK_ELECTRON_VERSION = '43.8.6';
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release');
const BINARY_FILE = path.join(BUILD_DIR, 'better_sqlite3.node');
const MARKER_FILE = path.join(BUILD_DIR, '.rebuild-electron-version');
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const VSWHERE = path.join(PROGRAM_FILES_X86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const WINDOWS_KITS_INCLUDE = path.join(PROGRAM_FILES_X86, 'Windows Kits', '10', 'Include');
const LOCAL_APP_DATA = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
const WINDOWS_APPS_ALIAS_DIR = path.join(LOCAL_APP_DATA, 'Microsoft', 'WindowsApps');
/** Prints `<version>\n<executable>` — enough to validate an interpreter. */
const PYTHON_PROBE = 'import sys; print(sys.version.split()[0]); print(sys.executable)';

function main() {
    // 1. Resolve target Electron version
    const targetVersion = resolveElectronVersion();
    if (!targetVersion) {
        console.error('[rebuild-native] Could not determine Electron version');
        process.exit(1);
    }

    // 2. Check marker file — skip only when the version matches AND the
    //    compiled binary is the one that build produced.
    //
    //    The marker alone is not trustworthy: `npm install` / `npm rebuild` /
    //    a fresh `npm ci` replaces `better_sqlite3.node` with a Node-ABI
    //    prebuild without touching the marker, so a stale marker used to make
    //    this script skip a rebuild that was actually required. That shipped a
    //    Node-ABI binary inside a VSIX and the extension host silently fell
    //    back to the in-memory log store (Commands view showed 0 commands).
    if (isAlreadyBuiltFor(targetVersion)) {
        console.log(`[rebuild-native] already built for Electron ${targetVersion} — skipping`);
        return;
    }

    // 3. Ensure build directory exists
    try { fs.mkdirSync(BUILD_DIR, { recursive: true }); } catch { /* ignore */ }

    // 4. Fail fast (with actionable output) when the Windows toolchain is incomplete
    preflightWindowsToolchain();

    // 5. Prefer the VS-developer-prompt environment over node-gyp's Add-Type
    //    discovery, which endpoint protection can block on locked-down machines.
    ensureVisualStudioEnv();

    // 6. Resolve Python (node-gyp cannot see uv-managed interpreters) and export
    //    it so the forked @electron/rebuild → node-gyp child inherits it.
    ensurePythonForNodeGyp();

    // 7. Patch MSVC headers, then rebuild
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

    // 8. Write marker (version + identity of the binary that was just built)
    writeMarker(targetVersion);
    console.log(`[rebuild-native] Done — built for Electron ${targetVersion}`);
}

/**
 * True when the marker names the target Electron version *and* the compiled
 * binary still matches the one recorded next to it.
 */
function isAlreadyBuiltFor(targetVersion) {
    if (!fs.existsSync(MARKER_FILE) || !fs.existsSync(BINARY_FILE)) { return false; }
    try {
        const raw = fs.readFileSync(MARKER_FILE, 'utf8').trim();
        const stat = fs.statSync(BINARY_FILE);

        // Legacy marker format: a bare Electron version string.
        if (!raw.startsWith('{')) {
            console.log(`[rebuild-native] legacy marker "${raw}" (no binary fingerprint) — rebuilding once to verify`);
            return false;
        }

        const marker = JSON.parse(raw);
        if (marker.electronVersion !== targetVersion) {
            console.log(`[rebuild-native] marker changed: ${marker.electronVersion} → ${targetVersion}`);
            return false;
        }
        if (marker.binaryMtimeMs !== stat.mtimeMs || marker.binarySize !== stat.size) {
            console.log('[rebuild-native] better_sqlite3.node was replaced after the last rebuild ' +
                '(npm install/rebuild?) — rebuilding');
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function writeMarker(electronVersion) {
    try {
        const stat = fs.statSync(BINARY_FILE);
        fs.writeFileSync(MARKER_FILE, JSON.stringify({
            electronVersion,
            binaryMtimeMs: stat.mtimeMs,
            binarySize: stat.size,
            writtenAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    } catch { /* ignore */ }
}

function resolveElectronVersion() {
    const fromEnv = process.env['VSCODE_ELECTRON_VERSION'];
    if (fromEnv) {
        console.log(`[rebuild-native] Electron ${fromEnv} (from VSCODE_ELECTRON_VERSION)`);
        return fromEnv;
    }
    // The running extension records the exact Electron/NODE_MODULE_VERSION of
    // the extension host — the only reliable source for the *installed* VS Code
    // (its package.json no longer ships `electronVersion`).
    const fromHost = queryElectronVersionFromHostRecord();
    if (fromHost) {
        console.log(`[rebuild-native] Electron ${fromHost} (recorded by the running extension host)`);
        return fromHost;
    }
    const fromInstance = queryElectronVersionFromVSCode();
    if (fromInstance) { return fromInstance; }
    console.warn(`[rebuild-native] Using fallback Electron ${FALLBACK_ELECTRON_VERSION}`);
    return FALLBACK_ELECTRON_VERSION;
}

/** Candidate shared cache directories (same resolution as the extension). */
function sharedCacheDirs() {
    const platform = process.platform;
    const dirs = [];
    if (platform === 'win32') {
        const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
        dirs.push(path.join(localAppData, 'ChatWizard'));
    } else if (platform === 'darwin') {
        dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'ChatWizard'));
    } else {
        const xdgData = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
        dirs.push(path.join(xdgData, 'chatwizard'));
    }
    return dirs;
}

/**
 * Electron version recorded by the extension host via `hostRuntimeInfo.ts`.
 * Covers the installed VS Code, Cursor, Insiders, … .
 */
function queryElectronVersionFromHostRecord() {
    for (const dir of sharedCacheDirs()) {
        const file = path.join(dir, 'vscode-host-runtime.json');
        try {
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            const electron = String(record.electron ?? '').trim();
            if (/^\d+\.\d+\.\d+$/.test(electron)) {
                const ageMin = Math.round((Date.now() - Date.parse(record.recordedAt ?? 0)) / 60000);
                console.log(`[rebuild-native] Host record ${file} (VS Code ${record.vscodeVersion}, ` +
                    `NODE_MODULE_VERSION ${record.modules}, recorded ${Number.isFinite(ageMin) ? ageMin + ' min ago' : 'unknown'})`);
                return electron;
            }
        } catch { /* no record yet — try the next candidate */ }
    }
    return null;
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

/**
 * Highest Windows 10/11 SDK version that ships `um\windows.h`, e.g. "10.0.26100.0".
 */
function highestWindowsSdkVersion() {
    const versions = safeReaddir(WINDOWS_KITS_INCLUDE).filter((version) =>
        /^\d+(\.\d+)*$/.test(version) &&
        fs.existsSync(path.join(WINDOWS_KITS_INCLUDE, version, 'um', 'windows.h')));
    versions.sort((a, b) => compareVersions(b, a));
    return versions[0] ?? null;
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) { return diff; }
    }
    return 0;
}

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

// ── Python discovery (node-gyp's own probe is too narrow) ────────────────────

/**
 * Runs `<command> [-3] -c PYTHON_PROBE` and returns `{ version, exe }` when the
 * command is a usable CPython 3, or null.
 *
 * The Microsoft Store app-execution alias (`...\WindowsApps\python.exe`) is a
 * 0-byte stub: it exits with code 9009 ("Python was not found; run without
 * arguments to install from the Microsoft Store") and prints nothing, so both
 * the exit code and the output check reject it.
 */
function probePython(command, prefixArgs = []) {
    try {
        const out = execFileSync(command, [...prefixArgs, '-c', PYTHON_PROBE], {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const [version, reportedExe] = out.trim().split(/\r?\n/);
        if (!version || !reportedExe) { return null; }
        if (!/^3\.\d+\./.test(version.trim())) { return null; }
        const exe = path.resolve(reportedExe.trim());
        if (!fs.existsSync(exe)) { return null; }
        if (exe.toLowerCase().startsWith(WINDOWS_APPS_ALIAS_DIR.toLowerCase() + path.sep)) { return null; }
        return { version: version.trim(), exe };
    } catch {
        return null;
    }
}

/**
 * uv keeps its interpreters in %APPDATA%\uv\python\<implementation>[-<minor>]
 * and does not put them on PATH (`uv python install --default` is what creates
 * the python.exe shim). `uv python find` reports whichever interpreter uv would
 * use — project virtualenv, pinned version, or a managed download.
 */
function probeUvPython() {
    try {
        const exe = execFileSync('uv', ['python', 'find'], {
            encoding: 'utf8',
            timeout: 60_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return exe && fs.existsSync(exe) ? probePython(exe) : null;
    } catch {
        return null; // uv not installed, or no interpreter installed yet
    }
}

/**
 * python.org installers beside the paths node-gyp hard-codes
 * (%LOCALAPPDATA%\Programs\Python\Python3xx, %ProgramFiles%\Python3xx).
 * Directory scan instead of a fixed version list so future majors work too.
 */
function conventionalWindowsPythons() {
    if (process.platform !== 'win32') { return []; }
    const roots = [
        path.join(LOCAL_APP_DATA, 'Programs', 'Python'),
        process.env['ProgramFiles'] ?? 'C:\\Program Files',
        process.env['ProgramW6432'] ?? 'C:\\Program Files',
        PROGRAM_FILES_X86,
    ];
    const hits = [];
    for (const root of roots) {
        for (const entry of safeReaddir(root)) {
            if (!/^python3/i.test(entry)) { continue; }
            const exe = path.join(root, entry, 'python.exe');
            if (fs.existsSync(exe)) { hits.push(exe); }
        }
    }
    return hits;
}

/**
 * Returns `{ version, exe, source }` for the first usable Python 3, or null.
 * Explicit configuration always wins, then PATH, then uv, then install dirs.
 */
function findPython() {
    const explicit = [
        ['CHATWIZARD_PYTHON', process.env['CHATWIZARD_PYTHON']],
        ['NODE_GYP_FORCE_PYTHON', process.env['NODE_GYP_FORCE_PYTHON']],
        ['PYTHON', process.env['PYTHON']],
        ['npm_config_python', process.env['npm_config_python']],
    ];
    for (const [source, exe] of explicit) {
        if (!exe) { continue; }
        const found = probePython(exe);
        if (found) { return { ...found, source }; }
        console.warn(`[rebuild-native] ${source}="${exe}" is not a usable Python 3 — trying other candidates`);
    }

    const onPath = [
        { source: 'python3 on PATH', command: 'python3', args: [] },
        { source: 'python on PATH', command: 'python', args: [] },
        { source: 'py -3 launcher', command: 'py', args: ['-3'] },
    ];
    for (const candidate of onPath) {
        const found = probePython(candidate.command, candidate.args);
        if (found) { return { ...found, source: candidate.source }; }
    }

    const fromUv = probeUvPython();
    if (fromUv) { return { ...fromUv, source: 'uv-managed interpreter' }; }

    for (const exe of conventionalWindowsPythons()) {
        const found = probePython(exe);
        if (found) { return { ...found, source: 'conventional install location' }; }
    }

    return null;
}

/**
 * node-gyp (spawned by @electron/rebuild) inherits our environment, so exporting
 * the interpreter here is enough — no extra CLI plumbing required. Exits with
 * the remediation steps instead of node-gyp's opaque failure.
 *
 * Only PYTHON is exported (not npm_config_python): node-gyp checks it right
 * after --python, while npm_config_python would make npm warn about an unknown
 * env config on every nested npm/npx call.
 */
function ensurePythonForNodeGyp() {
    const python = findPython();
    if (python) {
        process.env['PYTHON'] = python.exe;
        console.log(`[rebuild-native] Python ${python.version} (${python.source}) — ${python.exe}`);
        return;
    }
    printPythonHelp();
    process.exit(1);
}

function printPythonHelp() {
    const win = process.platform === 'win32';
    console.error('');
    console.error('[rebuild-native] node-gyp (used by @electron/rebuild) needs a CPython 3 interpreter —');
    console.error('[rebuild-native] none was found. node-gyp only probes: --python, PYTHON,');
    console.error('[rebuild-native] NODE_GYP_FORCE_PYTHON, the py launcher, "python3"/"python" on PATH,');
    console.error('[rebuild-native] and the conventional install directories.');
    if (win) {
        console.error('[rebuild-native] Two common setups it cannot see:');
        console.error('[rebuild-native]   - a uv-managed interpreter (%APPDATA%\\uv\\python\\cpython-*) — not on PATH;');
        console.error('[rebuild-native]   - the Microsoft Store "python.exe" alias in');
        console.error('[rebuild-native]     %LOCALAPPDATA%\\Microsoft\\WindowsApps — a stub that exits with code 9009');
        console.error('[rebuild-native]     and shadows any real install later in PATH.');
    }
    console.error('[rebuild-native] Fix it with one of:');
    if (win) {
        console.error('[rebuild-native]   1. uv users (recommended):  uv python install --default');
        console.error('[rebuild-native]        adds python.exe to %USERPROFILE%\\.local\\bin, ahead of the Store alias');
        console.error('[rebuild-native]   2. Any interpreter:        setx PYTHON "C:\\Path\\To\\python.exe"   (needs a new shell)');
        console.error('[rebuild-native]   3. This run only:          $env:PYTHON = "C:\\Path\\To\\python.exe"; npm run rebuild:native');
        console.error('[rebuild-native]   4. For npm/node-gyp only:  npm config set python "C:\\Path\\To\\python.exe"');
    } else {
        console.error('[rebuild-native]   1. Install Python 3 (e.g. apt install python3 / brew install python@3.12)');
        console.error('[rebuild-native]   2. Or point at an existing one:  export PYTHON=/path/to/python3');
    }
    console.error('[rebuild-native] This script also honours CHATWIZARD_PYTHON=<path> as an explicit override.');
    console.error('');
}

// ── Visual Studio environment (bypass node-gyp's Add-Type discovery) ─────────

/**
 * node-gyp locates Visual Studio by compiling `Find-VisualStudio.cs` at runtime
 * (`Add-Type`). On locked-down machines that compile is blocked - PowerShell
 * fails with `Error opening response file '...\Temp\xxx\xxx.cmdline' --
 * Access is denied` (endpoint protection / AppLocker denying `.cmdline` files) -
 * so node-gyp reports "Could not find any Visual Studio installation to use"
 * even though the C++ workload and Windows SDK are installed.
 *
 * When VCINSTALLDIR, VSCMD_VER and WindowsSDKVersion are set node-gyp takes the
 * VS-developer-prompt fast path instead and never shells out to PowerShell
 * (`findVSFromSpecifiedLocation`), so we derive those values from vswhere and
 * the installed SDK. Note node-gyp resolves the VS root as
 * `path.resolve(VCINSTALLDIR, '..')`, hence `<VS root>\VC`.
 */
function ensureVisualStudioEnv() {
    if (process.platform !== 'win32') { return; }
    if (process.env['VCINSTALLDIR']) {
        console.log('[rebuild-native] VCINSTALLDIR already set — keeping the existing Visual Studio environment');
        return;
    }

    const requires = '-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
    const vsRoot = vswhere(`${requires} -property installationPath`);
    const msbuild = vsRoot && path.join(vsRoot, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    if (!msbuild || !fs.existsSync(msbuild)) { return; } // let node-gyp do its own discovery

    const vsVersion = vswhere(`${requires} -property installationVersion`);
    const sdkVersion = highestWindowsSdkVersion();

    process.env['VCINSTALLDIR'] = path.join(vsRoot, 'VC');
    if (vsVersion) { process.env['VSCMD_VER'] = vsVersion; }
    if (sdkVersion) { process.env['WindowsSDKVersion'] = `${sdkVersion}\\`; }
    console.log(`[rebuild-native] Visual Studio ${vsVersion || '(version unknown)'} — ${vsRoot}` +
        (sdkVersion ? `, Windows SDK ${sdkVersion}` : ''));
}

main();
