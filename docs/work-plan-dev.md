# ChatWizard — Development Work Plan

## Overview

ChatWizard is a VS Code extension that reads AI chat session data directly from the local file system and builds a unified, searchable index over accumulated conversation history.

**Supported AI Chat Extensions:**
- **GitHub Copilot Chat** — reads per-workspace JSONL operation logs from `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/` and workspace metadata from `state.vscdb` (SQLite)
- **Claude Code** — reads session JSONL files from `~/.claude/projects/**/*.jsonl`

**Target Audience:** Developer-power-users who actively use GitHub Copilot Chat and/or Claude Code in VS Code and want visibility into their accumulated conversation history across projects.

---

## Phase 0 — Foundation & Scaffolding ✅ COMPLETE

**Goal:** Establish the extension skeleton, data-layer contracts, and file-system access patterns.

### Tasks
- [x] Scaffold VS Code extension with TypeScript (`yo code`)
- [x] Define data model interfaces: `Session`, `Message`, `CodeBlock`, `Prompt`
- [x] Implement Copilot JSONL parser (append-only operation log → conversation state reconstruction)
- [x] Implement Claude Code JSONL parser (`~/.claude/projects/**/*.jsonl`)
- [x] Implement Copilot workspace mapping reader (`workspace.json` + `state.vscdb` SQLite)
- [x] Implement `FileSystemWatcher` for live index updates as sessions are written
- [x] Build in-memory session index with basic CRUD
- [x] Unit tests for all parsers against sample fixture files

**Deliverable:** A headless extension that silently indexes all sessions on activation and stays current via file watchers. No UI yet.

**How to verify:**
- Activate the extension in the Extension Development Host and open the VS Code Output panel → select the "ChatWizard" channel; confirm it logs session counts for both Copilot and Claude sources with no parse errors.
- Send a new message in Copilot Chat or Claude Code while the dev host is running; confirm the Output channel logs a live index update within a few seconds.
- Run unit tests against fixture JSONL files for both Copilot (operation log replay) and Claude (snapshot) parsers and confirm all pass.

**Complexity:** High (parsing, log replay, SQLite access)
**Effort:** ~3 weeks

---

## Phase 1 — Session Management Panel ✅ COMPLETE

**Goal:** First visible surface — a TreeView listing all sessions across all workspaces.

**Depends on:** Phase 0

### Tasks
- [x] Register a VS Code TreeView (`vscode.window.createTreeView`)
- [x] Show session nodes: title, source badge (Copilot / Claude), workspace, date
- [x] Show per-session metadata: prompt count, response count, file size in KB
- [x] Implement sorting: by date, workspace, session length, title (A–Z), AI model, source
- [x] Sort direction indicators: toolbar icons toggle between ↑ and ↓; active direction shown at a glance
- [x] Sort direction persistence: chosen sort stack survives VS Code restarts (`globalState`)
- [x] Composite multi-key sort: "Configure Sort Order" builder lets the user pick up to 3 sort criteria in priority order
- [x] Session filtering: filter visible sessions by title substring, date range, model substring, min/max message count; active filters shown in the tree subtitle
- [x] Session pinning: right-click any session → "Pin Session" to lock it at the top of the list; pinned sessions persist across restarts; right-click → "Unpin Session" to restore
- [x] Drag-and-drop reordering: drag items within the TreeView to manually reposition them
- [x] Hover tooltip: shows Title, Source, Model, Workspace, Updated date, Size, prompt/response counts, and pinned status
- [x] Implement reader view (Webview panel) with full Markdown rendering including: headings, bold, italic, strikethrough (`~~`), inline code, fenced code blocks with language labels, pipe tables, 4-space indented code blocks, blockquotes, ordered/unordered lists, horizontal rules, and links
- [x] User vs. assistant messages visually distinct; user accent color configurable via `chatwizard.userMessageColor` setting
- [x] Aborted/cancelled response placeholder shown when a user turn has no following AI reply
- [x] Loading spinner shown while session HTML is being built
- [x] Empty messages (zero content after parsing) filtered before rendering
- [x] Wire `FileSystemWatcher` updates to refresh the TreeView live
- [x] Data quality: Claude sessions with epoch dates (1970-01-01) or zero messages are silently skipped
- [x] Extension settings:
  - `chatwizard.userMessageColor` — hex or CSS color for user message accent (default `#007acc`); color picker in Settings UI
  - `chatwizard.tooltipLabelColor` — color for tooltip field label text (Title:, Source:, etc.); leave blank for theme default

**Deliverable:** A fully browsable, sortable, filterable, pinnable session list. Clicking a session opens a readable conversation view with proper Markdown rendering.

