# ChatWizard

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/Veverke.chatwizard.svg)](https://marketplace.visualstudio.com/items?itemName=Veverke.chatwizard)
[![Installs](https://vsmarketplacebadges.dev/installs/Veverke.chatwizard.svg)](https://marketplace.visualstudio.com/items?itemName=Veverke.chatwizard)
[![Rating](https://vsmarketplacebadges.dev/rating/Veverke.chatwizard.svg)](https://marketplace.visualstudio.com/items?itemName=Veverke.chatwizard)
[![Open VSX Version](https://img.shields.io/open-vsx/v/Veverke/chatwizard?label=Open%20VSX)](https://open-vsx.org/extension/Veverke/chatwizard)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/Veverke/chatwizard)](https://open-vsx.org/extension/Veverke/chatwizard)
[![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue.svg)](LICENSE)
[![CI](https://github.com/veverke/chatwizard/actions/workflows/ci.yml/badge.svg)](https://github.com/veverke/chatwizard/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/veverke/chatwizard?style=social)](https://github.com/veverke/chatwizard)
[![GitHub Issues](https://img.shields.io/github/issues/veverke/chatwizard)](https://github.com/veverke/chatwizard/issues)
[![Last Commit](https://img.shields.io/github/last-commit/veverke/chatwizard)](https://github.com/veverke/chatwizard/commits/main)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/veverke/chatwizard/pulls)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Inspired by https://github.com/Veverke/bAInder, I decided to make a VS Code extension, with a developer perspective in mind.

Your AI chat history — unified, searchable, and always yours. Chat Wizard reads session data from every major AI coding tool and gives you a single place to search, browse, and analyse it all. Your conversation history is no longer trapped inside whichever tool or IDE created it.

> **Tags:** AI chat manager · Copilot chat manager · Claude chat manager · chat history viewer · prompt library · code block search · token usage analytics · LLM productivity · VS Code AI tools · conversation history manager · Cline chat manager · Roo code chat manager · Cursor chat manager · Windsurf chat manager · Aider chat manager · Google Antigravity chat manager

---

## Why ChatWizard?

- **Your history travels with you.** Switch from Cursor to VS Code, try Windsurf for a project, add Cline to your workflow — your full conversation archive stays intact and searchable in one place. No more context lost when you change tools or IDEs.
- **Everything in one view.** Whether you use one AI coding tool or five, Chat Wizard aggregates sessions from all of them. Search across a year of Copilot, Claude, Cline, Cursor, Windsurf, Aider, and Google Antigravity conversations in a single query.
- **100% local, read-only, zero setup.** Chat Wizard never makes a network call, never modifies your session files, and requires no API key or account. It passively reads what your existing tools already write to disk.
- **Not just a viewer.** Full-text search with regex, a deduplicated prompt library, a code block archive, per-model usage analytics, and a timeline with activity heat maps — capabilities that no individual AI tool exposes.

---

## Demos

### Search — Search Bar & Search Command

![Search demo: search bar and search command](images/demos/search.gif)

### Export to Markdown — Full Session & Excerpt

![Export to Markdown demo: full session and excerpt](images/demos/export-to-markup.gif)

### Session Filters

![Session Filters](images/demos/session-filters.gif)

### Prompt Library

![Prompt Library](images/demos/prompt-library.gif)

### Code Blocks (snippets)

![Code Blocks](images/demos/code-blocks.gif)

### Analytics

![Analytics](images/demos/analytics.gif)

### Model Usage

![Model Usage](images/demos/model-usage.gif)

---

## Features

- **Sessions Panel** — browse, sort, filter, pin, group, and reorder every AI session across all tools and workspaces
- **Full-Text Search** — instant in-memory keyword search with regex support and source/role filters
- **Semantic Search** — topic-similarity search via a local AI model (opt-in, ~22 MB)
- **Code Block Library** — every AI-generated code snippet, filterable by language, with one-click copy
- **Prompt Library** — deduplicated, frequency-ranked archive of all your prompts with near-duplicate clustering and merge
- **Analytics** — token usage charts, daily activity, top projects, top terms, longest sessions
- **Model Usage** — per-model request counts with date-range filtering and workspace/session drill-down
- **Timeline** — chronological feed with activity heat map, work bursts, topic drift ribbon, and streak stats
- **Export** — single session, multi-select, all sessions, or excerpt — to structured Markdown
- **MCP Server** — expose your full chat history to Claude Desktop, Cursor, Continue, and Copilot agent mode via the Model Context Protocol
- **`@chatwizard` Copilot Chat Participant** — `/queryHistory` and `/continueFromHistory` directly in Copilot Chat, no MCP server required
- **Live Indexing** — file watcher keeps all views up-to-date as new sessions are written, with no manual refresh needed
- **100% local** — no network calls, no account, read-only access to your existing session files

For detailed usage instructions, settings, and commands see the **[User Guide](docs/user-guide.md)**.

---

## ChatWizard vs. Native Chat Interfaces

Capabilities not available in the built-in GitHub Copilot Chat panel or the Claude Code terminal:

| Capability | ChatWizard | Copilot Chat (VS Code) | Claude Code (terminal) |
|-----------|:----------:|:---------------------:|:---------------------:|
| Browse all past sessions across all workspaces | ✅ | ❌ per-workspace only | ❌ no GUI history |
| Cross-session full-text search | ✅ | ❌ | ❌ |
| Regex search over chat history | ✅ | ❌ | ❌ |
| Filter sessions by model, date range, message count | ✅ | ❌ | ❌ |
| Multi-key composite sort of session list | ✅ | ❌ | ❌ |
| Pin & drag-and-drop reorder sessions | ✅ | ❌ | ❌ |
| Export conversations to Markdown | ✅ | ❌ | ❌ |
| Export a message excerpt (selected turns only) | ✅ | ❌ | ❌ |
| Unified code block library across all sessions | ✅ | ❌ | ❌ |
| Filter & sort AI-generated code blocks by language, content, source, role | ✅ | ❌ | ❌ |
| One-click copy of any historical code block | ✅ | ❌ | ❌ |
| Deduplicated, searchable prompt library | ✅ | ❌ | ❌ |
| Near-duplicate prompt detection & merge | ✅ | ❌ | ❌ |
| Token-usage analytics & daily activity charts | ✅ | ❌ | ❌ |
| Chronological timeline with jump-to-date | ✅ | ❌ | ❌ |
| Timeline heat map, work bursts & topic drift | ✅ | ❌ | ❌ |
| Per-model request usage dashboard | ✅ | ❌ | ❌ |
| Selective workspace indexing & scope management | ✅ | ❌ | ❌ |
| Live auto-refresh when sessions change | ✅ | ✅ current session | ✅ current session |
| 100% local — no external network calls | ✅ | ✅ | ✅ |
| Expose history to AI tools via MCP (Model Context Protocol) | ✅ | ❌ | ❌ |

---

## Supported AI Chat Extensions

| Extension | Data Source |
|-----------|-------------|
| **GitHub Copilot Chat** | Per-workspace JSONL operation logs at `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/` plus workspace metadata from `state.vscdb` (SQLite) |
| **Claude Code** | Conversation JSONL files at `~/.claude/projects/**/*.jsonl` |
| **Cline** (`saoudrizwan.claude-dev`) | Per-task JSON files at `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/` |
| **Roo Code** (`rooveterinaryinc.roo-cline`) | Per-task JSON files at `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<taskId>/` (Cline-compatible format) |
| **Cursor** | SQLite `state.vscdb` at `%APPDATA%/Cursor/User/workspaceStorage/<hash>/` — chat history stored under the `composer.composerData` key. Requires `better-sqlite3` (pre-built native module bundled with the extension). |
| **Windsurf** (Codeium) | SQLite `state.vscdb` at `%APPDATA%/Windsurf/User/workspaceStorage/<hash>/` — Cascade chat history stored under the `cascade.sessionData` key. Reuses the same `better-sqlite3` driver. |
| **Aider** | Markdown `.aider.chat.history.md` files written by Aider into each project root. ChatWizard scans all open VS Code workspace folders plus any paths listed in `chatwizard.aiderSearchRoots` (up to `chatwizard.aiderSearchDepth` levels deep, default 3). Optional `.aider.conf.yml` in the same directory is read for the `model:` key. No central storage directory — files live inside your project repos. |

> For tools with partial support, see [Limited Support](#limited-support) below.

---

## Limited Support

Some tools are supported with constraints. Features that operate on prompts alone — **Prompt Library**, **Full-Text Search**, **Analytics**, and **Timeline** — work fully. The session reader displays an informational banner explaining what is unavailable.

| Tool | What works | Limitation |
|------|-----------|------------|
| **Google Antigravity** | Prompt Library, full-text search, analytics, timeline, session reader (prompts only) | AI responses are not available from disk. Antigravity stores conversation content in an encrypted format that requires the running Language Server to decode. Only prompts are indexed. Configurable via `chatwizard.indexAntigravity` / `chatwizard.antigravityBrainPath`. |

---

## Installation

1. **VS Code Marketplace** — search for "ChatWizard" in the Extensions view and click Install.
2. **Manual install** — download the `.vsix` file and run `Extensions: Install from VSIX…` from the Command Palette.
3. The extension activates automatically on VS Code startup (`onStartupFinished`). No configuration is required for standard GitHub Copilot Chat and Claude Code installs.

---

## Requirements

- VS Code **1.85.0** or later.
- At least one supported AI coding tool installed and actively used: **GitHub Copilot Chat**, **Claude Code**, **Cline**, **Roo Code**, **Cursor**, **Windsurf**, **Aider**, or **Google Antigravity** (limited support — prompts only; see [Limited Support](#limited-support)). Chat Wizard reads the session files these tools write — it does not create sessions itself and requires no additional configuration for standard installs.

---

## Extension Settings

See the **[User Guide → Settings Reference](docs/user-guide.md#14-settings-reference)**.

---

## Commands

See the **[User Guide → Commands Reference](docs/user-guide.md#15-commands-reference)**.

---

## Architecture & Privacy

- **All processing is local.** ChatWizard never makes network requests. No session content, metadata, or telemetry is ever transmitted to any external server.
- **Read-only access.** ChatWizard reads AI chat session files but never writes to them or modifies them in any way.
- **Live index updates.** A `FileSystemWatcher` monitors the session directories and rebuilds the affected index entries whenever new sessions are created or existing ones are updated. All views refresh automatically.
- **No external indexing dependencies.** Full-text search uses a custom in-memory inverted index. Similarity clustering uses trigram scoring. Analytics use local token-count approximations. No ML models, no network calls.
- **MCP server — local and auth-gated.** When enabled, the MCP server binds exclusively to `127.0.0.1` (never `0.0.0.0`). All requests require a bearer token generated with `crypto.randomBytes(32)` and stored in VS Code's extension storage. The token is never logged. A `/health` endpoint is intentionally unauthenticated so clients can verify connectivity; it returns only `{ status: "ok", sessions: N }`.
- **Local telemetry (opt-in).** If `chatwizard.enableTelemetry` is enabled, usage events are appended to a JSONL file inside the extension's VS Code global storage directory on your local machine. This file is never read by any external service.

---

## Known Limitations

- **Copilot Chat session parsing** reconstructs conversation state by replaying an append-only operation log. Very large sessions (hundreds of messages) may take slightly longer to parse on first index build.
- **Claude Code epoch sessions** — sessions with a creation date of 1970-01-01 (epoch) or with zero messages are silently skipped during indexing. This matches Claude Code's own behavior of writing placeholder files before sessions are populated.
- **Token counts are approximations.** ChatWizard uses character-based counting (characters / 4) for Claude and Google Antigravity (Gemini) sessions, and word-based counting (words x 1.3) for Copilot/GPT sessions. These figures are estimates and will not exactly match the billing token counts reported by the respective providers.
- **Cursor and Windsurf schema stability.** Both IDEs store chat data in private SQLite databases whose internal schema can change in any update without notice. Chat Wizard targets the current schema; a future Cursor or Windsurf release may require a matching Chat Wizard update before sessions from those sources are visible again.
---

## Release Notes

### 1.4.0

- **MCP Server Mode** — local HTTP/SSE server exposing your full chat history via the Model Context Protocol. Binds to `localhost` only; all requests require a bearer token. Enable via `chatwizard.mcpServer.enabled`.
  - **8 MCP tools:** `chatwizard_search`, `chatwizard_find_similar`, `chatwizard_get_session`, `chatwizard_get_session_full`, `chatwizard_list_recent`, `chatwizard_get_context`, `chatwizard_list_sources`, `chatwizard_server_info`.
  - **2 MCP prompts:** `chatwizard.queryHistory`, `chatwizard.continueFromHistory` — available to any MCP client.
  - Config clipboard flow, status bar indicator, first-run consent modal.
  - **Token rotation** — `Chat Wizard: Rotate MCP Token` (`chatwizard.rotateMcpToken`) generates a new bearer token. Gated by `chatwizard.mcpServer.allowTokenRotation`.
  - **`Chat Wizard: Connect GitHub Copilot`** and **`Chat Wizard: Set Up Global Copilot Instructions`** commands for quick one-click setup.
- **`@chatwizard` Copilot Chat Participant** — use `/queryHistory` and `/continueFromHistory` directly in Copilot Chat without the MCP server running. `/queryHistory` shows the top-3 matching sessions and, on confirmation, consolidates all three and derives a semantically grounded answer.
- **VS Code Insiders support** — Copilot workspace storage is now auto-discovered from both stable (`Code`) and Insiders (`Code - Insiders`) installs.
- **Improved full-text search** — stop-word filtering and basic de-pluralisation raise relevance of keyword results.
- **Extension update notifier** — silent daily Marketplace check; shows a notification with an Open in Marketplace link when a newer version is available.

### 1.3.0

- **Google Antigravity support (limited)** — indexes user prompts from Google Antigravity stored at `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/overview.txt` (JSONL step logs). AI responses are not available from disk (stored in an encrypted format). Configurable via `chatwizard.indexAntigravity` / `chatwizard.antigravityBrainPath`.
- Antigravity prompts participate in search, prompt library, analytics, model usage, timeline, and source filtering. The session reader shows prompts only with an informational banner.
- Token counting for Antigravity sessions uses the Gemini character ÷ 4 approximation.
- Antigravity brand icon, CSS theme variable, and badge class added.

### 1.2.0

- **Cline support** — indexes Cline (`saoudrizwan.claude-dev`) task history; model and workspace path read from `ui_messages.json`; configurable via `chatwizard.indexCline` / `chatwizard.clineStoragePath`.
- **Roo Code support** — indexes Roo Code (`rooveterinaryinc.roo-cline`) task history (Cline-compatible format); configurable via `chatwizard.indexRooCode` / `chatwizard.rooCodeStoragePath`.
- **Cursor support** — indexes Cursor chat and agent sessions from SQLite `state.vscdb` (`composer.composerData`); configurable via `chatwizard.indexCursor` / `chatwizard.cursorStoragePath`.
- **Windsurf support** — indexes Windsurf Cascade sessions from SQLite `state.vscdb` (`cascade.sessionData`); configurable via `chatwizard.indexWindsurf` / `chatwizard.windsurfStoragePath`.
- **Aider support** — discovers `.aider.chat.history.md` files in workspace folders and `chatwizard.aiderSearchRoots`; model from `.aider.conf.yml`; configurable via `chatwizard.indexAider`, `chatwizard.aiderSearchRoots`, `chatwizard.aiderSearchDepth`.
- All new sources participate in search, prompt library, code blocks, analytics, model usage, and timeline.
- Cursor-native model IDs normalised (`cursor-fast`, `cursor-small`).

### 1.1.0

- **Workspace Management** — new `Manage Watched Workspaces` command lets you select exactly which Copilot and Claude workspaces to index; shows size and session count per workspace; persists selection and restarts the watcher.
- **Model Usage panel** — new sidebar tab showing per-model user request counts over a configurable date range, with workspace and session drill-down and friendly model name normalisation.
- **Timeline enhancements** — added activity heat map (click a day to filter), work burst clustering (2-hour window), per-week topic drift ribbon, summary stats bar (streak, active days, on-this-day), and inline keyword search.

### 1.0.4

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

---

## Contributing

Issues and pull requests are welcome at [https://github.com/veverke/chatwizard](https://github.com/veverke/chatwizard).

---

## License

This project is licensed under the **MIT License with Commons Clause** — see [LICENSE](LICENSE) for the full text.

In plain terms:
- You may use, copy, modify, and distribute the source code freely.
- You may **not** sell the software or offer it as a paid product or service (including hosting or consulting services whose value derives substantially from this software).

This is **source-available** software. It is not OSI-certified open source.
