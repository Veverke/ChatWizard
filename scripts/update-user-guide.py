#!/usr/bin/env python3
"""Apply all user-guide.md updates atomically."""
import re

FILE = r"c:\Repos\Personal\ChatWizard\docs\user-guide.md"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# Change 1: Table of Contents
old_toc = """## Table of Contents

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
19. [Commands Reference](#19-commands-reference)"""

new_toc = """## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Sidebar Overview](#2-sidebar-overview)
3. [Sessions Panel](#3-sessions-panel)
4. [Full-Text Search](#4-full-text-search)
5. [Semantic Search](#5-semantic-search)
6. [Code Blocks Panel](#6-code-blocks-panel)
7. [Prompt Library](#7-prompt-library)
8. [Knowledge Base](#8-knowledge-base)
9. [Action Items](#9-action-items)
10. [Analytics](#10-analytics)
11. [Model Usage](#11-model-usage)
12. [Timeline](#12-timeline)
13. [Session Bookmarks](#13-session-bookmarks)
14. [Inline Annotations](#14-inline-annotations)
15. [Session Linking](#15-session-linking)
16. [Session Status Lifecycle](#16-session-status-lifecycle)
17. [Session Sharing](#17-session-sharing)
18. [Keyboard Navigation](#18-keyboard-navigation)
19. [Did You Know Tips](#19-did-you-know-tips)
20. [Session Retention](#20-session-retention)
21. [Compacted Sessions](#21-compacted-sessions)
22. [REST API](#22-rest-api)
23. [Export](#23-export)
24. [MCP Server & AI Integrations](#24-mcp-server--ai-integrations)
25. [Workspace Management](#25-workspace-management)
26. [File History](#26-file-history)
27. [Session Tagging](#27-session-tagging)
28. [Session Archive](#28-session-archive)
29. [AI Intelligence — Summaries & Entity Extraction](#29-ai-intelligence--summaries--entity-extraction)
30. [Settings Reference](#30-settings-reference)
31. [Commands Reference](#31-commands-reference)"""

assert old_toc in content, "TOC not found!"
content = content.replace(old_toc, new_toc, 1)

# Change 2: Sidebar - "Six panels" -> "Eight panels", add KB and Action Items rows
old_sidebar = """Six panels live under the Chat Wizard Activity Bar icon:

| Panel | Purpose |
|-------|---------|
| **Sessions** | Browse every AI session across all tools and workspaces |
| **Prompt Library** | Your full history of prompts, deduplicated and searchable |
| **Code Blocks** | Every AI-generated code snippet, filterable by language |
| **Analytics** | Token usage charts and stats |"""

new_sidebar = """Eight panels live under the Chat Wizard Activity Bar icon:

| Panel | Purpose |
|-------|---------|
| **Sessions** | Browse every AI session across all tools and workspaces |
| **Prompt Library** | Your full history of prompts, deduplicated and searchable |
| **Code Blocks** | Every AI-generated code snippet, filterable by language |
| **Knowledge Base** | Categorized learnings, decisions, patterns, gotchas, and architecture |
| **Action Items** | Concrete follow-up tasks extracted from sessions |
| **Analytics** | Token usage charts and stats |"""

assert old_sidebar in content, "Sidebar not found!"
content = content.replace(old_sidebar, new_sidebar, 1)

# Change 3: Insert KB and Action Items sections after Prompt Library
kb_section = """---

## 8. Knowledge Base

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

## 9. Action Items

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

## 10. Analytics"""

anchor = """**Example workflow:** You vaguely remember a detailed system-prompt you wrote for a refactoring task. Open the Prompt Library, type `refactor`, find it, copy, paste.

---

## 8. Analytics"""

new_anchor = """**Example workflow:** You vaguely remember a detailed system-prompt you wrote for a refactoring task. Open the Prompt Library, type `refactor`, find it, copy, paste.""" + kb_section

assert anchor in content, "Prompt Library anchor not found!"
content = content.replace(anchor, new_anchor, 1)