**How to verify:**
- Open the ChatWizard activity bar icon; confirm a TreeView lists sessions from both Copilot Chat workspaces and Claude Code projects, each with source icon (github/hubot or pin), workspace name, date, message count, and file size.
- Hover over a session; confirm tooltip shows Title:, Source:, Model:, Workspace:, Updated:, Size:, and prompt/response counts.
- Use the sort toolbar buttons (Date, Workspace, Length, A–Z, Model) and confirm the list reorders; clicking the same button toggles direction (↑/↓ shown on the button). Reopen VS Code and confirm sort is remembered.
- Click the gear icon → "Configure Sort Order" and pick 2–3 sort criteria; confirm the tree subtitle shows the multi-key sort description and the list reflects it.
- Click the filter icon → set a title filter; confirm only matching sessions appear and the subtitle shows the active filter. Clear filters via the filter dialog.
- Right-click a session → "Pin Session"; confirm it moves to the top with a pin icon and stays there after a reload. Right-click → "Unpin Session" to restore.
- Drag a session to a different position in the list; confirm it moves.
- Click any session; confirm a Webview panel opens with a loading message that transitions to the full conversation. Confirm Markdown tables, bold, italic, strikethrough, code blocks, and lists all render correctly.
- Send a new chat message in either Copilot Chat or Claude Code; confirm the TreeView updates within a few seconds.
- Open `Settings → ChatWizard` and change `userMessageColor` to `#e06c75`; reopen a session and confirm the user message border/label uses the new color.

**Complexity:** Medium
**Effort:** ~2 weeks (original) + significant on-the-fly additions

---

## Phase 2 — Unified Search ✅ COMPLETE

**Goal:** Full-text search across all sessions, all workspaces, all supported extensions.

**Depends on:** Phase 0

### Tasks
- [x] Implement in-memory full-text index (inverted index; no external deps)
- [x] Separate indexing of user prompts vs. LLM responses
- [x] Build QuickPick search UI (`Ctrl+Shift+H` global keybinding)
- [x] Display results: source icon ($(github) / $(hubot)), session title, workspace, date, and content snippet
- [x] Snippet prefixed with role: "You:  …" for user turns, "Claude:  …" / "Copilot:  …" for AI turns
- [x] Exact match highlighting within the snippet detail line (explicit `highlights.detail` range passed to VS Code)
- [x] Source filter button (toolbar button cycles: All → Copilot only → Claude only → All) with distinct icon per state
- [x] Message-type filter button (cycles: All → Prompts only → Responses only → All) with distinct icon per state
- [x] Add regex search support (prefix query with `/` to enable regex mode)
- [x] Debounce live-search (300 ms) as the user types; accepts the selected result to open the session reader

**Deliverable:** `Ctrl+Shift+H` opens a QuickPick search panel that queries all history in real time with source-aware icons, role-labeled snippets, and highlighted match positions.

**How to verify:**
- Press `Ctrl+Shift+H`; type a term you recall using; confirm results appear with a source icon, session title, workspace, date, and a snippet that begins with "You:  " or the AI name.
- Confirm the matched term is highlighted within the snippet (not just in the title).
- Click the source filter button; cycle through All → Copilot → Claude states and confirm results change accordingly.
- Click the message-type filter button; select "Prompts only" and confirm only user-turn snippets appear; select "Responses only" and confirm only AI snippets appear.
- Type `/refactor.*class` and confirm regex results differ from plain-text results for the same term.
- Type quickly and confirm the results list does not update on every keystroke — it stabilizes after ~300 ms.
- Press Enter on a result; confirm the session opens in the reader view at the correct session.

**Complexity:** Medium-High
**Effort:** ~2 weeks

---

## Phase 3 — Export to Markdown ✅ COMPLETE

**Goal:** Export any session or set of sessions to a navigable `.md` file.

**Depends on:** Phase 1 (session list)

### Tasks
- [x] Implement Markdown serializer (`src/export/markdownSerializer.ts`): metadata header + role-labeled turns with `---` dividers
- [x] Scaffold `src/export/exportCommands.ts`: `registerExportCommands()` wires `chatwizard.exportSession` and `chatwizard.exportAll`
- [x] Wire `registerExportCommands()` into `extension.ts` activate function
- [x] Add "Export Session" and "Export All" entries to `package.json` commands + menus
- [x] Improve serializer: H2 per user prompt, H3 per AI response, code blocks with language labels
- [x] Open exported file in VS Code editor after save
- [x] Multi-select export via QuickPick (`chatwizard.exportSelected`)
- [x] Excerpt export — select specific messages from within the session reader (`chatwizard.exportExcerpt`)

