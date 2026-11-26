#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the ChatWizard VSIX, uninstalls the current installation, purges every
  local ChatWizard file/cache, and installs the fresh build into VS Code or Cursor.

.DESCRIPTION
  Steps:
    1. Runs `npm run package:vsix:<Platform>` -- i.e. rebuild:native -> bundle ->
       scripts/package-vsix.mjs -- producing an up-to-date platform VSIX.
    2. Uninstalls the currently installed `veverke.chatwizard` from the target IDE
       (a no-op when it is not installed).
    3. Purges local ChatWizard data/caches via scripts/clean-local-data.ps1:
       the extension's globalStorage folder (chatwizard-kb.json classification
       data, the downloaded Xenova/all-MiniLM-L6-v2 model, archive, telemetry,
       sidecar metadata, folder trees, MCP token, cloud-sync key/state), the
       per-workspace semantic embeddings, cached VSIX copies and the shared
       SQLite cache (chatwizard-cache.db, chatwizard-log-events.db,
       vscode-host-runtime.json, original-conversations).
    4. Installs that VSIX into the chosen IDE with --force.
    5. Prints instructions to reload the window.

  NOTE: files held open by a running IDE cannot be deleted on Windows. Close every
  window of the target IDE for a complete purge; when a path stays locked this
  script warns, finishes the install anyway, and asks you to run
  `npm run clean:data:<target>` afterwards.

.PARAMETER Target
  Which IDE to install into: 'vscode' (default) or 'cursor'.

.PARAMETER Platform
  esbuild/vsce platform to package. Defaults to win32-x64.

.PARAMETER KeepData
  Do not purge local data/caches (plain overwrite install).

.PARAMETER KeepSharedCache
  Purge the extension's own data but keep the cross-IDE shared cache
  (%LOCALAPPDATA%\ChatWizard) with its SQLite databases.

.PARAMETER SkipUninstall
  Do not uninstall the currently installed version first.

.EXAMPLE
  .\scripts\build-and-install.ps1
  .\scripts\build-and-install.ps1 -Target cursor
  .\scripts\build-and-install.ps1 -Target vscode -Platform linux-x64
  .\scripts\build-and-install.ps1 -KeepSharedCache
#>
param(
    [ValidateSet('vscode', 'cursor')]
    [string]$Target = 'vscode',

    [ValidateSet('win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64')]
    [string]$Platform = 'win32-x64',

    [switch]$KeepData,

    [switch]$KeepSharedCache,

    [switch]$SkipUninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$extensionId = 'veverke.chatwizard'
$vsix = "chatwizard-$Platform.vsix"
$vsixFull = Join-Path $root $vsix

function Resolve-IdeCli {
    param([string]$Ide)

    $names = if ($Ide -eq 'cursor') {
        @('cursor.cmd', 'cursor.exe', 'cursor')
    } else {
        @('code.cmd', 'code.exe', 'code')
    }
    foreach ($name in $names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd }
    }
    return $null
}

<#
  Runs an IDE CLI command in a background job and waits at most $TimeoutSeconds.
  The VS Code / Cursor CLI can block for a long time (it talks to the running
  window over IPC - `--list-extensions` was observed to hang indefinitely), so a
  timeout turns a possible hang into a warning instead of a wedged terminal.
  Returns @{ ExitCode; Output; TimedOut }.
#>
function Invoke-IdeCli {
    param(
        [string]$Exe,
        [string[]]$CliArgs,
        [int]$TimeoutSeconds = 300
    )

    $job = Start-Job -ScriptBlock {
        param($command, $arguments)
        # ErrorRecords from stderr are flattened so the text survives Receive-Job.
        $output = (& $command @arguments 2>&1 | ForEach-Object { $_.ToString() }) -join "`n"
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } -ArgumentList $Exe, (, $CliArgs)

    $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $finished) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ ExitCode = $null; Output = ''; TimedOut = $true }
    }

    $result = Receive-Job -Job $job
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = $result.ExitCode; Output = $result.Output; TimedOut = $false }
}