# Change 4: Renumber Model Usage and Timeline
content = content.replace("\n## 9. Model Usage", "\n## 11. Model Usage", 1)
content = content.replace("\n## 10. Timeline", "\n## 12. Timeline", 1)

# Change 5: Insert sections 13-22 between Timeline and Export
sections_13_22 = """---

## 13. Session Bookmarks

Bookmark important sessions with a ★ so you can jump back to them instantly.

### Toggle a Bookmark

- Click the **★ icon** next to any session in the Sessions panel to toggle the bookmark
- Or right-click → **Bookmark Session** / **Unbookmark Session**

### Viewing Bookmarks

Bookmarked sessions are listed under a **Bookmarked** heading at the top of the Sessions panel when grouping is enabled. You can also view all bookmarks in a dedicated list:

```
Ctrl+Shift+P → Chat Wizard: View… → Show Bookmarks
```

### Persistence

Bookmarks are stored in the per-workspace metadata file (`chatwizard-metadata.json`) and survive extension restarts and machine reboots.

---

## 14. Inline Annotations

Add freeform notes directly to any session message. Each annotation is pinned to a specific message within a session and appears inline when the session is open in the reader.

### Adding an Annotation

1. Open a session in the Markdown reader
2. Click the **📝** icon next to any message
3. Type your note in the inline text field that appears
4. Press **Enter** or click **Save** to persist it

### Editing and Deleting

- Hover over an existing annotation and click **✏️** to edit
- Click **🗑️** to delete it

### Persistence

Annotations are stored in the per-workspace metadata file and survive restarts. They are included in session exports (as footnotes).

---

## 15. Session Linking

Create bidirectional links between related sessions, making it easy to navigate between sessions that discuss the same topic, bug, or feature.

### Creating a Link

1. Open a session in the reader
2. Click the **🔗 Link** button in the session header toolbar
3. Search for the target session by title or keyword via QuickPick
4. Confirm — a link badge appears in both sessions' headers: `🔗 → [linked session title]`

### Navigating Linked Sessions

- Click the link badge in any session header to open the linked session
- Each session shows all its outgoing links as badges
- Linked sessions auto-navigate back: opening A → B creates a badge in B pointing to A

### Storage

Links are stored in the per-workspace metadata file. They can be exported in the Obsidian export as `[[wikilinks]]`.

---

## 16. Session Status Lifecycle

Track the state of each session through a simple workflow: **Open** → **Resolved** → **Revisit**.

### Statuses

| Status | Meaning | Visual cue |
|--------|---------|------------|
| **Open** | Default — session is active or unprocessed | No badge |
| **Resolved** | The issue or task described in this session is complete | `✓ Resolved` badge (green) |
| **Revisit** | Needs another look; parked for later | `↻ Revisit` badge (yellow) |

### Changing Status

- Right-click any session → **Set Status…** → pick a status
- Or open the session and use the status dropdown in the session header

### Filtering

```
Ctrl+Shift+P → Chat Wizard: Filter Sessions… → Filter by status
```

Select one or more statuses. The Sessions panel shows only matching sessions.

### Tag-Based Status

For automated workflow, you can define status-triggering tags. Set `chatwizard.statusTags` in settings to map a tag to a status. For example:
```json
"chatwizard.statusTags": {
  "resolved": "resolved",
  "wontfix": "resolved",
  "followup": "revisit"
}
```
When a session receives a tag matching one of the keys, its status updates automatically. Removing the tag reverts the status to Open.

---

## 17. Session Sharing

Share individual sessions or curated collections as portable HTML files — no ChatWizard installation needed on the recipient's side.

### Export as HTML

```
Ctrl+Shift+P → Chat Wizard: Export… → Export Session as HTML…
```

Produces a self-contained `.html` file with embedded styling, syntax-highlighted code blocks, and a clean reading layout.

### Code Block Redaction

Before sharing, you can redact sensitive code blocks:

1. After selecting the session, a preview dialog shows all code blocks
2. Check the **Redact** box next to any block you want to hide
3. Redacted blocks show as `[Code block redacted — sensitive content]` in the HTML output

### Batch Sharing

Select multiple sessions in the Sessions panel and use the **Export Selected** toolbar icon — each session becomes a separate HTML file in a folder of your choice.

---

## 18. Keyboard Navigation

Navigate the Sessions panel and Session reader entirely from the keyboard.

### Sessions Panel

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

### Session Reader

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one message |
| `k` / `↑` | Scroll up one message |
| `gg` | Scroll to top |
| `G` | Scroll to bottom |
| `Esc` | Close reader and return to Sessions panel |
| `Ctrl+F` | Find in session |

### Code Blocks Panel

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down |
| `Enter` | Open parent session scrolled to this block |
| `c` | Copy selected block to clipboard |
| `/` | Focus filter |

---

## 19. Did You Know Tips

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

## 20. Session Retention

Control how long sessions remain in the index before automatic cleanup.

### Setting Retention

```json
"chatwizard.sessionRetentionDays": 90
```

- Default: `0` (disabled — sessions are kept indefinitely)
- Set to any positive integer to automatically delete sessions older than N days
- The cleanup runs at startup and after each indexing cycle

### What Gets Deleted

- The session entry from the SQLite index
- Associated metadata (tags, bookmarks, annotations, links, action items)
- The archived copy (if any)

### Scope

Retention applies to all sessions regardless of source. For per-source limits, configure individual source settings or use the archive pruning settings (`chatwizard.archive.maxAgeDays`, `chatwizard.archive.maxSizeMB`).

---

## 21. Compacted Sessions

Sessions that have been compressed to save space are marked with a `· compacted` badge.

### What "Compacted" Means

When a session grows very large (e.g. many messages or large code blocks), ChatWizard may compact it to reduce storage size. Compacted sessions:
- Still appear in search results
- Still show their summary and metadata
- Show abbreviated content when opened in the reader (with a note that the session was compacted)
- Have a `· compacted` suffix in the Sessions panel

### Manual Compaction

```
Ctrl+Shift+P → Chat Wizard: Settings… → Compact Large Sessions
```

### Restoring

Compacted sessions are not deleted — they remain searchable and navigable. The `isCompacted` flag is stored in the session metadata and cleared if the session is re-indexed from its source.

---

## 22. REST API

A lightweight HTTP API for querying your session index programmatically — useful for custom integrations, scripts, and automation.

### Enabling

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
```"""

