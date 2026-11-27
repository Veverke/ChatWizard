<#
.SYNOPSIS
  Deletes every local ChatWizard artefact for one IDE: extension data, the
  downloaded AI model, per-workspace caches and the shared SQLite databases.

.DESCRIPTION
  Removes (best effort, with retries):

  Per IDE (VS Code or Cursor)
    <userData>/User/globalStorage/veverke.chatwizard/       (whole folder)
        chatwizard-kb.json                 knowledge-base classification data
        chatwizard-classification.json     shared topic classification
        chatwizard-metadata.json           pins, custom titles, tags, notes, ratings
        chatwizard-folders.json            user folder tree
        chatwizard-auto-folders.json       automatic (context) folder tree
        chatwizard-auto-classify.json      state of the last automatic run
        telemetry.jsonl                    local telemetry log
        mcp-token.txt                      token for the local MCP/REST server
        cloud-sync-key.bin / -state.json   cloud-sync key + sync state
        archive/                           archived sessions (only copy of some chats)
        models/                            Xenova/all-MiniLM-L6-v2 model download,
                                           ready/failure markers and sentinel
    <userData>/User/workspaceStorage/<hash>/veverke.chatwizard/
        semantic-embeddings.bin            per-workspace semantic index
    <userData>/CachedExtensionVSIXs/veverke.chatwizard-*.vsix
        the IDE's cached copy of an already installed VSIX
    <extensions>/veverke.chatwizard-<version>/
        only when the uninstall left the folder behind

  Shared across IDEs (skip with -KeepSharedCache)
    <shared cache dir>  (Windows: %LOCALAPPDATA%\ChatWizard)
        chatwizard-cache.db (+ -wal / -shm)    sessions, messages, bookmarks,
                                              removed turns, original transcripts
        chatwizard-log-events.db (+ -wal/-shm) normalised agent logs
        vscode-host-runtime.json              KEPT - the Electron / ABI record that
                                              scripts/rebuild-native.js reads, so the
                                              next build still targets the installed IDE
        original-conversations/               exported full transcripts
        A custom `chatwizard.sharedCacheDir` from the IDE's User/settings.json is
        honoured as well as the default path.

  Files held open by a running IDE cannot be deleted on Windows. The script warns
  up front; a path that stays locked is reported at the end and the exit code is
  4, so the caller can ask the user to close the IDE and re-run.

.PARAMETER Target
  Which IDE's data to clean: 'vscode' (default) or 'cursor'.

.PARAMETER KeepExtensionData
  Keep the per-IDE extension data (globalStorage, workspaceStorage, cached VSIX
  and a leftover extension folder) and only clean the shared cache.

.PARAMETER KeepSharedCache
  Keep the cross-IDE shared cache directory (the SQLite databases). Use this when
  you want a clean extension install without losing bookmarks/tags of other IDEs.

.PARAMETER DryRun
  Report what would be deleted (and how much space it occupies) without deleting.

.EXAMPLE
  .\scripts\clean-local-data.ps1
  .\scripts\clean-local-data.ps1 -Target cursor
  .\scripts\clean-local-data.ps1 -DryRun
  .\scripts\clean-local-data.ps1 -KeepSharedCache

.NOTES
  VS Code's own `state.vscdb` (globalState: model-download consent, KB category
  cache, UI preferences) belongs to the IDE, not to this extension, and is left
  untouched: it is shared with every other extension.
