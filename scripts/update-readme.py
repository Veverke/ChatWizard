#!/usr/bin/env python3
"""Update README.md Features list to include P3 features."""
import re

FILE = r"c:\Repos\Personal\ChatWizard\README.md"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# Update Features list: insert KB, Action Items after Prompt Library, add new features
old_features = """- **Sessions Panel** — browse, sort, filter, pin, group, and reorder every AI session across all tools and workspaces
- **Full-Text Search** — instant in-memory keyword search with regex support and source/role filters
- **Semantic Search** — topic-similarity search via a local AI model (opt-in, ~22 MB)
- **Code Block Library** — every AI-generated code snippet, filterable by language, with one-click copy
- **Prompt Library** — deduplicated, frequency-ranked archive of all your prompts with near-duplicate clustering and merge
- **Analytics** — token usage charts, daily activity, top projects, top terms, longest sessions
- **Model Usage** — per-model request counts with date-range filtering and workspace/session drill-down
- **Timeline** — chronological feed with activity heat map, work bursts, topic drift ribbon, and streak stats
- **Export** — single session, multi-select, all sessions, or excerpt — to structured Markdown, **Obsidian vault**, or **Notion database**
- **Session Archive** — every indexed session is mirrored locally so history survives source tool pruning
- **Session Tagging** — attach freeform labels to sessions; filter, search, and tag the active session from the status bar or `/tag` chat command
- **File History** — Chronicle-powered "N sessions touched this file" in the status bar, CodeLens, and Explorer right-click; `chatwizard_sessions_for_file` MCP tool
- **Branch & Work Item Grouping** — group sessions by git branch or extracted work-item ID (Jira, GitHub Issues, Azure DevOps)
- **AI Session Summaries** _(Beta)_ — auto-generated one-line summaries for every session (Chronicle data first, then VS Code LM API, then offline TF-IDF)
- **Entity Extraction** _(Beta)_ — automatic extraction of file paths, function names, error codes, and decision phrases; filterable chips in the session reader
- **MCP Server** — expose your full chat history to Claude Desktop, Cursor, Continue, and Copilot agent mode via the Model Context Protocol (**11 tools**)
- **`@chatwizard` Copilot Chat Participant** — `/queryHistory`, `/continueFromHistory`, `/tag`, and `/referMessage` directly in Copilot Chat, no MCP server required
- **Live Indexing** — file watcher keeps all views up-to-date as new sessions are written, with no manual refresh needed
- **100% local** — no network calls, no account, read-only access to your existing session files"""

assert old_features in content, "Features list not found!"

new_features = """- **Sessions Panel** — browse, sort, filter, pin, group, and reorder every AI session across all tools and workspaces
- **Full-Text Search** — instant in-memory keyword search with regex support and source/role filters
- **Semantic Search** — topic-similarity search via a local AI model (opt-in, ~22 MB)
- **Code Block Library** — every AI-generated code snippet, filterable by language, with one-click copy
- **Prompt Library** — deduplicated, frequency-ranked archive of all your prompts with near-duplicate clustering and merge
- **Knowledge Base** — AI-classified session categories (Decisions, Learnings, Patterns, Gotchas, Architecture) with doughnut chart dashboard and Obsidian export
- **Action Items** — automatic extraction of follow-up tasks from sessions with click-to-scroll to source message
- **Analytics** — token usage charts, daily activity, top projects, top terms, longest sessions
- **Model Usage** — per-model request counts with date-range filtering and workspace/session drill-down
- **Timeline** — chronological feed with activity heat map, work bursts, topic drift ribbon, and streak stats
- **Session Bookmarks** — ★ toggle bookmark on sessions with dedicated bookmarked list
- **Inline Annotations** — 📝 add freeform notes pinned to specific messages in any session
- **Session Linking** — bidirectional 🔗 links between related sessions with badge navigation
- **Session Status Lifecycle** — track Open → Resolved → Revisit workflow with tag-based auto-status
- **Session Sharing** — export as self-contained HTML with optional code block redaction
- **Keyboard Navigation** — full `j`/`k`/`gg`/`G` keyboard support for Sessions panel, Code Blocks, and reader
- **Did You Know Tips** — 🐿️ squirrel mascot cycles through user-guide tips every 5 minutes
- **Export** — single session, multi-select, all sessions, or excerpt — to structured Markdown, **Obsidian vault**, or **Notion database**
- **Session Retention** — auto-delete sessions older than `sessionRetentionDays` at startup and after each indexing cycle
- **Compacted Sessions** — large sessions compressed with `· compacted` badge and abbreviated content in reader
- **REST API** — lightweight HTTP endpoint (`GET /api/search`, `GET /api/sessions`, etc.) for custom integrations
- **Session Archive** — every indexed session is mirrored locally so history survives source tool pruning; configurable age/size limits
- **Session Tagging** — attach freeform labels to sessions; filter, search, and tag the active session from the status bar or `/tag` chat command
- **File History** — Chronicle-powered "N sessions touched this file" in the status bar, CodeLens, and Explorer right-click; `chatwizard_sessions_for_file` MCP tool
- **Branch & Work Item Grouping** — group sessions by git branch or extracted work-item ID (Jira, GitHub Issues, Azure DevOps)
- **AI Session Summaries** _(Beta)_ — auto-generated one-line summaries for every session (Chronicle data first, then VS Code LM API, then offline TF-IDF)
- **Entity Extraction** _(Beta)_ — automatic extraction of file paths, function names, error codes, and decision phrases; filterable chips in the session reader
- **MCP Server** — expose your full chat history to Claude Desktop, Cursor, Continue, and Copilot agent mode via the Model Context Protocol (**11 tools**)
- **`@chatwizard` Copilot Chat Participant** — `/queryHistory`, `/continueFromHistory`, `/tag`, and `/referMessage` directly in Copilot Chat, no MCP server required
- **Live Indexing** — file watcher keeps all views up-to-date as new sessions are written, with no manual refresh needed
- **100% local** — no network calls, no account, read-only access to your existing session files"""

content = content.replace(old_features, new_features, 1)

# Also fix settings reference link
content = content.replace(
    "(docs/user-guide.md#14-settings-reference)",
    "(docs/user-guide.md#30-settings-reference)"
)
content = content.replace(
    "(docs/user-guide.md#15-commands-reference)",
    "(docs/user-guide.md#31-commands-reference)"
)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("README.md updated successfully!")