# ChatWizard — Default Workspace Scope Work Plan

## Overview & Motivation

Today the extension indexes and watches **every** VS Code workspaceStorage directory that has ever had a Copilot Chat session, plus everything under `~/.claude/projects/`. This is rarely what a developer needs: the overwhelming daily use case is analysing chats related to the workspace that is currently open.

This work plan introduces **workspace scope management**: the extension defaults to the currently open workspace, lets users add or remove additional workspaces via a single command, and surfaces storage-size information so users can make informed choices.

---

## Requirements (from user story)

| # | Requirement |
|---|---|
| R1 | Extension defaults to indexing only the **currently open VS Code workspace** on first activation. |
| R2 | A new command lets the user **add** additional workspaces to the active scope. |
| R3 | The same command lets the user **remove** workspaces, but **cannot leave the selection empty** (minimum 1 workspace must remain selected). |
| R4 | Each workspace listed in the picker shows its **session file size in MB**; a summary line shows the **total MB** currently selected. |
| R5 | Scope changes take effect immediately — the index is rebuilt and file watchers are restarted for the new set. |

---

## Current Architecture — Relevant Pieces

| Component | Relevant behaviour |
|---|---|
| `src/watcher/configPaths.ts` | Resolves the root directories for Claude (`~/.claude/projects`) and Copilot (`workspaceStorage`). |
| `src/readers/copilotWorkspace.ts` | `discoverCopilotWorkspacesAsync()` scans **all** hash-dirs under workspaceStorage that contain `chatSessions/`. Returns `CopilotWorkspaceInfo[]`. |
| `src/watcher/fileWatcher.ts` | `ChatWizardWatcher.start()` calls the discovery functions with no filtering, builds a full index, and registers FS watchers for all discovered workspaces. |
| `src/extension.ts` | `activate()` creates the watcher and passes it `SessionIndex`. Scope manager will also be created here and threaded through. |
| `src/types/index.ts` | `CopilotWorkspaceInfo { workspaceId, workspacePath, storageDir }` and `Session { workspaceId, workspacePath, filePath }`. |

---

## Architectural Design

### New concept: `ScopedWorkspace`

A unified descriptor covering both Copilot and Claude workspace origins:

```typescript
export interface ScopedWorkspace {
    id: string;           // unique — copilot hash | claude dir name
    source: 'copilot' | 'claude';
    workspacePath: string;  // human-readable absolute path
    storageDir: string;     // physical directory containing session files
}
```

`ScopedWorkspace` is added to `src/types/index.ts`.

### New class: `WorkspaceScopeManager` (`src/watcher/workspaceScope.ts`)

Owns the persisted selection and the first-activation default-detection logic.

```
WorkspaceScopeManager
  ├─ constructor(context: ExtensionContext)
  ├─ initDefault(available: ScopedWorkspace[]): Promise<void>
  │     On first use: detect VS Code's current folder, match against `available`,
  │     persist that ID. Falls back to all workspaces if no match is found.
  ├─ getSelectedIds(): string[]
  ├─ setSelectedIds(ids: string[]): void
  └─ isDefault(): boolean   // true when no persisted state yet
```

Persistence uses `context.globalState.update()` so scope survives VS Code restarts.

### Session size utility (`src/watcher/workspaceScope.ts` or own file)

```typescript
async function calcWorkspaceSizeMb(storageDir: string, source: 'copilot' | 'claude'): Promise<number>
```

- **Copilot**: sums byte sizes of every `*.jsonl` file under `<storageDir>/chatSessions/`
- **Claude**: sums byte sizes of every `*.jsonl` file directly under `<storageDir>/` (a project sub-dir)
- Returns MB rounded to two decimal places
- Never throws — returns `0` on any I/O error

### Modified: `ChatWizardWatcher`

Receives `WorkspaceScopeManager` as a constructor argument and filters all workspace lists through `scopeManager.getSelectedIds()` before indexing or registering file watchers.

Gains a `restart()` method that disposes all current file watchers, clears the index, and calls `start()` again — used when the scope changes.

### New command: `chatwizard.manageWatchedWorkspaces`

Implemented in a new file `src/commands/manageWorkspaces.ts`.

Flow:
1. Discover **all** available workspaces (Copilot + Claude) via the async discovery functions.
2. Compute size for each in parallel via `calcWorkspaceSizeMb`.
3. Pre-check currently selected IDs.
4. Present `vscode.window.showQuickPick` with `canPickMany: true`.
5. If user confirms with an empty selection → show a warning, do not commit.
6. If the result equals the current selection → no-op.
7. Otherwise → `scopeManager.setSelectedIds(newIds)` → `watcher.restart()`.

---

## Implementation Phases

