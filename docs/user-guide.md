# ChatWizard — User Guide

ChatWizard indexes every AI chat session from all your tools (Copilot, Claude, Cursor, Cline, Roo Code, Windsurf, Aider, Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist) into one searchable archive — without sending anything off your machine.

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
14. [File History](#14-file-history)
15. [Session Tagging](#15-session-tagging)
16. [Session Archive](#16-session-archive)
17. [AI Intelligence — Summaries & Entity Extraction](#17-ai-intelligence--summaries--entity-extraction)
18. [Settings Reference](#18-settings-reference)
19. [Commands Reference](#19-commands-reference)

---

## 1. Getting Started

1. Install ChatWizard from the VS Code Marketplace.
2. The extension indexes sessions automatically on startup — no configuration needed for most setups.
3. Click the **Chat Wizard** speech-bubble icon in the Activity Bar to open the sidebar.

> **Supported tools:** GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, Google Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist.

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
| Add Tag… | Attach one or more freeform labels (see [Session Tagging](#15-session-tagging)) |
| Remove Tag… | Remove tags from the session |
| Regenerate Summary | Re-generate the AI-produced one-line summary |
| Archive Session | Force an immediate archive snapshot |
| Delete Archived Session | Remove from archive (live session is unaffected) |
| Reveal in Explorer | Show the source file in the VS Code Explorer |
| Export Selected… | Multi-select export |
| Inject as Context… | Export session and open it as context in a new Copilot Chat |

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
- **Source** — All / Copilot / Claude / Cline / Roo Code / Cursor / Windsurf / Aider / Antigravity / Continue.dev / Amazon Q / Gemini Code Assist
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

### Inject a Session as Context into a New Chat

Turn any past session into live context for a brand-new Copilot Chat conversation in one click:

1. Right-click any session in the Sessions panel
2. Choose **Inject as Context…**

ChatWizard will:
- Silently export the session to a Markdown file in your workspace root (no save dialog)
- Open that file in the editor so you can inspect it
- Open Copilot Chat pre-filled with `#file:/path/to/session.md Use this exported chat session as context for our conversation.`
- Leave the message unsent so you can customise the prompt before pressing **Enter**

> **Tip:** You can edit the pre-filled message to add a specific question, e.g. `#file:my-session.md We were debugging a race condition here — continue from where we left off.`

### Export to Obsidian

```
Ctrl+Shift+P → Chat Wizard: Export… → Export Sessions to Obsidian
```

Exports sessions as Obsidian-compatible Markdown files (one `.md` per session) into a folder you choose — ideally inside your Obsidian vault.

**Output format per file:**
- YAML frontmatter: `title`, `source`, `date`, `tags` (from your ChatWizard tags), `summary`, `chatwizard_id`
- Messages as Markdown (`**You:**` / `**Assistant:**` headings)
- File paths found in session content are emitted as `[[filename]]` wikilinks

**Scope picker:** choose "All sessions", "Pinned sessions only", or "Tagged sessions…" to export a curated subset.

Re-running the export overwrites existing files — it does not create duplicates.

### Export to Notion

```
Ctrl+Shift+P → Chat Wizard: Export… → Export Sessions to Notion
```

Exports sessions as pages in a Notion database using the public Notion API.

**First-time setup:**
1. In Notion, create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy the API key.
2. Share a database with your integration.
3. Run the export command — ChatWizard prompts for the API key (stored in VS Code `SecretStorage`, **never** in `settings.json`) and the database ID.

Subsequent exports skip the prompts and go directly to exporting.

To clear the stored API key: `Ctrl+Shift+P` → **ChatWizard: Forget Notion API Key**.

---

## 12. MCP Server & AI Integrations

The MCP server exposes your entire local chat history to any MCP-compatible AI tool — GitHub Copilot, Claude Desktop, Cursor, Continue, and others — so they can retrieve relevant past conversations before answering your questions. Everything runs **100% locally**; no data leaves your machine. The server is **read-only** and **opt-in**.

### Enabling the Server

1. Open VS Code Settings (`Ctrl+,`) and set `chatwizard.mcpServer.enabled` to `true`
2. VS Code will show a **first-run consent dialog** — review and confirm
3. The server starts on `http://127.0.0.1:6789` (port configurable via `chatwizard.mcpServer.port`)
4. A `$(broadcast) MCP` item appears in the status bar — click it to start or stop the server

### Quick Start

1. Enable the server as above
2. Open the Command Palette and run **Chat Wizard: Copy MCP Config to Clipboard**
3. Select your AI tool from the quick-pick menu
4. The config snippet (with your bearer token already embedded) is copied to clipboard and setup instructions open automatically
5. Paste into your tool's config file (see per-tool sections below) and restart the tool

### Available MCP Tools

| Tool | What it does | Key parameters |
|------|-------------|----------------|
| `chatwizard_get_context` | Best single tool — combines semantic + keyword search, returns ranked passages | `topic`, `limit` |
| `chatwizard_search` | Keyword/full-text search across all sessions | `query`, `source`, `limit`, `entityType`, `entityValue` |
| `chatwizard_find_similar` | Semantic similarity search (requires semantic search enabled) | `query`, `minScore`, `limit` |
| `chatwizard_get_session` | Fetch a session by ID (truncated to 4 000 chars) | `sessionId`, `maxChars` |
| `chatwizard_get_session_full` | Fetch complete untruncated session | `sessionId` |
| `chatwizard_list_recent` | List most-recently-updated sessions | `limit`, `source`, `since` |
| `chatwizard_list_sources` | Which tools are indexed and session counts | _(none)_ |
| `chatwizard_server_info` | Server health, version, session count, uptime | _(none)_ |
| `chatwizard_sessions_for_file` | Sessions that touched a specific file (Chronicle required) | `filePath` |
| `chatwizard_sessions_for_branch` | Sessions on a specific git branch | `branch` |
| `chatwizard_sessions_for_work_item` | Sessions for a work-item ID (requires `chatwizard.workItemPattern`) | `workItemId` |

**Example — ask Claude Desktop about a past decision:**
> The AI calls `chatwizard_get_context` with topic `"authentication strategy"` → retrieves your past sessions on that topic → answers based on your actual history.

### Per-Tool Setup

#### GitHub Copilot (VS Code)

Config file: **`settings.json`** — open via `Preferences: Open User Settings (JSON)` from the Command Palette.

Locations: **Windows** `%APPDATA%\Code\User\settings.json` · **macOS** `~/Library/Application Support/Code/User/settings.json` · **Linux** `~/.config/Code/User/settings.json`

```json
{
  "github.copilot.chat.mcpServers": {
    "chatwizard": {
      "type": "sse",
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

If `"github.copilot.chat.mcpServers"` already exists, add the `"chatwizard"` entry to the existing object. VS Code picks up changes automatically — no restart needed. Verify with: _"Call chatwizard_server_info and show me the result."_

#### Claude Desktop

Config file: **`claude_desktop_config.json`** — **Windows** `%APPDATA%\Claude\claude_desktop_config.json` · **macOS** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chatwizard": {
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

**Fully restart Claude Desktop** after saving (quit and relaunch — a window reload is not sufficient). Verify with: _"Please call chatwizard_server_info and show me the result."_

#### Cursor

Config file: **`.cursor/mcp.json`** (global, not project-specific) — **Windows** `%USERPROFILE%\.cursor\mcp.json` · **macOS/Linux** `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "chatwizard": {
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Restart Cursor or run `Developer: Reload Window`. Verify: `@chatwizard chatwizard_server_info`

#### Continue

Continue supports project-scoped and global MCP server files:
- **Project-scoped (recommended):** `.continue/mcpServers/chatwizard.json` in your workspace root
- **Global:** `~/.continue/mcpServers/chatwizard.json`

Save the following as `chatwizard.json` inside the `mcpServers/` directory:

```json
{
  "mcpServers": [
    {
      "name": "chatwizard",
      "transport": {
        "type": "sse",
        "url": "http://localhost:6789/sse",
        "requestOptions": {
          "headers": {
            "Authorization": "Bearer <your-token>"
          }
        }
      }
    }
  ]
}
```

Continue picks up new files in `mcpServers/` automatically. Switch Continue to **Agent mode** — MCP tools are only available in agent mode, not standard chat mode.

#### Generic / Any MCP-Compatible Client

| Property | Value |
|----------|-------|
| **SSE endpoint** | `http://localhost:6789/sse` |
| **Messages endpoint** | `http://localhost:6789/messages` |
| **Health endpoint** | `http://localhost:6789/health` _(no auth required)_ |
| **Auth header** | `Authorization: Bearer <your-token>` |
| **Transport** | HTTP + SSE |

Run **Chat Wizard: Copy MCP Config → Generic** to get a snippet with your actual token.

### `@chatwizard` Copilot Chat Participant

A lightweight alternative — **no MCP server required**. Invoke directly from the Copilot Chat panel in VS Code:

```
@chatwizard /queryHistory WAL mode SQLite deadlock
```
→ Returns a ranked table of top matching sessions with excerpts and clickable links.

```
@chatwizard /continueFromHistory MCP server implementation
```
→ Lists your 5 most recent sessions on that topic and proposes the 3 most valuable next actions. Important files from Chronicle sessions are shown as clickable VS Code file pills.

```
@chatwizard /tag #bugfix, topic:auth
```
→ Tags the currently active chat session with the given labels. Use `/removeTags #bugfix` to remove.

```
@chatwizard /referMessage P3
```
→ Streams the third user prompt from the current chat thread back as a Markdown blockquote — useful for referencing an earlier turn without scrolling back. `R2` quotes the second assistant response.

Run **Chat Wizard: Connect GitHub Copilot** to configure the participant. For global context instructions across all workspaces, run **Chat Wizard: Set Up Global Copilot Instructions**.

| | `@chatwizard` participant | MCP server |
|-|--------------------------|------------|
| Requires MCP server | No | Yes |
| Works in Copilot Chat | Yes | Yes (via MCP tools) |
| Works in Claude, Cursor, Continue | No | Yes |

### Token Security

The server uses a 64-character bearer token stored in VS Code's secret storage — never logged. To rotate the token after accidentally sharing it:

1. Enable `"chatwizard.mcpServer.allowTokenRotation": true` in settings
2. Run **Chat Wizard: Rotate MCP Token** from the Command Palette
3. Confirm the rotation — the MCP server restarts automatically with the new token
4. Run **Chat Wizard: Copy MCP Config** again and update every AI tool's config with the new token

**Manual fallback:** Delete `mcp-token.txt` from VS Code's extension global storage, restart the MCP server, then run **Chat Wizard: Copy MCP Config** to get the new token.

### Troubleshooting

**"Connection refused" or client can't connect**
- Confirm the server is running: status bar should show `$(broadcast) MCP`
- If not running, run **Chat Wizard: Start MCP Server** from the Command Palette
- Verify the port matches (`chatwizard.mcpServer.port`, default `6789`)
- Check that VS Code is not blocked by a local firewall rule on `127.0.0.1:6789`

**"401 Unauthorized"**
- Run **Chat Wizard: Copy MCP Config** again to get a fresh snippet with the current token, paste it into your tool's config, and restart the tool

**"Port already in use"**
- Change `chatwizard.mcpServer.port` to an unused port (e.g. `6790`) and update the URL in your tool's config

**Semantic search tools return "not available"**
- `chatwizard_find_similar` and the semantic path of `chatwizard_get_context` require `chatwizard.enableSemanticSearch: true`
- `chatwizard_search` (keyword) is always available regardless of semantic search status

---

## 13. Workspace Management

By default, ChatWizard indexes all workspaces it discovers. To restrict which workspaces are indexed:

```
Ctrl+Shift+P → Chat Wizard: Settings… → Manage Watched Workspaces
```

A multi-select list shows every discovered workspace with its path, size, and session count. The currently open workspace is always included.

---

## 14. File History

Chronicle-powered visibility into which sessions touched the current file — directly in the editor, without opening the history panel.

### Status Bar

When Chronicle data is populated (`chatwizard.indexChronicle: true`), the status bar shows **`$(comment) N sessions`** for the active file. The item is hidden when the file has no history. Click it to open the File History panel.

### CodeLens

A `$(history) N ChatWizard sessions touched this file — click to view` lens appears at the top of files with Chronicle data. Disable via `chatwizard.codeLens.enabled: false`; the status bar and Explorer menu continue to work regardless.

### Explorer Context Menu

Right-click any file in the Explorer (or the editor tab) → **ChatWizard: Show File History**.

### File History Panel

Lists sessions that touched the file with:
- Date and source badge
- One-line summary (from AI-generated summaries)
- **[Open session]** button — opens the session webview

When no Chronicle data exists for the file, the panel shows an empty state: _"No Chronicle data found — enable `chat.localIndex.enabled` to populate this view."_

### MCP Tool

`chatwizard_sessions_for_file` accepts both absolute paths and workspace-relative paths. Useful for injecting file-centric context from any MCP client:

> _"Call `chatwizard_sessions_for_file` with `src/auth.ts` and show me the recent sessions."_

---

## 15. Session Tagging

Attach freeform labels to sessions for quick filtering and future retrieval.

### Adding Tags

Right-click any session → **Add Tag…**. Enter one or more comma-separated labels:

```
#bugfix, topic:auth, kind:decision
```

Tags are normalised (lowercased, leading `#` stripped for storage, displayed with `#` prefix).

### Removing Tags

Right-click → **Remove Tag…** — opens a multi-select QuickPick of the session's existing tags.

### Tag Display

- **Session tree** — up to 3 tag chips shown inline; overflow displayed as `+N more`.
- **Session reader header** — tag chips appear alongside the source badge and date.

### Filtering by Tag

```
Ctrl+Shift+P → Chat Wizard: Filter Sessions… → Filter by tags
```

Select one or more tags; the Sessions panel shows only matching sessions. A clear-filter button appears in the view title.

### Tagging the Active Session

When you're actively working in a chat tool, use one of these to tag the session without leaving your flow:

- **Command Palette:** `Ctrl+Shift+P` → **ChatWizard: Tag Active Session**
- **Status bar button:** `$(tag) Tag session` appears in the status bar while a session is live (within `chatwizard.activeSessionWindowMinutes`, default 120 min). Disappears once the session goes idle.
- **Chat command:** type `@chatwizard /tag #bugfix, topic:auth` directly in the Copilot Chat panel. `@chatwizard /removeTags #bugfix` removes tags the same way.

### Pin Migration

On first run of 1.5.0, existing pinned sessions are automatically migrated to the new `chatwizard-metadata.json` store. No manual action required.

---

## 16. Session Archive

ChatWizard mirrors every indexed session to its own local storage so you never lose history if a source tool prunes its data.

### How It Works

After each successful parse, the raw session content is saved to `<extension globalStorageUri>/archive/<source>/<sessionId>.<ext>`. On the next startup, any session present in the archive but no longer in the live index is loaded and marked as archived.

Archived sessions appear in the Sessions panel with a **`· archived`** suffix and a tooltip: _"This session is no longer available from its source — served from ChatWizard archive."_

### Show Archive Statistics

```
Ctrl+Shift+P → Chat Wizard: Settings… → Show Archive Statistics
```

Displays total archived sessions, total size on disk, and the oldest archived date.

### Pruning

By default, the archive grows unbounded. To cap it:

| Setting | Default | Effect |
|---------|---------|--------|
| `chatwizard.archive.maxAgeDays` | `0` (disabled) | Remove sessions older than N days |
| `chatwizard.archive.maxSizeMB` | `0` (disabled) | Cap total size — oldest sessions removed first |

Pruning runs at startup **after** archived sessions are loaded, so they are always visible at least once before any removal.

### Manual Archive Actions

Right-click any session in the Sessions panel:
- **Archive Session** — forces an immediate archive snapshot of that session.
- **Delete Archived Session** — removes the archive copy (the live session is unaffected).

---

## 17. AI Intelligence — Summaries & Entity Extraction

> **Beta:** These two features are functional but have not completed full end-to-end testing. They run silent background jobs and will not break other functionality, but may produce unexpected results on very large indexes or sessions containing large pasted code blocks. Please [report any issues on GitHub](https://github.com/veverke/chatwizard/issues).

### Session Summaries _(Beta)_

After indexing completes, ChatWizard generates a one-line summary for every session in the background. The summary appears as:
- **Tree item tooltip** — hover any session in the Sessions panel.
- **Session reader header** — a paragraph below the session title.

Generation is transparent and never blocks startup. Three-tier strategy:
1. Chronicle `checkpoints.overview` (free, instant — no LLM).
2. VS Code LM API (Copilot subscription, cheapest model, one-shot prompt). Errors are silenced — the fallback is used instead.
3. TF-IDF keyword extraction (fully offline — works without Copilot).

To force a refresh: right-click any session → **Regenerate Summary**.

### Entity Extraction _(Beta)_

A second background job extracts structured entities from session content and stores them in `chatwizard-metadata.json`:

| Entity type | Examples |
|-------------|---------|
| File paths | `src/auth.ts`, `package.json` |
| Function / class names | `handleLogin`, `AuthService` |
| Error codes | `SQLITE_BUSY`, `ENOENT`, `TypeError: Cannot read` |
| Decision phrases | `"I decided to use"`, `"we chose"`, `"the approach is"` |

**In the session reader:** a collapsible **Entities** section shows chips for extracted entries. File path chips open the file in the editor when clicked. Entity chips use a distinct visual style (🔮 prefix) to distinguish them from user-applied tags.

**In MCP search:** `chatwizard_search` accepts optional `entityType` and `entityValue` parameters to pre-filter sessions by extracted entity before full-text scoring:

> _"Call `chatwizard_search` with `entityType: 'errors', entityValue: 'SQLITE_BUSY'`"_

---

## 18. Settings Reference

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
| `chatwizard.indexContinue` | `true` | `chatwizard.continueStoragePath` |
| `chatwizard.indexAmazonQ` | `true` | `chatwizard.amazonQStoragePath` |
| `chatwizard.indexGeminiCodeAssist` | `true` | `chatwizard.geminiCodeAssistStoragePath` |

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
| `chatwizard.mcp.reranker.enabled` | `false` | Enable TF-IDF reranker for `chatwizard_get_context` |

### Chronicle & File History

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.indexChronicle` | `true` | Enrich sessions with Copilot Chronicle checkpoint data |
| `chatwizard.chronicle.enableLocalIndex` | `true` | Auto-enable `chat.localIndex.enabled` for branch & file data |
| `chatwizard.codeLens.enabled` | `true` | Show "N sessions touched this file" CodeLens in editors |

### Branch & Work Item Grouping

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.workItemPattern` | `""` (disabled) | Regex to extract work-item IDs from branch names. Examples: `[A-Z]+-\d+` (Jira), `AB#\d+` (Azure DevOps), `#\d+` (GitHub Issues) |

### Session Tagging

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.activeSessionWindowMinutes` | `120` | Look-back window for "active session" detection; controls when the `$(tag) Tag session` status bar button is shown |

### Session Archive

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.archive.maxAgeDays` | `0` (disabled) | Prune archived sessions older than N days at startup |
| `chatwizard.archive.maxSizeMB` | `0` (disabled) | Cap total archive size; oldest sessions removed first |

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

## 19. Commands Reference

### Command Palette (user-facing)

| Command | Title |
|---------|-------|
| `chatwizard.search` | Chat Wizard: Full-Text Search |
| `chatwizard.semanticSearch` | Chat Wizard: Find Sessions by Topic (Semantic) |
| `chatwizard.filterSessions` | Chat Wizard: Filter Sessions… |
| `chatwizard.configureSortOrder` | Chat Wizard: Configure Sort Order… |
| `chatwizard.groupSessions` | Chat Wizard: Group Sessions… |
| `chatwizard.filterCodeBlocks` | Chat Wizard: Filter Code Blocks… |
| `chatwizard.showCodeBlocks` | Chat Wizard: Show Code Blocks |
| `chatwizard.showPromptLibrary` | Chat Wizard: Show Prompt Library |
| `chatwizard.showAnalytics` | Chat Wizard: Show Analytics Dashboard |
| `chatwizard.showTimeline` | Chat Wizard: Show Timeline |
| `chatwizard.exportAll` | Chat Wizard: Export All Sessions… |
| `chatwizard.exportSelected` | Chat Wizard: Export Selected Sessions… |
| `chatwizard.exportExcerpt` | Chat Wizard: Export Session Excerpt… |
| `chatwizard.exportToObsidian` | Chat Wizard: Export Sessions to Obsidian |
| `chatwizard.exportToNotion` | Chat Wizard: Export Sessions to Notion |
| `chatwizard.forgetNotionApiKey` | Chat Wizard: Forget Notion API Key |
| `chatwizard.injectAsContext` | Right-click session → Inject as Context… |
| `chatwizard.tagActiveSession` | Chat Wizard: Tag Active Session |
| `chatwizard.showFileHistory` | Chat Wizard: Show File Session History |
| `chatwizard.showArchiveStats` | Chat Wizard: Show Archive Statistics |
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
| `chatwizard.injectAsContext` | Right-click menu → Inject as Context… |
| `chatwizard.addTagFromTree` | Right-click menu → Add Tag… |
| `chatwizard.removeTagFromTree` | Right-click menu → Remove Tag… |
| `chatwizard.regenerateSummary` | Right-click menu → Regenerate Summary |
| `chatwizard.archiveSession` | Right-click menu → Archive Session |
| `chatwizard.deleteArchivedSession` | Right-click menu → Delete Archived Session |
| `chatwizard.revealSessionInExplorer` | Right-click menu → Reveal in Explorer |
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
| Tag the session you're currently in | Status bar `$(tag) Tag session` or `@chatwizard /tag #label` |
| See which sessions touched a file | Right-click the file in Explorer → **Show File History** |
| Group sessions by git branch | Sessions panel toolbar → Group → By Branch |
| Group sessions by work item (Jira, AzDO…) | Set `chatwizard.workItemPattern`, then Group → By Work Item |
| Quote a past turn in the current chat | `@chatwizard /referMessage P3` |
| Check token usage this month | Analytics panel |
| See which models you've used | Model Usage panel |
| Export a session to Markdown | Right-click session → Export Session to Markdown |
| Export to an Obsidian vault | `Ctrl+Shift+P` → **Export Sessions to Obsidian** |
| Export to Notion | `Ctrl+Shift+P` → **Export Sessions to Notion** |
| Inject a session as context into a new chat | Right-click session → Inject as Context… |
| Ask Copilot using your history | `@chatwizard /queryHistory <question>` |
| Connect Claude Desktop to your history | Enable MCP server → Copy MCP Config → paste & restart |
| Force a full re-index | `Ctrl+Shift+P` → **Chat Wizard: Rescan Sessions** |
| Only index recent sessions | Set `chatwizard.oldestSessionDate` to a date |