#>
param(
    [ValidateSet('vscode', 'cursor')]
    [string]$Target = 'vscode',

    [switch]$KeepExtensionData,

    [switch]$KeepSharedCache,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ExtensionId = 'veverke.chatwizard'
$IsWindowsHost = ($env:OS -eq 'Windows_NT')

$script:Failures = New-Object System.Collections.ArrayList
$script:FreedBytes = [int64]0
$script:RemovedCount = 0

# -- Helpers -----------------------------------------------------------------

function Test-IsMacOS {
    try {
        return [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
            [System.Runtime.InteropServices.OSPlatform]::OSX)
    } catch {
        return $false
    }
}

function Get-IdeLocations {
    param([string]$Ide)

    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $folderName = if ($Ide -eq 'cursor') { 'Cursor' } else { 'Code' }
    $extRoot = if ($Ide -eq 'cursor') { '.cursor' } else { '.vscode' }
    $displayName = if ($Ide -eq 'cursor') { 'Cursor' } else { 'VS Code' }
    $processes = if ($Ide -eq 'cursor') { @('Cursor') } else { @('Code', 'Code - Insiders') }

    if ($IsWindowsHost) {
        $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $homeDir 'AppData\Roaming' }
        $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $homeDir 'AppData\Local' }
        $userData = Join-Path $appData $folderName
        $extensions = Join-Path $homeDir (Join-Path $extRoot 'extensions')
        $sharedCache = Join-Path $localAppData 'ChatWizard'
    } elseif (Test-IsMacOS) {
        $userData = Join-Path $homeDir ('Library/Application Support/' + $folderName)
        $extensions = Join-Path $homeDir (Join-Path $extRoot 'extensions')
        $sharedCache = Join-Path $homeDir 'Library/Application Support/ChatWizard'
    } else {
        $userData = Join-Path $homeDir (Join-Path '.config' $folderName)
        $extensions = Join-Path $homeDir (Join-Path $extRoot 'extensions')
        $sharedCache = Join-Path $homeDir (Join-Path '.local/share' 'chatwizard')
    }

    return [pscustomobject]@{
        DisplayName = $displayName
        Processes = $processes
        UserData = $userData
        Extensions = $extensions
        SharedCache = $sharedCache
        Settings = Join-Path $userData (Join-Path 'User' 'settings.json')
    }
}

<#
  Reads `chatwizard.sharedCacheDir` out of the IDE's User/settings.json.
  The file is JSONC (comments, trailing commas), so only that one value is
  extracted instead of parsing the whole document. Returns $null when the
  setting is absent or empty (i.e. the platform default applies).
#>
function Get-ConfiguredSharedCacheDir {
    param([string]$SettingsPath)

    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $SettingsPath -Raw -ErrorAction Stop
    } catch {
        return $null
    }
    if (-not $raw) { return $null }

    $match = [regex]::Match($raw, '"chatwizard\.sharedCacheDir"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $match.Success) { return $null }

    $value = $match.Groups[1].Value
    $value = $value -replace '\\\\', '\'
    $value = $value -replace '\\"', '"'
    $value = [Environment]::ExpandEnvironmentVariables($value).Trim()
    if (-not $value) { return $null }
    return $value
}

function Get-PathSize {
    param([string]$Path)

    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            return [int64](Get-Item -LiteralPath $Path -Force).Length
        }
        $sum = (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { return [int64]0 }
        return [int64]$sum
    } catch {
        return [int64]0
    }
}

function Format-Size {
    param([int64]$Bytes)

    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return ('{0} B' -f $Bytes)
}

<#
  Deletes a file or a directory tree. Retries briefly so a just-exited IDE can
  release its locks; a path that still refuses is collected in $script:Failures.
#>
function Remove-ChatWizardPath {
    param(
        [string]$Path,
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host ('   - {0}: not present' -f $Label) -ForegroundColor DarkGray
        return
    }

    $size = Get-PathSize $Path

    if ($DryRun) {
        Write-Host ('   - {0}: would delete {1} ({2})' -f $Label, $Path, (Format-Size $size)) -ForegroundColor Yellow
        $script:FreedBytes += $size
        $script:RemovedCount++
        return
    }

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            Write-Host ('   - {0}: deleted {1}' -f $Label, (Format-Size $size)) -ForegroundColor DarkGray
            $script:FreedBytes += $size
            $script:RemovedCount++
            return
        } catch {
            if ($attempt -lt 3) {
                Start-Sleep -Milliseconds 500
                continue
            }
            $script:Failures.Add([pscustomobject]@{ Path = $Path; Reason = $_.Exception.Message }) | Out-Null
            Write-Warning ('   ! {0}: could not delete {1} - {2}' -f $Label, $Path, $_.Exception.Message)
        }
    }
}