### Phase 1 — `ScopedWorkspace` type & `WorkspaceScopeManager` ✅ COMPLETED

**Files changed:**
- `src/types/index.ts` — add `ScopedWorkspace` interface
- `src/watcher/workspaceScope.ts` — new file

**Tasks:**
- [x] Add `ScopedWorkspace` to `src/types/index.ts`
- [x] Implement `WorkspaceScopeManager`:
  - Persist/restore selected IDs via `context.globalState`
  - `initDefault()`: compare `vscode.workspace.workspaceFolders[0]?.uri.fsPath` (normalised) against `available[i].workspacePath` (normalised). On Windows use `path.normalize` and case-insensitive comparison.
  - Guard: if no match is found (e.g. untitled window, or no prior Copilot/Claude data), default to selecting **all** available workspaces.
- [x] Implement `calcWorkspaceSizeMb()` as a standalone async function in `workspaceScope.ts`
- [x] Write unit tests for `WorkspaceScopeManager` in `test/suite/workspaceScope.test.ts`
- [x] Write unit tests for `calcWorkspaceSizeMb` covering copilot and claude paths

**Deliverables:**
- `src/types/index.ts` updated with `ScopedWorkspace` interface
- `src/watcher/workspaceScope.ts` — `WorkspaceScopeManager` class + `calcWorkspaceSizeMb` function
- `test/suite/workspaceScope.test.ts` — unit test suite covering scope persistence, default detection, and size calculation

**UI testability at this point:**
None yet — these are pure logic modules with no user-facing surface. Validate via unit tests only.

---

### Phase 2 — Claude workspace-to-path resolution ✅ COMPLETED

**Context:** Under `~/.claude/projects/` the subdirectory names are derived from the workspace root path, but the exact encoding convention used by the Claude CLI must be verified against real data before implementing the filter.

