# ChatWizard — Cursor Recommendations Work Plan

This doc lists **repo-specific** recommendations to improve ChatWizard as a VSIX extension, with an emphasis on **Cursor** support (and other VS Code-fork sources) based on the current codebase.

## High-impact fixes (correctness + “multi-source” completion)

### 1) Make UI labels + filters truly multi-source

Several UI/UX paths still assume only **Copilot** vs **Claude**, but the watcher/indexing supports **Cline / Roo Code / Cursor / Windsurf / Aider** too.

- **Session viewer assistant label**: `src/views/sessionWebviewPanel.ts` uses `session.source === 'copilot' ? 'Copilot' : 'Claude'`, which mislabels every non-copilot source as “Claude”.
  - **Recommendation**: centralize `friendlySourceName(source)` and `sourceIcon(source)` and use it consistently across tree items, tooltips, session viewer, export pickers, analytics, etc.

- **Code blocks filter**: `src/extension.ts` → `filterCodeBlocks` offers only Copilot/Claude in `sessionSource`.
  - **Recommendation**: extend the picker to all `SessionSource` values and update any display strings (“Source (Copilot/Claude)”).

- **Export UI**:
  - `src/export/exportCommands.ts` → `exportSelected` uses `detail: Copilot/Claude` only.
  - `exportExcerpt` uses `assistantLabel = session.source === 'copilot' ? 'Copilot' : 'Claude'`.
  - **Recommendation**: display the real source label and icon for all sources, and consider including the **workspace name/path** and **model** when available.

### 2) Restart/re-index on *all* relevant setting changes (not just Claude/Copilot)

`src/extension.ts` currently restarts the watcher on:

- `chatwizard.claudeProjectsPath`
- `chatwizard.copilotStoragePath`
- `chatwizard.oldestSessionDate`
- `chatwizard.maxSessions`

But Cursor/Windsurf/Cline/Roo/Aider also have enable flags and storage settings in `package.json`.

- **Recommendation**: expand the configuration watcher to include:
  - **Source roots**: `chatwizard.clineStoragePath`, `chatwizard.rooCodeStoragePath`, `chatwizard.cursorStoragePath`, `chatwizard.windsurfStoragePath`
  - **Enable toggles**: `chatwizard.indexClaude`, `chatwizard.indexCopilot`, `chatwizard.indexCline`, `chatwizard.indexRooCode`, `chatwizard.indexCursor`, `chatwizard.indexWindsurf`, `chatwizard.indexAider`, `chatwizard.enabled`
  - **Aider scan settings**: `chatwizard.aiderSearchRoots`, `chatwizard.aiderSearchDepth`
  - **Parser behavior**: `chatwizard.maxLineLengthChars`
- **Implementation detail**: some changes should trigger a full watcher restart; others may only require re-rendering. But correctness-wise, a restart is the safe default.

### 3) Workspace scoping should include Cursor/Windsurf/Cline/Roo/Aider sources

The app has a `WorkspaceScopeManager`, but the activation-time scope discovery in `src/extension.ts` builds `allAvailable` from **Copilot + Claude only**.

- **Recommendation**: include discovered workspaces/tasks for:
  - Cursor (`discoverCursorWorkspacesAsync`)
  - Windsurf (`discoverWindsurfWorkspacesAsync`)
  - Cline/Roo (tasks as “workspaces” or a separate scope category)
  - Aider (workspace folders + configured roots)
- **UX suggestion**: treat “scope” as **sources + workspaces**:
  - a checkbox for each source
  - optional per-workspace scoping for sources that have a stable workspace identity (Copilot/Cursor/Windsurf/Claude)

### 4) Cursor/Windsurf deletion handling should clean up orphaned sessions

In `src/watcher/fileWatcher.ts`, when a Cursor/Windsurf `state.vscdb` is deleted the code logs but **does not remove** sessions because composer IDs are not known.

- **Recommendation**: maintain a reverse index `vscdbPath -> sessionIds` (or store `filePath` on sessions, which already exists in types, and query the `SessionIndex` for sessions matching that `filePath`).
  - When `state.vscdb` is deleted, remove all sessions that came from that file immediately.
  - This avoids “phantom sessions” until the next reload/rescan.

### 5) Add safety guards consistent with the Claude/Copilot path traversal checks

`ChatWizardWatcher` has `_isSafeFilePath` / `_isSafeFilePathAsync` and applies them to Claude/Copilot files during collection. Cursor/Windsurf/Cline/Roo/Aider collectors currently do not apply the same containment checks consistently for every on-disk read (especially for task discovery and SQLite reads).

- **Recommendation**: standardize “safe path” checks in readers:
  - Resolve base dir once, then skip any file/dir whose `realpath` escapes.
  - Apply file-size limits before reading JSON/SQLite blobs where possible.