old_timeline_end = """- **Inline keyword search** — filters by session title + first prompt

---

## 11. Export"""
new_timeline_end = """- **Inline keyword search** — filters by session title + first prompt""" + sections_13_22 + """

---

## 23. Export"""

assert old_timeline_end in content, "Timeline/Export junction not found!"
content = content.replace(old_timeline_end, new_timeline_end, 1)

# Change 6: Renumber remaining sections
content = content.replace("\n## 12. MCP Server & AI Integrations", "\n## 24. MCP Server & AI Integrations", 1)
content = content.replace("\n## 13. Workspace Management", "\n## 25. Workspace Management", 1)
content = content.replace("\n## 14. File History", "\n## 26. File History", 1)
content = content.replace("\n## 15. Session Tagging", "\n## 27. Session Tagging", 1)
content = content.replace("\n## 16. Session Archive", "\n## 28. Session Archive", 1)
content = content.replace("\n## 17. AI Intelligence — Summaries & Entity Extraction", "\n## 29. AI Intelligence — Summaries & Entity Extraction", 1)
content = content.replace("\n## 18. Settings Reference", "\n## 30. Settings Reference", 1)
content = content.replace("\n## 19. Commands Reference", "\n## 31. Commands Reference", 1)

# Change 7: Update cross-reference links
content = content.replace('(#15-session-tagging)', '(#27-session-tagging)')

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("All changes applied successfully!")