**Encoding convention (verified):** Claude CLI replaces all path separators (`/`, `\`) and colons (`:`) with dashes (`-`). The drive letter is preserved as-is (lowercase). Example: `C:\Repos\Personal\ChatWizard` → `c--Repos-Personal-ChatWizard`.

**Tasks:**
- [x] **Investigate** directory naming: encoding is slash/colon → dash substitution (verified against real `~/.claude/projects/` data).
- [x] Add a `resolveClaudeWorkspacePath(dirName: string): string | undefined` function to `src/readers/claudeWorkspace.ts` (new file, parallel to `copilotWorkspace.ts`) that decodes a directory name back to a human-readable workspace path. Return `undefined` if decoding fails.
- [x] Add `discoverClaudeWorkspacesAsync(): Promise<ScopedWorkspace[]>` in the same file, scanning all project dirs and decoding paths.
- [x] Update `collectClaudeSessionsAsync` in `fileWatcher.ts` to receive a `selectedIds` filter and skip dirs not in the list.
- [x] Add unit tests with fixture directory names and expected decoded paths in `test/suite/claudeWorkspaceDiscovery.test.ts`.

**Deliverables:**
- `src/readers/claudeWorkspace.ts` — `resolveClaudeWorkspacePath()` + `discoverClaudeWorkspacesAsync()`
- `src/watcher/fileWatcher.ts` — `collectClaudeSessionsAsync` updated to accept a `selectedIds` filter parameter
- `test/suite/claudeWorkspaceDiscovery.test.ts` — unit tests for directory name decoding

**UI testability at this point:**
Still no visible change — the filter is wired into the collector function but `extension.ts` does not yet create or pass a `WorkspaceScopeManager`, so the extension still behaves identically in practice. Validate correctness via unit tests only.

> **Note:** Until Phase 2 is complete, Claude sessions from the current workspace will be included by default (all Claude sessions pass through). Phase 2 gates fully correct Claude scoping but does not block Phase 1, 3, 4, or 5.

---

### Phase 3 — Wire scope into `ChatWizardWatcher` ✅ COMPLETED

**Files changed:**
- `src/watcher/fileWatcher.ts`
- `src/extension.ts`

**Tasks:**
- [x] Add `scopeManager: WorkspaceScopeManager` parameter to `ChatWizardWatcher` constructor.
- [x] In `collectCopilotSessionsAsync()`: filter the result of `discoverCopilotWorkspacesAsync()` to those whose `workspaceId` is in `scopeManager.getSelectedIds()`.
- [x] In `start()` Copilot watcher loop: same filter so FS watchers are only created for selected workspaces.
- [x] In `collectClaudeSessionsAsync()`: pass `scopeManager.getSelectedIds()` to the directory filter (guarded by Phase 2 being done; until then, no filter applied to Claude).
- [x] Add `restart()` to `ChatWizardWatcher`:
  ```typescript
  async restart(): Promise<void> {
      this.dispose();          // stop watchers
      this.index.clear();     // drop all sessions
      await this.start();     // re-index + attach new watchers
  }
  ```
  `SessionIndex.clear()` now fires a typed `'clear'` event (and the plain change notification) so all UI panels refresh automatically. `FullTextSearchEngine.clear()` was added and is called from the typed listener handler in `extension.ts`.
- [x] In `extension.ts` `activate()`:
  - Create `WorkspaceScopeManager` with `context`
  - Discover all available workspaces once (to pass to `initDefault`)
  - Await `scopeManager.initDefault(available)`
  - Pass `scopeManager` to `ChatWizardWatcher`
- [x] Unit test: verify that initialising the watcher with a scope filter results in only the matching workspaces being indexed.

**Deliverables:**
- `src/watcher/fileWatcher.ts` — `scopeManager` parameter added to constructor; `restart()` method; Copilot filtering live
- `src/extension.ts` — `WorkspaceScopeManager` created, `initDefault()` called, passed to `ChatWizardWatcher`
- `test/suite/fileWatcher.test.ts` (new or extended) — scoped indexing integration test

**UI testability at this point:**
- Open the extension in VS Code Extension Development Host.
- Verify the **Session tree, Search panel, Analytics panel, and Timeline** all load showing only sessions from the currently open workspace — sessions from other past workspaces should be absent.
- Check the **Output channel** (`ChatWizard`) for a log line confirming which workspace ID was selected by `initDefault()`.
- Close VS Code, reopen it in the same folder — confirm the same single-workspace scope is restored (persisted via `globalState`).
- Open VS Code in a different folder — confirm only that folder's sessions appear.

---

### Phase 4 — Command implementation

**Files changed:**
- `src/commands/manageWorkspaces.ts` — new file
- `src/extension.ts` — register command

**Tasks:**
- [ ] Implement `registerManageWorkspacesCommand(context, scopeManager, watcher, channel)` in `src/commands/manageWorkspaces.ts`.
- [ ] Build QuickPick items. Each item:
  ```
  label      : path.basename(ws.workspacePath)   // folder name only
  description: ws.workspacePath                   // full path for disambiguation
  detail     : "X.XX MB  •  <source>"            // size + copilot/claude badge
  picked     : scopeManager.getSelectedIds().includes(ws.id)
  ```
- [ ] Add a **non-selectable separator/description item** at the top of the list (or in `title`) showing the total MB of all currently selected workspaces. Use a `vscode.QuickPickItem` with `kind: vscode.QuickPickItemKind.Separator` labelled e.g. `"Selected total: X.XX MB"`. Update this label reactively if the API allows it, or recalculate on confirm.
- [ ] After `showQuickPick` resolves:
  - If `undefined` (cancelled) → no-op.
  - If empty array → show `vscode.window.showWarningMessage('At least one workspace must remain selected.')` → no-op.
  - If unchanged → no-op.
  - Else → `scopeManager.setSelectedIds(selected.map(i => i.id))` → `await watcher.restart()`.
- [ ] Register in `extension.ts` and in `package.json` as `chatwizard.manageWatchedWorkspaces`.
- [ ] Unit tests in `test/suite/manageWorkspacesCommand.test.ts`:
  - Empty selection is rejected.
  - Single-workspace selection with no deselection of the currently open workspace passes.
  - Scope manager is not updated on cancel.

**Deliverables:**
- `src/commands/manageWorkspaces.ts` — full command implementation with QuickPick, size display, empty-selection guard
- `src/extension.ts` — command registered
- `test/suite/manageWorkspacesCommand.test.ts` — unit tests for selection validation and scope-manager update logic

**UI testability at this point:**
- Open Command Palette → type `ChatWizard: Manage Watched Workspaces`.
  - **Command exists and opens**: a multi-select QuickPick appears listing all available workspaces.
  - **Pre-checked state**: the workspace(s) currently in scope are already checked.
  - **Size information**: each item shows `X.XX MB  •  copilot` or `•  claude` in its detail line.
  - **Total summary**: a separator or title area shows the aggregate MB of currently selected workspaces.
  - **Add a workspace**: check an unchecked workspace and confirm — session tree should expand with sessions from the new workspace within seconds.
  - **Remove a workspace**: uncheck a workspace and confirm — its sessions should disappear from the tree, search, analytics, and timeline immediately.
  - **Empty selection guard**: uncheck all items and confirm — a warning notification appears and the scope is unchanged.
  - **Cancel**: press Escape — scope and index are unchanged.
  - **Restart persistence**: after changing scope, close and reopen VS Code — the same scope should be active on reload.

---

### Phase 5 — `package.json` registration

**Files changed:** `package.json`

**Tasks:**
- [ ] Add command contribution:
  ```json
  {
    "command": "chatwizard.manageWatchedWorkspaces",
    "title": "ChatWizard: Manage Watched Workspaces"
  }
  ```
- [ ] Add `chatwizard.enabled`, `chatwizard.indexClaude`, `chatwizard.indexCopilot` to `contributes.configuration` (they are read in code today but missing from the manifest).
- [ ] Verify `activationEvents` covers the new command if the extension uses explicit activation events.

**Deliverables:**
- `package.json` — `chatwizard.manageWatchedWorkspaces` command declared under `contributes.commands`
- `package.json` — `chatwizard.enabled`, `chatwizard.indexClaude`, `chatwizard.indexCopilot` declared under `contributes.configuration`

**UI testability at this point:**
- Open **Settings UI** (`Ctrl+,`) and search for `chatwizard` — `enabled`, `indexClaude`, and `indexCopilot` now appear with descriptions and toggle controls (previously invisible to users).
- Open Command Palette and confirm `ChatWizard: Manage Watched Workspaces` appears in the list with a clean title (no internal identifier leaking).
- Disable the extension via `chatwizard.enabled: false` in settings and reload — confirm the tree is empty and the Output channel logs the disabled message.

---

### Phase 6 — `onDidChangeConfiguration` updates

**Files changed:** `src/extension.ts`

**Tasks:**
- [ ] If `chatwizard.claudeProjectsPath` or `chatwizard.copilotStoragePath` change, use `watcher.restart()` rather than only prompting "Reload Window" — the scope manager already knows which workspaces were selected; re-discovery will find them under the new path.
- [ ] Consider whether path changes should also reset the scope manager's persisted IDs (since a path change to a different machine's data would invalidate old IDs). Recommendation: on path change, reset to default (re-run `initDefault()`).

**Deliverables:**
- `src/extension.ts` — `onDidChangeConfiguration` updated to call `watcher.restart()` and conditionally re-run `initDefault()` on path-setting changes

**UI testability at this point:**
- In Settings, change `chatwizard.copilotStoragePath` to a custom directory — the extension should re-index automatically **without** prompting a window reload. The Output channel should log a restart event.
- Change the path back to empty (default) — same automatic reload behaviour.
- Verify all panels (tree, search, analytics, timeline) reflect the new data within a few seconds of the setting change.

---

## Edge Cases & Notes

| Scenario | Handling |
|---|---|
| No VS Code workspace folder open (untitled window) | `initDefault()` falls back to selecting **all** available workspaces. |
| Current workspace has no Copilot/Claude session data yet | No matching entry in discovered workspaces. Scope defaults to all (or shows empty with a message). |
| User deletes the workspaceStorage hash directory manually | Discovery returns fewer workspaces. On next command open, stale IDs simply produce no matches and are silently dropped; scope manager normalises the state. |
| All workspaces removed from `scopeManager` by external edit of `globalState` | Watcher detects empty selected list on `start()`, logs a warning, falls back to all workspaces to avoid a blank extension. |
| Very large workspace (hundreds of MB) | Size is shown but the UI does not block. Size computation is async and shows `"computing…"` temporarily. |
| Multi-root VS Code workspace (multiple folders) | `vscode.workspace.workspaceFolders` returns multiple entries. `initDefault()` selects all workspaces matching any of the open folders. |
| Windows path case sensitivity | Normalise both sides with `path.normalize(p).toLowerCase()` before comparison in `initDefault()`. |

---

## Files Created / Modified Summary

| Action | File |
|---|---|
| New | `src/watcher/workspaceScope.ts` |
| New | `src/readers/claudeWorkspace.ts` |
| New | `src/commands/manageWorkspaces.ts` |
| New | `test/suite/workspaceScope.test.ts` |
| New | `test/suite/claudeWorkspaceDiscovery.test.ts` |
| New | `test/suite/manageWorkspacesCommand.test.ts` |
| Modified | `src/types/index.ts` — add `ScopedWorkspace` |
| Modified | `src/watcher/fileWatcher.ts` — scope filtering + `restart()` |
| Modified | `src/extension.ts` — scope manager creation + command registration |
| Modified | `package.json` — command + missing settings |

---

## Effort Estimate

| Phase | Effort |
|---|---|
| Phase 1 — ScopedWorkspace + WorkspaceScopeManager + size utility | 1.5 days |
| Phase 2 — Claude directory encoding investigation + resolver | 1 day |
| Phase 3 — Wire scope into watcher | 1 day |
| Phase 4 — Command implementation + QuickPick UI | 1 day |
| Phase 5 — package.json | 0.25 days |
| Phase 6 — onDidChangeConfiguration refinements | 0.25 days |
| Tests across all phases | 1 day |
| **Total** | **~6 days** |
