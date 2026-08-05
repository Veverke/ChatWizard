# ChatWizard — User Guide

ChatWizard indexes every AI chat session from all your tools (Copilot, Claude, Cursor, Cline, Roo Code, Windsurf, Aider, Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist) into one searchable archive — without sending anything off your machine.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Sidebar Overview](#2-sidebar-overview)
3. [Sessions Panel](#3-sessions-panel)
   - [Browsing Sessions](#browsing-sessions)
   - [Sorting & Grouping](#sorting--grouping)
   - [Filtering Sessions](#filtering-sessions)
   - [Pinning](#pinning)
   - [Session Folders](#session-folders)
   - [Session Status Lifecycle](#session-status-lifecycle)
   - [Session Bookmarks](#session-bookmarks)
   - [Inline Annotations](#inline-annotations)
   - [Session Linking](#session-linking)
   - [Session Tagging](#session-tagging)
   - [Session Archive](#session-archive)
   - [Context Menu](#context-menu)
4. [Search](#4-search)
   - [Full-Text Search](#full-text-search)
   - [Semantic Search](#semantic-search)
5. [Code Blocks Panel](#5-code-blocks-panel)
   - [Filtering Code Blocks](#filtering-code-blocks)
   - [Actions](#actions-1)
6. [Prompt Library](#6-prompt-library)
7. [Knowledge Base](#7-knowledge-base)
   - [Generating the Knowledge Base](#generating-the-knowledge-base)
   - [Custom Categories](#custom-categories)
   - [Exporting](#exporting)
   - [Regeneration](#regeneration)
8. [Action Items](#8-action-items)
   - [How It Works](#how-it-works)
   - [Managing Action Items](#managing-action-items)
9. [Analytics & Monitoring](#9-analytics--monitoring)
   - [Analytics Dashboard](#analytics-dashboard)
   - [Model Usage](#model-usage)
   - [Timeline](#timeline)
10. [Export & Sharing](#10-export--sharing)
    - [Export a Single Session](#export-a-single-session)
    - [Export Selected Sessions](#export-selected-sessions)
    - [Export All Sessions](#export-all-sessions)
    - [Export an Excerpt](#export-an-excerpt)
    - [Inject as Context](#inject-as-context)
    - [Export to Obsidian](#export-to-obsidian)
    - [Export to Notion](#export-to-notion)
    - [Share as HTML](#share-as-html)
    - [Code Block Redaction](#code-block-redaction)
    - [Batch Sharing](#batch-sharing)
11. [MCP Server & AI Integrations](#11-mcp-server--ai-integrations)
    - [Enabling the Server](#enabling-the-server)
    - [Quick Start](#quick-start)
    - [Available MCP Tools](#available-mcp-tools)
    - [Per-Tool Setup](#per-tool-setup)
    - [@chatwizard Copilot Participant](#chatwizard-copilot-participant)
    - [Token Security](#token-security)
    - [Troubleshooting](#troubleshooting-1)
12. [REST API](#12-rest-api)
    - [Enabling the API](#enabling-the-api)
    - [Authentication](#authentication)
    - [Endpoints](#endpoints)
    - [Example](#example)
13. [Workspace & File History](#13-workspace--file-history)
    - [Workspace Management](#workspace-management)
    - [File History](#file-history)
14. [Session Lifecycle Management](#14-session-lifecycle-management)
    - [Session Retention](#session-retention)
    - [Compacted Sessions](#compacted-sessions)
15. [AI Intelligence](#15-ai-intelligence)
    - [Session Summaries](#session-summaries)
    - [Entity Extraction](#entity-extraction)
16. [Keyboard Navigation](#16-keyboard-navigation)
    - [Sessions Panel Keys](#sessions-panel-keys)
    - [Session Reader Keys](#session-reader-keys)
    - [Code Blocks Panel Keys](#code-blocks-panel-keys)
17. [Did You Know Tips](#17-did-you-know-tips)
    - [How It Works](#how-it-works-1)
    - [Fallback Tips](#fallback-tips)
    - [Disabling](#disabling)
18. [Settings Reference](#18-settings-reference)
19. [Commands Reference](#19-commands-reference)
20. [Quick Reference](#20-quick-reference)

---

## 1. Getting Started

1. Install ChatWizard from the VS Code Marketplace.
2. The extension indexes sessions automatically on startup — no configuration needed for most setups.
3. Click the **Chat Wizard** speech-bubble icon in the Activity Bar to open the sidebar.

> **Supported tools:** GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, Google Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist.

---

## 2. Sidebar Overview

Eight panels live under the Chat Wizard Activity Bar icon:

| Panel | Purpose |
|-------|---------|
| **Sessions** | Browse every AI session across all tools and workspaces |
| **Prompt Library** | Your full history of prompts, deduplicated and searchable |
| **Code Blocks** | Every AI-generated code snippet, filterable by language |
| **Knowledge Base** | Categorized learnings, decisions, patterns, gotchas, and architecture |
| **Action Items** | Concrete follow-up tasks extracted from sessions |
| **Analytics** | Token usage charts and stats |
| **Model Usage** | Per-model request counts with date range filtering |
| **Timeline** | Chronological feed with heat map, streaks, and topic drift |

Each panel can also be opened as a standalone editor tab:

```
Ctrl+Shift+P → Chat Wizard: View… → Show Analytics Dashboard
```

---

## 3. Sessions Panel

The Sessions panel is the central hub — every AI session across all tools and workspaces appears here. All session-related features (sorting, filtering, tagging, bookmarks, folders, status, etc.) are available from this panel.

### Browsing Sessions

Sessions appear as a list. Click any session to open it in a Markdown reader with full syntax-highlighted code blocks.

### Sorting & Grouping

Use the toolbar icons to toggle grouping and change sort order:

**Group by:**
- **Date** — bucketed into Today / Yesterday / This Week / This Month / Older
- **Branch** — git branch names (requires Chronicle)
- **Work Item** — Jira, AzDO, or GitHub issue IDs (requires `chatwizard.workItemPattern`)

**Sort by** (toggle ascending/descending with each click):
- Date, Title, Workspace, Length (message count), or Model

**Multi-key sorting** (e.g. "by workspace, then by date descending"):

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Configure Sort Order…
```

### Filtering Sessions

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Filter Sessions…
```

Criteria: title substring, date range, model name, min/max message count, status, tags.

**Example:** Show only Copilot sessions from last week with >10 messages:
- Title: _(leave blank)_
- From: `2026-05-07`, Until: `2026-05-14`
- Model: `copilot`
- Min messages: `10`

### Pinning

Pin important sessions so they float to the top. Use the **pin icon** on the row or right-click → **Pin Session**.

### Session Folders

Organize sessions into folders for project-level grouping:

- **Create a folder:** `Ctrl+Shift+P` → **Chat Wizard: Create Folder** or right-click in the Sessions panel → **Create Folder**
- **Rename:** right-click a folder → **Rename Folder**
- **Delete:** right-click a folder → **Delete Folder** (sessions inside are unlinked, not deleted)
- **Move a session:** right-click a session → **Move to Folder…** or drag-and-drop onto a folder
- **Nested folders:** folders can be created inside other folders

### Session Status Lifecycle

Track the state of each session through a simple workflow: **Open** → **Resolved** → **Revisit**.

**Statuses:**

| Status | Meaning | Visual cue |
|--------|---------|------------|
| **Open** | Default — session is active or unprocessed | No badge |
| **Resolved** | The issue or task described in this session is complete | `✓ Resolved` badge (green) |
| **Revisit** | Needs another look; parked for later | `↻ Revisit` badge (yellow) |

**Changing Status:**
- Right-click any session → **Set Status…** → pick a status
- Or open the session and use the status dropdown in the session header

**Filtering by status:**
```
Ctrl+Shift+P → Chat Wizard: Filter Sessions… → Filter by status
```

**Tag-Based Status (auto-workflow):**
Set `chatwizard.statusTags` in settings to map a tag to a status. For example:
```json
"chatwizard.statusTags": {
  "resolved": "resolved",
  "wontfix": "resolved",
  "followup": "revisit"
}
```
When a session receives a tag matching one of the keys, its status updates automatically. Removing the tag reverts the status to Open.

### Session Bookmarks

Bookmark important sessions with a ★ so you can jump back to them instantly.

**Toggle a Bookmark:**
- Click the **★ icon** next to any session in the Sessions panel
- Or right-click → **Bookmark Session** / **Unbookmark Session**

**Viewing Bookmarks:**
Bookmarked sessions are listed under a **Bookmarked** heading at the top of the Sessions panel when grouping is enabled. You can also view all bookmarks in a dedicated list:

```
Ctrl+Shift+P → Chat Wizard: View… → Show Bookmarks
```

**Persistence:**
Bookmarks are stored in the per-workspace metadata file (`chatwizard-metadata.json`) and survive extension restarts and machine reboots.

### Inline Annotations

Add freeform notes directly to any session message. Each annotation is pinned to a specific message within a session and appears inline when the session is open in the reader.

**Adding an Annotation:**
1. Open a session in the Markdown reader
2. Click the **📝** icon next to any message
3. Type your note in the inline text field that appears
4. Press **Enter** or click **Save** to persist it

**Editing and Deleting:**
- Hover over an existing annotation and click **✏️** to edit
- Click **🗑️** to delete it

**Persistence:**
Annotations are stored in the per-workspace metadata file and survive restarts. They are included in session exports (as footnotes). Search across all annotations:

```
Ctrl+Shift+P → Chat Wizard: Search Annotations
```

### Session Linking

Create bidirectional links between related sessions, making it easy to navigate between sessions that discuss the same topic, bug, or feature.

**Creating a Link:**
1. Open a session in the reader
2. Click the **🔗 Link** button in the session header toolbar
3. Search for the target session by title or keyword via QuickPick
4. Confirm — a link badge appears in both sessions' headers: `🔗 → [linked session title]`

**Navigating Linked Sessions:**
- Click the link badge in any session header to open the linked session
- Each session shows all its outgoing links as badges
- Linked sessions auto-navigate back: opening A → B creates a badge in B pointing to A

**Storage:**
Links are stored in the per-workspace metadata file. They can be exported in the Obsidian export as `[[wikilinks]]`.

### Session Tagging

Attach freeform labels to sessions for quick filtering and future retrieval.

**Adding Tags:**
Right-click any session → **Add Tag…**. Enter one or more comma-separated labels:

```
#bugfix, topic:auth, kind:decision
```

Tags are normalised (lowercased, leading `#` stripped for storage, displayed with `#` prefix).

**Removing Tags:**
Right-click → **Remove Tag…** — opens a multi-select QuickPick of the session's existing tags.

**Tag Display:**
- **Session tree** — up to 3 tag chips shown inline; overflow displayed as `+N more`.
- **Session reader header** — tag chips appear alongside the source badge and date.

**Filtering by Tag:**
```
Ctrl+Shift+P → Chat Wizard: Filter Sessions… → Filter by tags
```
Select one or more tags; the Sessions panel shows only matching sessions. A clear-filter button appears in the view title.

**Tagging the Active Session:**
When you're actively working in a chat tool, use one of these to tag the session without leaving your flow:

- **Command Palette:** `Ctrl+Shift+P` → **ChatWizard: Tag Active Session**
- **Status bar button:** `$(tag) Tag session` appears in the status bar while a session is live (within `chatwizard.activeSessionWindowMinutes`, default 120 min). Disappears once the session goes idle.
- **Chat command:** type `@chatwizard /tag #bugfix, topic:auth` directly in the Copilot Chat panel. `@chatwizard /removeTags #bugfix` removes tags the same way.

**Pin Migration:**
On first run of 1.5.0, existing pinned sessions are automatically migrated to the new `chatwizard-metadata.json` store. No manual action required.

### Session Archive

ChatWizard mirrors every indexed session to its own local storage so you never lose history if a source tool prunes its data.

**How It Works:**
After each successful parse, the raw session content is saved to `<extension globalStorageUri>/archive/<source>/<sessionId>.<ext>`. On the next startup, any session present in the archive but no longer in the live index is loaded and marked as archived.

Archived sessions appear in the Sessions panel with a **`· archived`** suffix and a tooltip: _"This session is no longer available from its source — served from ChatWizard archive."_

**Show Archive Statistics:**
```
Ctrl+Shift+P → Chat Wizard: Settings… → Show Archive Statistics
```
Displays total archived sessions, total size on disk, and the oldest archived date.

**Pruning:**
By default, the archive grows unbounded. To cap it:

| Setting | Default | Effect |
|---------|---------|--------|
| `chatwizard.archive.maxAgeDays` | `0` (disabled) | Remove sessions older than N days |
| `chatwizard.archive.maxSizeMB` | `0` (disabled) | Cap total size — oldest sessions removed first |

Pruning runs at startup **after** archived sessions are loaded, so they are always visible at least once before any removal.

**Manual Archive Actions:**
Right-click any session in the Sessions panel:
- **Archive Session** — forces an immediate archive snapshot of that session.
- **Delete Archived Session** — removes the archive copy (the live session is unaffected).

### Context Menu

Right-click any session for a full action menu:

| Action | Description |
|--------|-------------|
| Pin / Unpin Session | Keeps session at top of list |
| Export Session to Markdown | Save single session as `.md` |
| Add Tag… | Attach one or more freeform labels |
| Remove Tag… | Remove tags from the session |
| Regenerate Summary | Re-generate the AI-produced one-line summary |
| Set Status… | Mark as Open / Resolved / Revisit |
| Bookmark / Unbookmark | Toggle star bookmark |
| Move to Folder… | Organize into a session folder |
| Archive Session | Force an immediate archive snapshot |
| Delete Archived Session | Remove from archive (live session is unaffected) |
| Reveal in Explorer | Show the source file in the VS Code Explorer |
| Export Selected… | Multi-select export |
| Inject as Context… | Export session and open it as context in a new Copilot Chat |

---

## 4. Search

Two search modes let you find past sessions: keyword-based full-text search and meaning-based semantic search.

### Full-Text Search

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

### Semantic Search

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

## 5. Code Blocks Panel

Every fenced code block the AI has ever generated is archived here.

### Filtering Code Blocks

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
- **Sort by** — Date, Workspace, Length, Title, or Language

---

## 6. Prompt Library

A deduplicated, frequency-ranked archive of every prompt you've ever typed.

- **Exact duplicates** are collapsed into a single entry with usage count + project count
- **Near-duplicate clustering** groups similar prompts (trigram similarity); use **Merge** to consolidate a cluster
- **Keyword search** filters prompts inline
- **Copy to clipboard** — reuse any prompt instantly

**Example workflow:** You vaguely remember a detailed system-prompt you wrote for a refactoring task. Open the Prompt Library, type `refactor`, find it, copy, paste.

---

## 7. Knowledge Base

The Knowledge Base panel classifies your sessions into categories (Decisions, Learnings, Patterns, Gotchas, Architecture) using an AI-first pipeline — the free Copilot LM API freely invents category labels from conversation content. When the AI model is unavailable, a heuristic phrase-matching fallback assigns one of the five built-in types.

### Generating the Knowledge Base

1. Open the **Knowledge Base** panel in the sidebar
2. Click **Generate KB** — all sessions are classified in the background
3. A doughnut chart shows the category distribution
4. Click any slice to drill down to individual sessions

The dashboard can also be opened as a standalone editor tab:
```
Ctrl+Shift+P → Chat Wizard: View… → Show Knowledge Base Dashboard
```

### Custom Categories

When generating, you can configure custom fallback categories for the heuristic classifier. The LLM always generates freely regardless of categories — the category list only constrains the heuristic fallback when the LLM is unavailable.

### Exporting

Click **Export** in the KB dashboard to write an Obsidian-compatible Markdown knowledge base to a folder of your choice, with clustered entries and cross-links.

### Regeneration

Click **Regenerate** to re-run classification on all sessions. The result updates both the sidebar view and any open dashboard panel.

---

## 8. Action Items

The Action Items panel automatically extracts concrete follow-up tasks from your sessions. When you open a session in the reader, action items are extracted from assistant messages using signal phrases (e.g. "we should", "remember to", "next steps", "don't forget").

### How It Works

- **Heuristic extraction** — signal phrases in assistant messages are detected and the surrounding sentence is captured as an action item
- **LLM-based extraction** — the free Copilot LM API is tried first for richer extraction; the heuristic is the fallback
- Items appear in the **Action Items** sidebar panel, grouped by session
- Clicking an item opens the parent session and scrolls to the exact message where the item was inferred

### Managing Action Items

- Check the circle icon to mark an item as done ✓
- Click the item to open the source session at the relevant message
- Done items are grouped separately at the bottom
- Items persist in the session metadata across restarts

---

## 9. Analytics & Monitoring

Three panels provide data-driven insight into your AI usage.

### Analytics Dashboard

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

### Model Usage

Shows which AI models you've used most, with drill-down to workspace and session level.

1. Open the **Model Usage** panel in the sidebar
2. Set a date range (defaults to current month)
3. Expand any model row to see the workspaces, then the sessions, that consumed it

**Example:** To see which model you used most in May 2026:
- From: `2026-05-01`
- To: `2026-05-31`

Model IDs are normalized to friendly names (e.g. `claude-sonnet-4-6` → `Claude Sonnet 4.6`).

### Timeline

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

## 10. Export & Sharing

Export sessions to multiple formats and destinations, or share them as self-contained HTML files.

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

### Inject as Context

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

### Share as HTML

```
Ctrl+Shift+P → Chat Wizard: Export… → Export Session as HTML…
```

Produces a self-contained `.html` file with embedded styling, syntax-highlighted code blocks, and a clean reading layout — no ChatWizard installation needed on the recipient's side.

### Code Block Redaction

Before sharing, you can redact sensitive code blocks:

1. After selecting the session, a preview dialog shows all code blocks
2. Check the **Redact** box next to any block you want to hide
3. Redacted blocks show as `[Code block redacted — sensitive content]` in the HTML output

### Batch Sharing

Select multiple sessions in the Sessions panel and use the **Export Selected** toolbar icon — each session becomes a separate HTML file in a folder of your choice.

---

## 11. MCP Server & AI Integrations

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

## 12. REST API

A lightweight HTTP API for querying your session index programmatically — useful for custom integrations, scripts, and automation.

### Enabling the API

```json
"chatwizard.restApi.enabled": true
```

The REST API server starts on `http://127.0.0.1:6791` (port configurable via `chatwizard.restApi.port`). A `$(globe) REST` item appears in the status bar when the server is running.

### Authentication

Requests must include the header `Authorization: Bearer <token>`. The token is the same one used by the MCP server. Find it by running **Chat Wizard: Copy MCP Config to Clipboard** — the bearer token is embedded in the snippet.

### Endpoints

| Method | Path | Description | Parameters |
|--------|------|-------------|------------|
| `GET` | `/health` | Server status | — |
| `GET` | `/api/sessions` | List sessions (paginated) | `limit`, `offset`, `source`, `status` |
| `GET` | `/api/sessions/:id` | Get a single session | — |
| `GET` | `/api/search` | Full-text search | `q` (query string), `limit`, `source` |
| `GET` | `/api/sessions/:id/messages` | Get messages for a session | — |
| `GET` | `/api/tags` | List all tags | — |
| `GET` | `/api/stats` | Index statistics | — |

### Example

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:6791/api/search?q=authentication
```

---

## 13. Workspace & File History

### Workspace Management

By default, ChatWizard indexes all workspaces it discovers. To restrict which workspaces are indexed:

```
Ctrl+Shift+P → Chat Wizard: Settings… → Manage Watched Workspaces
```

A multi-select list shows every discovered workspace with its path, size, and session count. The currently open workspace is always included.

### File History

Chronicle-powered visibility into which sessions touched the current file — directly in the editor, without opening the history panel.

**Status Bar:** When Chronicle data is populated (`chatwizard.indexChronicle: true`), the status bar shows **`$(comment) N sessions`** for the active file. The item is hidden when the file has no history. Click it to open the File History panel.

**CodeLens:** A `$(history) N ChatWizard sessions touched this file — click to view` lens appears at the top of files with Chronicle data. Disable via `chatwizard.codeLens.enabled: false`; the status bar and Explorer menu continue to work regardless.

**Explorer Context Menu:** Right-click any file in the Explorer (or the editor tab) → **ChatWizard: Show File History**.

**File History Panel:** Lists sessions that touched the file with date, source badge, summary, and **[Open session]** button. When no Chronicle data exists, the panel shows an empty state.

**MCP Tool:** `chatwizard_sessions_for_file` accepts both absolute paths and workspace-relative paths for injecting file-centric context from any MCP client.

---

## 14. Session Lifecycle Management

### Session Retention

Control how long sessions remain in the index before automatic cleanup.

```json
"chatwizard.sessionRetentionDays": 90
```

- Default: `0` (disabled — sessions are kept indefinitely)
- Set to any positive integer to automatically delete sessions older than N days
- The cleanup runs at startup and after each indexing cycle

**What Gets Deleted:**
- The session entry from the SQLite index
- Associated metadata (tags, bookmarks, annotations, links, action items)
- The archived copy (if any)

**Scope:** Retention applies to all sessions regardless of source. For per-source limits, configure individual source settings or use the archive pruning settings.

### Compacted Sessions

Sessions that have been compressed to save space are marked with a `· compacted` badge.

**What "Compacted" Means:**
When a session grows very large (e.g. many messages or large code blocks), ChatWizard may compact it to reduce storage size. Compacted sessions:
- Still appear in search results
- Still show their summary and metadata
- Show abbreviated content when opened in the reader
- Have a `· compacted` suffix in the Sessions panel

**Manual Compaction:**
```
Ctrl+Shift+P → Chat Wizard: Settings… → Compact Large Sessions
```

**Restoring:**
Compacted sessions are not deleted — they remain searchable and navigable. The `isCompacted` flag is stored in the session metadata and cleared if the session is re-indexed from its source.

---

## 15. AI Intelligence

> **Beta:** These features are functional but have not completed full end-to-end testing. They run silent background jobs and will not break other functionality, but may produce unexpected results on very large indexes or sessions containing large pasted code blocks.

### Session Summaries

After indexing completes, ChatWizard generates a one-line summary for every session in the background. The summary appears as:
- **Tree item tooltip** — hover any session in the Sessions panel.
- **Session reader header** — a paragraph below the session title.

Generation is transparent and never blocks startup. Three-tier strategy:
1. Chronicle `checkpoints.overview` (free, instant — no LLM).
2. VS Code LM API (Copilot subscription, cheapest model, one-shot prompt).
3. TF-IDF keyword extraction (fully offline — works without Copilot).

To force a refresh: right-click any session → **Regenerate Summary**.

### Entity Extraction

A second background job extracts structured entities from session content and stores them in `chatwizard-metadata.json`:

| Entity type | Examples |
|-------------|---------|
| File paths | `src/auth.ts`, `package.json` |
| Function / class names | `handleLogin`, `AuthService` |
| Error codes | `SQLITE_BUSY`, `ENOENT`, `TypeError: Cannot read` |
| Decision phrases | `"I decided to use"`, `"we chose"`, `"the approach is"` |

**In the session reader:** a collapsible **Entities** section shows chips for extracted entries. File path chips open the file in the editor when clicked. Entity chips use a distinct visual style (🔮 prefix) to distinguish them from user-applied tags.

**In MCP search:** `chatwizard_search` accepts optional `entityType` and `entityValue` parameters to pre-filter sessions by extracted entity before full-text scoring.

---

## 16. Keyboard Navigation

Navigate the Sessions panel and Session reader entirely from the keyboard.

### Sessions Panel Keys

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `g` (twice) | Jump to first session |
| `G` (Shift+G) | Jump to last session |
| `Enter` | Open selected session |
| `/` | Focus the filter/search box |
| `l` | Toggle grouping on/off |
| `h` | Toggle help overlay |

### Session Reader Keys

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one message |
| `k` / `↑` | Scroll up one message |
| `gg` | Scroll to top |
| `G` | Scroll to bottom |
| `Esc` | Close reader and return to Sessions panel |
| `Ctrl+F` | Find in session |

### Code Blocks Panel Keys

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down |
| `Enter` | Open parent session scrolled to this block |
| `c` | Copy selected block to clipboard |
| `/` | Focus filter |

---

## 17. Did You Know Tips

A 🐿️ squirrel mascot in the status bar cycles through useful tips about ChatWizard features at regular intervals.

### How It Works

- The status bar shows 🐿️ **Did you know?** with a random tip from the user guide
- A new tip appears every **5 minutes** while you're working
- Click the squirrel to open the relevant section in the user guide
- Tips are extracted from the section headings of `user-guide.md` itself, so they stay in sync as the guide evolves

### Fallback Tips

If the user guide cannot be read at startup, a built-in set of tips covers the core features: semantic search, MCP server, session tagging, file history, keyboard shortcuts, export formats, and the Prompt Library.

### Disabling

Set `chatwizard.didYouKnow.enabled` to `false` in settings to hide the squirrel.

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

### Session Status

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.statusTags` | `{}` | Map tag labels to auto-statuses (e.g. `{"resolved": "resolved", "followup": "revisit"}`) |

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
| `chatwizard.sessionRetentionDays` | `0` (disabled) | Auto-delete sessions older than N days |
| `chatwizard.didYouKnow.enabled` | `true` | Show/hide the 🐿️ Did You Know status bar nudge |
| `chatwizard.didYouKnowInterval` | `300` | Seconds between nudge tips (default 5 min) |

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
| `chatwizard.createFolder` | Chat Wizard: Create Folder |
| `chatwizard.renameFolder` | Chat Wizard: Rename Folder |
| `chatwizard.deleteFolder` | Chat Wizard: Delete Folder |
| `chatwizard.setSessionStatus` | Chat Wizard: Set Session Status… |
| `chatwizard.searchAnnotations` | Chat Wizard: Search Annotations |

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
| `chatwizard.moveSessionToFolder` | Right-click menu → Move to Folder… |

### Sort & grouping toolbar commands

Sessions panel toolbar cycles through: `chatwizard.sortByDate`, `chatwizard.sortByWorkspace`, `chatwizard.sortByLength`, `chatwizard.sortByTitle`, `chatwizard.sortByModel` (each with `.asc` / `.desc` variants). Grouping: `chatwizard.enableSessionGrouping` / `chatwizard.disableSessionGrouping`.

Code Blocks panel toolbar cycles through: `chatwizard.cbSortByDate`, `chatwizard.cbSortByWorkspace`, `chatwizard.cbSortByLength`, `chatwizard.cbSortByTitle`, `chatwizard.cbSortByLanguage`. Grouping: `chatwizard.enableCbGrouping` / `chatwizard.disableCbGrouping`.

---

## 20. Quick Reference

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