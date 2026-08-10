#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the ChatWizard VSIX and installs it into VS Code or Cursor.

.DESCRIPTION
  Steps:
    1. Runs `npm run package:vsix:<Platform>` — i.e. rebuild:native → bundle →
       scripts/package-vsix.mjs — producing an up-to-date platform VSIX.
    2. Installs that VSIX into the chosen IDE (vscode or cursor) with --force.
    3. Prints instructions to reload the window.

.PARAMETER Target
  Which IDE to install into: 'vscode' (default) or 'cursor'.

.PARAMETER Platform
  esbuild/vsce platform to package. Defaults to win32-x64.

.EXAMPLE
  .\scripts\build-and-install.ps1
  .\scripts\build-and-install.ps1 -Target cursor
  .\scripts\build-and-install.ps1 -Target vscode -Platform linux-x64
#>
param(
    [ValidateSet('vscode', 'cursor')]
    [string]$Target = 'vscode',

    [ValidateSet('win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64')]
    [string]$Platform = 'win32-x64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$vsix = "chatwizard-$Platform.vsix"
$vsixFull = Join-Path $root $vsix

# ── 1. Build + package VSIX (rebuild:native → bundle → package-vsix.mjs) ─────
Write-Host "`n[1/2] Building and packaging VSIX via 'npm run package:vsix:$Platform'..." -ForegroundColor Cyan
npm run "package:vsix:$Platform"
if ($LASTEXITCODE -ne 0) { throw "package:vsix:$Platform failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $vsixFull)) { throw "Expected VSIX not found: $vsixFull" }

# ── 2. Sanity check that the built bundle contains the context-key logic ─────
Write-Host "[2/2] Installing into $Target..." -ForegroundColor Cyan
$js = Join-Path $root 'dist\extension.js'
if (Test-Path $js) {
    $hit = Select-String -Path $js -Pattern 'chatwizard:isVSCode' -Quiet
    if (-not $hit) {
        Write-Warning "dist\extension.js does not contain 'chatwizard:isVSCode' - the bundle may be stale."
    }
}

# ── Install ──────────────────────────────────────────────────────────────────
switch ($Target) {
    'vscode' {
        code --install-extension $vsixFull --force
        if ($LASTEXITCODE -ne 0) { throw "VS Code install failed (exit $LASTEXITCODE)." }
        $reloadCmd = 'Ctrl+Shift+P  ->  "Developer: Reload Window"'
    }
    'cursor' {
        $cursorCli = Get-Command cursor.cmd -ErrorAction SilentlyContinue
        if (-not $cursorCli) { throw "cursor.cmd not found on PATH. Install Cursor's CLI first." }
        & $cursorCli.Source --install-extension $vsixFull --force
        if ($LASTEXITCODE -ne 0) { throw "Cursor install failed (exit $LASTEXITCODE)." }
        $reloadCmd = 'Ctrl+Shift+P  ->  "Developer: Reload Window" (within Cursor)'
    }
}

Write-Host "`n✅ Installed into $Target." -ForegroundColor Green
Write-Host "All that's left: $reloadCmd" -ForegroundColor Yellow