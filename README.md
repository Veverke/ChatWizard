# ChatWizard

Unified search, analytics, and history browser for your GitHub Copilot Chat and Claude Code sessions.

---

## Features

### Session Management Panel
A sortable, filterable, pinnable TreeView listing every AI chat session across all your workspaces. Sort by date, workspace, session length, title, or AI model — with multi-key composite sort and persistent preferences. Pin important sessions to keep them at the top. Hover over any session for a rich tooltip showing title, source, model, workspace, date, size, and message counts. Click any session to open a full Markdown-rendered conversation reader with visually distinct user and assistant messages.

### Unified Full-Text Search
Press `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) to open an instant QuickPick search panel covering all sessions from all workspaces. Powered by an in-memory inverted index with no external dependencies. Results include source icon, session title, workspace, date, and a role-labeled snippet ("You: …" or "Claude: …") with exact match highlighting. Filter by source (All / Copilot / Claude) and message type (All / Prompts / Responses). Prefix your query with `/` to enable regex mode.

### Export to Markdown
Export any session or selection of sessions to navigable `.md` files. Each export produces a structured document with H2 headings for user prompts and H3 headings for AI responses, fenced code blocks with language identifiers, and a metadata header. Supports single-session export, export-all, multi-select export via QuickPick, and excerpt export for selected messages from within the session reader.

### Code Block Extraction
Browse every fenced code block the AI has ever generated — across all sessions, all workspaces. Filter by programming language, search by content, and copy any block to the clipboard in one click. Each entry shows the originating session title, date, source, workspace, and message role.

### Prompt Library
A deduplicated, frequency-ranked library of every user-turn prompt you have ever typed. Exact duplicates are collapsed into a single entry showing how many times and across how many projects you have used it. Search the library by keyword and copy any prompt back to the clipboard for reuse.

### Analytics Dashboard
A Chart.js-powered webview dashboard aggregating token usage, daily activity, top projects, top terms, and longest sessions. Token counts are computed locally using a character-based approximation for Claude and a word-based approximation for Copilot/GPT. Summary cards, a daily activity line chart, a top-projects table, a top-terms bar chart, and longest-sessions tables (by message count and token count) are all included. Open via `ChatWizard: Show Analytics Dashboard` or the Analytics sidebar tab.

### Duplicate Prompt Detection
Trigram similarity clustering surfaces groups of near-duplicate prompts in the Prompt Library. Each cluster shows all variants with their source session title and date, and a label indicating how many times you have asked something equivalent. A Merge action collapses the cluster into a single canonical entry.

### Timeline View
A chronological feed of all sessions across all workspaces, grouped by month. Each entry shows project name, session title, first prompt, message count, and date. Use the Jump-to-Date input to scroll directly to any month. Filter the feed by workspace and source using the sticky dropdown bar. The view refreshes live as new sessions are indexed.

### Configurable Data Source Paths
Override the default discovery paths for Claude Code sessions and Copilot Chat workspace storage via extension settings — useful for non-standard VS Code installs or custom data directories.

---

## Supported AI Chat Extensions

| Extension | Data Source |
|-----------|-------------|
| **GitHub Copilot Chat** | Per-workspace JSONL operation logs at `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/` plus workspace metadata from `state.vscdb` (SQLite) |
| **Claude Code** | Conversation JSONL files at `~/.claude/projects/**/*.jsonl` |

---

## Installation

1. **VS Code Marketplace** — search for "ChatWizard" in the Extensions view and click Install.
2. **Manual install** — download the `.vsix` file and run `Extensions: Install from VSIX…` from the Command Palette.
3. The extension activates automatically on VS Code startup (`onStartupFinished`). No configuration is required for standard GitHub Copilot Chat and Claude Code installs.

---

## Requirements

- VS Code **1.85.0** or later.
- GitHub Copilot Chat and/or Claude Code installed and actively used. ChatWizard reads the session files these extensions write — it does not create sessions itself.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.userMessageColor` | `#007acc` | Accent color for user message borders in the session reader (hex or CSS color name) |
| `chatwizard.tooltipLabelColor` | `` | Color for field labels in session hover tooltips (empty = VS Code theme default) |
| `chatwizard.codeBlockHighlightColor` | `#EA5C00` | Highlight color applied to code blocks when navigating from the Code Blocks view |
| `chatwizard.scrollToFirstCodeBlock` | `true` | Auto-scroll to first code block when opening a session from the Code Blocks view |
| `chatwizard.claudeProjectsPath` | `` | Custom path to the Claude Code projects directory (empty = default `~/.claude/projects`) |
| `chatwizard.copilotStoragePath` | `` | Custom path to the Copilot Chat workspace storage directory (empty = platform default) |
| `chatwizard.enableTelemetry` | `false` | Enable local-only usage telemetry written to the extension's global storage directory (no external data transmission) |

