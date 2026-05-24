# ChatWizard — P2 Feature Work Plan

_Created: May 2026_

> Covers all **P2 — Next Quarter** features from `whats-next.md` (features #10–#22).
> Every feature is broken into atomic tasks that are **mutually independent** within that feature
> so work can be distributed across parallel tracks. Cross-feature dependencies are called out
> explicitly at the top of each section.
>
> **Effort key:** XS < 1 day · S = 1–3 days · M = 1–2 weeks
>
> **Status legend:**
> | Symbol | Meaning |
> |--------|---------|
> | ⬜ | Not started |
> | 🔄 | In progress |
> | ✅ | Complete |

---

## Table of Contents

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| [10](#feature-10--copilot-chronicle-phase-3--file-centric-history) | Copilot Chronicle Phase 3 — file-centric history | M | ⬜ |
| [11](#feature-11--copilot-chronicle-phase-4--work-item--branch-grouping) | Copilot Chronicle Phase 4 — work item & branch grouping | M | ⬜ |
| [12](#feature-12--session-archive-own-storage) | Session archive (own storage) | M | ⬜ |
| [13](#feature-13--session-tagging--labels) | Session tagging / labels | M | ⬜ |
| [14](#feature-14--chat-participant-clickable-file-links) | Chat participant: clickable file links | S | ⬜ |
| [15](#feature-15--continuedev-source-support) | Continue.dev source support | M | ⬜ |
| [16](#feature-16--amazon-q-developer-source-support) | Amazon Q Developer source support | M | ⬜ |
| [17](#feature-17--gemini-code-assist-source-support) | Gemini Code Assist source support | M | ⬜ |
| [18](#feature-18--ai-generated-session-summaries--auto-descriptions) | AI-generated session summaries / auto-descriptions | M | ⬜ |
| [19](#feature-19--entity-extraction-from-sessions) | Entity extraction from sessions | M | ⬜ |
| [20](#feature-20--prompt-cost-analysis) | Prompt cost analysis | M | ⬜ |
| [21](#feature-21--mcp-phase-ii-reranker-for-chatwizard_get_context) | MCP Phase II: reranker for `chatwizard_get_context` | M | ⬜ |
| [22](#feature-22--obsidian--notion-native-export) | Obsidian / Notion native export | S | ⬜ |
| [23](#feature-23--message-turn-labels--in-thread-references) | Message turn labels & in-thread references | S | ⬜ |

---

## Feature 10 — Copilot Chronicle Phase 3 — File-Centric History

**Effort:** M  
**Prerequisite:** Chronicle Phase 1 & 2 (P1, already implemented — `session_files` table populated in `ChronicleStore`).

### Overview

Surface "N chat sessions touched this file" directly in the editor — status bar, CodeLens, and Explorer context menu — so ChatWizard meets the developer where they are instead of requiring a deliberate visit to the session panel. Also exposes `chatwizard_sessions_for_file` as an MCP tool.

### Atomic Tasks

- [ ] **10-A** — `ChronicleStore.sessionsForFile(filePath: string): SessionSummary[]`
  - Pure data method on the existing `ChronicleStore` singleton.
  - Normalise the input path: lower-case drive letter on Windows, forward-slash separator, resolve `..` components before lookup.
  - Return sessions sorted by `updated_at DESC`.
  - No VS Code dependency — fully unit-testable.

- [ ] **10-B** — `chatwizard_sessions_for_file` MCP tool
  - New file `src/mcp/tools/sessionsForFileTool.ts`, registers with the MCP server.
  - Input: `{ filePath: string }` — accepts both absolute paths and workspace-relative paths; resolves relative paths against `vscode.workspace.workspaceFolders[0]`.
  - Output: array of `{ sessionId, title, source, date, summary }` objects.
  - Graceful empty result (not an error) when Chronicle data is absent.

- [ ] **10-C** — `FileHistoryStatusBarItem`
  - New file `src/ui/fileHistoryStatusBar.ts`.
  - Subscribes to `vscode.window.onDidChangeActiveTextEditor`.
  - When Chronicle data exists for the active file: shows `$(comment) N sessions` in the status bar (left-aligned, priority after git).
  - When no data: item is hidden (not showing zero).
  - Clicking the item fires `chatwizard.showFileHistory` command.
  - Disposes cleanly on extension deactivate.

- [ ] **10-D** — `FileHistoryCodeLensProvider`
  - New file `src/ui/fileHistoryCodeLens.ts`, implements `vscode.CodeLensProvider`.
  - Registers for all document languages that have at least one matching session.
  - CodeLens appears at line 0: `"$(history) N ChatWizard sessions touched this file — click to view"`.
  - Gated behind `chatwizard.codeLens.enabled` setting (default: `true`).
  - Invalidation: `_onDidChangeCodeLenses` fires when the active file changes.

- [ ] **10-E** — Explorer context menu entry
  - Add `"ChatWizard: Show File History"` to `explorer/context` contribution in `package.json`.
  - Command handler: resolves the URI from the context argument, calls `sessionsForFile()`, opens the `FileHistoryPanel` webview.

- [ ] **10-F** — `FileHistoryPanel` webview
  - New file `src/views/fileHistoryPanel.ts`.
  - Lists sessions touching the file: date, source badge, one-line summary, `[Open session]` button.
  - Reuses existing webview CSS tokens (source badge colours, dark-mode variables).
  - Renders a friendly empty state when no Chronicle data is available: "No Chronicle data found — enable `chat.localIndex.enabled` to populate this view."

- [ ] **10-G** — Path normalisation utility
  - `src/utils/pathNormaliser.ts` — `normalisePath(p: string): string`.
  - Handles: Windows drive letters (`C:\` → `c:/`), mixed slash styles, trailing slashes, symlinks (best-effort `fs.realpathSync`).
  - Shared by 10-A, 10-B, and future file-matching code.

### Unit Tests

- [ ] `chronicleStore.sessionsForFile` — exact match, case-insensitive match on Windows paths, relative path resolution, unknown file returns `[]`.
- [ ] `pathNormaliser.normalisePath` — Windows path, macOS path, UNC path, trailing slash, already normalised path (idempotent).
- [ ] `FileHistoryStatusBarItem` — shows count when data present, hides when no data, disposes subscriptions on deactivate.
- [ ] `sessionsForFileTool` — workspace-relative input resolved correctly, absolute path passthrough, empty Chronicle returns empty array not error.
- [ ] `FileHistoryCodeLensProvider` — returns one CodeLens at line 0, returns `[]` when no Chronicle sessions, respects `chatwizard.codeLens.enabled: false`.
### E2E Tests

- [ ] **Scenario: open a file that was touched in a Chronicle session** — status bar shows correct count, clicking opens `FileHistoryPanel` listing matching sessions.
- [ ] **Scenario: open a file with no Chronicle history** — status bar item is hidden, CodeLens is absent, Explorer menu command opens panel with empty state.
- [ ] **Scenario: MCP tool called with relative path** — resolves correctly and returns same sessions as absolute path.
- [ ] **Scenario: Chronicle DB absent** — all surfaces degrade silently (no errors, no empty counts shown).
- [ ] **Scenario: file history panel `[Open session]` button** — opens the session webview for the correct session.
### Manual Tests

1. Open a file you have worked on in a Copilot session recently. Verify the status bar shows a non-zero count and the CodeLens appears at line 1.
2. Click the status bar item. Verify the `FileHistoryPanel` opens, lists sessions with dates and source badges, and summaries are readable (not empty).
3. Click `[Open session]` in the panel. Verify the session webview opens and scrolls to the correct session.
4. Right-click a file in the Explorer that has no Chronicle history. Verify "Show ChatWizard History" appears and opens the empty-state panel (no error dialog).
5. Disable CodeLens via `chatwizard.codeLens.enabled: false`. Verify no CodeLens appears, but status bar and Explorer menu still work.
6. Open a file, then switch to another file with a different session count. Verify status bar updates within 200 ms.
7. Call `chatwizard_sessions_for_file` from an MCP client with a relative path (e.g. `"src/auth.ts"`). Verify correct sessions are returned.
8. _(Potential bug surface)_ Open a file on a network share / UNC path. Verify no crash and path normalisation does not produce an empty result set when sessions exist for that file.
9. _(Potential bug surface)_ Rapidly switch between files. Verify the status bar does not flicker or show a count from the previous file.
### Completion Checklist

- [ ] All atomic tasks (10-A through 10-G) implemented and code-reviewed
- [ ] All unit tests green (`npm test`)
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] `chatwizard_sessions_for_file` documented in README MCP tool catalogue
- [ ] `chatwizard.codeLens.enabled` setting added to `package.json` `contributes.configuration`
- [ ] ⬜ → ✅ in this document and in `whats-next.md` feature table

---

## Feature 11 — Copilot Chronicle Phase 4 — Work Item & Branch Grouping

**Effort:** M  
**Prerequisite:** Chronicle Phase 3 (feature 10) done — specifically the `ChronicleStore` `session_refs` index and the branch field on `sessions`.

### Overview

The Sessions tab's existing **group mode** toggle now includes **By Branch** and **By Work Item** modes alongside the default date grouping. Sessions are grouped directly inside the Sessions view using a toolbar action; no separate sidebar tab is needed. Two new MCP tools expose this grouping programmatically.

### Atomic Tasks

- [ ] **11-A** — `chatwizard.workItemPattern` configuration setting
  - Add to `package.json` `contributes.configuration`.
  - Type: `string`, default: `""` (empty = feature disabled).
  - Description and examples in the schema description field: `PREFIX-\\d+` (matches `prefix-12345`), `[A-Z]+-\\d+`, `#\\d+`, `AB#\\d+`.
  - Validate on change: if the value is not a valid regex, surface a warning notification (never throw).

- [ ] **11-B** — `WorkItemExtractor` utility
  - New file `src/utils/workItemExtractor.ts`.
  - `extractWorkItem(text: string, pattern: RegExp): string | undefined` — returns first match.
  - Inputs: branch name, commit message, `session_refs.ref_value`.
  - Pure function, no side effects — fully unit-testable without VS Code.

- [ ] **11-C** — `ByContextTreeDataProvider`
  - New file `src/views/byContextTreeProvider.ts`, implements `vscode.TreeDataProvider`.
  - Two top-level grouping modes, toggled by a view-title action button:
    - **By Branch** — group sessions under their `sessions.branch` value; sessions with no branch go under `(no branch)`.
    - **By Work Item** — applies `WorkItemExtractor` to branch names and commit messages; sessions matching a work item ID are grouped under that ID; unmatched sessions go under `(unassigned)`.
  - Shows session count per group as description.
  - When `chatwizard.workItemPattern` is empty, **By Work Item** mode shows an inline placeholder node: `"Set chatwizard.workItemPattern to enable work item grouping"`.

- [ ] **11-D** — `chatwizard_sessions_for_branch` MCP tool
  - New file `src/mcp/tools/sessionsForBranchTool.ts`.
  - Input: `{ branch: string }`.
  - Output: sessions whose `sessions.branch` equals the input (case-insensitive).

- [ ] **11-E** — `chatwizard_sessions_for_work_item` MCP tool
  - New file `src/mcp/tools/sessionsForWorkItemTool.ts`.
  - Input: `{ workItemId: string }`.
  - If `chatwizard.workItemPattern` is not set: return a structured error `{ error: "NO_PATTERN", message: "Set chatwizard.workItemPattern to enable work item lookup. Examples: PREFIX-\\d+, [A-Z]+-\\d+" }`.
  - Output: sessions where any commit/branch matches the pattern and the extracted ID equals `workItemId`.

- [ ] **11-F** ~~— Register "By Context" view in `package.json`~~ — **Removed.** Branch and work item grouping are exposed as group modes on the Sessions tab toolbar, not as a separate view container.
  ~~View ID: `chatwizard.byContextView`.~~
  ~~Title: `"By Context"`.~~
  ~~Icon: a branching-path icon (reuse `$(git-branch)` codicon).~~

### Unit Tests

- [ ] `WorkItemExtractor.extractWorkItem` — matching pattern, non-matching text, malformed regex input (should not throw), empty text.
- [ ] `ByContextTreeDataProvider` — tree built correctly for branch mode, work item mode, empty pattern shows placeholder, sessions with no branch go under `(no branch)`.
- [ ] `sessionsForBranchTool` — exact branch match, case-insensitive match, branch not found returns empty array.
- [ ] `sessionsForWorkItemTool` — with pattern set returns correct sessions, without pattern set returns structured error, no matching sessions returns empty array.
- [ ] Setting validation — invalid regex pattern triggers notification but does not throw or break the extension.

### E2E Tests

- [ ] **Scenario: switch Sessions tab to branch grouping mode** — sessions appear grouped under correct branch names.
- [ ] **Scenario: toggle to "By Work Item" mode with pattern set** — sessions grouped correctly; a session whose branch name contains a matching work item ID appears under that ID.
- [ ] **Scenario: work item grouping with pattern not configured** — placeholder node shown, not an empty view.
- [ ] **Scenario: MCP `chatwizard_sessions_for_branch`** — returns sessions for the queried branch.
- [ ] **Scenario: MCP `chatwizard_sessions_for_work_item` without pattern** — returns the structured error (not a thrown exception).

### Manual Tests

1. Verify branch grouping mode in the Sessions tab shows your recent git branches with correct session counts.
2. Set `chatwizard.workItemPattern` to `[A-Z]+-\d+`. Switch to "By Work Item" mode. Verify sessions from feature branches (e.g. `feature/AUTH-123`) appear under `AUTH-123`.
3. Set an invalid regex (e.g. `[unclosed`). Verify a warning notification appears and the extension does not crash; the previous valid grouping is shown or a graceful placeholder.
4. Open a terminal and query `chatwizard_sessions_for_branch` with a branch you have sessions on. Verify the result includes the correct sessions.
5. Query `chatwizard_sessions_for_work_item` before setting `chatwizard.workItemPattern`. Verify the structured error message is returned (not an uncaught exception).
6. _(Potential bug surface)_ Sessions where the branch is `null` (Cursor / pre-Chronicle sessions). Verify they appear under `(no branch)` and not in any work item group.
7. _(Potential bug surface)_ Branch name that matches multiple work item IDs (e.g. `feature/AUTH-123-PROJ-456`). Verify the first match wins and the session is not duplicated.

### Completion Checklist

- [ ] All atomic tasks (11-A through 11-F) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] Both new MCP tools documented in README
- [ ] `chatwizard.workItemPattern` documented with examples in README and `package.json` schema
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 12 — Session Archive (Own Storage)

**Effort:** M  
**Prerequisite:** None — self-contained feature. Full detail in `work-plan-session-archive.md`; this section captures the atomic breakdown and test plan.

### Overview

Every session ChatWizard indexes is mirrored verbatim to `globalStorageUri/archive/<source>/<sessionId>.<ext>`. When the source tool prunes its data, ChatWizard continues serving those sessions from its own copy.

### Atomic Tasks

- [ ] **12-A** — `SessionArchive` class — pure I/O, no VS Code deps
  - `src/archive/sessionArchive.ts`.
  - `has(sessionId, source): boolean` — synchronous (backed by in-memory manifest).
  - `save(sessionId, source, rawContent: string | Buffer): Promise<void>` — atomic write via `.tmp` + rename.
  - `loadAll(source): Promise<ArchivedSession[]>` — reads all archived sessions for a source.
  - `prune(options: PruneOptions): Promise<number>` — removes by age and/or total size; returns count of removed files.
  - `stats(): ArchiveStats` — `{ totalSessions, totalBytes, oldestDate }`.

- [ ] **12-B** — Strategy A archive writes (file-per-session sources)
  - Inside `buildInitialIndex()` for Claude, Copilot, Cline, Roo Code, Aider, Antigravity parsers: after a successful parse, call `archive.save()` with the raw file bytes.
  - Inside each source's file-change watcher: on file-changed event, overwrite the archive entry.
  - Guard: skip if `archive.has()` returns true and the source file is unchanged (compare mtime).

- [ ] **12-C** — Strategy B archive writes (SQLite-backed sources: Cursor, Windsurf)
  - After parsing a session from `state.vscdb`, call `archive.save()` with `JSON.stringify(session)`.
  - Restore path: `JSON.parse(content)` produces a `Session` directly — no parser needed.

- [ ] **12-D** — Archive-only session loading at startup
  - After `buildInitialIndex()` completes, call `archive.loadAll()` for each source.
  - Any session ID in the archive but not in the live index gets added to the index with `session.archived = true`.
  - Log: `"[ChatWizard] Archive: loaded N archive-only sessions from <source>"`.

- [ ] **12-E** — "Archived" badge in session tree
  - Session tree items with `session.archived === true` show a `· archived` suffix in the description.
  - Tooltip: `"This session is no longer available from its source — served from ChatWizard archive"`.

- [ ] **12-F** — `ChatWizard: Show Archive Stats` command
  - Shows an information message: `"Archive: 1,204 sessions · 47 MB · oldest: 2025-11-03"`.
  - Also displayed inline as a collapsed section in the Manage Workspaces panel.

- [ ] **12-G** — Opt-in pruning settings
  - `chatwizard.archive.maxAgeDays` (default: `0` = never prune by age).
  - `chatwizard.archive.maxSizeMB` (default: `0` = no size cap).
  - Pruning runs at startup after archive-only session loading, so never removes a session that has just been shown to the user.
  - Pruning removes oldest-first (by `updated_at`).

### Unit Tests

- [ ] `SessionArchive.save` — creates directory if absent, writes atomically (tmp + rename), idempotent on second call with same content.
- [ ] `SessionArchive.has` — returns `true` after save, `false` for unknown session.
- [ ] `SessionArchive.loadAll` — returns all saved sessions for a source, ignores files from other sources.
- [ ] `SessionArchive.prune` by age — removes sessions older than threshold, returns correct count.
- [ ] `SessionArchive.prune` by size — removes oldest first until under cap.
- [ ] `SessionArchive.stats` — returns correct counts and dates.
- [ ] Strategy B restore — `JSON.parse(archived content)` produces a `Session` with all fields intact.
- [ ] Archive-only session loading — session absent from live index but present in archive appears in `getAllSummaries()` with `archived: true`.

### E2E Tests

- [ ] **Scenario: first run archives all current sessions** — after startup, archive directory contains one file per indexed session for at least one source.
- [ ] **Scenario: source file deleted after archival** — session still appears in session tree with `· archived` badge.
- [ ] **Scenario: archive stats command** — shows correct numbers (non-zero after first run).
- [ ] **Scenario: pruning by age** — after setting `maxAgeDays: 1`, sessions older than 1 day are removed from archive at next startup (but still-live sessions are not removed).
- [ ] **Scenario: Cursor session archived and restored** — archived via Strategy B, restored without running the Cursor parser again.

### Manual Tests

1. Run the extension fresh. Open Output channel → ChatWizard. Verify log lines like `"Archive: archived 47 new sessions from copilot"`.
2. Note a session title from a Claude source. Manually delete the source `.jsonl` file. Restart VS Code. Verify the session still appears in the tree with `· archived` label.
3. Click the archived session. Verify the session webview loads correctly with full content.
4. Run `ChatWizard: Show Archive Stats`. Verify the message shows a non-zero session count and a plausible byte size.
5. Set `chatwizard.archive.maxAgeDays: 30`. Restart. Verify only sessions older than 30 days are removed and recent sessions remain.
6. _(Potential bug surface)_ Archive a session, then update the source file (e.g. the conversation continues). Restart. Verify the archive is updated to the newer version, not stuck on the older snapshot.
7. _(Potential bug surface)_ Run on a machine where `globalStorageUri` is on a read-only filesystem or network mount. Verify a clear error notification is shown and the extension continues to function (no session tree failure).
8. _(Potential bug surface)_ Archive directory reaches several GB. Verify `Show Archive Stats` still loads instantly (uses manifest, not a directory scan).

### Completion Checklist

- [ ] All atomic tasks (12-A through 12-G) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] `work-plan-session-archive.md` tasks marked complete
- [ ] `chatwizard.archive.*` settings documented in README
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 13 — Session Tagging / Labels

**Effort:** M  
**Prerequisite:** Sidecar metadata model (Feature 9 / P1). Full detail in `work-plan-kb-and-tagging.md`; this section is the atomic breakdown and test plan.

### Overview

Users can attach freeform labels (`#bugfix`, `topic:auth`, `kind:decision`) to sessions via right-click. Tags are stored in `chatwizard-metadata.json` and displayed as chips in the session tree and reader.

### Atomic Tasks

- [ ] **13-A** — `MetadataStore` and `SessionMetadata` interfaces
  - `src/metadata/metadataStore.ts` — `load()`, `save()`, `getSession()`, `updateSession()`, `addTag()`, `removeTag()`, `getAllTags()`.
  - Atomic write (`.tmp` + rename) to prevent corruption.
  - `getAllTags()` returns `Array<{ tag: string; count: number }>` sorted by count descending.

- [ ] **13-B** — Pin state migration
  - On first load of `MetadataStore`, scan existing pin storage (wherever pins are currently saved) and write them into `chatwizard-metadata.json` as `pinned: true` entries.
  - One-time migration; set a `"version": 1` flag to avoid re-running.

- [ ] **13-C** — Tag chips in session tree items
  - In `SessionTreeProvider`, read `MetadataStore.getSession(id).tags` and render up to 3 chips as part of the tree item description.
  - Overflow: `+N more` appended when more than 3 tags.
  - Tree refreshes when `MetadataStore` fires its `onDidChange` event.

- [ ] **13-D** — "Add Tag…" and "Remove Tag…" context menu items
  - `chatwizard.addTag` command: opens `vscode.window.showInputBox` with `placeHolder: 'e.g. topic:auth, #bugfix'`; comma-split input; normalize to lowercase, trim whitespace, strip leading `#` for storage (add back on display).
  - `chatwizard.removeTag` command: opens `QuickPick` of existing tags on that session; multi-select.
  - Both registered in `explorer/context` for `chatwizard.sessionItem` menu context.

- [ ] **13-E** — `chatwizard.filterByTag` command
  - `QuickPick` lists all tags with counts: `topic:auth  (12 sessions)`.
  - Selecting a tag sets a "tag filter" on `SessionTreeProvider` that hides non-matching sessions.
  - A visible filter indicator (e.g. `$(filter)` in the view title) lets the user clear the filter in one click.

- [ ] **13-F** — Tag display in session reader webview
  - Session reader header shows tag chips alongside source badge and date.
  - Tags are read-only in the webview (editing is done from the tree or command palette).

- [x] **13-G** — `LiveSessionTracker` — in-memory active session registry
  - **Why not `updatedAt` heuristics or VS Code Chat API:**  
    The VS Code Chat API (`ChatRequest` / `ChatContext`) exposes **no thread or conversation ID** to third-party extensions. `ChatContext.history` only contains turns where `@chatwizard` was explicitly addressed — the user's 20 prior Copilot messages are invisible to CW. The `updatedAt` timestamp heuristic is unreliable when multiple AI tools are running, or when the extension starts cold (no baseline to compare against).  
    The correct source of truth is already in the watcher: every live update handler (`onClineFileChanged`, `onCursorFileChanged`, `mergeChronicleDataAsync`, etc.) already knows the exact session ID that just changed.
  - New class `LiveSessionTracker` in `src/utils/liveSessionTracker.ts`:
    - Stores `Map<SessionSource, { sessionId: string; updatedAt: Date }>` — one slot per source, updated on every live event.
    - `record(source: SessionSource, sessionId: string): void` — called by the watcher on every live upsert.
    - `getActive(windowMs?: number): Array<{ sessionId: string; source: SessionSource; updatedAt: Date }>` — returns entries updated within `windowMs` (default: `chatwizard.activeSessionWindowMinutes * 60_000`, fallback `120 * 60_000`), sorted by `updatedAt DESC`.
    - `getMostRecent(): { sessionId: string; source: SessionSource; updatedAt: Date } | undefined` — top entry regardless of window (used as a last resort when the window has expired).
    - Pure in-memory; no persistence needed — the watcher repopulates it on the first live event after a restart (typically within seconds of any new message).
  - Wire into the watcher: every path that calls `this.index.upsert(session)` for a live event (not the initial batch) also calls `this.liveTracker.record(session.source, session.id)`.
  - Pass the tracker reference down to the chat participant handler and the status bar button.

- [x] **13-H** — "Tag Active Session" — command palette + status bar entry point
  - **Problem this solves:** the primary real-world use case is tagging a session *while it is still in progress*, not after the fact from the history tree. All existing 13-D / 13-E entry points require navigating to a completed session in the tree.
  - `chatwizard.tagActiveSession` command:
    - Calls `liveTracker.getActive()`.
    - If exactly one entry: proceeds directly to the tag `InputBox` for that session (same UX as 13-D `chatwizard.addTag`).
    - If multiple entries (e.g. user has Copilot and Cursor both running): shows a `QuickPick` limited to those active entries, sorted most-recent first.
    - If no entries within the window: falls back to `liveTracker.getMostRecent()` with a hint `"Last active session was X minutes ago"`, then falls back further to the full `pickSessionId` picker if `getMostRecent()` is also undefined.
  - Status bar item `ActiveSessionTagButton` (`src/ui/activeSessionTagButton.ts`):
    - Receives the `LiveSessionTracker` reference.
    - On `liveTracker.onDidUpdate` event: checks `getActive()` — shows `$(tag) Tag session` when at least one entry qualifies, hides otherwise.
    - Tooltip: `"Tag the active chat session"`. Click fires `chatwizard.tagActiveSession`.
    - Disposes cleanly on extension deactivate.
  - Register `chatwizard.tagActiveSession` in `package.json` under `contributes.commands` with title `"ChatWizard: Tag Active Session"` and in the Command Palette (no `when` guard).

- [x] **13-I** — `/tag` chat participant command (inline tagging from Copilot chat)
  - **Problem this solves:** Copilot users are already in the chat panel. Requiring them to leave the chat, find the tree item, and right-click breaks flow. `/tag` meets them where they are.
  - New command handler `handleTagCommand` in `src/mcp/chatParticipant.ts`, invoked when the user types `/tag` in the `@chatwizard` participant.
  - Input parsing: everything after `/tag` is treated as a comma-separated tag list (same normalisation as 13-D — lowercase, trim, strip leading `#` for storage).
    - Example: `/tag #bugfix, topic:auth` → stores `['bugfix', 'topic:auth']`.
    - Empty input (bare `/tag` with no arguments): responds with `"Usage: /tag label1, label2  — e.g. /tag #bugfix, topic:auth"`.
  - Session resolution: calls `liveTracker.getActive()` (from 13-G). Because `@chatwizard /tag` itself triggers a watcher update (Copilot writes the `/tag` message to Chronicle within seconds), the tracker will have the current session ID by the time the async handler runs. If needed, the handler can `await` a short `refreshSessionById` call first to flush the watcher.
  - On success: responds with a confirmation Markdown message in the chat stream, e.g.:
    > Tagged **"Fix auth middleware regression"** with `#bugfix`, `topic:auth`.
  - On ambiguity: responds listing the candidates and asking the user to use `chatwizard.tagActiveSession` from the command palette to disambiguate.
  - No side effects on the chat session itself — tag is written only to `chatwizard-metadata.json` via `MetadataStore`.

### Unit Tests

- [ ] `MetadataStore.load` — returns empty schema for missing file, correctly parses existing file.
- [ ] `MetadataStore.addTag` — adds tag, deduplicates, persists to disk.
- [ ] `MetadataStore.removeTag` — removes existing tag, no-op for absent tag.
- [ ] `MetadataStore.getAllTags` — returns sorted-by-count list, counts are accurate.
- [ ] `MetadataStore.save` — atomic write (file exists and is valid even if process is killed mid-write — test by inspecting tmp file lifecycle).
- [ ] Pin migration — existing pins appear as `pinned: true` in metadata store after migration, migration does not run twice.
- [ ] `SessionTreeProvider` tag chip rendering — 3 tags shown as chips, 4th tag causes `+1 more` overflow.
- [ ] Tag filter — tree shows only tagged sessions when filter active, all sessions when filter cleared.
- [ ] Tag normalization — `"  #Auth "` → stored as `"auth"`, displayed as `#auth`.
- [ ] `LiveSessionTracker.record` + `getActive` — single source returns one entry, two sources return two entries sorted by recency, entries older than window are excluded, window default applied.
- [ ] `LiveSessionTracker.getMostRecent` — returns most recently recorded entry regardless of window; returns `undefined` when tracker is empty.
- [ ] `ActiveSessionTagButton` — visible after a `liveTracker.onDidUpdate` event within the window, hidden when no entries qualify, disposes without error.
- [ ] `/tag` command — single tag stored correctly, comma-separated list stored correctly, empty input returns usage hint, ambiguous session (multiple active sources) returns disambiguation message.

### E2E Tests

- [ ] **Scenario: add a tag via right-click** — tag appears in tree item description and session reader header after adding.
- [ ] **Scenario: remove a tag** — tag disappears from tree item and reader after removing.
- [ ] **Scenario: filter by tag** — tree shows only sessions with the selected tag; view title shows filter indicator.
- [ ] **Scenario: tag persists across restart** — after adding a tag and restarting VS Code, the tag is still visible.
- [ ] **Scenario: pin migration** — after first upgrade, existing pinned sessions still show as pinned in the tree.
- [ ] **Scenario: tag active session via command palette** — while a chat is open and updating, `chatwizard.tagActiveSession` pre-selects the current session; tag is stored and visible in the tree within seconds.
- [ ] **Scenario: tag active session via status bar** — `$(tag) Tag session` button appears in the status bar while a session is live; clicking it opens the tag input; button disappears after the session has been idle longer than the window.
- [ ] **Scenario: `/tag` in Copilot chat** — typing `@chatwizard /tag #bugfix` in the chat panel tags the current Copilot session and returns a confirmation message in the chat response.
- [ ] **Scenario: `/tag` with no active session** — when no session has been updated within the window, the participant responds with a disambiguation message rather than silently failing.

### Manual Tests

1. Right-click a session, choose "Add Tag…". Type `topic:auth, #bugfix`. Verify both tags appear as chips on the tree item (max 3 shown inline).
2. With 4+ tags on a session, verify `+1 more` overflow chip appears and hovering the tree item shows all tags in the tooltip.
3. Run "Filter by Tag…" from the command palette. Select `#bugfix`. Verify the tree is filtered and a clear-filter button appears in the view title.
4. Clear the tag filter. Verify all sessions reappear immediately.
5. Close and reopen VS Code. Verify the tags added in step 1 are still present.
6. Open a session in the reader. Verify tags appear in the header, consistent with what the tree shows.
7. _(Potential bug surface)_ Add a tag that is just whitespace or an empty string. Verify it is silently ignored (not stored as an empty tag).
8. _(Potential bug surface)_ Two VS Code windows open simultaneously with the same workspace. Add a tag in window A. Verify window B reflects the change within a few seconds (file-watcher on metadata JSON).
9. _(Potential bug surface)_ Tag with emoji (`🔥fix`). Verify it round-trips without corruption and displays correctly in tree and webview.
10. While actively using Copilot chat, run "ChatWizard: Tag Active Session" from the command palette. Verify the input pre-selects (or auto-identifies) the current session without requiring manual selection from a full list.
11. Open the status bar while a chat is running. Verify `$(tag) Tag session` is visible. Wait until the session has been idle for longer than `chatwizard.activeSessionWindowMinutes`. Verify the button disappears.
12. In the Copilot chat panel, type `@chatwizard /tag topic:refactor`. Verify the chat response confirms the tag and the session tree shows `#topic:refactor` on the current session within seconds.
13. Type `@chatwizard /tag` with no labels. Verify the response is a usage hint, not an error.

### Completion Checklist

- [ ] All atomic tasks (13-A through 13-I) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] `work-plan-kb-and-tagging.md` Phase 0 + Phase 1 tasks marked complete
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 14 — Chat Participant: Clickable File Links

**Effort:** S  
**Prerequisite:** Chronicle Phase 2 (`important_files` field populated on `Session` objects from `checkpoints.important_files`).

### Overview

Replace plain-text file paths in `/continueFromHistory` output with VS Code native `stream.anchor()` file pills. "Last time you were editing `jwtHandler.ts`" becomes a one-click link.

### Atomic Tasks

- [ ] **14-A** — Surface `important_files` on `Session`
  - In `src/parsers/copilotChronicle.ts` (or Chronicle reader), map `checkpoints.important_files` to a `string[]` field `session.importantFiles`.
  - Deserialize the field (it may be stored as a JSON string or delimited list — probe the schema and handle both).
  - Field is `undefined` for non-Chronicle sessions.

- [ ] **14-B** — `stream.anchor()` emission in `/continueFromHistory`
  - In `src/mcp/chatParticipant.ts`, after building the continuation summary:
  - For each path in `session.importantFiles`, resolve it against the Chronicle `sessions.repository` root (or `vscode.workspace.workspaceFolders[0]`).
  - If the file exists on disk: emit `stream.anchor(vscode.Uri.file(absPath), basename)`.
  - If the file does not exist: fall back to `stream.markdown(\`\`${basename}\`\`)` (no broken pill).
  - Order: emit anchors before the continuation text so the most actionable content is first.

- [ ] **14-C** — Path resolution for `important_files`
  - `src/utils/fileAnchorResolver.ts` — `resolveAnchorPath(relPath: string, repoRoot: string | undefined, workspaceFolders: readonly vscode.WorkspaceFolder[]): vscode.Uri | undefined`.
  - Try absolute path first; then relative to `repoRoot`; then relative to each workspace folder; return `undefined` if not found.
  - No VS Code dependency in the resolution logic itself — accepts strings and returns a string so it can be unit-tested.

### Unit Tests

- [ ] `copilotChronicle` parser — `important_files` populated when Chronicle data present, `undefined` when absent.
- [ ] `fileAnchorResolver.resolveAnchorPath` — absolute path resolves directly, relative path resolves against repoRoot, relative path resolves against workspace folder, unresolvable path returns `undefined`.
- [ ] `/continueFromHistory` handler — when `importantFiles` has valid paths, `stream.anchor` is called once per file; when paths don't exist on disk, `stream.markdown` is called instead.

### E2E Tests

- [ ] **Scenario: `/continueFromHistory` on a Chronicle-backed session** — output contains blue file pill links for the important files.
- [ ] **Scenario: important file no longer on disk** — output shows filename as inline code, no broken pill link, no error.
- [ ] **Scenario: non-Chronicle session** — output unchanged (no anchors, no errors).

### Manual Tests

1. Run `/continueFromHistory` in the chat panel for a recent Copilot session. Verify that files listed under "last time you were editing" appear as blue pill links, not plain text.
2. Click one of the blue pill links. Verify it opens the correct file in the editor.
3. Move or delete one of the files listed. Run `/continueFromHistory` again. Verify the deleted file appears as `filename.ts` (inline code) and does not produce an error message.
4. Run `/continueFromHistory` on a Claude or Cursor session (no Chronicle data). Verify output is unchanged from the current behaviour.
5. _(Potential bug surface)_ Chronicle `important_files` contains an absolute Windows path when running on macOS (developer switching machines). Verify the path normaliser falls back to workspace-relative lookup and either resolves or gracefully falls back to inline code.

### Completion Checklist

- [ ] All atomic tasks (14-A through 14-C) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 15 — Continue.dev Source Support

**Effort:** M  
**Prerequisite:** None — fully parallel with all other new source features (16, 17).

### Overview

Index AI conversations stored by Continue.dev at `~/.continue/sessions/`. Continue.dev has 100K+ VS Code installs and uses a well-defined JSONL format.

### Atomic Tasks

- [ ] **15-A** — Format research & fixture creation
  - Read a sample of real `~/.continue/sessions/*.jsonl` files.
  - Document the schema: message roles, timestamp field, model field, session ID structure.
  - Create two fixture files in `test/fixtures/continue/` — one minimal (2 messages), one large (50+ messages, multi-model).

- [ ] **15-B** — `ContinueWorkspace` discovery
  - New file `src/readers/continueWorkspace.ts`.
  - Platform-aware base path: `~/.continue/sessions/` (all platforms).
  - Returns `WorkspaceInfo[]` with source `'continue'` and the absolute sessions directory path.
  - Respects `chatwizard.continueStoragePath` override setting for non-standard installs.

- [ ] **15-C** — `ContinueParser`
  - New file `src/parsers/continueParser.ts`.
  - Maps Continue.dev JSONL message format to `Session` type.
  - Handles: role mapping (`human`/`assistant` or `user`/`assistant`), timestamp parsing, model name extraction, graceful skipping of malformed lines.
  - Deduplicates sessions by conversation ID if Continue uses UUIDs.

- [ ] **15-D** — Source registration and wiring
  - Register `ContinueWorkspace` and `ContinueParser` in `SessionIndex` and `extension.ts` startup chain.
  - Add Continue to the `SessionSource` type union and `SOURCE_LABELS` map.
  - Wire into file watcher for live updates.

- [ ] **15-E** — UI: analytics, filter, badge
  - Add `'continue'` to the analytics panel source cards.
  - Add `'continue'` to the timeline source filter dropdown.
  - Add `'continue'` to the search-panel source cycle.
  - Add CSS variable `--cw-source-continue` with an appropriate brand colour (Continue uses teal/green — pick `#5cad8a` or check current branding).

### Unit Tests

- [ ] `ContinueParser` — parses minimal fixture, parses large fixture (all messages present), malformed line skipped silently, correct session ID assigned.
- [ ] `ContinueParser` — role mapping (`human` and `user` both map to `'user'`), timestamp is a valid `Date`.
- [ ] `ContinueWorkspace` discovery — returns workspace when `~/.continue/sessions/` exists, returns `[]` when absent.
- [ ] `ContinueWorkspace` — respects `chatwizard.continueStoragePath` override.
- [ ] Source registration — `chatwizard_list_sources` MCP tool includes `'continue'` when sessions are indexed.

### E2E Tests

- [ ] **Scenario: Continue.dev sessions present** — sessions appear in the session tree with the Continue source badge and correct dates.
- [ ] **Scenario: filter by Continue source** — source filter correctly shows only Continue sessions.
- [ ] **Scenario: analytics panel** — Continue card shows correct session count.
- [ ] **Scenario: `chatwizard_search` on Continue session content** — returns relevant Continue sessions.
- [ ] **Scenario: Continue sessions absent** — extension starts without error, `chatwizard_list_sources` does not include `'continue'`.

### Manual Tests

1. Install Continue.dev, start a conversation, and verify ChatWizard indexes it within a few seconds (live watcher).
2. Open the analytics panel. Verify the Continue source card shows the correct session count.
3. Use the source filter in the search panel to filter to Continue only. Verify only Continue sessions appear.
4. Open a Continue session in the reader. Verify messages render correctly with correct role attribution (user vs. assistant).
5. Run `chatwizard_get_context` from an MCP client on a topic you discussed in Continue. Verify the Continue session is returned alongside Copilot/Claude results.
6. _(Potential bug surface)_ Continue.dev session file that is still being written (session in progress). Verify partial JSONL does not crash the parser — the valid lines are parsed and the partial line is skipped.
7. _(Potential bug surface)_ Continue.dev configured with a non-standard storage path. Verify `chatwizard.continueStoragePath` override works correctly.
8. _(Potential bug surface)_ Continue.dev session with a very long single message (e.g. pasted 5,000-line file). Verify it is indexed and searchable (not truncated silently and losing the session).

### Completion Checklist

- [ ] All atomic tasks (15-A through 15-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] Continue.dev added to README "Supported Sources" list
- [ ] `chatwizard.continueStoragePath` setting in `package.json` with documentation
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 16 — Amazon Q Developer Source Support

**Effort:** M  
**Prerequisite:** None — fully parallel with features 15 and 17.

### Overview

Index conversations from Amazon Q Developer (formerly AWS CodeWhisperer). Targets enterprise AWS shops; direct entry point for the corporate tier.

### Atomic Tasks

- [ ] **16-A** — Format research & fixture creation
  - Locate Amazon Q Developer session storage on each platform (likely under `~/.aws/amazonq/` or `%APPDATA%\Amazon Q\`). Document exact paths.
  - Identify format: JSON, JSONL, SQLite, or proprietary.
  - Create two fixture files in `test/fixtures/amazonq/`.
  - If format is undocumented, probe the running extension's VS Code storage via `globalStorageUri` for the `Amazon.amazon-q-vscode` extension ID.

- [ ] **16-B** — `AmazonQWorkspace` discovery
  - New file `src/readers/amazonQWorkspace.ts`.
  - Platform-aware base paths for Windows, macOS, Linux.
  - Respects `chatwizard.amazonQStoragePath` override.

- [ ] **16-C** — `AmazonQParser`
  - New file `src/parsers/amazonQParser.ts`.
  - Maps Amazon Q message format to `Session` type.
  - Handle known quirks (if found during research): multi-turn vs. inline completions, context panel vs. chat panel conversations.

- [ ] **16-D** — Source registration and wiring
  - Register in `SessionIndex` and `extension.ts`.
  - Add `'amazonq'` to `SessionSource` and `SOURCE_LABELS`.
  - Wire into file watcher.

- [ ] **16-E** — UI: analytics, filter, badge
  - Add `'amazonq'` to all source UI surfaces.
  - CSS variable `--cw-source-amazonq` with AWS orange (`#FF9900`).

### Unit Tests

- [ ] `AmazonQParser` — parses minimal fixture, malformed input handled, correct role mapping.
- [ ] `AmazonQWorkspace` — discovers sessions when directory exists, returns `[]` when absent, respects override setting.
- [ ] Source registration — `chatwizard_list_sources` includes `'amazonq'` when sessions present.

### E2E Tests

- [ ] **Scenario: Amazon Q sessions present** — sessions appear in tree with correct badge.
- [ ] **Scenario: source filter and analytics** — Amazon Q sessions filterable and counted correctly.
- [ ] **Scenario: Amazon Q absent** — no error at startup.

### Manual Tests

1. Start an Amazon Q Developer conversation in VS Code. Verify ChatWizard picks it up (may require knowing the actual storage path — document it in the work item during 16-A).
2. Open the indexed session in the reader. Verify the conversation renders correctly.
3. Search for content from the Amazon Q session. Verify it appears in results.
4. _(Potential bug surface)_ Amazon Q may store both inline code completions and chat conversations in the same store. Verify only chat conversations are indexed (completions are not meaningful as sessions).
5. _(Potential bug surface)_ Amazon Q may require AWS credentials to be active. Verify ChatWizard can read the session files even when the user is logged out of AWS.

### Completion Checklist

- [ ] All atomic tasks (16-A through 16-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] Amazon Q added to README "Supported Sources" list
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 17 — Gemini Code Assist Source Support

**Effort:** M  
**Prerequisite:** None — fully parallel with features 15 and 16.

### Overview

Index conversations from the Google Gemini Code Assist VS Code extension. Gemini Code Assist is a direct GitHub Copilot competitor with fast-growing adoption.

### Atomic Tasks

- [ ] **17-A** — Format research & fixture creation
  - Locate Gemini Code Assist session storage. Check `globalStorageUri` for `google.google-cloud-code` or the Gemini Code Assist extension ID. Also check `~/.gemini/` (shared with Antigravity).
  - Distinguish Gemini Code Assist (VS Code extension) from Antigravity (CLI) storage paths.
  - Create two fixture files in `test/fixtures/geminiCodeAssist/`.

- [ ] **17-B** — `GeminiCodeAssistWorkspace` discovery
  - New file `src/readers/geminiCodeAssistWorkspace.ts`.
  - Platform-aware discovery. Must not conflict with the existing `antigravityWorkspace.ts` path discovery.
  - Respects `chatwizard.geminiCodeAssistStoragePath` override.

- [ ] **17-C** — `GeminiCodeAssistParser`
  - New file `src/parsers/geminiCodeAssistParser.ts`.
  - Maps format to `Session` type.
  - Handle: Gemini multi-turn JSON, model name (`gemini-1.5-pro`, `gemini-2.0-flash`, etc.).

- [ ] **17-D** — Source registration and wiring
  - Register in `SessionIndex` and `extension.ts`.
  - Add `'geminiCodeAssist'` to `SessionSource` and `SOURCE_LABELS`.
  - Wire into file watcher.

- [ ] **17-E** — UI: analytics, filter, badge
  - Add `'geminiCodeAssist'` to all source UI surfaces.
  - CSS variable `--cw-source-geminiCodeAssist` with Google blue (`#4285F4`).
  - Do not confuse with existing Antigravity badge colour.

### Unit Tests

- [ ] `GeminiCodeAssistParser` — parses minimal fixture, role mapping correct, model field populated.
- [ ] `GeminiCodeAssistWorkspace` — returns workspace when present, does not clash with Antigravity discovery.
- [ ] Source registration — `chatwizard_list_sources` includes `'geminiCodeAssist'`.

### E2E Tests

- [ ] **Scenario: Gemini Code Assist sessions present** — sessions in tree with correct badge and colour.
- [ ] **Scenario: analytics and filter** — sessions counted and filterable.
- [ ] **Scenario: Antigravity and Gemini Code Assist coexist** — both sources indexed without collision or double-counting.

### Manual Tests

1. Install Gemini Code Assist, start a conversation. Verify ChatWizard indexes it.
2. Open the session in the reader. Verify messages render and model name is displayed correctly.
3. Verify the source badge colour is distinct from Antigravity's badge.
4. _(Potential bug surface)_ Gemini Code Assist stores data in `~/.gemini/` alongside Antigravity. Verify path discrimination works — no Antigravity sessions appear under the Gemini Code Assist source and vice versa.
5. _(Potential bug surface)_ Gemini Code Assist session format may change between extension versions. Verify the parser fails gracefully (logs a warning, skips the file) rather than crashing the entire index build.

### Completion Checklist

- [ ] All atomic tasks (17-A through 17-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] Gemini Code Assist added to README "Supported Sources" list
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 18 — AI-Generated Session Summaries / Auto-Descriptions

**Effort:** M  
**Prerequisite:** Feature 13 (MetadataStore) for caching summaries. Chronicle Phase 1 for free Copilot-session summaries.

### Overview

Auto-generate a one-line summary for every session using a three-tier strategy: (1) Chronicle `checkpoints.overview` (free), (2) VS Code LM API via the user's Copilot subscription (no extra key), (3) offline TF-IDF heuristic fallback.

### Atomic Tasks

- [ ] **18-A** — Three-tier `SummaryGenerator`
  - New file `src/analytics/summaryGenerator.ts`.
  - `generate(session: Session): Promise<string>`:
    1. If `session.chronicle?.overview` exists → return it directly (no LLM).
    2. Else, call `vscode.lm.selectChatModels({ vendor: 'copilot' })`, pick the cheapest available model, send a one-shot prompt: `"Summarise this coding session in one sentence (max 15 words):\n\n<first 800 chars of session content>"`.
    3. If LM API unavailable or returns an error → fall back to TF-IDF heuristic: extract top-3 keywords from session content, return `"<keyword1>, <keyword2>, <keyword3>"`.
  - Rate-limit LM API calls: max 5 concurrent, with a 50 ms inter-call delay.
  - Never called during search or index build — only during the post-index background job.

- [ ] **18-B** — Background summary generation job
  - Runs after `buildInitialIndex()` completes, outside the critical path.
  - Processes sessions without a cached summary in batches of 20.
  - Skips sessions already summarized (checks `MetadataStore.getSession(id).summary`).
  - Pauses if the user starts typing in the editor (throttle via `onDidChangeTextDocument`).
  - Progress reported in the output channel, not the UI (silent by default).

- [ ] **18-C** — Summary displayed in session tree tooltip
  - `SessionTreeProvider`: `item.tooltip = new vscode.MarkdownString(summary)` when summary available.
  - No change to the tree item label itself (summary is not shown inline — too noisy).

- [ ] **18-D** — Summary displayed in session reader header
  - Add a `<p class="session-summary">` below the title in the session webview HTML template.
  - If no summary yet: omit the element (not a placeholder — silently absent until generated).

- [ ] **18-E** — "Regenerate Summary" context menu item
  - Command `chatwizard.regenerateSummary` available on session tree item right-click.
  - Clears cached summary for that session, re-runs `SummaryGenerator`, updates tree and reader.

- [ ] **18-F** — LM API rate limit and error handling
  - If the LM API returns a quota error: log to output channel, fall back to TF-IDF for remaining sessions in the current batch.
  - Never surface LM API errors as VS Code error notifications to the user.

### Unit Tests

- [ ] `SummaryGenerator` — Chronicle path returns `checkpoints.overview` without calling LM API.
- [ ] `SummaryGenerator` — LM API path called when no Chronicle data; result cached in MetadataStore.
- [ ] `SummaryGenerator` — TF-IDF fallback used when LM API unavailable (stub returns `undefined`).
- [ ] `SummaryGenerator` — TF-IDF fallback produces non-empty string for any non-empty session.
- [ ] Rate limiter — concurrent calls do not exceed 5 simultaneously (use fake timers).
- [ ] Background job — skips sessions with existing summaries, processes remaining sessions.
- [ ] "Regenerate" command — clears existing summary and triggers re-generation.

### E2E Tests

- [ ] **Scenario: Chronicle session** — summary appears in tree tooltip immediately (no LM call delay).
- [ ] **Scenario: non-Chronicle session** — summary appears in tree tooltip after background job completes (~seconds after startup).
- [ ] **Scenario: LM API unavailable** — TF-IDF fallback summary is used; no error notification shown to user.
- [ ] **Scenario: regenerate summary** — updated summary appears in tree tooltip and reader header.
- [ ] **Scenario: session reader** — summary paragraph visible in header when available.

### Manual Tests

1. After extension startup, wait 30 seconds, then hover over several sessions in the tree. Verify tooltips show one-line summaries.
2. For a Copilot session with Chronicle data: verify the summary appears instantly on hover (no delay — no LM call).
3. For a Claude session: verify a summary appears within ~10 seconds of startup (LM API path).
4. Right-click a session and choose "Regenerate Summary". Verify the new summary appears within a few seconds.
5. Open a session in the reader. Verify the summary appears in the header below the title.
6. _(Potential bug surface)_ The user has no active Copilot subscription (LM API returns auth error). Verify the TF-IDF fallback runs silently and no error appears in the UI.
7. _(Potential bug surface)_ A session with only code and no natural language (e.g. session consists entirely of a pasted 2,000-line file). Verify the TF-IDF heuristic produces a sensible summary (e.g. filename-based) rather than an empty string.
8. _(Potential bug surface)_ 5,000+ sessions to summarize. Verify the background job does not block the UI and VS Code remains responsive throughout.

### Completion Checklist

- [ ] All atomic tasks (18-A through 18-F) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 19 — Entity Extraction from Sessions

**Effort:** M  
**Prerequisite:** Feature 13 (MetadataStore) for storing extracted entities.

### Overview

Extract and index structured entities from session content post-indexing: file paths, function/class names, error codes/messages, and explicit decisions. Surface these as auto-generated read-only tags in the session reader and expose them as search filters.

### Atomic Tasks

- [ ] **19-A** — `EntityExtractor` utility
  - New file `src/analytics/entityExtractor.ts`.
  - `extract(session: Session): ExtractedEntities`:
    - **File paths**: regex `/([\w.\-/\\]+\.(ts|js|py|go|rs|java|cs|cpp|json|yaml|toml|md))/g` against all message content.
    - **Function/class names**: regex for common patterns — `function \w+`, `class \w+`, `` `\w+()` `` in backtick context.
    - **Error messages**: regex for common prefixes — `Error:`, `TypeError:`, `SQLITE_`, `ENOENT`, `4\d\d`, `5\d\d` HTTP codes.
    - **Decisions**: phrases matching `"I (decided|chose|will use|am going to) ..."`, `"we chose"`, `"the approach is"`.
  - Returns `ExtractedEntities: { filePaths: string[]; functionNames: string[]; errors: string[]; decisions: string[] }`.
  - Pure function — no I/O, fully unit-testable.

- [ ] **19-B** — `ExtractedEntities` schema in `SessionMetadata`
  - Extend the `SessionMetadata` interface to include `entities?: ExtractedEntities`.
  - Add `entitiesVersion: number` field — if the extractor is updated, bump the version and re-extract.

- [ ] **19-C** — Background extraction job
  - Runs after `buildInitialIndex()` and the summary generation job (lower priority).
  - Processes sessions without `entities` (or with outdated `entitiesVersion`) in batches of 50.
  - All I/O is to `MetadataStore` — pure local processing, no network.

- [ ] **19-D** — Entity-aware search extension
  - Extend `SearchEngine.search()` to accept optional `entityFilter: { type: EntityType; value: string }`.
  - When filter is active, pre-filter sessions by `metadata.entities[type].includes(value)` before full-text search.
  - Expose via `chatwizard_search` MCP tool: new optional `entityType` and `entityValue` parameters.

- [ ] **19-E** — Entity chips in session reader (read-only)
  - Session reader webview renders a collapsible "Entities" section listing extracted file paths, function names, and errors as chips.
  - Chips are not user-editable (auto-tags, distinct from user tags visually — use a different chip style with a `$(sparkle)` prefix).
  - File path chips are clickable: emit a `chatwizard.openFile` message back to the extension host to open the file.

### Unit Tests

- [ ] `EntityExtractor.extract` — file paths extracted from message text, function names extracted, error codes detected, decision phrases matched.
- [ ] `EntityExtractor.extract` — no false positives: code blocks that are not file paths are not extracted as file paths.
- [ ] `EntityExtractor.extract` — empty session returns `{ filePaths: [], functionNames: [], errors: [], decisions: [] }`.
- [ ] Background job — sessions processed correctly, `entitiesVersion` checked, already-extracted sessions skipped.
- [ ] Search with entity filter — returns only sessions containing the specified entity.
- [ ] `chatwizard_search` MCP tool — `entityType` + `entityValue` filters applied correctly.

### E2E Tests

- [ ] **Scenario: entity chips in session reader** — open a session that mentioned several file paths; verify those paths appear as chips in the Entities section.
- [ ] **Scenario: clickable file chip** — clicking a file path chip in the reader opens the file in the editor.
- [ ] **Scenario: entity-filtered MCP search** — `chatwizard_search` with `entityType: "filePaths", entityValue: "auth.ts"` returns only sessions that mentioned `auth.ts`.
- [ ] **Scenario: no entities** — session with only prose content shows no Entities section (not an empty section).

### Manual Tests

1. Open a session where you discussed several files by name. Verify those file names appear as chips in the Entities section of the reader.
2. Click a file path chip. Verify the file opens in the editor.
3. From an MCP client, call `chatwizard_search` with `entityType: "errors", entityValue: "SQLITE_BUSY"`. Verify sessions mentioning that error are returned.
4. Run `chatwizard_search` with `entityType: "decisions"`. Verify sessions containing decision phrases are returned and ranked higher.
5. _(Potential bug surface)_ A session where someone pastes a code block containing many function names. Verify function names extracted from inside code blocks are ranked lower or distinguished from those mentioned in prose (to avoid noise).
6. _(Potential bug surface)_ 10,000+ sessions to process. Verify the extraction job completes without exhausting memory and does not block the UI.
7. _(Potential bug surface)_ Extractor updated (version bumped). Verify existing entity caches are invalidated and re-extracted on next startup without requiring a manual action.

### Completion Checklist

- [ ] All atomic tasks (19-A through 19-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] `chatwizard_search` MCP tool documentation updated with `entityType`/`entityValue` params
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 20 — Prompt Cost Analysis

**Effort:** M  
**Prerequisite:** None — fully self-contained. Full background in `work-plan-cost-effective-prompts.md`.

### Overview

Local, zero-LLM prompt analysis: token count estimate, similarity check against session history, verbosity heuristics, multi-question detection, model selection suggestion. Exposed as `@chatwizard /analyzePrompt` and `ChatWizard: Analyze Selected Prompt` command.

### Atomic Tasks

- [ ] **20-A** — Local tokenizer
  - New file `src/utils/tokenizer.ts`.
  - GPT-4/Claude BPE-compatible tokenizer using a pre-bundled vocabulary file (≤ 100 KB gzipped, no network call).
  - `countTokens(text: string): number` — synchronous.
  - `estimateCost(tokens: number, model: ModelId): { inputUsd: number; outputUsd: number }` — uses a hardcoded price table; price table is a `const` object to allow easy updates.

- [ ] **20-B** — `PromptAnalyzer` orchestrator
  - New file `src/analytics/promptAnalyzer.ts`.
  - `analyze(draftPrompt: string): PromptAnalysis`:
    - Token count via 20-A.
    - Similarity check: call `SemanticIndexer.findSimilar(draftPrompt, 3)` — returns top-3 historical sessions with similarity score.
    - Verbosity flags: large code block pasted (`/```[\s\S]{500,}```/`), open-ended scope phrases (`/list all|explain everything|write a complete/i`), multiple questions (`/\?[^?]*\?/`).
    - Model suggestion: if token count < 500 and no code block → suggest `gpt-4o-mini` or `claude-haiku`.
  - Returns `PromptAnalysis: { tokenCount, estimatedCostUsd, similarSessions, flags, modelSuggestion }`.
  - Synchronous for the heuristic parts; async for similarity check.

- [ ] **20-C** — `@chatwizard /analyzePrompt` chat participant command
  - Registered in `chatParticipant.ts` as a new command handler for `/analyzePrompt`.
  - Input: the user's prompt text (the content of the chat input after `/analyzePrompt`).
  - Output via `stream.markdown()`:
    - Token count and estimated cost: `"~1,240 tokens · est. $0.04 at Sonnet rates"`.
    - If similar sessions found: `"You asked something very similar on [date] — review before sending?"` with session links.
    - Verbosity flags: one actionable tip per flag detected.
    - Model suggestion if a cheaper model is appropriate.
  - Does **not** send the prompt anywhere; zero LLM calls.

- [ ] **20-D** — `ChatWizard: Analyze Selected Prompt` editor command
  - Registered in `package.json` as an editor context menu command when text is selected.
  - Reads the selection, calls `PromptAnalyzer.analyze()`, shows results in a VS Code information message with "View Details" button (opens a webview panel with full analysis).
  - Works regardless of which file the selection is in.

- [ ] **20-E** — Price table maintenance helper
  - `src/utils/modelPriceTable.ts` — exported `const PRICE_TABLE` with input/output USD-per-million-token rates for: `gpt-4o`, `gpt-4o-mini`, `claude-3-5-sonnet`, `claude-3-haiku`, `gemini-1.5-pro`, `gemini-2.0-flash`.
  - Price table is the single source of truth — used by both 20-A and future post-session cost tips (Feature 37/P3).
  - Include a comment: `// Last updated: <date>` to make staleness obvious.

### Unit Tests

- [ ] `tokenizer.countTokens` — known strings return expected counts (cross-check against published tiktoken results), empty string returns 0.
- [ ] `tokenizer.estimateCost` — correct USD values for a known token count and model.
- [ ] `PromptAnalyzer.analyze` — verbosity flag detected for pasted code block, multi-question detected, model suggestion triggered for short prompts.
- [ ] `PromptAnalyzer.analyze` — similar sessions detected when semantic index contains a matching session.
- [ ] `PromptAnalyzer.analyze` — no flags, no model suggestion for a clean focused prompt.
- [ ] `/analyzePrompt` handler — streams correct markdown output, does not call any LLM.
- [ ] Price table — all expected models present; no model has zero cost (would indicate a stale entry).

### E2E Tests

- [ ] **Scenario: `/analyzePrompt` with a verbose prompt** — verbosity flags and model suggestion appear in the chat response.
- [ ] **Scenario: `/analyzePrompt` with a similar past query** — past session links appear in the response.
- [ ] **Scenario: `Analyze Selected Prompt` command** — selecting text in an editor and running the command shows the analysis notification.
- [ ] **Scenario: clean minimal prompt** — no flags, no suggestions — response says `"Looks good — well-scoped prompt"`.

### Manual Tests

1. Type `@chatwizard /analyzePrompt explain everything about the authentication system in this codebase in detail`. Verify the response flags the open-ended scope and suggests restricting output.
2. Paste a 100-line code block into `/analyzePrompt`. Verify a tip appears suggesting to reference the file by path instead.
3. Type `/analyzePrompt How do I fix the login bug?` (a query you have asked before). Verify a past-session similarity link appears.
4. Select a short, focused prompt in a text file. Run "ChatWizard: Analyze Selected Prompt". Verify the information message shows the token count and cost estimate.
5. Verify no network request is made during any analysis (check the Network tab / Charles proxy or simply verify it works while offline).
6. _(Potential bug surface)_ The price table is out of date (models change pricing). Verify the hardcoded cost is clearly labeled as an estimate and includes a "Last updated" notice so users know it may not be current.
7. _(Potential bug surface)_ The draft prompt is in a non-English language. Verify the tokenizer handles multi-byte characters without crashing (BPE handles UTF-8 natively).

### Completion Checklist

- [ ] All atomic tasks (20-A through 20-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] `/analyzePrompt` command documented in README chat participant commands section
- [ ] `ChatWizard: Analyze Selected Prompt` in README command palette section
- [ ] `work-plan-cost-effective-prompts.md` tasks marked complete
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 21 — MCP Phase II: Reranker for `chatwizard_get_context`

**Effort:** M  
**Prerequisite:** None — additive to the existing MCP server. Full background in `work-plan-mcp-server-phase-II.md`.

### Overview

Add an optional cross-encoder reranker pass after the semantic + keyword merge in `GetContextTool`. The cross-encoder scores each candidate against the query a second time, resolving rank disagreements. Gated behind a config flag (off by default).

### Atomic Tasks

- [ ] **21-A** — Cross-encoder model selection
  - Evaluate `ms-marco-MiniLM-L-6-v2` (ONNX, ~23 MB quantized) for accuracy and latency.
  - Benchmark: time 50-candidate reranking on Windows/macOS/Linux test machines.
  - Document: model file size, median latency per call, accuracy gain vs. bi-encoder-only (use existing `test/fixtures/` sessions as a retrieval evaluation set).
  - Decision output: if latency > 300 ms median or model > 40 MB, propose an alternative.

- [ ] **21-B** — `Reranker` class
  - New file `src/search/reranker.ts`.
  - `Reranker.score(query: string, candidates: ScoredSession[]): Promise<ScoredSession[]>`:
    - Runs cross-encoder inference (ONNX Runtime) on `(query, candidate.passage)` pairs.
    - Returns candidates re-sorted by cross-encoder score descending.
  - Constructor takes `modelPath: string` — resolved from extension resources at startup.
  - Exposes `isReady(): boolean` — returns false before ONNX model is loaded or if load failed.
  - If `isReady()` is false: `score()` returns `candidates` unchanged (passthrough, no error).

- [ ] **21-C** — Per-platform ONNX build & CI integration
  - Add `onnxruntime-node` to dependencies (already present for the bi-encoder — verify version compatibility).
  - Add the cross-encoder ONNX model file to `resources/models/reranker.onnx`.
  - Update `scripts/rebuild-native.js` to include the reranker model path.
  - Update CI to run the build on Windows, macOS, and Linux runners.

- [ ] **21-D** — Wire reranker into `GetContextTool`
  - After the existing merge step, if `chatwizard.mcp.reranker.enabled` is `true` and `reranker.isReady()`, call `reranker.score()`.
  - Config flag: `chatwizard.mcp.reranker.enabled` (default: `false`).
  - Add timing instrumentation: log `[Reranker] N candidates reranked in Xms` to output channel.

- [ ] **21-E** — Latency benchmarks and accuracy tests
  - `test/e2e/reranker.test.ts`:
    - Load the ONNX model, score 50 candidates against a known query.
    - Assert: time elapsed < 500 ms.
    - Assert: the known most-relevant session is ranked #1 by the reranker (use a fixture where the answer is known).

### Unit Tests

- [ ] `Reranker.isReady` — returns `false` before model loaded, `true` after successful load.
- [ ] `Reranker.score` — passthrough when `isReady()` is false (unchanged order, no error).
- [ ] `Reranker.score` — correct reranking with a mock scoring function (unit-level, no ONNX dependency).
- [ ] `GetContextTool` — when reranker disabled, output order unchanged vs. current behaviour.
- [ ] `GetContextTool` — when reranker enabled and ready, output is re-sorted by cross-encoder score.
- [ ] Config flag — changing `chatwizard.mcp.reranker.enabled` takes effect on next tool call without restart.

### E2E Tests

- [ ] **Scenario: reranker disabled (default)** — `chatwizard_get_context` behaviour unchanged, latency baseline established.
- [ ] **Scenario: reranker enabled** — results are reranked; benchmark asserts < 500 ms for 50 candidates.
- [ ] **Scenario: ONNX model file missing** — `isReady()` returns false, tool falls back gracefully (no crash, no user-visible error).

### Manual Tests

1. Enable `chatwizard.mcp.reranker.enabled: true`. Query `chatwizard_get_context` on a topic where you know the most relevant session. Verify it now appears as the first result (or higher than before).
2. Observe the output channel after the query. Verify the timing log line appears (e.g. `[Reranker] 18 candidates reranked in 87ms`).
3. With a large index (100+ sessions), measure wall-clock time from MCP call to response. Verify the reranker adds less than 500 ms to total latency.
4. Disable the reranker (`chatwizard.mcp.reranker.enabled: false`). Verify the next call reverts to the original (unreranked) order.
5. _(Potential bug surface)_ Reranker called concurrently by multiple MCP clients simultaneously. Verify no race condition on the shared ONNX session object (use a mutex or `Promise` queue if needed).
6. _(Potential bug surface)_ Reranker model file is present but corrupt. Verify ONNX runtime error is caught and `isReady()` returns false, not a runtime crash.

### Completion Checklist

- [ ] All atomic tasks (21-A through 21-E) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green (including latency benchmark passing)
- [ ] Manual tests performed and all issues fixed
- [ ] `work-plan-mcp-server-phase-II.md` Item 1 marked complete
- [ ] `chatwizard.mcp.reranker.enabled` documented in README MCP configuration section
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Feature 22 — Obsidian / Notion Native Export

**Effort:** S  
**Prerequisite:** None — self-contained export feature.

### Overview

Export curated sessions as Obsidian-compatible Markdown (YAML frontmatter, wikilinks) and optionally to Notion via the public Notion API (user provides their own API key — never required, never stored in settings.json).

### Atomic Tasks

- [ ] **22-A** — `ObsidianExporter`
  - New file `src/export/obsidianExporter.ts`.
  - `export(sessions: Session[], targetDir: string): Promise<ExportResult>`:
    - One `.md` file per session in `targetDir/chatwizard/<source>/YYYY-MM-DD-<title-slug>.md`.
    - YAML frontmatter: `title`, `source`, `date`, `tags` (from MetadataStore if available), `summary`, `chatwizard_id`.
    - Body: session messages as Markdown, user turns prefixed with `**You:**`, assistant turns with `**Assistant:**`.
    - Wikilinks: file paths found in session content are emitted as `[[filename]]` wikilinks.
    - Backlinks section at the end: lists any other exported sessions that mention the same file paths.
  - `ExportResult: { exported: number; skipped: number; errors: string[] }`.

- [ ] **22-B** — `ChatWizard: Export to Obsidian` command
  - `vscode.window.showOpenDialog` to pick a target folder (must be an existing directory).
  - `vscode.window.showQuickPick` to choose scope: "All sessions", "Pinned sessions only", "Tagged sessions…" (opens tag QuickPick).
  - Calls `ObsidianExporter.export()`, shows a notification: `"Exported 47 sessions to ~/Documents/MyVault/chatwizard"` with an `[Open Folder]` action.

- [ ] **22-C** — `NotionExporter`
  - New file `src/export/notionExporter.ts`.
  - Uses the Notion public API (`https://api.notion.com/v1/`) — user provides their own API key and target database ID.
  - `export(session: Session, databaseId: string, apiKey: string): Promise<void>`:
    - Creates one Notion page per session.
    - Page title: session title; properties: source, date, tags, summary.
    - Body: session content as Notion blocks (paragraph blocks per message; code blocks as Notion code blocks).
  - API key stored in `context.secrets` (VS Code `SecretStorage`) — never in `settings.json` or `chatwizard-metadata.json`.
  - Rate-limit: 3 requests per second (Notion API limit).

- [ ] **22-D** — `ChatWizard: Export to Notion` command
  - If API key not stored: prompt for it via `vscode.window.showInputBox({ password: true })`, store in `SecretStorage`.
  - If database ID not stored: prompt for it; store in `globalStorageUri/notion-config.json` (not a secret).
  - Scope picker same as Obsidian command.
  - Progress notification: `vscode.window.withProgress()` showing export progress.
  - "Forget API Key" secondary command for credential reset.

### Unit Tests

- [ ] `ObsidianExporter` — YAML frontmatter contains all required fields, session messages rendered correctly, wikilinks generated for file paths found in content.
- [ ] `ObsidianExporter` — title slug generated correctly (special chars stripped, spaces to hyphens, max 60 chars).
- [ ] `ObsidianExporter` — `ExportResult` counts are accurate for a mixed success/skip batch.
- [ ] `NotionExporter` — session converted to correct Notion blocks (paragraph per message, code block for fenced code).
- [ ] `NotionExporter` — API key read from `SecretStorage`, never from config.
- [ ] `NotionExporter` — rate limiter: third consecutive call within 1 second is queued, not dropped.
- [ ] Notion credential reset command — clears key from `SecretStorage`.

### E2E Tests

- [ ] **Scenario: export to Obsidian** — files created at correct paths with valid YAML frontmatter and Markdown content.
- [ ] **Scenario: Obsidian export filtered to pinned sessions** — only pinned sessions are exported.
- [ ] **Scenario: export to Notion** — Notion API called once per session with correct block structure (use a local mock of the Notion API endpoint).
- [ ] **Scenario: Notion API key not set** — prompt shown, key stored in SecretStorage, subsequent export skips the prompt.

### Manual Tests

1. Run `ChatWizard: Export to Obsidian`, pick a folder (ideally your actual Obsidian vault). Verify exported `.md` files open in Obsidian with correct frontmatter, readable content, and wikilinks pointing to real files in the vault.
2. Re-run the Obsidian export. Verify existing files are overwritten (not duplicated).
3. Run `ChatWizard: Export to Notion`. Enter a valid API key and database ID. Verify pages appear in Notion with correct title, source, date, and content blocks.
4. Verify the Notion API key is **not** stored in `settings.json` or any file that would be committed to git.
5. Run `ChatWizard: Forget Notion API Key`. Verify the next export prompts for the key again.
6. _(Potential bug surface)_ Session title contains characters invalid for a filename (e.g. `:`). Verify the Obsidian filename slug strips or replaces those characters and the file is created successfully.
7. _(Potential bug surface)_ Notion API rate limit hit (more than 3 requests/second). Verify the exporter slows down and completes without an API error appearing to the user.
8. _(Potential bug surface)_ Notion database ID is malformed (not a UUID). Verify a clear error message is shown ("Invalid database ID format") rather than a generic HTTP error.

### Completion Checklist

- [ ] All atomic tasks (22-A through 22-D) implemented and code-reviewed
- [ ] All unit tests green
- [ ] All e2e tests green
- [ ] Manual tests performed and all issues fixed
- [ ] Both export commands documented in README
- [ ] Notion API key security note added to README (stored in SecretStorage, not settings)
- [ ] ⬜ → ✅ in this document and `whats-next.md`

---

## Cross-Feature Notes

### Shared Prerequisites

Several features depend on the **sidecar MetadataStore** (Feature 13-A). Build this first if features 13, 18, and 19 are to run in parallel — they all write to `chatwizard-metadata.json`. The store must handle concurrent writes safely (the atomic-write + in-memory cache pattern in 13-A is sufficient for the single-process VS Code model).

### Parallelisation Strategy

The following tracks are fully independent and can proceed simultaneously once their prerequisites are met:

```
Track A (new sources)      Track B (Chronicle data)   Track C (intelligence)
─────────────────────      ─────────────────────────  ─────────────────────
15 Continue.dev            10 File-centric history    18 Session summaries
16 Amazon Q                11 Work-item grouping      19 Entity extraction
17 Gemini Code Assist      14 Clickable file links    20 Prompt cost analysis
                                                      21 Reranker

Track D (infrastructure)   Track E (UX)
────────────────────────   ────────────
12 Session archive         13 Session tagging
22 Obsidian/Notion export  23 Turn labels & /referMessage
```

Track B (10 and 11) must proceed in order (11 builds on 10's `ChronicleStore` extensions).
Track C features (18 and 19) both need MetadataStore from Track E (13-A) — schedule 13-A as an unblocking first step.
All other tracks are fully independent.

### Definition of Done (per feature)

A feature is complete when **all** of the following are true:
1. All atomic tasks implemented and passing code review.
2. `npm test` green (all unit tests).
3. All e2e scenarios in this document pass.
4. All manual tests in this document executed without surfacing new bugs (or any found bugs are fixed before marking complete).
5. README updated for user-facing changes.
6. Feature row in `whats-next.md` updated to ✅.
7. This document's completion checklist fully checked.

---

## Feature 23 — Message Turn Labels & In-Thread References

**Effort:** S  
**Prerequisite:** None — fully self-contained.

### Overview

Two complementary capabilities that make individual messages in a chat session referenceable by a compact, stable identifier:

1. **Session reader turn labels** — every message in the ChatWizard session reader displays a small `P1` / `R1` badge (`P` = user prompt, `R` = assistant response, numbered independently from 1). A hover-revealed copy button writes a structured reference string to the clipboard.

2. **`@chatwizard /referMessage`** — a new slash command that resolves `P{N}` or `R{N}` from the **current live chat thread** by reading `ChatContext.history`, then streams the referenced message back as a blockquote so the model has it as explicit context.

### Why

Long chat threads produce "refer to what you said earlier" friction. There is no built-in Copilot Chat mechanism for labelling or quoting prior turns. CW's session reader already has `data-msg-idx` on every bubble and `visibleIdx` in the renderer — the turn label is a one-line extension of that tracking. The `history` API gives the chat participant full access to the live thread.

### Atomic Tasks

- [x] **23-A** — Turn label computation in `sessionRenderer.renderMessage`
  - Count prior messages up to `visibleIdx` to derive independent `pCount`/`rCount`.
  - Render `<span class="cw-turn-label">P{N}</span>` in the message header, between the role label and the timestamp.
  - Add `id="cw-msg-P{N}"` / `id="cw-msg-R{N}"` to the outer message div (enables in-page `#` links).
  - Skipped messages get the label but no copy button (no meaningful content to quote).

- [x] **23-B** — Copy-as-reference button in the session reader
  - `<button class="cw-copy-ref-btn" data-turn="P3" title="Copy as reference (P3)">⧉</button>` in each message header; hidden by default, revealed on `.message:hover`.
  - Click handler (webview JS, event delegation): extracts first and last non-empty lines from `data-raw`, composes:
    ```
    [Session: <title>] P3
    ↳ "First line of the message..."
       "...last line."
    ```
    Single-line messages omit the last-line entry. Posts `{ command: 'copy', text }` to the extension (reuses the existing copy-to-clipboard handler).
  - CSS: `.cw-turn-label` — monospace, tiny border-box; `.cw-copy-ref-btn` — `margin-left: auto`, opacity 0 → 0.4 on parent hover → 1 on button hover.

- [x] **23-C** — `@chatwizard /referMessage` slash command
  - New `ReferMessagePrompt` class in `src/mcp/prompts/contextPrompts.ts`.
  - Argument: `ref` — the P/R reference string (case-insensitive).
  - Handled as a **special early-return path** in `createParticipantHandler` (before the LLM dispatch): reads `chatContext.history`, counts turns of the requested role, streams the matching turn's content as a Markdown blockquote.
  - Usage string emitted on parse failure: `` `@chatwizard /referMessage P3` or `@chatwizard /referMessage R2` ``.
  - Out-of-range message: friendly error with actual count, e.g. `"No R5 found. This thread has 3 responses so far."`.
  - Added to `PROMPT_DEFS` and `package.json` `contributes.chatParticipants.commands`.

### Unit Tests

- [ ] `sessionRenderer.renderMessage` — user message at `visibleIdx` 2 with 2 prior user messages yields label `P3`; assistant message at `visibleIdx` 3 with 1 prior assistant yields `R2`; first message in session yields `P1`/`R1`; `id` attribute is `cw-msg-P3`.
- [ ] `sessionRenderer.renderMessage` — skipped message includes turn label, does not include `.cw-copy-ref-btn`.
- [ ] `/referMessage` handler — `P2` with 3 request turns in history returns blockquote of the 2nd request; `R1` with 2 response turns returns blockquote of the 1st response.
- [ ] `/referMessage` handler — case-insensitive: `p3` and `P3` resolve identically.
- [ ] `/referMessage` handler — `P0` and `P99` (out of range) return error string, do not throw.
- [ ] `/referMessage` handler — malformed input (`X3`, `P`, `3P`, empty string) returns usage string, does not throw.
- [ ] `/referMessage` handler — empty history returns `"No P1 found. This thread has 0 prompts so far."`.

### E2E Tests

- [ ] **Scenario: session reader turn labels** — open any session; verify `P1`, `R1`, `P2`, `R2`… labels appear in message headers in correct order; `id` attributes match the labels.
- [ ] **Scenario: copy-as-reference** — hover a message bubble; verify the ⧉ button appears; click it; verify clipboard contains the `[Session: …] P3 ↳ "…"` format with correct session title.
- [ ] **Scenario: `/referMessage P2` in a live thread** — send two prompts, then `@chatwizard /referMessage P1`; verify the response streams back the first prompt as a blockquote.
- [ ] **Scenario: `/referMessage R1` in a live thread** — verify first assistant response is quoted correctly.
- [ ] **Scenario: `/referMessage P99` out of range** — verify friendly error, not an exception.

### Manual Tests

1. Open any session in the ChatWizard reader. Verify `P1`, `R1`, `P2`… labels appear in each message header — monospace, small, with a subtle border box. Verify they do not obscure the role label or timestamp.
2. Hover a user message. Verify the ⧉ button fades in at the right edge of the header. Click it. Paste into an editor; verify the format:
   ```
   [Session: <title>] P3
   ↳ "First line of the message..."
      "...last line."
   ```
3. Click ⧉ on a single-line message. Verify only the `↳ "line"` entry appears (no empty last-line).
4. In a Copilot Chat thread with at least 3 user turns, type `@chatwizard /referMessage P2`. Verify the second user prompt appears as a blockquote in the response.
5. Type `@chatwizard /referMessage R1`. Verify the first assistant response is quoted.
6. Type `@chatwizard /referMessage P99`. Verify an informative "No P99 found" message, no stack trace, no extension error.
7. Type `@chatwizard /referMessage abc`. Verify the usage hint is shown.
8. _(Potential bug surface)_ Session with only user messages (no assistant responses — e.g. Cursor aiService source). Verify `R` labels are absent and `/referMessage R1` returns the out-of-range message, not a crash.
9. _(Potential bug surface)_ Session reader opened on a very long session (200+ messages). Verify turn labels are correct for messages beyond the initial window (loaded via "Load more messages…") — labels must reflect global position, not chunk-local position.

### Completion Checklist

- [x] Task 23-A implemented (`sessionRenderer.ts`)
- [x] Task 23-B implemented (`sessionWebviewPanel.ts` CSS + JS)
- [x] Task 23-C implemented (`contextPrompts.ts` + `chatParticipant.ts` + `package.json`)
- [ ] Unit tests written and green
- [ ] E2E tests written and green
- [ ] Manual tests performed and issues fixed
- [ ] ⬜ → ✅ in this document and `whats-next.md`
