# Change Log

## [1.4.0] - 2026-04-30

- **Fine-grained topic similarity embeddings** — the semantic index now stores one vector per user message and one vector per paragraph of each AI response (split on `\n\n`), replacing the previous single-vector-per-session approach. Session-level vectors were effectively a broad-domain centroid that could not distinguish topics within a single-project workspace; message- and paragraph-level vectors keep each embedding within the model's 256-token window and produce significantly tighter similarity scores.
- **Scope filter in topic similarity search** — the semantic search quick-pick now has a scope toggle button cycling `Both → My questions → AI responses → Both`. "My questions" searches only user-message vectors; "AI responses" searches only assistant-paragraph vectors; changing scope re-runs the query rather than re-filtering client-side. Icons: `$(list-unordered)` / `$(comment)` / `$(hubot)`.
- **Raised `SEMANTIC_MIN_SCORE` default** — default minimum similarity score raised from `0.25` to `0.35`; fine-grained vectors produce tighter distributions and the old threshold admitted too much noise. The `chatwizard.semanticMinScore` setting description updated to reflect the new recommended range (`0.30–0.45`).
- **Removed `SEMANTIC_MAX_CHARS` truncation** — the 2048-character hard cap on text passed to the embedding model is removed. Individual user messages and AI paragraphs are short enough to stay within the model's 256-token limit without a character ceiling; truncating long inputs was silently discarding signal.
- **Semantic index binary format** — the persistent `semantic-embeddings.bin` file uses a composite key `"sessionId::role::messageIndex::paragraphIndex"` per entry so each stored vector is traceable to its exact message and paragraph.
- **Progress UX for model loading and indexing** — model loading and the embedding queue now surface progress via `vscode.window.withProgress` (window-level notification bar showing "Chat Wizard: loading AI model…" / "Chat Wizard: indexing… N / M sessions") instead of a left-aligned status bar item. The notification bar is less intrusive and consistent with how the extension surfaces other background work.
- **Search results deduplicated by session** — the keyword search quick-pick (`chatwizard.search`) now shows at most one result per session (the highest-scoring hit), eliminating duplicate entries when multiple snippets from the same session matched the query.
- **Workspace matching fix in Manage Workspaces** — workspace items are now matched to the active VS Code window using a prefix/child-path comparison (`itemPath === openPath || itemPath.startsWith(openPath + sep)`) rather than an exact-path equality check. Previously, when a deeper Cursor or Copilot workspace path was also discovered under the same root, the exact match failed and deselect-all fell back to all workspaces instead of staying scoped to the current one.
- **"Topic similarity" terminology** — user-visible strings updated from "semantic search" to "topic similarity search" / "Find Sessions by Topic" throughout the command palette, setting descriptions, button tooltips, and notification messages to better describe what the feature does.

## [1.3.0] - 2026-04-23

- **Google Antigravity support** — indexes agent conversations from Google Antigravity (Google’s VS Code-fork AI IDE) stored as JSONL step logs at `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/overview.txt`. User messages are extracted from `<USER_REQUEST>` XML envelopes; tool-only model steps are skipped; AI responses come from `PLANNER_RESPONSE` steps that carry text content. Session title is derived from the first user message (max 120 chars). Configurable via `chatwizard.indexAntigravity` and `chatwizard.antigravityBrainPath`.
- Antigravity sessions participate fully in full-text search, the prompt library, code block extraction, analytics, model usage, timeline, and source filtering across all panels.
- Token counting for Antigravity sessions uses the character ÷ 4 Gemini approximation (same as Claude) rather than the GPT word-based heuristic.
- `modelUsageEngine`: Antigravity sessions with no model field fall back to the label `Gemini Auto`.
- Antigravity brand icon (gradient “A” arch in Google Blue / Yellow / Red) added to `resources/icons/`.
- `--cw-antigravity` CSS variable and `.cw-badge-antigravity` badge class added to the shared theme (Google Blue `#4285F4` dark / `#1a73e8` light).
- Analytics panel: added “Antigravity Sessions” summary card; per-source session counter is now explicit for all sources rather than using a catch-all `else` branch.
- Timeline: Antigravity added to the source filter dropdown and `SRC_LABEL` map; timeline entries get the `cw-badge-antigravity` badge.
- Search panel: source filter cycle expanded to include Antigravity (`All → Copilot → Claude → Antigravity → All`).

## [1.2.0] - 2026-04-21

