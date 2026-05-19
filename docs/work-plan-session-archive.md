# ChatWizard — Session Archive Work Plan

_Created: May 2026_

---

## Overview

ChatWizard's stated mission is to be the **source of truth** for AI chat history. But today it is a read-only observer: it reads session files owned by AI tools and never persists anything itself. When an AI tool prunes old sessions — which Claude Code, Cursor, and others do silently, by age or storage pressure — ChatWizard loses those sessions too. The user had no way to prevent this and no way to recover.

This feature introduces a **session archive** owned exclusively by ChatWizard. Every session that ChatWizard indexes is immediately mirrored in its own storage. From that point on, the original source file is irrelevant — pruning, deleting, or reinstalling the AI tool cannot touch ChatWizard's copy. The archive is the canonical record. Only the user, via ChatWizard's own settings, can remove content from it.

### Core constraints

- **CW owns the archive** — stored under `context.globalStorageUri/archive/<source>/`; no other process writes there
- **Immutable unless user opts in** — default: archived sessions are never deleted automatically; user must explicitly configure `chatwizard.archive.maxAgeDays` or `chatwizard.archive.maxSizeMB` to enable pruning
- **Source file is the freshest version** — if both a live source file and an archive copy exist, the source wins (live sessions can be updated mid-conversation); archive fills in for anything the source no longer has
- **No re-indexing cost** — archival is a file-copy side-effect of the parse step, not a second parse
- **Transparent to the user** — the session viewer, MCP server, and search engine do not need to know whether a session came from the source or the archive; the `Session` object is identical either way
- **100% local** — same privacy guarantee as the rest of ChatWizard; nothing leaves the machine

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Archive format | Raw source file copied verbatim | Zero information loss; original file remains re-parseable if the parser changes |
| Archive path | `globalStorageUri/archive/<source>/<sessionId>.<ext>` | Stable key; survives source file rename or move |
| Source-of-truth precedence | Live source file beats archive | Live sessions can grow mid-conversation; we always want the latest content |
| When to archive | On first successful parse during `buildInitialIndex` and on every file-change event | Captures everything from first run; keeps archive up to date while source exists |
| Archive-only sessions | Loaded at startup from archive when source file is gone | These are exactly the sessions that would otherwise be lost |
| Pruning | Never by default; opt-in via `chatwizard.archive.maxAgeDays` and `chatwizard.archive.maxSizeMB` | CW should never silently lose data unless the user explicitly asked for it |
| Scope of archival | All sources CW already indexes (Claude, Copilot, Cursor, Windsurf, Cline, Roo Code, Aider, Antigravity) | Any indexed source could be pruned by its parent tool |
| Archival strategy | Two strategies based on storage model — see below | File-per-session sources can archive raw bytes; SQLite-backed sources must serialize the parsed `Session` |

### Storage model taxonomy

Not all sources use files. This distinction drives the archival and restore path:

| Strategy | Sources | Raw storage | Archive content |
|---|---|---|---|
| **A — File-per-session** | Claude, Copilot, Cline, Roo Code, Aider, Antigravity | One file (`.jsonl` / `.md` / `.json`) per session | Verbatim copy of the source file |
| **B — Database-backed** | Cursor, Windsurf | Multiple sessions per SQLite `state.vscdb`; no per-session file | `JSON.stringify(session)` — the parsed `Session` object serialized to JSON |

Strategy A is preferred because it is format-agnostic (parser upgrades automatically benefit the archive). Strategy B is unavoidable because `state.vscdb` is owned by Cursor/Windsurf and contains every workspace's data in a single file — copying it raw would be gigabytes and would not give us per-session granularity.

For Strategy B, when restoring archive-only sessions, no parser is needed — `JSON.parse(content)` produces a `Session` directly.

---

## User-visible impact

- **Sessions from months ago reappear** — the first time this version runs, it archives everything still available. Subsequent startups, even after the source tool prunes its data, still load those sessions from the archive.
- **"Archive" badge** — sessions loaded exclusively from the archive (source file gone) get a subtle indicator in the tree view so the user knows they are viewing a preserved copy.
- **New output channel log lines** — on startup CW logs how many sessions were loaded from source vs. archive vs. newly archived.
- **Archive size visible in settings** — a `Chat Wizard: Show Archive Stats` command (or inline in the Manage Workspaces panel) shows total archived session count and disk usage.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Phase 1 — Archive Storage Layer ⬜

**Goal:** Build the `SessionArchive` class that owns archive read/write with no dependency on VS Code APIs, so it is fully unit-testable.

**Depends on:** Nothing (pure Node.js I/O).

### Tasks

