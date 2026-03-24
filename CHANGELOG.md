# Change Log

## [1.2.0] - 2026-03-24

- **Cline support** — indexes Cline (`saoudrizwan.claude-dev`) task history from `api_conversation_history.json` per task; mixed text/tool-use content is handled with tool calls silently skipped; model and workspace path read from `ui_messages.json`. Configurable via `chatwizard.indexCline` and `chatwizard.clineStoragePath`.
- **Roo Code support** — indexes Roo Code (`rooveterinaryinc.roo-cline`) task history using the same parser as Cline (identical storage format, different extension ID). Configurable via `chatwizard.indexRooCode` and `chatwizard.rooCodeStoragePath`.
- **Cursor support** — indexes Cursor chat and agent sessions from SQLite `state.vscdb` files (`composer.composerData` key); one `state.vscdb` can contain multiple sessions. Requires the bundled `better-sqlite3` native module. Configurable via `chatwizard.indexCursor` and `chatwizard.cursorStoragePath`.
- **Windsurf support** — indexes Windsurf (Codeium) Cascade sessions from SQLite `state.vscdb` files (`cascade.sessionData` key); reuses the same `better-sqlite3` driver as Cursor. Configurable via `chatwizard.indexWindsurf` and `chatwizard.windsurfStoragePath`.
- **Aider support** — discovers and indexes `.aider.chat.history.md` files in all open VS Code workspace folders and any directories listed in `chatwizard.aiderSearchRoots`; scans up to `chatwizard.aiderSearchDepth` levels deep (default 3, max 5); model read from `.aider.conf.yml` when present. Configurable via `chatwizard.indexAider`, `chatwizard.aiderSearchRoots`, and `chatwizard.aiderSearchDepth`.
- All five new sources participate fully in full-text search, the prompt library, code block extraction, analytics, model usage, timeline, and workspace management.
- Cursor-native model IDs normalised: `cursor-fast` → `Cursor Fast`, `cursor-small` → `Cursor Small`.
- `better-sqlite3` native module bundled with the extension; VSIX packages are built per OS to include the correct platform binary.

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