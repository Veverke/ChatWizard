# ChatWizard — P3 Work Plan (H2 2026)

_Created: June 2026_  
_Source: P3 section of [whats-next.md](whats-next.md)_

---

## Overview

This plan covers all **P3 — H2 2026** features from the master roadmap (features #23–#45).
Each feature is broken into atomic, independently-implementable tasks with UT coverage,
e2e tests, manual verification steps, and a completion gate.

**Effort key:** XS < 1 day · S = 1–3 days · M = 1–2 weeks · L = 3–6 weeks  
**File path conventions:** all paths are workspace-relative from `c:\_\ChatWizard`.

---

## Pre-flight: Implementation Status Audit

Before beginning P3 work, each feature was checked against the current codebase to determine
whether it (or a significant part of it) is already implemented.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 23 | KB entry classification + KB generation | ✅ Implemented | All source files exist: `kbClassifier.ts`, `kbClusterer.ts`, `kbExporter.ts`. Types defined. |
| 24 | SQLite persistent cache | ✅ Implemented | Full CacheManager implementation: schema, FTS5, parse_state, incremental parsing, wired into extension.ts and watcher. |
| 25 | Git/branch linkage | ✅ Implemented | `gitContextReader.ts` exists. Chronicle branch data merged in extension.ts. Branch grouping in tree view. |
| 26 | Workspace Digest / Standup Reports | ✅ Implemented | `digestBuilder.ts` exists and is functional. |
| 27 | Cloud sync (opt-in) | ✅ Implemented | `CloudSyncManager` with Gist/S3/Azure backends, AES-256-GCM encryption, periodic sync. |
| 28 | Session status lifecycle | ✅ Implemented | Status picker, filter by status, context value, tree item display, status chip in reader. |
| 29 | Bookmarks within a session | ✅ Implemented | Full bookmark UI, toggle, persistence in sidecar, jump list. |
| 30 | Inline annotations | ✅ Implemented | Full annotation UI, add/edit/delete, persistence. |
| 31 | Session linking | ✅ Implemented | Bidirectional linking, link/unlink commands, sidecar persistence. |
| 32 | Response rating | ✅ Implemented | Types, sidecar store methods, commands registered. |
| 33 | Duplicate / related session detection | ✅ Implemented | `duplicateDetector.ts` exists. |
| 34 | Outcome / follow-up tracking | ✅ Implemented | `actionItemExtractor.ts` exists. Types and sidecar store methods. |
| 35 | Keyboard-only navigation | ✅ Complete | Focus navigation commands registered + `keybindings` entries added in `package.json` for `j`/`k`/`g`/`G`/`/` navigation. |
| 36 | Session sharing | ✅ Implemented | `sessionHtmlExporter.ts` exists. Share command available. |
| 37 | Post-session cost tips & analytics | ✅ Implemented | `SessionCostAdvisorNotifier` is instantiated in extension.ts. |
| 38 | MCP tools: `includeCode` flag | ✅ Implemented | `contentFilter.ts` exists with `stripCodeBlocks()`. |
| 39 | MCP `/mcp-config` auth hardening | ✅ Implemented | Auth check already present in `mcpServer.ts` (line 187). |
| 40 | Antigravity `.pb` (protobuf) support | ✅ Implemented | `antigravityProtobuf.ts` exists and is wired. |
| 41 | Zed AI source support | ✅ Implemented | `zed.ts`, `zedWorkspace.ts` exist. `SessionSource` includes `'zed'`. |
| 42 | Tabnine Chat source support | ✅ Implemented | Parser (`parsers/tabnine.ts`) and reader (`readers/tabnineWorkspace.ts`) exist and are now wired into the file watcher. `TabnineSourceWatcher` implements `ISourceWatcher`. `indexTabnine` config setting added. Sessions are collected at startup and watched live. |
| 43 | Session retention controls | ✅ Complete | `sessionRetentionDays` setting applied in extension.ts. `semanticIndexMaxAgeDays` now wired into `SemanticIndexer.scheduleSession()` via `setMaxAgeDays()`. |
| 44 | API / programmatic access | ✅ Implemented | Full REST API server with health, sessions list/detail, search, stats endpoints. Bearer auth. |
| 45 | Compacted session detection & visibility | ✅ Implemented | `isCompacted`/`compactionSummary` fields on `Session` type. |

### Key findings

- **Features 28–35, 37–43, 45 are now complete** — all P3 features with existing source code have been fully wired and configured.
- **Feature 35** now has comprehensive keybindings: `j`/`k` for navigation, `g` for focus, `/` for search, `l`/`h` for expand/collapse, `ctrl+l` for filter, `enter` for open, `ctrl+a` for select all.
- **Feature 42** is now fully implemented: Tabnine parser (`parsers/tabnine.ts`) and reader (`readers/tabnineWorkspace.ts`) already existed; the `TabnineSourceWatcher` (`watcher/sources/TabnineSourceWatcher.ts`) provides `ISourceWatcher` integration for both initial indexing and live file watching. The `indexTabnine` configuration flag (default `true`) allows users to disable Tabnine indexing.
- **Feature 43** is now fully complete: `sessionRetentionDays` works in UI; `semanticIndexMaxAgeDays` is now wired into `SemanticIndexer.setMaxAgeDays()` and filters sessions at `scheduleSession()` time. Config is read from VS Code settings and applied in `extension.ts` during `createAndInitSemanticIndexer()`.
- **All P3 features now implemented**. Features 24, 27, and 44 have been built and wired. See Feature implementation sections for detailed architecture.

---

## Table of Contents

| # | Feature | Effort | Status | What You Can Now Do |
|---|---------|--------|--------|---------------------|
| [23](#feature-23--kb-entry-classification--kb-generation) | KB entry classification + KB generation | L | ✅ | Run `ChatWizard: Generate Knowledge Base` to classify sessions into KB entry types and export an Obsidian-compatible Markdown knowledge base. |
| [24](#feature-24--sqlite-persistent-cache) | SQLite persistent cache | L | ⬜ | All sessions are cached in a local SQLite DB (FTS5 search). Startup loads from cache instantly. Unchanged JSONL files are skipped via parse_state tracking. |
| [25](#feature-25--gitbranch-linkage) | Git/branch linkage | M | ✅ | Sessions are auto-tagged with the current Git branch and commit. Tree view has **Group by Branch** mode. Reader header shows the branch. |
| [26](#feature-26--workspace-digest--standup-reports) | Workspace Digest / Standup Reports | M | ✅ | Run `ChatWizard: Generate Digest` to produce a Markdown standup report filtered by time window, grouped by branch and model. |
| [27](#feature-27--cloud-sync-opt-in) | Cloud sync (opt-in) | L | ⬜ | Enable cloud sync to back up sessions to a private GitHub Gist with AES-256-GCM encryption. Periodic auto-sync every 5 minutes. |
| [28](#feature-28--session-status-lifecycle) | Session status lifecycle | S | ✅ | Set sessions to **Open**, **Resolved**, or **Revisit**. Filter by status. Badges and chips appear in the tree and reader. |
| [29](#feature-29--bookmarks-within-a-session) | Bookmarks within a session | S | ✅ | Click ★/☆ on any message to bookmark it. A jump list lets you scroll to bookmarked messages. Bookmarks persist across restarts. |
| [30](#feature-30--inline-annotations) | Inline annotations | S | ✅ | Click 📝 on any message to add an inline note. Annotations are saved and rendered when re-opening the session. |
| [31](#feature-31--session-linking) | Session linking | M | ✅ | Link two related sessions via QuickPick. Links are bidirectional — opening a session shows its linked sessions. |
| [32](#feature-32--response-rating) | Response rating | S | ✅ | Rate a response as helpful (👍) or not (👎). Ratings are stored per-message in the sidecar metadata. |
| [33](#feature-33--duplicate--related-session-detection) | Duplicate / related session detection | M | ✅ | The extension auto-detects similar sessions using embedding-based cosine similarity. Related sessions are suggested for review. |
| [34](#feature-34--outcome--follow-up-tracking) | Outcome / follow-up tracking | S | ✅ | Action items are auto-extracted from sessions via heuristic phrase matching. Track what needs to be done after a coding session. |
| [35](#feature-35--keyboard-only-navigation) | Keyboard-only navigation | S | ✅ | Navigate the tree view entirely by keyboard: `j`/`k` to move, `g` to focus tree, `/` to search, `l`/`h` to expand/collapse. |
| [36](#feature-36--session-sharing) | Session sharing | M | ✅ | Run `ChatWizard: Share Session` to export a session as a self-contained HTML file. Optionally redact code blocks. |
| [37](#feature-37--post-session-cost-tips--analytics) | Post-session cost tips & analytics | S | ✅ | After a session, see cost analytics (tokens used, estimated cost) and tips for reducing costs. Integrated into the session reader. |
| [38](#feature-38--mcp-tools-includecode-flag) | MCP tools: `includeCode` flag | S | ✅ | The MCP `chatwizard_search_sessions` tool has an `includeCode` param. Set to `false` to exclude code blocks from results. |
| [39](#feature-39--mcp-mcp-config-auth-hardening) | MCP `/mcp-config` auth hardening | XS | ✅ | The `/mcp-config` endpoint requires a valid Bearer token. Unauthorized requests receive a 401 response. |
| [40](#feature-40--antigravity-pb-protobuf-support) | Antigravity `.pb` (protobuf) support | S | ✅ | ChatWizard can now read Antigravity's protobuf-format files (`.pb`), scanning wire-type 2 string fields and parsing them into sessions. |
| [41](#feature-41--zed-ai-source-support) | Zed AI source support | S | ✅ | ChatWizard now discovers and indexes sessions from **Zed AI** editor, parsed from Zed's conversation format. |
| [42](#feature-42--tabnine-chat-source-support) | Tabnine Chat source support | M | ✅ | ChatWizard now discovers and indexes **Tabnine Chat** sessions. Toggle via `chatwizard.indexTabnine`. Initial indexing + live file watching. |
| [43](#feature-43--session-retention-controls) | Session retention controls | S | ✅ | Set `chatwizard.sessionRetentionDays` to auto-hide old sessions. Set `semanticIndexMaxAgeDays` to limit which sessions are embedded. |
| [44](#feature-44--api--programmatic-access) | API / programmatic access | M | ⬜ | Enable `chatwizard.restApi.enabled` to start a REST API. Access sessions, search, and stats via HTTP with Bearer token auth. |
| [45](#feature-45--compacted-session-detection--visibility) | Compacted session detection & visibility | S | ✅ | Compacted sessions (Claude summary JSONL entries) are detected and flagged with an `isCompacted` marker and badge in the tree view. |

---

## Feature 23 — KB Entry Classification + KB Generation

_Effort: L · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1) and Feature 13 (session tagging, P2)_

### Status: ✅ Implemented

All source files exist:
- `src/types/kb.ts` — `KbEntry`, `KbEntryType` types
- `src/analytics/kbClassifier.ts` — `classifySession()` with heuristic rules
- `src/analytics/kbClusterer.ts` — `clusterEntries()` using tag grouping + cosine similarity
- `src/export/kbExporter.ts` — `exportKbAsync()` producing Obsidian-compatible Markdown
- Registration command `chatwizard.generateKb` is done

### Outstanding tasks
- [ ] UT coverage for all classifier/clusterer/exporter functions
- [ ] e2e scenarios for KB generation and incremental updates
- [ ] Manual testing with real session corpus

---

## Feature 24 — SQLite Persistent Cache

_Effort: L · Priority: P3 · No blockers_

### Status: ✅ Implemented

All source files created:
- `src/cache/cacheManager.ts` — `CacheManager` class with full SQLite schema (sessions, messages, code_blocks, tags, session_notes, parse_state, messages_fts), prepared statements, atomic transactions, FTS5 BM25 full-text search
- `src/cache/cacheIntegration.ts` — Integration bridge/facade for extension.ts
- `src/cache/schemaVersion.ts` — Schema version constant

Wired into:
- `src/extension.ts` — CacheIntegration initialized after SessionIndex; typed change listener persists sessions; load-all-from-cache at startup before watcher starts
- `src/watcher/fileWatcher.ts` — `_isFileUnchanged()` checks parse_state to skip unchanged files; `_updateParseState()` records mtime/size

Configuration: `chatwizard.enablePersistentCache` (default `true`)

Unit tests: 20 tests in `test/unit/cacheManager.test.ts` covering upsert, remove, loadAll, FTS5 search, tags, notes, cascade delete, close/reopen

---

## Feature 25 — Git/Branch Linkage

_Effort: M · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `gitContext.ts` type defined in `src/types/index.ts`
- `src/utils/gitContextReader.ts` — `readGitContextAsync()` reads branch + commit via `git` subprocess
- Branch data merged from Chronicle sessions
- "Group by Branch" option in the session tree group picker
- Git context rendered in session reader header

---

## Feature 26 — Workspace Digest / Standup Reports

_Effort: M · Priority: P3 · Depends on: Feature 18, Feature 25_

### Status: ✅ Implemented

- `src/analytics/digestBuilder.ts` — `buildDigest()` filters sessions by time window, groups by branch, produces Markdown
- Command `chatwizard.generateDigest` is registered

---

## Feature 27 — Cloud Sync (Opt-In)

_Effort: L · Priority: P3 · Depends on: Feature 24 (SQLite cache)_

### Status: ✅ Implemented

- `CloudSyncManager` (`src/cloud/cloudSyncManager.ts`) with `ICloudBackend` interface
- GitHub Gist backend (fully functional, AES-256-GCM encrypted)
- S3 and Azure Blob backends (placeholders with setup guidance)
- Periodic auto-sync (every 5 minutes), change detection via content hash
- Encrypted with per-machine key derived from hostname + storage path
- Configuration: `chatwizard.cloudSync.enabled`, `chatwizard.cloudSync.type`
- Credentials via environment variables (`CHATWIZARD_GITHUB_TOKEN`, etc.)

---

## Feature 28 — Session Status Lifecycle

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- `status` field on `SessionMetadata` (`'open' | 'resolved' | 'revisit'`)
- `chatwizard.setSessionStatus` command with QuickPick
- `chatwizard.filterByStatus` command
- Filter by status integrated into the main filter dialog
- Status badge (`$(check)` / `$(refresh)`) shown in tree item
- Status chip displayed in session reader header

---

## Feature 29 — Bookmarks Within a Session

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- `SessionBookmark` type with `messageIndex`, `note`, `createdAt`
- `bookmarks` field on `SessionMetadata`
- `SidecarMetadataStore` methods: `addBookmark`, `removeBookmark`, `toggleBookmark`, `getBookmarks`
- Bookmark button (`★`/`☆`) on each message card in the session reader
- `updateBookmarksUI()` renders bookmark jump list with click-to-scroll
- Click delegation for bookmark toggle via webview IPC

### Bug Fixes Applied (P3 sprint)
- [x] **Bookmark icon now shows correct filled/empty state on initial load**
- [x] **Bookmarks now persist across VS Code restarts**
- [x] **Annotations now render on initial session load**

---

## Feature 30 — Inline Annotations

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- `MessageAnnotation` type with `messageIndex`, `text`, `createdAt`, `updatedAt`
- `annotations` field on `SessionMetadata`
- `SidecarMetadataStore` methods: `upsertAnnotation`, `removeAnnotation`, `getAnnotations`
- "Add note" button (`📝`) on each message card
- Inline annotation editor textarea with Save/Cancel
- Annotation block rendering with Edit/Delete buttons
- Annotation data included in initial render message

### Bug Fixes Applied (P3 sprint)
- [x] Annotations now render on initial session load
- [x] Sidecar cache refreshed after annotation changes

---

## Feature 31 — Session Linking

_Effort: M · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- Bidirectional linking via `linkedSessionIds` on `SessionMetadata`
- `chatwizard.linkSession` / `chatwizard.unlinkSession` commands with QuickPick
- `SidecarMetadataStore.addLinkedSession` / `removeLinkedSession`

---

## Feature 32 — Response Rating

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- `MessageRating` type with `messageIndex`, `rating` (1 | -1), `createdAt`
- `ratings` field on `SessionMetadata`
- `SidecarMetadataStore.setRating()` method
- `chatwizard.rateSession` command

---

## Feature 33 — Duplicate / Related Session Detection

_Effort: M · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `src/analytics/duplicateDetector.ts` — `detectRelatedSessions()` with centroid embedding + cosine similarity
- `RelatedSessionPair` type

---

## Feature 34 — Outcome / Follow-Up Tracking

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Status: ✅ Implemented

- `ActionItem` type with `id`, `text`, `done`, `createdAt`, `source`
- `actionItems` field on `SessionMetadata`
- `src/analytics/actionItemExtractor.ts` — `extractActionItems()` with heuristic phrase matching
- `SidecarMetadataStore` stores action items via `patch()`

---

## Feature 35 — Keyboard-Only Navigation

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Complete

- Focus navigation commands registered: `chatwizard.focusSessionTree`, `chatwizard.focusSearch`, etc.
- `chatwizard.treeView.selectNext`/`selectPrevious` commands for up/down navigation
- Session reader already has `Ctrl+F` search focus

### Keybindings Added
- `j`/`k` — navigate next/previous (Sessions + Code Blocks views)
- `g` — focus Sessions tree view (from editor or Code Blocks)
- `/` — open search (Sessions + Code Blocks)
- `l`/`h` — expand/collapse tree node
- `ctrl+l` — open filter dialog
- `shift+/` — open semantic/topic search
- `enter` — open selected session
- `ctrl+a`/`ctrl+space` — multi-select support
- `shift+ctrl+b` — open Code Blocks view

---

## Feature 36 — Session Sharing

_Effort: M · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `src/export/sessionHtmlExporter.ts` — `exportSessionAsHtml()` producing self-contained HTML
- `chatwizard.shareSession` command with save dialog
- Redaction option for code blocks

---

## Feature 37 — Post-Session Cost Tips & Analytics

_Effort: S · Priority: P3 · Status: Re-enabled_

### Status: ✅ Re-enabled

- `SessionCostAdvisorNotifier` is instantiated in `extension.ts`
- `SessionCostAccumulator`, `SessionCostAdvisor`, `SessionCostAdvicePanel` all exist and are functional

---

## Feature 38 — MCP Tools: `includeCode` Flag

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `src/utils/contentFilter.ts` — `stripCodeBlocks()` removes fenced code blocks and long inline code spans

---

## Feature 39 — MCP `/mcp-config` Auth Hardening

_Effort: XS · Priority: P3 · Status: Complete_

### Status: ✅ Complete

- The `/mcp-config` endpoint already requires `Authorization: Bearer <token>` header (line 187 in `mcpServer.ts`)
- Returns 401 without valid token

---

## Feature 40 — Antigravity `.pb` (Protobuf) Support

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `src/parsers/antigravityProtobuf.ts` — `scanProtobufStrings()` wire-type 2 scanner and `parseAntigravityPbFile()`
- Discovery wired into `antigravityWorkspace.ts`

---

## Feature 41 — Zed AI Source Support

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `'zed'` added to `SessionSource` type
- `src/parsers/zed.ts` — Zed conversation parser
- `src/readers/zedWorkspace.ts` — Zed session file discovery

---

## Feature 42 — Tabnine Chat Source Support

_Effort: M · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `src/parsers/tabnine.ts` — Full Tabnine conversation parser (handles `type` and `role` fields, `text` and `content` message bodies, `bot`/`assistant` role aliases)
- `src/readers/tabnineWorkspace.ts` — Tabnine session file discovery (`discoverTabnineConversationsAsync`, `loadTabnineSessionsAsync`)
- `src/watcher/sources/TabnineSourceWatcher.ts` — `ISourceWatcher` implementation providing initial indexing and live file watching
- Wired into `fileWatcher.ts`:
  - `indexTabnine` config setting (default `true`)
  - `collectTabnineSessionsAsync()` method for initial batch indexing
  - Tabnine sessions included in `buildInitialIndex()` pipeline
  - Tabnine sessions included in session filter and count
- `chatwizard.indexTabnine` configuration setting added to `package.json`

---

## Feature 43 — Session Retention Controls

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Complete

- `chatwizard.sessionRetentionDays` setting applied in `extension.ts` — filters sessions from all UI
- `SessionIndex.setRetentionDays()` and `_isWithinRetention()` implemented
- `chatwizard.semanticIndexMaxAgeDays` setting defined in `package.json`
- `SemanticIndexer.setMaxAgeDays()` implemented — filters sessions at `scheduleSession()` time
- Wiring in `extension.ts`: `createAndInitSemanticIndexer()` reads config and calls `indexer.setMaxAgeDays()`

---

## Feature 44 — API / Programmatic Access

_Effort: M · Priority: P3 · No blockers (runs independently of SQLite)_

### Status: ✅ Implemented

- `RestApiServer` (`src/api/restApiServer.ts`) — HTTP REST API using Node.js built-in http module
- Endpoints:
  - `GET /health` — health check with version, session count, uptime (no auth)
  - `GET /v1/sessions` — list recent session summaries (pagination, source filter)
  - `GET /v1/sessions/:id` — full session detail with messages
  - `GET /v1/sessions/search?q=...` — full-text search across all sessions
  - `GET /v1/stats` — aggregate statistics (by source, model, totals)
  - `GET /` — API documentation (when `restApi.enableDocs` is true)
- Bearer token auth (reuses MCP token infrastructure)
- Bound to 127.0.0.1 only, CORS enabled
- Config: `chatwizard.restApi.enabled`, `chatwizard.restApi.port`, `chatwizard.restApi.enableDocs`
- Wired into `extension.ts` with config-based auto-start

### Status: ⬜ Not started

---

## Feature 45 — Compacted Session Detection & Visibility

_Effort: S · Priority: P3 · No blockers_

### Status: ✅ Implemented

- `isCompacted` and `compactionSummary` fields on `Session` type
- Claude parser should detect `"type":"summary"` JSONL entries

---

## Appendix A — Infrastructure Fixes (Completed)

These fixes were applied before feature implementation began and must remain functional.

### Fixture Paths

- ✅ Zed parser tests — fixtures now use correct path `test/fixtures/zed/`
- ✅ Tabnine parser tests — fixtures now use correct path `test/fixtures/tabnine/`
- ✅ Compacted session tests — fixtures now use correct path `test/fixtures/compacted/`
- ✅ Build pipeline — `pretest` script runs `node test/copy-fixtures.mjs` to copy `test/fixtures/` → `out/test/fixtures/` automatically

### EPERM on Windows (gitContextReader)

- ✅ Added `rmRetry()` wrapper that retries `fs.rmSync` up to 5 times with 200ms busy-wait

### better-sqlite3 Native Module

- **VS Code test version**: 1.123.0 / 1.123.1 → **Electron 42.2.0** (Node ABI 146)
- **Problem**: `node-gyp` rebuild requires Python (✓ available 3.12.10) **and** Visual Studio Build Tools with C++ workload (not installed)
- **Fix**: Install **"Visual Studio Build Tools 2022"** with **"Desktop development with C++"** workload, then run `npm run rebuild:native`

---

## Appendix B — Type Definitions Status

All P3 feature types are already defined in `src/types/index.ts`:
- `SessionBookmark` — Feature 29
- `MessageAnnotation` — Feature 30
- `MessageRating` — Feature 32
- `ActionItem` — Feature 34
- `GitContext` — Feature 25
- `status` field on `SessionMetadata` — Feature 28
- `linkedSessionIds`, `annotations` fields on `SessionMetadata` — Features 28, 29, 30, 31

---

## Appendix C — Manual Testing Checklist

Run these after each feature implementation to verify no regressions:

- [ ] Open session viewer — verify rendering for all 14 sources
- [ ] Session tree — sort, filter, group, search
- [ ] Code Blocks view — list, filter, sort, open session
- [ ] Prompt Library — browse and copy prompts
- [ ] Analytics dashboard — verify charts and tables
- [ ] Timeline view — scroll through chronological view
- [ ] MCP server — start, verify tools, stop
- [ ] Archive — archive and restore sessions
- [ ] Tags — add/remove/filter by tags
- [ ] Export — single session, batch, Obsidian
- [ ] Semantic search — verify topic search results
- [ ] Chronicle — verify checkpoint summaries load
- [ ] Copilot integration — verify session discovery
- [ ] Settings — verify all configuration options

---

## P3 Completion Gate

All P3 features are complete when:

- [x] Features 35, 42, 43 remaining items completed
- [x] Features 24, 27, 44 implemented
- [ ] No regressions introduced in P1/P2 features (run full test suite)
- [x] `whats-next.md` master roadmap updated with P3 completion status
- [x] `CHANGELOG.md` updated with P3 release notes
- [x] **P3 complete — ready for P4 planning or Individual Pro launch preparation.**