**Deliverable:** Right-click a session → Export → Markdown file opens with full Outline navigation.

**How to verify:**
- Right-click a Copilot Chat session in the TreeView → "Export Session"; confirm a `.md` file opens in the VS Code editor.
- Open the Outline panel (`View → Outline`); confirm H2 headings for each user prompt and H3 headings for each AI response are listed and clickable.
- Repeat for a Claude Code session; confirm the same structure is produced.
- Use "Export All" and confirm one file per session is created in the target directory, or a single combined file depending on the chosen mode.
- Open the exported file and confirm fenced code blocks have the correct language identifier (e.g., ` ```typescript `).

**Complexity:** Low
**Effort:** ~1 week

---

## Phase 4 — Code Block Extraction ✅ COMPLETE

**Goal:** Index all fenced code blocks and make them browsable and copyable.

**Depends on:** Phase 0

### Tasks
- [x] Extend parser to extract fenced code blocks with language, content, and originating session (`IndexedCodeBlock` interface + `getAllCodeBlocks()` on `SessionIndex`)
- [x] Build Code Blocks Webview panel (filterable by language, searchable by content) — `CodeBlocksPanel` with sticky toolbar
- [x] Implement full-text search within code block content (`CodeBlockSearchEngine`)
- [x] Add one-click copy-to-clipboard
- [x] Show originating session title, date, source, workspace, and message role per block

**Deliverable:** A dedicated view listing every code snippet the AI ever generated, filterable by language.

**How to verify:**
- Open the Code Blocks panel; confirm code blocks from both Copilot Chat and Claude Code sessions appear, each tagged with language and originating session.
- Apply a language filter (e.g., "TypeScript"); confirm only TypeScript blocks are shown.
- Search by content within the panel (e.g., a function name you remember); confirm the correct block appears.
- Click the copy button on a block; paste into a new editor tab and confirm the content is correct.

**Complexity:** Medium
**Effort:** ~1.5 weeks

---

## Phase 5 — Prompt Library ✅ COMPLETE

**Goal:** Extract, deduplicate, and surface every user-turn prompt for re-use.

**Depends on:** Phase 0, Phase 7 (similarity detection, can be simplified without it)

### Tasks
- [x] Extract all user-turn messages across sessions
- [x] Deduplicate exact matches
- [x] Cluster by trigram/TF-IDF similarity (basic grouping)
- [x] Build Prompt Library panel: searchable, sorted by frequency
- [x] Add copy-to-clipboard per prompt
- [x] Show frequency count: "Asked 7 times across 3 projects"

**Deliverable:** A library of reusable prompts ranked by how often the user reaches for them.

**How to verify:**
- Open the Prompt Library panel; confirm user-turn prompts from both Copilot Chat and Claude Code sessions are listed.
- Confirm exact-duplicate prompts are collapsed into one entry showing a frequency count.
- Find a prompt you recall typing many times; confirm the count and project count match expectations (e.g., "Asked 7 times across 3 projects").
- Click copy on a prompt; paste into a Copilot Chat or Claude Code input box to confirm it is usable.
- Search within the panel by keyword; confirm matching prompts are filtered.

**Complexity:** Medium
**Effort:** ~1.5 weeks

---

## Phase 6 — Analytics & Usage Stats ✅ COMPLETE

**Goal:** Aggregate statistics computed from the session index.

**Depends on:** Phase 0

### Tasks
- [x] Token counting utility (`src/analytics/tokenCounter.ts`): char/4 approximation for Claude, word×1.3 for Copilot/GPT — no external deps
- [x] Analytics engine (`src/analytics/analyticsEngine.ts`): `computeAnalytics()` produces `AnalyticsData` with session-level metrics, daily activity, project activity, top terms, longest sessions
- [x] Compute session-level metrics: total sessions, prompts, responses, tokens (user vs. LLM) broken out by source
- [x] Compute aggregate metrics: activity over time (daily token totals, prompt counts, session counts)
- [x] Surface most active projects (by token count), most frequent user-prompt terms (top 20, stop-word filtered)
- [x] Build Analytics Webview panel (`src/analytics/analyticsPanel.ts`) with Chart.js via CDN: summary cards, daily activity line chart, top projects table, top terms bar chart, longest sessions tables
- [x] Show longest sessions by message count and token count (top 10 each)
- [x] Register `chatwizard.showAnalytics` command; wire live refresh on index changes
- [x] Unit tests for tokenCounter (full formula coverage) and analyticsEngine (all aggregations and edge cases)

**Deliverable:** An analytics dashboard showing consumption trends, token usage, and project activity.

**How to verify:**
- Open the Analytics Webview panel; confirm charts render for activity over time (sessions/prompts per day or week).
- Confirm token counts are shown separately for Copilot Chat (GPT tokenizer) and Claude Code (Anthropic tokenizer).
- Confirm user-prompt tokens vs. LLM-response tokens are broken out per session and in aggregate.
- Check the "most active projects" section; confirm it reflects your actual workspace usage.
- Confirm the longest sessions by token count list a session you know was lengthy.

**Complexity:** Medium-High (tokenizers, charting)
**Effort:** ~2 weeks

---

## Phase 7 — Duplicate / Similar Prompt Detection ✅ COMPLETE

**Goal:** Surface semantically equivalent prompts across sessions without ML dependencies.

**Depends on:** Phase 5

### Tasks
- [x] Implement TF-IDF or trigram similarity scoring between prompts
- [x] Identify clusters of near-duplicate prompts
- [x] Surface in UI: "You asked something equivalent to this N times across M projects"
- [x] Allow merging/consolidating entries in the Prompt Library
- [x] Enrich `PromptEntry` with `sessionMeta` (session title, date, source) per occurrence
- [x] Show source session title + date on each variant in the Prompt Library sidebar tab
- [x] Merge button per cluster collapses variants into canonical (client-side + extension message)
- [x] Tests: sessionMeta coverage in promptExtractor.test.ts, HTML generation in promptLibraryPanel.test.ts, full similarityEngine coverage

**Deliverable:** Notification-style hints and a grouped view of repeated prompts.

**How to verify:**
- Open the Prompt Library left side tab; confirm similar (but not identical) prompts are visually grouped together under a shared cluster heading.
- Expand a cluster; confirm each variant is listed with its source session and date.
- Confirm a tooltip or inline label reads something like "You asked something equivalent to this 4 times across 2 projects."
- Use the merge/consolidate action on a cluster and confirm it collapses into a single canonical entry in the library.

**Complexity:** Medium
**Effort:** ~1.5 weeks

---

## Phase 8 — Timeline View ✅ COMPLETE

**Goal:** Chronological feed of all sessions across all workspaces.

**Depends on:** Phase 1

### Tasks
- [x] Implement Timeline Webview left side tab with chronological session feed (`src/timeline/timelineViewProvider.ts`)
- [x] Each entry: project, session title, first prompt, message count, date
- [x] Add date navigation / jump-to-date (date input scrolls to nearest month group)
- [x] Filter by workspace/project (workspace + source dropdowns in sticky filter bar)
- [x] `buildTimeline()` data builder (`src/timeline/timelineBuilder.ts`): skips epoch/empty sessions, sorts newest-first, extracts firstPrompt from string or content-block messages
- [x] Live refresh on index changes via `addChangeListener`
- [x] Unit tests: `test/suite/timelineBuilder.test.ts` (20 cases) + `test/suite/timelineViewProvider.test.ts` (12 cases)

**Deliverable:** A "what was I working on last Tuesday?" view spanning all projects.

**How to verify:**
- Open the Timeline Webview panel; confirm entries from both Copilot Chat and Claude Code sessions appear in reverse-chronological order, each showing project name, session title, first prompt, and message count.
- Use "Jump to date" to navigate to a date a week ago; confirm the view scrolls to that position.
- Apply a workspace filter; confirm only sessions from the selected project appear.

**Complexity:** Low-Medium
**Effort:** ~1 week

---

## Phase 9 — Polish & Release ✅ COMPLETE

**Goal:** Production-readiness: performance, packaging, documentation, marketplace listing.

**Depends on:** All phases

### Tasks
- [x] Performance audit: index build time on large history (1000+ sessions)
- [x] Incremental index updates (avoid full rebuild on file change)
- [x] Extension settings: configurable data source paths
- [x] Write README with full feature walkthrough
- [ ] Package with `vsce` and publish to VS Code Marketplace *(manual operational step)*
- [x] Add telemetry opt-in (local only, no external calls)

### Implementation details
- **Batch initial build** (`src/watcher/fileWatcher.ts`): `buildInitialIndex()` now collects all sessions via `collectClaudeSessions()` / `collectCopilotSessions()`, then calls `index.batchUpsert(all)` — firing listeners exactly once instead of N times during startup.
- **`parseFile()` helper** (`src/watcher/fileWatcher.ts`): shared private method returns `Session | null`; used by both the batch collector and the live `indexFile()` (single-file upsert on file change events).
- **Typed change events** (`src/index/sessionIndex.ts`): `SessionIndexEvent` union type (`upsert` / `remove` / `batch`), `addTypedChangeListener()` method. `upsert()` fires `{ type: 'upsert', session }`, `remove()` fires `{ type: 'remove', sessionId }`, `batchUpsert()` fires `{ type: 'batch', sessions }`.
- **`batchUpsert(sessions[])** (`src/index/sessionIndex.ts`): inserts all sessions silently then fires one typed + one plain notification.
- **Incremental full-text search** (`src/extension.ts`): replaced `rebuildSearchIndex()` (full O(n) scan on every change) with `index.addTypedChangeListener()` that calls `engine.index(session)`, `engine.remove(sessionId)`, or a loop for batches — O(1) per live update.
- **`CodeBlockSearchEngine` incremental methods** (`src/codeblocks/codeBlockSearchEngine.ts`): `removeBySession(sessionId)`, `upsertBySession(sessionId, blocks)`, `get size`.
- **Configurable paths** (`src/watcher/configPaths.ts`): `resolveClaudeProjectsPath(override?)` and `resolveCopilotStoragePath(override?)` with override → config → default priority. Settings: `chatwizard.claudeProjectsPath`, `chatwizard.copilotStoragePath`. window-reload prompt on change.
- **Local telemetry** (`src/telemetry/telemetryRecorder.ts`): `TelemetryRecorder` class; JSONL file in `context.globalStorageUri.fsPath`; no external calls; events: `extension.activated`, `session.opened`, `search.opened`; gated behind `chatwizard.enableTelemetry` (default false); `onDidChangeConfiguration` updates the gate at runtime.
- **README.md**: written with full feature walkthrough, settings table, commands table, architecture/privacy notes.
- **package.json**: version `1.0.0`, `license: "MIT"`, keywords, `categories: ["Other","Visualization"]`, repository; three new settings added.

**Unit tests added:**
- `test/suite/codeBlockSearchIncremental.test.ts` — 17 tests for `size`, `removeBySession`, `upsertBySession`, `getLanguages`, `search` incrementally
- Extended `test/suite/sessionIndex.test.ts` — typed listener and `batchUpsert` coverage
- `test/suite/configPaths.test.ts` — `resolveClaudeProjectsPath`/`resolveCopilotStoragePath`: default, override, empty-string fallback
- `test/suite/telemetryRecorder.test.ts` — disabled no-op, enabled write, JSONL format, `getEvents`, `clear`, corrupt-line resilience

**Deliverable:** A published `.vsix` and Marketplace listing; all features work end-to-end with no manual configuration required for standard Copilot Chat and Claude Code installs.

**How to verify:**
- Install the packaged `.vsix` via `Extensions: Install from VSIX…` on a clean VS Code profile; confirm the extension activates without errors.
- Confirm both Copilot Chat and Claude Code sessions are auto-discovered using default paths (no manual configuration required).
- Navigate to extension settings; change the Claude Code sessions path to a custom directory and confirm the index updates to reflect the new location.
- Trigger a large index build (1000+ sessions) and confirm activation completes in a reasonable time with no UI freeze.
- Confirm the Output channel shows no unhandled errors during a typical usage session spanning all features.

**Complexity:** Medium
**Effort:** ~2 weeks

---

## Phase Summary

| Phase | Feature | Effort | Complexity | Depends On | Status |
|-------|---------|--------|------------|------------|--------|
| 0 | Foundation & Parsers | 3 weeks | High | — | ✅ Complete |
| 1 | Session Management Panel | 2 weeks+ | Medium | 0 | ✅ Complete |
| 2 | Unified Search | 2 weeks | Medium-High | 0 | ✅ Complete |
| 3 | Export to Markdown | 1 week | Low | 1 | ✅ Complete |
| 4 | Code Block Extraction | 1.5 weeks | Medium | 0 | ✅ Complete |
| 5 | Prompt Library | 1.5 weeks | Medium | 0, 7 | ✅ Complete |
| 6 | Analytics & Usage Stats | 2 weeks | Medium-High | 0 | ✅ Complete |
| 7 | Duplicate Prompt Detection | 1.5 weeks | Medium | 5 | ✅ Complete |
| 8 | Timeline View | 1 week | Low-Medium | 1 | ✅ Complete |
| 9 | Polish & Release | 2 weeks | Medium | All | ✅ Complete |

**Total estimated effort:** ~17.5 weeks

---

## Architectural Constraints (carry through all phases)

- Read-only access to source files; never write to Copilot or Claude session files
- All processing is local; no data leaves the machine
- `FileSystemWatcher` drives live index updates
- Copilot JSONL requires log replay (not snapshot); parsers must handle this
- Token counting uses tokenizer vocab files already on disk (no network download required)