- [ ] Create `src/archive/sessionArchive.ts`
  - `SessionArchive` class, constructor takes `archiveDir: string`
  - `has(sessionId: string, source: SessionSource): boolean` — synchronous check (checks for file existence via cache)
  - `save(sessionId: string, source: SessionSource, rawContent: string | Buffer): Promise<void>` — writes to `archiveDir/<source>/<sessionId>.<ext>`, creates parent dir if needed
  - `load(sessionId: string, source: SessionSource): Promise<string | null>` — reads raw content; returns `null` if not archived
  - `listAll(): Promise<ArchiveEntry[]>` — returns `{ sessionId, source, filePath, sizeBytes, modifiedAt }[]` for all entries
  - `remove(sessionId: string, source: SessionSource): Promise<void>` — used by the optional pruning feature
  - `pruneByAge(maxAgeDays: number): Promise<number>` — removes entries older than N days; returns count removed
  - `pruneBySize(maxSizeBytes: number): Promise<number>` — evicts oldest entries until under limit; returns count removed
  - `getTotalSizeBytes(): Promise<number>`
  - File extension per source: `.jsonl` for Claude/Copilot/Cline/Roo/Aider/Antigravity (Strategy A — raw source bytes); `.json` for Cursor/Windsurf (Strategy B — serialized `Session` JSON)
  - Add `isDbBacked(source: SessionSource): boolean` helper that returns `true` for `cursor` and `windsurf`; used by `loadArchiveOnlySessions` to decide whether to re-parse or deserialize

- [ ] Export `SessionArchive` from `src/archive/index.ts`

- [ ] Unit tests in `test/suite/sessionArchive.test.ts`
  - `save` then `has` returns true
  - `save` then `load` returns original content exactly
  - `load` on non-existent returns null
  - `has` on non-existent returns false
  - `listAll` returns correct count after multiple saves
  - `remove` deletes file; subsequent `has` returns false
  - `pruneByAge` removes only entries older than threshold
  - `pruneBySize` removes oldest-first until under limit
  - Parent directory is created automatically if missing
  - Concurrent `save` calls for different sessions do not corrupt each other

---

## Phase 2 — Integration with FileWatcher ⬜

**Goal:** Wire `SessionArchive` into `FileWatcher` so that every successfully parsed session is archived, and archive-only sessions are loaded at startup.

**Depends on:** Phase 1.

### Tasks

- [ ] Add `archiveDir` parameter to `ChatWizardWatcher` constructor (defaults to `context.globalStorageUri.fsPath + '/archive'` in `extension.ts`)
- [ ] Instantiate `SessionArchive` in `ChatWizardWatcher`
- [ ] **Strategy A — file-per-session sources** (Claude, Copilot, Cline, Roo, Aider, Antigravity):
  - In `parseFile()`: read raw file bytes _before_ parsing (one `fs.readFile` call whose result is passed to both the parser and `archive.save`); after successful parse call `archive.save(session.id, session.source, rawBytes)` — fire-and-forget
  - On live file-change events (`indexFile`): same — re-read raw bytes and save after successful parse
  - On file-delete events: do NOT remove from archive

- [ ] **Strategy B — database-backed sources** (Cursor, Windsurf):
  - In `collectCursorSessionsAsync()`: after each session passes the validity check (non-empty, non-epoch), call `archive.save(session.id, session.source, JSON.stringify(session))` — fire-and-forget; applies to both workspace-level and global-DB sessions
  - In `collectWindsurfSessionsAsync()`: same — call `archive.save` for each valid session after parse
  - There is no file-delete event for DB-backed sources; archival only happens during collection

- [ ] In `buildInitialIndex()`: after collecting all source sessions, call `loadArchiveOnlySessions()` (see below) and merge into the batch; log how many came from source vs. archive
- [ ] Add `loadArchiveOnlySessions(sourceSessionIds: Set<string>): Promise<Session[]>` method on `ChatWizardWatcher`:
  - Lists all archive entries
  - Filters out entries whose `sessionId` is already in `sourceSessionIds` (source is authoritative for those)
  - For remaining entries:
    - Strategy A sources: re-parse the archived file bytes using the appropriate parser (same path as live parse)
    - Strategy B sources: `JSON.parse(content) as Session` — no parser needed
  - Returns the assembled `Session[]`
- [ ] Log line in Output channel: `[init] Source: N sessions, Archive-only: M sessions, Newly archived: K sessions`

- [ ] Unit tests in `test/suite/fileWatcher.archive.test.ts`
  - After `buildInitialIndex`, archive contains a file for each parsed session
  - After source file deletion, `buildInitialIndex` still loads the session from archive
  - Archive-only sessions appear in the index alongside live sessions
  - `parseFile` error does NOT archive the file (no garbage in archive)
  - Live file-change events trigger archival (Strategy A)
  - `collectCursorSessionsAsync` archives each valid session (Strategy B)
  - `collectWindsurfSessionsAsync` archives each valid session (Strategy B)
  - Archive-only Cursor session is restored via `JSON.parse` (no parser call)
  - Archive-only Claude session is restored via `parseClaudeSession` (same as live)