<# Prints the meaningful lines of a CLI result, indented under the current step. #>
function Show-CliOutput {
    param([string]$Output)

    if (-not $Output) { return }
    $lines = @($Output -split "`r?`n" |
        Where-Object { $_.Trim().Length -gt 0 } |
        Where-Object { $_ -notmatch 'DeprecationWarning|trace-deprecation|DEP\d{4}' })
    foreach ($line in ($lines | Select-Object -First 12)) {
        Write-Host ('      ' + $line.Trim()) -ForegroundColor DarkGray
    }
}

$cliName = if ($Target -eq 'cursor') { 'cursor' } else { 'code' }
$cli = Resolve-IdeCli -Ide $Target
if (-not $cli) {
    throw ("'{0}' was not found on PATH - install the '{0}' shell command of {1} first." -f $cliName, $Target)
}

# -- 1. Build + package VSIX (rebuild:native -> bundle -> package-vsix.mjs) ---
Write-Host "`n[1/4] Building and packaging VSIX via 'npm run package:vsix:$Platform'..." -ForegroundColor Cyan
npm run "package:vsix:$Platform"
if ($LASTEXITCODE -ne 0) { throw "package:vsix:$Platform failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $vsixFull)) { throw "Expected VSIX not found: $vsixFull" }

# -- 2. Uninstall the current installation ------------------------------------
if ($SkipUninstall) {
    Write-Host '[2/4] Uninstall skipped (-SkipUninstall).' -ForegroundColor Yellow
} else {
    Write-Host "[2/4] Uninstalling the current $extensionId from $Target..." -ForegroundColor Cyan
    $uninstall = Invoke-IdeCli -Exe $cli.Source -CliArgs @('--uninstall-extension', $extensionId) -TimeoutSeconds 180
    Show-CliOutput -Output $uninstall.Output
    if ($uninstall.TimedOut) {
        Write-Warning "The $Target CLI did not answer within 180s - continuing; the install below overwrites the files anyway."
    } elseif ($uninstall.ExitCode -ne 0) {
        Write-Warning ("Uninstall reported exit {0} (not installed, or the IDE refused to remove it) - continuing." -f $uninstall.ExitCode)
    }
}

# -- 3. Purge local data and caches -------------------------------------------
if ($KeepData) {
    Write-Host '[3/4] Local data purge skipped (-KeepData).' -ForegroundColor Yellow
} else {
    Write-Host '[3/4] Purging local ChatWizard data and caches...' -ForegroundColor Cyan
    $cleanScript = Join-Path $PSScriptRoot 'clean-local-data.ps1'
    $cleanArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cleanScript, '-Target', $Target)
    if ($KeepSharedCache) { $cleanArgs += '-KeepSharedCache' }
    & powershell.exe @cleanArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Warning ("Local data cleanup could not delete every path (exit {0}). Close all {1} windows and run 'npm run clean:data:{1}' to finish the purge." -f $LASTEXITCODE, $Target)
    }
}

# -- 4. Install ---------------------------------------------------------------
Write-Host "[4/4] Installing into $Target..." -ForegroundColor Cyan
$js = Join-Path $root 'dist\extension.js'
if (Test-Path $js) {
    $hit = Select-String -Path $js -Pattern 'chatwizard:isVSCode' -Quiet
    if (-not $hit) {
        Write-Warning "dist/extension.js does not contain 'chatwizard:isVSCode' - the bundle may be stale."
    }
}

$install = Invoke-IdeCli -Exe $cli.Source -CliArgs @('--install-extension', $vsixFull, '--force') -TimeoutSeconds 600
Show-CliOutput -Output $install.Output
if ($install.TimedOut) {
    throw "The $Target CLI did not answer within 600s while installing. Open $Target once, then re-run this script (or run '$cliName --install-extension $vsix' manually)."
}
if ($install.ExitCode -ne 0) { throw "$Target install failed (exit $($install.ExitCode))." }

$reloadCmd = if ($Target -eq 'cursor') {
    'Ctrl+Shift+P  ->  "Developer: Reload Window" (within Cursor)'
} else {
    'Ctrl+Shift+P  ->  "Developer: Reload Window"'
}

Write-Host "`nInstalled into $Target." -ForegroundColor Green
Write-Host "All that's left: $reloadCmd" -ForegroundColor Yellow


