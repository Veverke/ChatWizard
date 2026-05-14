# ChatWizard — User Guide

ChatWizard indexes every AI chat session from all your tools (Copilot, Claude, Cursor, Cline, Roo Code, Windsurf, Aider, Antigravity) into one searchable archive — without sending anything off your machine.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Sidebar Overview](#2-sidebar-overview)
3. [Sessions Panel](#3-sessions-panel)
4. [Full-Text Search](#4-full-text-search)
5. [Semantic Search](#5-semantic-search)
6. [Code Blocks Panel](#6-code-blocks-panel)
7. [Prompt Library](#7-prompt-library)
8. [Analytics](#8-analytics)
9. [Model Usage](#9-model-usage)
10. [Timeline](#10-timeline)
11. [Export](#11-export)
12. [MCP Server & AI Integrations](#12-mcp-server--ai-integrations)
13. [Workspace Management](#13-workspace-management)
14. [Settings Reference](#14-settings-reference)
15. [Commands Reference](#15-commands-reference)

---

## 1. Getting Started

1. Install ChatWizard from the VS Code Marketplace.
2. The extension indexes sessions automatically on startup — no configuration needed for most setups.
3. Click the **Chat Wizard** speech-bubble icon in the Activity Bar to open the sidebar.

> **Supported tools:** GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, Google Antigravity.

---

## 2. Sidebar Overview

Six panels live under the Chat Wizard Activity Bar icon:

| Panel | Purpose |
|-------|---------|
| **Sessions** | Browse every AI session across all tools and workspaces |
| **Prompt Library** | Your full history of prompts, deduplicated and searchable |
| **Code Blocks** | Every AI-generated code snippet, filterable by language |
| **Analytics** | Token usage charts and stats |
| **Model Usage** | Per-model request counts with date range filtering |
| **Timeline** | Chronological feed with heat map, streaks, and topic drift |

Each panel can also be opened as a standalone editor tab:

```
Ctrl+Shift+P → Chat Wizard: View… → Show Analytics Dashboard
```

---

## 3. Sessions Panel

### Browsing Sessions

Sessions appear as a list. Click any session to open it in a Markdown reader with full syntax-highlighted code blocks.

### Grouping & Sorting

Use the toolbar icons to toggle grouping and change sort order:

- **Group by date** — bucketed into Today / Yesterday / This Week / This Month / Older
- **Sort by** — Date, Title, Workspace, Length (message count), or Model; each sort toggles ascending/descending

For multi-key sorting (e.g. "by workspace, then by date descending"):

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Configure Sort Order…
```

### Filtering

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Filter Sessions…
```

Criteria: title substring, date range, model name, min/max message count.

**Example:** Show only Copilot sessions from last week with >10 messages:
- Title: _(leave blank)_
- From: `2026-05-07`, Until: `2026-05-14`
- Model: `copilot`
- Min messages: `10`

### Pinning

Pin important sessions so they float to the top. Use the **pin icon** on the row or right-click → **Pin Session**.

### Context Menu (right-click a session)

| Action | Description |
|--------|-------------|
| Pin / Unpin Session | Keeps session at top of list |
| Export Session to Markdown | Save single session as `.md` |
| Export Selected… | Multi-select export |

---

## 4. Full-Text Search

**Keyboard shortcut:** Open via `Ctrl+Shift+P` → **Chat Wizard: Search… → Full-Text Search**

Results show a snippet from the matching message with the match highlighted, labelled as `You:` or `Copilot:` (etc.).  
Selecting a result opens the session scrolled to the matching message.

**Examples:**

| Goal | Query |
|------|-------|
| Find sessions about a specific error | `ECONNREFUSED 5432` |
| Find all sessions where you asked about migrations | `database migration` |
| Regex search for a function name | `/handleAuthError` |

**Filters available in the search QuickPick:**
- **Source** — All / Copilot / Claude / Cline / Roo Code / Cursor / Windsurf / Aider / Antigravity
- **Role** — All / Prompts only / Responses only

> If results exceed 500, a banner prompts you to refine the query.

---

## 5. Semantic Search

Finds sessions by **meaning**, not keywords. Useful when you remember the concept but not the exact wording.

**One-time setup:** Enable semantic search in settings:
```json
"chatwizard.enableSemanticSearch": true
```
A ~22 MB model downloads on first use.

**Invoke:**
```
Ctrl+Shift+P → Chat Wizard: Search… → Find Sessions by Topic (Semantic)
```

**Examples:**

| Goal | Query |
|------|-------|
| Find sessions about database performance | `slow query optimization` |
| Find sessions about a UI animation problem | `CSS transition not working` |
| Find architecture discussions | `microservices vs monolith tradeoffs` |

Tune sensitivity with `chatwizard.semanticMinScore` (default `0.35`; lower = more results, higher = stricter).

---

## 6. Code Blocks Panel

Every fenced code block the AI has ever generated is archived here.

### Filter Code Blocks

Click the **filter icon** in the Code Blocks toolbar or:
```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Filter Code Blocks…
```
Criteria: language, content substring, source tool, message role.

**Example:** Find all TypeScript snippets that use `async/await`:
- Language: `typescript`
- Content: `async`

### Actions

- **Click** a code block → opens the parent session scrolled to that block (optionally highlighted in orange)
- **Copy icon** on each row → copies the block contents to clipboard
- **Group by language** — toggle via toolbar to bucket blocks under `typescript`, `python`, `sql`, etc.

---

## 7. Prompt Library

A deduplicated, frequency-ranked archive of every prompt you've ever typed.

- **Exact duplicates** are collapsed into a single entry with usage count + project count
- **Near-duplicate clustering** groups similar prompts (trigram similarity); use **Merge** to consolidate a cluster
- **Keyword search** filters prompts inline
- **Copy to clipboard** — reuse any prompt instantly

**Example workflow:** You vaguely remember a detailed system-prompt you wrote for a refactoring task. Open the Prompt Library, type `refactor`, find it, copy, paste.

---

## 8. Analytics

Open via the sidebar panel or:
```
Ctrl+Shift+P → Chat Wizard: View… → Show Analytics Dashboard
```

**What's shown:**
- Summary cards: total sessions, messages, estimated tokens
- Daily activity line chart
- Top projects by token consumption
- Top 20 most-used terms (bar chart)
- Longest sessions (by message count and token count)

The dashboard refreshes automatically as new sessions are indexed.

---

## 9. Model Usage

Shows which AI models you've used most, with drill-down to workspace and session level.

1. Open the **Model Usage** panel in the sidebar
2. Set a date range (defaults to current month)
3. Expand any model row to see the workspaces, then the sessions, that consumed it

**Example:** To see which model you used most in May 2026:
- From: `2026-05-01`
- To: `2026-05-31`

Model IDs are normalized to friendly names (e.g. `claude-sonnet-4-6` → `Claude Sonnet 4.6`).

---

## 10. Timeline

A chronological feed of all sessions with activity analytics.

```
Ctrl+Shift+P → Chat Wizard: View… → Show Timeline
```

**Features:**
- **Activity heat map** — calendar grid colored by session density; click a day to filter to that day's sessions
- **Work bursts** — sessions within a 2-hour window are clustered into burst cards showing duration, source mix, and message count
- **Topic drift ribbon** — top 3 keywords per week, showing how your work topics shifted over time
- **Stats bar** — active days this week, total sessions, current daily streak, longest streak, "on this day last month"
- **Jump to date** — type `YYYY-MM` to scroll to any month instantly
- **Source filter** — show only Claude sessions, only Cursor, etc.
- **Inline keyword search** — filters by session title + first prompt

---

## 11. Export

### Export a Single Session

Right-click any session → **Export Session to Markdown**

### Export Selected Sessions

1. `Ctrl+Click` multiple sessions in the Sessions panel to multi-select
2. Click the **Export Selected** (checklist) icon in the toolbar

Or via Command Palette:
```
Ctrl+Shift+P → Chat Wizard: Export… → Export Selected Sessions…
```

### Export All Sessions

```
Ctrl+Shift+P → Chat Wizard: Export… → Export All Sessions…
```

Choose output format:
- **One file per session** — saves into a folder you choose
- **Single combined file** — includes a navigable table of contents

### Export an Excerpt

Export only specific turns from a session:
```
Ctrl+Shift+P → Chat Wizard: Export… → Export Session Excerpt…
```

**Output format:** Each file has a metadata header (source, model, date, workspace), H2 headings for user messages, H3 for AI responses, and syntax-highlighted code blocks.

---

## 12. MCP Server & AI Integrations

The MCP server lets any MCP-compatible AI tool (Claude Desktop, Cursor, Continue, Copilot agent mode) query your full chat archive as a tool.

### Enabling the Server

1. Set `"chatwizard.mcpServer.enabled": true` in settings
2. VS Code will show a **first-run consent dialog** — review and confirm
3. The server starts on `http://127.0.0.1:6789` (port is configurable)
4. A status bar indicator shows the server state

### Connecting an AI Tool

```
Ctrl+Shift+P → Chat Wizard: Copy MCP Config to Clipboard
```

Select your tool (Copilot, Claude Desktop, Cursor, Continue), then paste the config into that tool's MCP config file and restart it.

### Available MCP Tools

| Tool | What it does | Key parameters |
|------|-------------|----------------|
| `chatwizard_get_context` | Best single tool — combines semantic + keyword search, returns ranked passages | `topic`, `limit` |
| `chatwizard_search` | Keyword search across all sessions | `query`, `source`, `limit` |
| `chatwizard_find_similar` | Semantic similarity search | `query`, `minScore`, `limit` |
| `chatwizard_get_session` | Fetch a session by ID (truncated) | `sessionId`, `maxChars` |
| `chatwizard_get_session_full` | Fetch complete untruncated session | `sessionId` |
| `chatwizard_list_recent` | List most-recently-updated sessions | `limit`, `source`, `since` |
| `chatwizard_list_sources` | Which tools are indexed and session counts | _(none)_ |
| `chatwizard_server_info` | Server health, version, session count | _(none)_ |

**Example — ask Claude Desktop about a past decision:**
> The AI calls `chatwizard_get_context` with topic `"authentication strategy"` → retrieves your past sessions on that topic → answers based on your actual history.

### `@chatwizard` Copilot Chat Participant

No MCP server needed. Invoke directly from the Copilot Chat panel:

```
@chatwizard /queryHistory WAL mode SQLite deadlock
```
→ Returns a ranked table of top matching sessions with excerpts and clickable links.

```
@chatwizard /continueFromHistory MCP server implementation
```
→ Lists your 5 most recent sessions on that topic and proposes the 3 most valuable next actions.

### Token Security

The server uses a 64-character bearer token stored in VS Code's secret storage — never logged. To rotate the token after accidentally sharing it:

1. Enable `"chatwizard.mcpServer.allowTokenRotation": true`
2. `Ctrl+Shift+P` → **Chat Wizard: Rotate MCP Token**

---

## 13. Workspace Management

By default, ChatWizard indexes all workspaces it discovers. To restrict which workspaces are indexed:

```
Ctrl+Shift+P → Chat Wizard: Settings… → Manage Watched Workspaces
```

A multi-select list shows every discovered workspace with its path, size, and session count. The currently open workspace is always included.

---

## 14. Settings Reference

### Data Scope

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.enabled` | `true` | Master on/off switch |
| `chatwizard.oldestSessionDate` | _(empty)_ | Only index sessions on/after this date (e.g. `2025-11-01`) |
| `chatwizard.maxSessions` | `0` (no limit) | Cap total sessions loaded (newest first) |

### Source Toggles

Each source has an index toggle and an optional custom path override:

| Setting | Default | Path override setting |
|---------|---------|----------------------|
| `chatwizard.indexCopilot` | `true` | `chatwizard.copilotStoragePath` |
| `chatwizard.indexClaude` | `true` | `chatwizard.claudeProjectsPath` |
| `chatwizard.indexCline` | `true` | `chatwizard.clineStoragePath` |
| `chatwizard.indexRooCode` | `true` | `chatwizard.rooCodeStoragePath` |
| `chatwizard.indexCursor` | `true` | `chatwizard.cursorStoragePath` |
| `chatwizard.indexWindsurf` | `true` | `chatwizard.windsurfStoragePath` |
| `chatwizard.indexAider` | `true` | `chatwizard.aiderSearchRoots` (array), `chatwizard.aiderSearchDepth` (default `3`) |
| `chatwizard.indexAntigravity` | `true` | `chatwizard.antigravityBrainPath` |

Leave a path override empty to use the platform default location.

### Semantic Search

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.enableSemanticSearch` | `false` | Enable topic-similarity search (~22 MB model) |
| `chatwizard.semanticMinScore` | `0.35` | Match threshold (0–1); lower = more results |

### MCP Server

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.mcpServer.enabled` | `false` | Start server on VS Code launch |
| `chatwizard.mcpServer.port` | `6789` | Listening port (restart required) |
| `chatwizard.mcpServer.allowTokenRotation` | `false` | Allow token rotation command |

### Appearance

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.userMessageColor` | `#007acc` | Accent color for user message borders in session reader |
| `chatwizard.codeBlockHighlightColor` | `#EA5C00` | Highlight color when jumping to a code block (blank = disable) |
| `chatwizard.scrollToFirstCodeBlock` | `true` | Auto-scroll to first code block when opening from Code Blocks view |
| `chatwizard.tooltipLabelColor` | _(empty)_ | Color for labels in session hover tooltips |

### Other

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.maxLineLengthChars` | `1,000,000` | Max character length of a single JSONL line when parsing Claude sessions |
| `chatwizard.enableTelemetry` | `false` | Write local-only usage events to a JSONL file in extension storage; never transmitted externally |

---

## 15. Commands Reference

### Command Palette (user-facing)

| Command | Title |
|---------|-------|
| `chatwizard.search` | Chat Wizard: Full-Text Search |
| `chatwizard.semanticSearch` | Chat Wizard: Find Sessions by Topic (Semantic) |
| `chatwizard.filterSessions` | Chat Wizard: Filter Sessions… |
| `chatwizard.configureSortOrder` | Chat Wizard: Configure Sort Order… |
| `chatwizard.filterCodeBlocks` | Chat Wizard: Filter Code Blocks… |
| `chatwizard.showCodeBlocks` | Chat Wizard: Show Code Blocks |
| `chatwizard.showPromptLibrary` | Chat Wizard: Show Prompt Library |
| `chatwizard.showAnalytics` | Chat Wizard: Show Analytics Dashboard |
| `chatwizard.showTimeline` | Chat Wizard: Show Timeline |
| `chatwizard.exportAll` | Chat Wizard: Export All Sessions… |
| `chatwizard.exportSelected` | Chat Wizard: Export Selected Sessions… |
| `chatwizard.exportExcerpt` | Chat Wizard: Export Session Excerpt… |
| `chatwizard.manageWatchedWorkspaces` | Chat Wizard: Manage Watched Workspaces |
| `chatwizard.rescan` | Chat Wizard: Rescan Sessions |
| `chatwizard.startMcpServer` | Chat Wizard: Start MCP Server |
| `chatwizard.stopMcpServer` | Chat Wizard: Stop MCP Server |
| `chatwizard.copyMcpConfig` | Chat Wizard: Copy MCP Config to Clipboard |
| `chatwizard.rotateMcpToken` | Chat Wizard: Rotate MCP Token |
| `chatwizard.connectCopilot` | Chat Wizard: Connect GitHub Copilot |
| `chatwizard.setupGlobalInstructions` | Chat Wizard: Set Up Global Copilot Instructions |

### Session & Code Block actions (triggered from UI)

| Command | Trigger |
|---------|---------|
| `chatwizard.pinSession` / `chatwizard.unpinSession` | Pin icon on session row / right-click menu |
| `chatwizard.exportSession` | Right-click menu / inline export icon |
| `chatwizard.exportFromTreeSelection` | Right-click menu (multi-select) |
| `chatwizard.openSession` | Click a session in the Sessions panel |
| `chatwizard.openSessionFromCodeBlock` | Click an entry in the Code Blocks panel |
| `chatwizard.loadMoreSessions` | "Load More" item at bottom of Sessions panel |
| `chatwizard.loadMoreCodeBlocks` | "Load More" item at bottom of Code Blocks panel |

### Sort & grouping toolbar commands

Sessions panel toolbar cycles through: `chatwizard.sortByDate`, `chatwizard.sortByWorkspace`, `chatwizard.sortByLength`, `chatwizard.sortByTitle`, `chatwizard.sortByModel` (each with `.asc` / `.desc` variants). Grouping: `chatwizard.enableSessionGrouping` / `chatwizard.disableSessionGrouping`.

Code Blocks panel toolbar cycles through: `chatwizard.cbSortByDate`, `chatwizard.cbSortByWorkspace`, `chatwizard.cbSortByLength`, `chatwizard.cbSortByTitle`, `chatwizard.cbSortByLanguage`. Grouping: `chatwizard.enableCbGrouping` / `chatwizard.disableCbGrouping`.

---

## Quick Reference

| Task | How |
|------|-----|
| Search past sessions by keyword | `Ctrl+Shift+P` → **Full-Text Search** |
| Search by concept/meaning | `Ctrl+Shift+P` → **Find Sessions by Topic (Semantic)** |
| Find a code snippet the AI wrote | Code Blocks panel → filter by language |
| Reuse a past prompt | Prompt Library → search → copy |
| Check token usage this month | Analytics panel |
| See which models you've used | Model Usage panel |
| Export a session to Markdown | Right-click session → Export Session to Markdown |
| Ask Copilot using your history | `@chatwizard /queryHistory <question>` |
| Connect Claude Desktop to your history | Enable MCP server → Copy MCP Config → paste & restart |
| Force a full re-index | `Ctrl+Shift+P` → **Chat Wizard: Rescan Sessions** |
| Only index recent sessions | Set `chatwizard.oldestSessionDate` to a date |