---

## Phase 3 — Extension Wiring & Settings ⬜

**Goal:** Pass `archiveDir` from `extension.ts` into `ChatWizardWatcher`; expose archive settings and the stats command.

**Depends on:** Phase 2.

### Tasks

- [ ] In `extension.ts`: pass `context.globalStorageUri.fsPath` + `/archive` as `archiveDir` to `ChatWizardWatcher`
- [ ] Add settings to `package.json`:
  ```jsonc
  "chatwizard.archive.enabled": {
    "type": "boolean", "default": true,
    "description": "Archive all indexed sessions in ChatWizard's own storage so they survive source tool pruning."
  },
  "chatwizard.archive.maxAgeDays": {
    "type": "integer", "default": 0, "minimum": 0,
    "description": "Remove archived sessions older than this many days. 0 = never prune."
  },
  "chatwizard.archive.maxSizeMB": {
    "type": "integer", "default": 0, "minimum": 0,
    "description": "Keep archive under this size in MB by evicting oldest entries. 0 = no limit."
  }
  ```
- [ ] Register `chatwizard.showArchiveStats` command:
  - Shows a `vscode.window.showInformationMessage` with: total archived sessions, total size on disk, breakdown by source, oldest archived session date
- [ ] Add command to `package.json` contributions
- [ ] Respect `chatwizard.archive.enabled`: if false, skip all archive write/read operations
- [ ] On activation, if archive pruning settings are set, run pruning after `buildInitialIndex` completes
- [ ] Unit tests:
  - `showArchiveStats` fires without error when archive is empty
  - `chatwizard.archive.enabled = false` causes no archive files to be written

---

## Phase 4 — UX: Archive Badge in Tree View ⬜

**Goal:** Sessions loaded from archive (source file gone) get a visible indicator so users understand they are viewing a preserved copy.

**Depends on:** Phase 2.

### Tasks

- [ ] Add `archivedOnly?: boolean` field to `SessionSummary` (set to `true` for archive-only sessions)
- [ ] In `SessionTreeItem`: when `summary.archivedOnly` is true:
  - Append `· archived` to the `description` string
  - Set `iconPath` to a `ThemeIcon('archive')` (or add it to the warning icon set)
  - Add a tooltip line: `"Source file no longer exists — this session is preserved in ChatWizard's archive."`
- [ ] `SessionTreeProvider.getDescription()`: when any archived-only sessions are present, append `· N archived` to the tree subtitle
- [ ] Unit tests:
  - `SessionTreeItem` with `archivedOnly: true` has correct description suffix and icon
  - Tree description reflects archived count

---

## Phase 5 — Manual Testing Checklist ⬜

After all phases pass unit tests, verify the following manually:

1. **Fresh install simulation**: delete `globalStorageUri/archive/`, reload extension → archive is populated on startup; Output channel shows `[init] Newly archived: N sessions`
2. **Prune simulation (Claude — Strategy A)**: find a `.jsonl` file in `~/.claude/projects/<workspace>/`, rename it out of the directory, reload extension → session still appears in tree with `· archived` badge; restore the file, reload → badge disappears
2b. **Prune simulation (Cursor — Strategy B)**: note a session ID from the tree; locate `state.vscdb` in `%APPDATA%/Cursor/User/globalStorage/`, rename the file out, reload extension → Cursor sessions previously indexed still appear in tree with `· archived` badge; restore the file, reload → live source wins again
2c. **Prune simulation (Copilot — Strategy A)**: rename a `.jsonl` file in `workspaceStorage/<hash>/chatSessions/`, reload → session preserved in archive with badge
3. **Settings UI**: open Settings, search `chatwizard.archive` → all three settings appear with correct descriptions and defaults
4. **Show Archive Stats command**: run via Command Palette → info message appears with correct counts and size
5. **`maxAgeDays` pruning**: set `chatwizard.archive.maxAgeDays = 1`, reload → sessions older than yesterday are removed; Output channel logs the count
6. **`archive.enabled = false`**: set to false, reload → no archive directory is created/written; Output channel shows `[init] Archive disabled`
7. **MCP server**: verify that archive-only sessions are returned by `chatwizard_search` and `chatwizard_list_recent` — the MCP layer should not know or care about origin

---

## Out of Scope (this plan)

- **Export / backup of the archive** — covered by the existing export feature (Phase 2 of original roadmap)
- **Cross-machine sync** — out of scope for the local-first model; would be a separate Cloud Sync work plan
- **Deduplication of storage** — archive stores raw source content; no compression or delta encoding in this phase
- **Re-parsing with updated parsers** — archive stores raw source bytes; if a parser is upgraded, the archive can be re-parsed transparently without any migration step