## Cursor-specific improvements (SQLite source robustness)

### 6) Make Cursor SQLite parsing resilient to schema/key drift

`src/parsers/cursor.ts` assumes:

- table `ItemTable`
- key `composer.composerData`
- JSON shape `{ allComposers: [...] }`

Cursor may evolve these keys or introduce per-version changes.

- **Recommendation**:
  - Add defensive probing:
    - If `composer.composerData` missing, optionally search keys with `LIKE '%composer%'` (bounded) and log a helpful parse warning.
  - Preserve parse errors on the session (`session.parseErrors`) for Cursor too, not only for Claude.
  - Add a “schema mismatch” warning that includes Cursor version hints (if detectable) and the key(s) found.

### 7) Avoid “re-indexing everything” on any Cursor DB touch

The file watcher triggers on `**/state.vscdb` changes and then parses *every* composer in that DB.

- **Recommendation**:
  - Add a lightweight “DB fingerprint” cache per `vscdbPath` (e.g., file mtime + size) and skip re-parse if unchanged.
  - If feasible, store per-composer updatedAt and only upsert those that changed (requires remembering prior composer timestamps).

## Search, performance, and scalability

### 8) Provide a fallback when the inverted index returns 0 results

`src/search/fullTextEngine.ts` uses a doc-frequency threshold (`MIN_DOC_FREQ = 2`) and does not index hapax tokens. This is a great memory optimization, but it can be surprising: queries that exist in exactly one session become “unsearchable” via the index.

- **Recommendation**: if indexed-token search yields 0 candidates:
  - fallback to a bounded linear scan (like regex mode) for plain text
  - or expose a setting like `chatwizard.searchIncludeRareTokens` (default false) / `chatwizard.searchMinDocFreq` (default 2)

### 9) Improve indexing progress reporting (multi-source)

`buildInitialIndex()` uses `Promise.all` and per-collector progress callbacks, but the totals are per-source and not aggregated meaningfully.

- **Recommendation**:
  - provide a “phase” label (e.g., “Scanning Cursor workspaces…”, “Parsing Claude sessions…”) and a per-phase counter
  - emit a final breakdown of indexed session counts by source + number of parse warnings

## UX improvements that fit Cursor users

### 10) Add “Open related workspace” and “Copy session link” affordances

Many Cursor users bounce between projects quickly.

- **Recommendation**:
  - Add commands (and session webview buttons):
    - **Open workspace folder** (if `session.workspacePath` exists)
    - **Copy session permalink**: `chatwizard.openSession?sessionId=...` (internal URI scheme) or a structured ID that can be pasted into search.

### 11) Unify “empty state” guidance per source

`makeEmptyStateMsg()` in `src/extension.ts` still describes only Claude + Copilot.

- **Recommendation**: include per-source troubleshooting links/messages:
  - show which sources are enabled
  - show the configured storage roots for each enabled source
  - include a “Reload window” CTA

## Security / webview hardening

### 12) Reduce reliance on `unsafe-inline` in CSP

`src/views/sessionWebviewPanel.ts` uses CSP `script-src 'unsafe-inline'` and injects a large inline script.

- **Recommendation**:
  - move scripts to bundled files served via `webview.asWebviewUri(...)` and use a nonce-based CSP
  - same for large inline styles where practical (styles can remain inline if necessary, but script is higher risk)

## Testing + packaging improvements (Cursor-specific)

### 13) Expand tests around Cursor/Windsurf parsing and live update behavior

There are already test suites for many parts. Cursor/Windsurf have unique failure modes (SQLite key/schema drift, partial writes, locked DB).

- **Recommendation**:
  - Add tests for:
    - DB locked / file in use (better-sqlite3 open error)
    - missing key / malformed JSON blob
    - large composer arrays capped by `MAX_COMPOSERS`
  - Add a test ensuring non-copilot sources don’t get mislabeled in UI payloads.

### 14) Consider prebuild strategy for `better-sqlite3`

The repo already does targeted VSIX packaging and native rebuilds (`package.json` scripts + `.github/workflows/package-targeted-vsix.yml`).

- **Recommendation**:
  - document the build matrix and troubleshooting steps in `README.md`
  - consider distributing prebuilt binaries where supported to reduce end-user friction (balanced against VSIX size)

## Suggested implementation order (small PR-sized steps)

1. **Fix multi-source labeling** across UI and export flows.
2. **Restart watcher on all source settings** changes.
3. **Scope discovery includes all sources** (or introduce source-level scope toggles).
4. **Cursor/Windsurf deletion cleanup** via filePath → sessionIds mapping.
5. **Search fallback for rare tokens** (or configurable MIN_DOC_FREQ).
6. **Cursor parser resilience** and incremental parsing optimizations.
7. **Webview CSP hardening** and reduce inline scripts.