<# Deletes every entry matching a wildcard inside a folder (e.g. leftover versions). #>
function Remove-ChatWizardMatches {
    param(
        [string]$Folder,
        [string]$Pattern,
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $Folder)) {
        Write-Host ('   - {0}: not present' -f $Label) -ForegroundColor DarkGray
        return
    }

    $items = @(Get-ChildItem -LiteralPath $Folder -Filter $Pattern -Force -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) {
        Write-Host ('   - {0}: none' -f $Label) -ForegroundColor DarkGray
        return
    }

    foreach ($item in $items) {
        Remove-ChatWizardPath -Path $item.FullName -Label ($Label + ' (' + $item.Name + ')')
    }
}

# -- Main --------------------------------------------------------------------

$ide = Get-IdeLocations -Ide $Target

Write-Host ''
if ($DryRun) {
    Write-Host ('ChatWizard data cleanup for {0} (dry run)' -f $ide.DisplayName) -ForegroundColor Cyan
} else {
    Write-Host ('ChatWizard data cleanup for {0}' -f $ide.DisplayName) -ForegroundColor Cyan
}
Write-Host ('   user data : {0}' -f $ide.UserData) -ForegroundColor DarkGray
Write-Host ('   extensions: {0}' -f $ide.Extensions) -ForegroundColor DarkGray

$running = @()
foreach ($processName in $ide.Processes) {
    $found = Get-Process -Name $processName -ErrorAction SilentlyContinue
    if ($found) { $running += $processName }
}
if ($running.Count -gt 0) {
    if ($DryRun) {
        Write-Host ('   {0} is running - some files would be reported as locked.' -f $ide.DisplayName) -ForegroundColor Yellow
    } else {
        Write-Warning ((('{0} is running: close every {0} window for a complete purge. ' -f $ide.DisplayName) +
            'The SQLite cache stays locked until the extension host exits, so you may need to re-run ') +
            ('npm run clean:data:{0} afterwards.' -f $Target))
    }
}

# -- 1. Per-IDE extension data ----------------------------------------------

if ($KeepExtensionData) {
    Write-Host ' Extension data: kept (-KeepExtensionData)' -ForegroundColor Yellow
} else {
    Write-Host ' Extension data (knowledge base, classification, metadata, folders, archive, model):' -ForegroundColor Cyan
    Remove-ChatWizardPath `
        -Path (Join-Path $ide.UserData (Join-Path 'User' (Join-Path 'globalStorage' $ExtensionId))) `
        -Label 'globalStorage'

    Write-Host ' Per-workspace storage (semantic embeddings):' -ForegroundColor Cyan
    $workspaceStorage = Join-Path $ide.UserData (Join-Path 'User' 'workspaceStorage')
    if (-not (Test-Path -LiteralPath $workspaceStorage)) {
        Write-Host '   - workspaceStorage: not present' -ForegroundColor DarkGray
    } else {
        $workspaceDirs = @(Get-ChildItem -LiteralPath $workspaceStorage -Directory -Force -ErrorAction SilentlyContinue)
        $hits = 0
        foreach ($dir in $workspaceDirs) {
            $candidate = Join-Path $dir.FullName $ExtensionId
            if (Test-Path -LiteralPath $candidate) {
                Remove-ChatWizardPath -Path $candidate -Label ('workspace ' + $dir.Name)
                $hits++
            }
        }
        if ($hits -eq 0) {
            Write-Host '   - no workspace holds ChatWizard data' -ForegroundColor DarkGray
        }
    }

    Write-Host ' Cached VSIX copies:' -ForegroundColor Cyan
    Remove-ChatWizardMatches `
        -Folder (Join-Path $ide.UserData 'CachedExtensionVSIXs') `
        -Pattern ($ExtensionId + '-*.vsix') `
        -Label 'cached VSIX'

    Write-Host ' Leftover extension folder (the uninstall should already have removed it):' -ForegroundColor Cyan
    if ($running.Count -gt 0 -and -not $DryRun) {
        Write-Host '   - skipped: the IDE is running and holds its native modules open' -ForegroundColor DarkGray
    } else {
        Remove-ChatWizardMatches `
            -Folder $ide.Extensions `
            -Pattern ($ExtensionId + '-*') `
            -Label 'extension folder'
    }
}