---

## Commands

| Command | Title | Keyboard Shortcut |
|---------|-------|-------------------|
| `chatwizard.search` | Search | `Ctrl+Shift+H` / `Cmd+Shift+H` |
| `chatwizard.openSession` | Open Session | — |
| `chatwizard.filterSessions` | Filter Sessions… | — |
| `chatwizard.configureSortOrder` | Configure Sort Order… | — |
| `chatwizard.pinSession` | Pin Session | Right-click context menu |
| `chatwizard.unpinSession` | Unpin Session | Right-click context menu |
| `chatwizard.exportSession` | Export Session to Markdown | Right-click context menu |
| `chatwizard.exportAll` | Export All Sessions… | Sessions view toolbar |
| `chatwizard.exportSelected` | Export Selected Sessions… | Sessions view toolbar |
| `chatwizard.exportExcerpt` | Export Session Excerpt… | — |
| `chatwizard.exportFromTreeSelection` | Export Selected… | Right-click context menu |
| `chatwizard.showCodeBlocks` | Show Code Blocks | — |
| `chatwizard.filterCodeBlocks` | Filter Code Blocks… | Code Blocks view toolbar |
| `chatwizard.showPromptLibrary` | Show Prompt Library | — |
| `chatwizard.showAnalytics` | Show Analytics Dashboard | — |
| `chatwizard.showTimeline` | Show Timeline | — |

Sort commands (`chatwizard.sortByDate`, `chatwizard.sortByDate.asc`, `chatwizard.sortByDate.desc`, and equivalents for workspace, length, title, and model) are available in the Sessions view toolbar. Matching commands prefixed `chatwizard.cb` are available in the Code Blocks view toolbar.

---

## Architecture & Privacy

- **All processing is local.** ChatWizard never makes network requests. No session content, metadata, or telemetry is ever transmitted to any external server.
- **Read-only access.** ChatWizard reads AI chat session files but never writes to them or modifies them in any way.
- **Live index updates.** A `FileSystemWatcher` monitors the session directories and rebuilds the affected index entries whenever new sessions are created or existing ones are updated. All views refresh automatically.
- **No external indexing dependencies.** Full-text search uses a custom in-memory inverted index. Similarity clustering uses trigram scoring. Analytics use local token-count approximations. No ML models, no network calls.
- **Local telemetry (opt-in).** If `chatwizard.enableTelemetry` is enabled, usage events are appended to a JSONL file inside the extension's VS Code global storage directory on your local machine. This file is never read by any external service.

---

## Known Limitations

- **Copilot Chat session parsing** reconstructs conversation state by replaying an append-only operation log. Very large sessions (hundreds of messages) may take slightly longer to parse on first index build.
- **Claude Code epoch sessions** — sessions with a creation date of 1970-01-01 (epoch) or with zero messages are silently skipped during indexing. This matches Claude Code's own behavior of writing placeholder files before sessions are populated.
- **Token counts are approximations.** ChatWizard uses character-based counting (characters / 4) for Claude sessions and word-based counting (words x 1.3) for Copilot/GPT sessions. These figures are estimates and will not exactly match the billing token counts reported by Anthropic or OpenAI.

---

## Release Notes

### 1.0.0

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

Issues and pull requests are welcome at [https://github.com/avrei/chatwizard](https://github.com/avrei/chatwizard).

---

## License

MIT
