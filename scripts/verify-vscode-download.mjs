/**
 * scripts/verify-vscode-download.mjs
 *
 * Verifies that the VS Code executable downloaded by @vscode/test-electron
 * actually exists on disk. On macOS arm64 runners the .app bundle is sometimes
 * extracted without the Electron binary (the is-complete marker is written
 * but Contents/MacOS/Electron is missing).
 *
 * If the binary is missing, the cache is cleared so the next download call
 * will re-download and re-extract.
 *
 * Usage:
 *   node scripts/verify-vscode-download.mjs          # checks stable
 *   VSCODE_VERSION=insiders node scripts/verify-vscode-download.mjs
 */

import { existsSync, rmSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { platform, arch } from 'os';

const VSCODE_VERSION = process.env['VSCODE_VERSION'] ?? 'stable';
const CACHE_DIR = resolve(process.cwd(), '.vscode-test');

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
    const appName = installDir.includes('insiders')
      ? 'Visual Studio Code - Insiders.app'
      : 'Visual Studio Code.app';
    return join(installDir, appName, 'Contents', 'MacOS', 'Electron');
  }
  if (p === 'win32') {
    return installDir.includes('insiders')
      ? join(installDir, 'Code - Insiders.exe')
      : join(installDir, 'Code.exe');
  }
  return installDir.includes('insiders')
    ? join(installDir, 'code-insiders')
    : join(installDir, 'code');
}

function findInstallDir() {
  if (!existsSync(CACHE_DIR)) return null;
  const entries = readdirSync(CACHE_DIR);
  const pf = platformDir();
  const isInsiders = VSCODE_VERSION === 'insiders';
  for (const entry of entries) {
    const full = join(CACHE_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    const hasInsiders = entry.includes('insiders');
    if (hasInsiders !== isInsiders) continue;
    if (entry.startsWith(`vscode-${pf}`)) return full;
  }
  return null;
}

function main() {
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
  console.error(`[verify-vscode-download] Clearing cache at ${installDir} and is-complete marker`);

  try {
    rmSync(installDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[verify-vscode-download] Failed to remove ${installDir}: ${err}`);
    process.exit(1);
  }

  console.error(`[verify-vscode-download] Cache cleared — next download will re-fetch VS Code`);
  process.exit(1);
}

main();