- **CI: unit tests on every release** — the release workflow now runs the full test suite on each target platform (Windows, Linux, macOS x64, macOS arm64) before building the VSIX, catching regressions before publication.
- **Cline support** — indexes Cline (`saoudrizwan.claude-dev`) task history from `api_conversation_history.json` per task; mixed text/tool-use content is handled with tool calls silently skipped; model and workspace path read from `ui_messages.json`. Configurable via `chatwizard.indexCline` and `chatwizard.clineStoragePath`.
- **Roo Code support** — indexes Roo Code (`rooveterinaryinc.roo-cline`) task history using the same parser as Cline (identical storage format, different extension ID). Configurable via `chatwizard.indexRooCode` and `chatwizard.rooCodeStoragePath`.
- **Cursor support** — indexes Cursor chat and agent sessions from SQLite `state.vscdb` files (`composer.composerData` key); one `state.vscdb` can contain multiple sessions. Requires the bundled `better-sqlite3` native module. Configurable via `chatwizard.indexCursor` and `chatwizard.cursorStoragePath`.
- **Windsurf support** — indexes Windsurf (Codeium) Cascade sessions from SQLite `state.vscdb` files (`cascade.sessionData` key); reuses the same `better-sqlite3` driver as Cursor. Configurable via `chatwizard.indexWindsurf` and `chatwizard.windsurfStoragePath`.
- **Aider support** — discovers and indexes `.aider.chat.history.md` files in all open VS Code workspace folders and any directories listed in `chatwizard.aiderSearchRoots`; scans up to `chatwizard.aiderSearchDepth` levels deep (default 3, max 5); model read from `.aider.conf.yml` when present. Configurable via `chatwizard.indexAider`, `chatwizard.aiderSearchRoots`, and `chatwizard.aiderSearchDepth`.
- All five new sources participate fully in full-text search, the prompt library, code block extraction, analytics, model usage, timeline, and workspace management.
- Cursor-native model IDs normalised: `cursor-fast` → `Cursor Fast`, `cursor-small` → `Cursor Small`.
- `better-sqlite3` native module bundled with the extension; VSIX packages are built per OS to include the correct platform binary.
- **Session Reader streaming** — large sessions (500+ messages) now load only the most-recent messages on open, with a banner to load earlier history on demand; content is streamed to the webview in small batches so the panel is interactive immediately.
- **Tree view pagination** — Sessions and Code Blocks panels now load items in pages; a "Load More (N remaining)" entry appears at the bottom so the UI stays fast regardless of session count.
- **Session grouping by date** — the Sessions panel now groups sessions into date buckets (Today, Yesterday, This Week, This Month, Older) by default; a toolbar toggle switches between grouped and flat-list views, with the choice persisted across restarts.
- **Code block grouping by language** — the Code Blocks panel now groups entries by language by default; a toolbar toggle switches between grouped and flat-list views, with the choice persisted across restarts.
- **Prompt clustering performance** — near-duplicate detection now uses a MinHash pre-filter to skip full trigram comparison on unrelated pairs, runs in async `setImmediate`-chunked batches to avoid blocking the extension host, caps computation at 5,000 entries, and caches results until the prompt index changes.

## [1.1.0] - 2026-03-22

- **Workspace Management** — new `Manage Watched Workspaces` command lets you select exactly which Copilot and Claude workspaces to index; shows size and session count per workspace; persists selection and restarts the watcher.
- **Model Usage panel** — new sidebar tab showing per-model user request counts over a configurable date range, with workspace and session drill-down and friendly model name normalisation.
- **Timeline enhancements** — added activity heat map (click a day to filter), work burst clustering (2-hour window), per-week topic drift ribbon, summary stats bar (streak, active days, on-this-day), and inline keyword search.

## [1.0.0] - 2026-03-18

Initial release. All nine development phases complete:

- Phase 0: Foundation — parsers, file watchers, session index
- Phase 1: Session Management Panel — TreeView, reader, sort, filter, pin, drag-drop
- Phase 2: Unified Full-Text Search — inverted index, QuickPick UI, regex, role filters
- Phase 3: Export to Markdown — single, all, multi-select, excerpt
- Phase 4: Code Block Extraction — language filter, content search, copy-to-clipboard
- Phase 5: Prompt Library — deduplication, frequency ranking, copy
- Phase 6: Analytics Dashboard — token usage, daily activity chart, top projects, top terms
- Phase 7: Duplicate Prompt Detection — trigram similarity clusters, merge action
- Phase 8: Timeline View — chronological feed, month groups, workspace filter, jump-to-date
- Phase 9: Polish — configurable data source paths, local telemetry opt-in, release packaging