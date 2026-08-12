/**
 * scripts/verify-vscode-download.mjs
 *
 * Ensures the VS Code executable downloaded by @vscode/test-electron exists on
 * disk. On macOS runners the .app bundle is sometimes extracted without the
 * Electron binary: `unzip` exits 0, the is-complete marker is written, but
 * Contents/MacOS/Electron is missing.
 *
 * When the binary is missing this script delegates to
 * scripts/repair-macos-vscode.py which uses Python's zipfile module (preserves
 * symlinks and the .app bundle structure that Info-ZIP's unzip mangles).
 *
 * Exit code 0 = executable present, 1 = unrecoverable.
 *
 * Usage:
 *   node scripts/verify-vscode-download.mjs          # stable
 *   VSCODE_VERSION=insiders node scripts/verify-vscode-download.mjs
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VSCODE_VERSION = process.env['VSCODE_VERSION'] ?? 'stable';
const CACHE_DIR = resolve(process.cwd(), '.vscode-test');
const isInsiders = VSCODE_VERSION === 'insiders';
const isMac = platform() === 'darwin';

function platformDir() {
  const p = platform();
  const a = process.arch;
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
 * build - the native-module rebuild step runs AFTER this step and reads the
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

function main() {
  if (!isMac) {
    console.log(`[verify] Platform ${platform()} - no repair needed`);
    process.exit(0);
  }

  const installDir = findInstallDir();
  if (!installDir) {
    console.log(`[verify] No install dir found in ${CACHE_DIR} - nothing to verify`);
    process.exit(0);
  }

  const exe = executablePath(installDir);
  if (existsSync(exe)) {
    console.log(`[verify] OK - ${exe} exists`);
    process.exit(0);
  }

  // VS Code 1.133+ renamed the macOS binary from Electron → Code.
  // If the Code binary exists, create a symlink Electron → Code.
  const codeExe = exe.replace(/\/Electron$/, '/Code');
  if (existsSync(codeExe)) {
    console.log(`[verify] Electron binary missing, but Code binary found — creating symlink`);
    try {
      execFileSync('ln', ['-s', 'Code', exe], { stdio: 'inherit' });
      if (existsSync(exe)) {
        console.log(`[verify] OK - symlink ${exe} → Code created`);
        process.exit(0);
      }
    } catch {
      console.error(`[verify] Failed to create symlink`);
    }
  }

  console.error(`[verify] MISSING - ${exe} not found`);
  console.error(`[verify] Delegating to repair-macos-vscode.py ...`);

  const url = downloadUrl(installDir);
  const pyScript = join(__dirname, 'repair-macos-vscode.py');
  try {
    execFileSync('python3', [pyScript, installDir, url], { stdio: 'inherit' });
    process.exit(0);
  } catch (err) {
    console.error(`[verify] Repair script failed`);
    process.exit(1);
  }
}

main();