/**
 * scripts/verify-vscode-download.mjs
 *
 * Ensures the VS Code executable downloaded by @vscode/test-electron exists on
 * disk. On macOS runners the .app bundle is sometimes extracted without the
 * Electron binary: `unzip` exits 0, the is-complete marker is written, but
 * Contents/MacOS/Electron is missing (observed consistently on macOS arm64
 * runners with VS Code 1.133.0+).
 *
 * When the binary is missing this script repairs the install itself:
 *   1. Clears the corrupt cache dir
 *   2. Downloads the zip again with curl
 *   3. Extracts it with `ditto -x -k` (Apple's archiver — handles app bundles,
 *      symlinks and permissions correctly, unlike Info-ZIP's `unzip`)
 *   4. Re-verifies and writes the is-complete marker
 *
 * Exit code 0 = executable present, 1 = unrecoverable.
 *
 * Usage:
 *   node scripts/verify-vscode-download.mjs          # stable
 *   VSCODE_VERSION=insiders node scripts/verify-vscode-download.mjs
 */

import { existsSync, rmSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { platform, arch, tmpdir } from 'os';
import { execFileSync } from 'child_process';

const VSCODE_VERSION = process.env['VSCODE_VERSION'] ?? 'stable';
const CACHE_DIR = resolve(process.cwd(), '.vscode-test');
const COMPLETE_FILE_NAME = 'is-complete';
const isInsiders = VSCODE_VERSION === 'insiders';
const isMac = platform() === 'darwin';

function platformDir() {
  const p = platform();
  const a = arch();
  if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin';
  if (p === 'win32') return a === 'arm64' ? 'win32-arm64-archive' : 'win32-x64-archive';
  return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function executablePath(installDir) {
  const p = platform();
  if (p === 'darwin') {
    const appName = isInsiders
      ? 'Visual Studio Code - Insiders.app'
      : 'Visual Studio Code.app';
    return join(installDir, appName, 'Contents', 'MacOS', 'Electron');
  }
  if (p === 'win32') {
    return isInsiders
      ? join(installDir, 'Code - Insiders.exe')
      : join(installDir, 'Code.exe');
  }
  return isInsiders
    ? join(installDir, 'code-insiders')
    : join(installDir, 'code');
}

function findInstallDir() {
  if (!existsSync(CACHE_DIR)) return null;
  const entries = readdirSync(CACHE_DIR);
  const pf = platformDir();
  for (const entry of entries) {
    const full = join(CACHE_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.includes('insiders') !== isInsiders) continue;
    if (entry.startsWith(`vscode-${pf}`)) return full;
  }
  return null;
}

/**
 * Determine the download URL for the version @vscode/test-electron already
 * resolved. For stable, the numeric version is embedded in the dir name
 * (vscode-darwin-arm64-1.133.0). For insiders, we fetch the latest insiders
 * build — the native-module rebuild step runs AFTER this step and reads the
 * Electron version from .vscode-test/, so the ABI always matches.
 */
function downloadUrl(installDir) {
  const pf = platformDir();
  if (isInsiders) {
    return `https://update.code.visualstudio.com/latest/${pf}/insider?released=true`;
  }
  const match = /vscode-[a-z0-9-]+-([0-9]+\.[0-9]+\.[0-9]+)$/.exec(installDir);
  if (!match) {
    throw new Error(`Cannot determine VS Code version from dir name: ${installDir}`);
  }
  return `https://update.code.visualstudio.com/${match[1]}/${pf}/stable?released=true`;
}

function repairWithDitto(installDir) {
  const exe = executablePath(installDir);
  const zipPath = join(tmpdir(), `vscode-test-${Date.now()}.zip`);
  const url = downloadUrl(installDir);

  console.log(`[verify-vscode-download] Repairing install with curl + ditto`);
  console.log(`[verify-vscode-download] Downloading ${url}`);

  try {
    execFileSync('curl', ['-L', '-o', zipPath, url], { stdio: 'inherit' });
  } catch (err) {
    console.error(`[verify-vscode-download] curl failed: ${err}`);
    process.exit(1);
  }

  console.log(`[verify-vscode-download] Clearing corrupt cache at ${installDir}`);
  try {
    rmSync(installDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[verify-vscode-download] Failed to remove ${installDir}: ${err}`);
    process.exit(1);
  }
  mkdirSync(installDir, { recursive: true });

  console.log(`[verify-vscode-download] Extracting with ditto -x -k ...`);
  try {
    // ditto is Apple's archiver: preserves symlinks, permissions and the
    // app-bundle structure that Info-ZIP's unzip mangles on macOS runners.
    execFileSync('ditto', ['-x', '-k', zipPath, installDir], { stdio: 'inherit' });
  } catch (err) {
    console.error(`[verify-vscode-download] ditto extraction failed: ${err}`);
    process.exit(1);
  }

  try {
    rmSync(zipPath, { force: true });
  } catch { /* best effort */ }

  if (existsSync(exe)) {
    writeFileSync(join(installDir, COMPLETE_FILE_NAME), '');
    console.log(`[verify-vscode-download] OK — ${exe} exists after ditto repair`);
    process.exit(0);
  }

  console.error(`[verify-vscode-download] STILL MISSING — ${exe} not found even after ditto repair`);
  process.exit(1);
}

function main() {
  if (!isMac) {
    console.log(`[verify-vscode-download] Platform ${platform()} — no repair needed`);
    process.exit(0);
  }

  const installDir = findInstallDir();
  if (!installDir) {
    console.log(`[verify-vscode-download] No install dir found in ${CACHE_DIR} — nothing to verify`);
    process.exit(0);
  }

  const exe = executablePath(installDir);
  if (existsSync(exe)) {
    console.log(`[verify-vscode-download] OK — ${exe} exists`);
    process.exit(0);
  }

  console.error(`[verify-vscode-download] MISSING — ${exe} not found`);
  repairWithDitto(installDir);
}

main();