# -- 2. Shared cache (cross-IDE) --------------------------------------------

if ($KeepSharedCache) {
    Write-Host ' Shared cache: kept (-KeepSharedCache)' -ForegroundColor Yellow
} else {
    Write-Host ' Shared cache (SQLite databases, host record, original conversations):' -ForegroundColor Cyan

    $sharedDirs = @($ide.SharedCache)
    $configured = Get-ConfiguredSharedCacheDir -SettingsPath $ide.Settings
    if ($configured) {
        Write-Host ('   - chatwizard.sharedCacheDir is set to {0}' -f $configured) -ForegroundColor DarkGray
        if ($sharedDirs -notcontains $configured) { $sharedDirs += $configured }
    }

    foreach ($sharedDir in $sharedDirs) {
        # `vscode-host-runtime.json` is not user data: it records the Electron /
        # NODE_MODULE_VERSION of the installed IDE so scripts/rebuild-native.js
        # compiles better-sqlite3 for the right ABI. Keep it across the purge,
        # otherwise the next build falls back to a .vscode-test binary (or the
        # hard-coded default) and the native module can stop loading.
        $runtimeFile = Join-Path $sharedDir 'vscode-host-runtime.json'
        $runtimeRecord = $null
        if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
            try { $runtimeRecord = Get-Content -LiteralPath $runtimeFile -Raw -ErrorAction Stop } catch { $runtimeRecord = $null }
        }

        Remove-ChatWizardPath -Path $sharedDir -Label 'shared cache'

        if ($runtimeRecord -and -not $DryRun) {
            try {
                New-Item -ItemType Directory -Force -Path $sharedDir | Out-Null
                Set-Content -LiteralPath $runtimeFile -Value $runtimeRecord -NoNewline -Encoding UTF8
                Write-Host '   - kept vscode-host-runtime.json (native-module ABI record used by rebuild:native)' -ForegroundColor DarkGray
            } catch {
                Write-Warning ('   ! could not restore vscode-host-runtime.json in {0}' -f $sharedDir)
            }
        }
    }
}

# -- Summary ----------------------------------------------------------------

Write-Host ''
$verb = if ($DryRun) { 'would be freed' } else { 'freed' }
$removedWord = if ($DryRun) { 'would be removed' } else { 'removed' }

if ($script:Failures.Count -eq 0) {
    Write-Host ('Cleanup complete: {0} location(s) {1}, {2} {3}.' -f $script:RemovedCount, $removedWord, (Format-Size $script:FreedBytes), $verb) -ForegroundColor Green
    exit 0
}

Write-Host ('Cleanup incomplete: {0} location(s) {1}, {2} {3}, {4} locked.' -f $script:RemovedCount, $removedWord, (Format-Size $script:FreedBytes), $verb, $script:Failures.Count) -ForegroundColor Yellow
foreach ($failure in $script:Failures) {
    Write-Host ('   - {0}' -f $failure.Path) -ForegroundColor Yellow
    Write-Host ('     {0}' -f $failure.Reason) -ForegroundColor DarkGray
}
Write-Host ('   Close every {0} window, then re-run: npm run clean:data:{1}' -f $ide.DisplayName, $Target) -ForegroundColor Yellow
exit 4

