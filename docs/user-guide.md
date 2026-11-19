# ChatWizard — User Guide

ChatWizard indexes every AI chat session from all your tools — GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, Google Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist and Tabnine — into one searchable, analyzable archive, without sending anything off your machine.

This guide documents **every user-facing feature**, panel, setting and command in the extension. If something below is not available in your build, check `Chat Wizard: Show Output Channel` with `chatwizard.logLevel` set to `DEBUG`, or open an issue.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Sidebar Overview](#sidebar-overview)
   - [Watch Agent Logs Panels](#watch-agent-logs-panels)
3. [Sessions Panel](#sessions-panel)
   - [Browsing Sessions](#browsing-sessions)
   - [Sorting & Grouping](#sorting--grouping)
   - [Filtering Sessions](#filtering-sessions)
   - [Pinning](#pinning)
   - [Session Folders](#session-folders)
   - [Session Status Lifecycle](#session-status-lifecycle)
   - [Session Tagging](#session-tagging)
   - [Regenerating Titles](#regenerating-titles)
   - [Session Archive](#session-archive)
   - [Context Menu](#context-menu)
4. [Session Reader](#session-reader)
   - [Reader Layout](#reader-layout)
   - [Turn Labels & References](#turn-labels--references)
   - [Searching the Transcript](#searching-the-transcript)
   - [Load All Messages](#load-all-messages)
   - [Message Bookmarks](#message-bookmarks)
   - [Inline Annotations](#inline-annotations)
   - [Removing Turns from a Conversation](#removing-turns-from-a-conversation)
   - [Entities Row](#entities-row)
5. [Search](#search)
   - [Full-Text Search](#full-text-search)
   - [Semantic Search](#semantic-search)
6. [Code Blocks Panel](#code-blocks-panel)
   - [Filtering Code Blocks](#filtering-code-blocks)
   - [Actions](#actions)
7. [Prompt Library](#prompt-library)
8. [Knowledge Base](#knowledge-base)
   - [Generating the Knowledge Base](#generating-the-knowledge-base)
   - [Auto-Tagging & Export](#auto-tagging--export)
9. [Analytics & Monitoring](#analytics--monitoring)
   - [Analytics Dashboard](#analytics-dashboard)
   - [Model Usage](#model-usage)
   - [Timeline](#timeline)
10. [Export & Sharing](#export--sharing)
    - [Export a Single Session](#export-a-single-session)
    - [Export Selected Sessions](#export-selected-sessions)
    - [Export All Sessions](#export-all-sessions)
    - [Export an Excerpt](#export-an-excerpt)
    - [Inject as Context](#inject-as-context)
    - [Export to Obsidian](#export-to-obsidian)
    - [Export to Notion](#export-to-notion)
    - [Share as HTML](#share-as-html)
11. [MCP Server & AI Integrations](#mcp-server--ai-integrations)
    - [Enabling the Server](#enabling-the-server)
    - [Quick Start](#quick-start)
    - [Available MCP Tools](#available-mcp-tools)
    - [Per-Tool Setup](#per-tool-setup)
    - [@chatwizard Copilot Participant](#chatwizard-copilot-participant)
    - [Token Security](#token-security)
    - [Troubleshooting](#troubleshooting)
12. [REST API](#rest-api)
    - [Enabling the API](#enabling-the-api)
    - [Authentication](#authentication)
    - [Endpoints](#endpoints)
    - [Example](#example)
13. [Cloud Sync (Opt-In)](#cloud-sync-opt-in)
14. [Workspace Digest](#workspace-digest)
15. [Workspace & File History](#workspace--file-history)
    - [Workspace Management](#workspace-management)
    - [File History](#file-history)
16. [Session Lifecycle Management](#session-lifecycle-management)
    - [Session Retention](#session-retention)
    - [Compacted Sessions](#compacted-sessions)
17. [AI Intelligence](#ai-intelligence)
    - [Session Summaries](#session-summaries)
    - [Entity Extraction](#entity-extraction)
18. [Navigation & Shortcuts](#navigation--shortcuts)
19. [Did You Know Tips](#did-you-know-tips)
    - [How It Works](#how-it-works)
    - [Fallback Tips](#fallback-tips)
    - [Disabling](#disabling)
20. [Settings Reference](#settings-reference)
21. [Commands Reference](#commands-reference)
22. [Quick Reference](#quick-reference)
23. [Known Limitations](#known-limitations)
24. [Feedback](#feedback)

---

## Getting Started

1. Install ChatWizard from the VS Code Marketplace (or Open VSX for VSCodium / Cursor / Windsurf).
2. The extension indexes sessions automatically on startup — no configuration needed for most setups.
3. Click the **Chat Wizard** speech-bubble icon in the Activity Bar to open the sidebar.
4. New here? Try the five-minute tour at the end of this guide: [Quick Reference](#quick-reference).

> **Supported tools:** GitHub Copilot (per-workspace and agent-host storage), Claude Code, Cline (legacy and 4.x storage), Roo Code, Cursor, Windsurf, Aider, Google Antigravity, Continue.dev, Amazon Q Developer, Gemini Code Assist, Tabnine Chat.

> **First-run cost:** the very first index can take a few seconds per thousand messages. Afterwards, the SQLite cache loads instantly and only changed files are re-parsed.

---

## Sidebar Overview

Eight panels live under the Chat Wizard Activity Bar icon:

| Panel | Purpose |
|-------|---------|
| **Sessions** | Browse every AI session across all tools and workspaces |
| **Prompt Library** | Your full history of prompts, deduplicated and searchable |
| **Code Blocks** | Every AI-generated code snippet, filterable by language |
| **Commands** | What your agent *did*: executed shell commands (with **Run in Terminal**), a unified action timeline, and a diff explorer — grouped per session / workspace |
| **Knowledge Base** | Categorized learnings, decisions, patterns, gotchas, and architecture |
| **Analytics** | Token usage charts and stats |
| **Model Usage** | Per-model request counts with date range filtering |
| **Timeline** | Chronological feed with heat map, streaks, and topic drift |

### Watch Agent Logs Panels

The **Commands** panel is the home of the _watch-logs_ subsystem (Phase 2/3 of
`docs/work-plan-watch-logs.md`). It contains four collapsible sections — **Terminal
Commands**, **LLM Tool Calls**, **Unified Timeline** and **Diff Explorer** — instead of
separate sidebar views; all of them start collapsed so the panel opens compact. AI models
do not run commands themselves — the *host tools* execute
them, and ChatWizard replays the agent-execution trail each tool writes to disk:

| Tool | Source file | What is captured |
|------|-------------|------------------|
| **GitHub Copilot** | `chatSessions/*.jsonl` | `toolInvocationSerialized` entries (`run_in_terminal`, `create_file`, `move_file`, `apply_patch`, …), `textEditGroup` inline edits, terminal notifications **with exit codes** |
| **Cline / Roo Code** | `tasks/<id>/ui_messages.json` | `say:'command'` + `command_output` chunks, tool calls, `editedExistingFile` SEARCH/REPLACE diffs, `error`/`error_retry`, `task_progress` plan steps |
| **Aider** | `.aider.chat.history.md` | `> !cmd` and the `/run`, `/test`, `/lint` commands (+ their output), `Applied edit to …` file edits, fenced `diff` blocks |
| **Windsurf** | `state.vscdb` → `cascade.sessionData` | structured tool calls when present, otherwise the shell commands Cascade proposed (fenced `bash`/`sh`/`pwsh`/`cmd` blocks in assistant messages) |

Fidelity differs per tool: **exit codes** are only logged by Copilot; Cline/Roo Code and
Aider record output but no exit status; Windsurf does not persist tool executions at all, so
its command rows are marked *derived* in the event details. Diffs likewise: Copilot stores the
replacement text only (additions-only patches), while Cline and Aider patches carry both sides.

> **Cline 4.x storage.** Cline 4.x moved its chat history out of VS Code's
> `globalStorage` into its own home directory: `~/.cline/data/sessions/<id>/`
> (`<id>.json` metadata + `<id>.messages.json` transcript), overridable with the
> `CLINE_DATA_DIR` / `CLINE_DIR` environment variables. ChatWizard indexes those
> sessions alongside the legacy `tasks/<id>/` directories (which Cline leaves
> behind on upgrade), including live updates while a task runs. Their
> `tool_use` / `tool_result` parts are normalized too, so `run_commands`,
> `editor` and `apply_patch` calls show up as **commands, file operations and
> diffs** (with exit codes and captured output) in the Commands view.

> **Copilot agent-host storage.** Newer VS Code (1.146+) / Copilot Chat (1.0+)
> stopped writing chats to `workspaceStorage/<hash>/chatSessions/*.jsonl` and
> keeps them in the Copilot home instead:
> `<COPILOT_HOME || ~/.copilot>/session-state/<id>/` (`workspace.yaml` with the
> chat title/cwd/git info + `events.jsonl` transcript), overridable with the
> `COPILOT_HOME` environment variable. ChatWizard indexes both layouts, including
> live updates while a chat runs, and replays `tool.execution_start` /
> `tool.execution_complete` into command / diff / error rows.
>
> Because `session-state` is machine-global, agent-host chats are **scoped by
> their `cwd`** (`workspace.yaml`): only chats opened under the VS Code folder(s)
> you have open appear in the Sessions view. Chats from another repository
> (e.g. `C:\src\selling` while working in `C:\src\_\ChatWizard`) stay hidden —
> the legacy `workspaceStorage/<hash>/chatSessions` layout stays scoped by
> workspace id.

> **Workspace scoping.** The agent-log store is shared by every workspace on the
> machine, so the Commands view is scoped to the VS Code folder(s) you have open
> (`chatwizard` activity while `chatwizard` is open, nothing from
> `vscode-extension-analytics`). Close all folders — or open a folderless
> window — to see the unscoped history. The scope follows `File → Add Folder to
> Workspace` changes immediately.


- **Terminal Commands** lists every shell / git / build / test command, newest first,
  grouped per session, with exit badges, copy-to-clipboard, open-session and
  **Run in Terminal** actions. This section holds `command` events only.
- **LLM Tool Calls** is the counterpart for structured tool invocations — reading a file
  (`view` / `read_file`), searching the codebase, asking a question, and so on. Rows are
  self-describing: the label is `toolName [identifying argument]`
  (`view [src/extension.ts]`, `powershell [npm test]`), so a list of identical tool names
  is actually readable. The section shares the filter bar, the workspace scope and the
  per-session grouping of the other sections.
- Clicking any row opens **one shared details window** — subsequent clicks replace its
  contents instead of opening another tab, so browsing a long log never leaves you lost
  among a dozen webviews. Every event starts with a plain-English **Description** of what
  the command / tool does (`Runs a Git command: git status`,
  `Reads a file from the workspace: src/extension.ts`), followed by **Input** and
  **Output** sections when the event has them: commands show their text / working
  directory / shell as input and their exit code plus captured stdout/stderr as output,
  tool calls show their JSON arguments as input and the captured result as output.
  Command rows also show a **▶ Run in Terminal** button directly under the command text
  (it re-runs the command in a fresh VS Code terminal, using the captured working
  directory when it still exists).
- **Unified Timeline** mixes all six event kinds (commands, file operations, diffs, tool
  calls, errors, planner steps). Use the filter icon (or
  `Chat Wizard: Filter Unified Timeline…`) to focus on failures, diffs, or commands only.
  Tool-call rows carry the same `toolName [target]` label as the LLM Tool Calls section.
- **Diff Explorer** lists every changed file **alphabetically** — each file expands into its
  change rows **newest first**, so you keep the edit timeline of that file (`create`,
  `diff`, `move`, `rename`, …), interleaved as they actually happened. Double-click a change
  (or use
  `Open Visual Diff`) to see it in VS Code's native diff editor — side-by-side or inline,
  with coloured rows, word-level highlighting and "collapse unchanged regions", exactly like
  a GUI Git client. `Open Patch` renders the raw patch text in a disposable markdown editor;
  `Copy Change` copies the diff text; `Open File` reveals the affected file when it still
  exists. The change rows' hover tooltip shows only a short patch preview.
- **One icon family per section.** Terminal Commands rows use `run` (exit code unknown) /
  `terminal` (exit 0) / `error` (failed), LLM Tool Calls rows use `tools`, Unified Timeline
  rows use `history` with the outcome as colour (red = failed command / error, yellow =
  warning) and Diff Explorer rows use one icon per operation
  (`diff`, `file-add`, `trash`, `arrow-swap`, `move`, `new-folder`) — so a row names its
  section at a glance, even when the tree is deep.
- **One filter bar for all four sections** (Phase 4). The filter button in the view title
  bar (or `Chat Wizard: Filter Agent Logs…`) opens a menu with the current state of every
  facet:
  - **Search Agent Logs…** (`chatwizard.logs.search`) — case-insensitive free text; all words
    must match. It searches command text, working directory, shell, output summaries, file
    paths and operation details, diff text, tool names and arguments, error messages and
    stack traces, planner descriptions, plus the agent name and workspace path.
  - **Filter by Agent…** (`chatwizard.logs.filterByAgent`) — restrict to one AI tool.
  - **Show Failures Only** (`chatwizard.logs.toggleFailures`) — failed commands (non-zero exit
    code), failed tool calls (`success: false`) and non-warning `error` events.
  - **Filter by Event Kind…** (`chatwizard.logs.timeline.filter`) — the Unified Timeline's
    kind filter, which now composes with the facets above.
  - **Clear All Filters** (`chatwizard.logs.clearFilters`) — reset everything.

  While a filter is active the section rows say so (`12 commands · 2 failed · filtered`), and
  the counts always describe what is actually visible.
- **`Chat Wizard: Show Agent Log Stats`** (`chatwizard.logs.showStats`) opens a markdown report
  with totals (events, commands, failed commands, failures, errors, diffs, +/− lines) and a
  command **success rate** over commands that logged an exit code — plus one row per agent
  (sessions, commands, failed, errors, diffs, files, tool calls, steps) and one row per
  session (events, commands, failures, last activity).

The underlying event store is a read-only SQLite database
(`chatwizard-log-events.db`, colocated with the session cache); events are re-indexed
automatically whenever a Copilot session file, Cline/Roo Code task, Aider history file or
Windsurf workspace database is created or rewritten by the tool.

Each panel can also be opened as a standalone editor tab:

```
Ctrl+Shift+P → Chat Wizard: View… → Show Analytics Dashboard
```

---

## Sessions Panel

The Sessions panel is the central hub — every AI session across all tools and workspaces appears here. All session-related features (sorting, filtering, tagging, bookmarks, folders, status, etc.) are available from this panel.

### Browsing Sessions

Sessions appear as a list. Click any session to open it in a Markdown reader with full syntax-highlighted code blocks. Links in a conversation are clickable — Markdown links as well as bare `http://…`, `https://…` and `www.…` addresses — and open in your default browser; URLs inside code blocks stay as plain text.

The tree renders **200 rows at a time**. When a filter or grouping still has more matches, a **Load More Sessions** row sits at the bottom of the list; clicking it runs `chatwizard.loadMoreSessions` and appends the next 200 sessions. Changing a filter, sort order or grouping resets the view to the first 200.

### Sorting & Grouping

Use the toolbar icons to toggle grouping and change sort order.

**Group by** (toolbar → **Group Sessions…**):
- **Date** — Today / Yesterday / This Week / This Month / Older
- **Branch** — git branch names (requires Chronicle; `chatwizard.chronicle.enableLocalIndex`)
- **Work Item** — Jira / Azure DevOps / GitHub issue IDs extracted with `chatwizard.workItemPattern`
- **Tag** — one group per tag (untagged sessions fall into their own bucket)
- **Folder** — your [session folders](#session-folders); unassigned sessions appear under `(uncategorized)`
- **None** — a flat list

**Sort by** (each click toggles ascending/descending):
- Date, Title, Workspace, Length (message count), or Model

**Multi-key sorting** (e.g. "by workspace, then by date descending"):

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Configure Sort Order…
```

### Filtering Sessions

```
Ctrl+Shift+P → Chat Wizard: Filter & Sort… → Filter Sessions…
```

The filter dialog supports:

| Filter | Notes |
|--------|-------|
| Title | substring, case-insensitive |
| Date range | from / until (`YYYY-MM-DD`) |
| Model | substring match on the model name |
| Source | one AI tool (Copilot, Claude, Cline, …) |
| Message count | minimum / maximum |
| Status | Open / Resolved / Revisit |
| Tags | one or more tags (OR match) |
| Hide interrupted | drop sessions that were cut off mid-response |
| Only with warnings | keep sessions that logged parse warnings |

All active filters are reflected in the view title; the same button clears them.

**Example:** show only Copilot sessions from last week with more than 10 messages — From `2026-05-07`, Until `2026-05-14`, Source `copilot`, Min messages `10`.

### Pinning

Pin important sessions so they float to the top. Use the **📌 pin icon** on the row or right-click → **Pin Session** / **Unpin Session**. Pinned sessions also get their own group when grouping is enabled.

### Session Folders

Organize sessions into folders for project-level grouping:

- **Create a folder:** `Ctrl+Shift+P` → **Chat Wizard: Create Folder** or the **new-folder** icon in the Sessions view title
- **Subfolders:** right-click a folder → **Create Subfolder**
- **Rename / delete:** right-click a folder → **Rename Folder** / **Delete Folder** (sessions inside are unlinked, not deleted)
- **Move a session:** right-click a session → **Move Session to Folder…**, or drag-and-drop it onto a folder
- **Group by folder:** toolbar → **Group Sessions…** → **Folder**

Folders are stored in `chatwizard-folders.json` in extension storage, so they survive reloads and are shared across IDEs that use the same storage.

### Session Status Lifecycle

Track the state of each session through a simple workflow: **Open** → **Resolved** → **Revisit**.

| Status | Meaning | Visual cue |
|--------|---------|------------|
| **Open** | Default — active or unprocessed | No badge |
| **Resolved** | The task described in this session is complete | `✓` prefix (green badge) |
| **Revisit** | Parked; needs another look | `⟲` prefix (yellow badge) |

**Change it:** right-click a session → **Set Session Status…** → pick a status, or use the **Session…** command-palette group → *Set Session Status…*. The reader header shows the current status as a read-only chip.

**Filter by status:** right-click → **Filter by Status…**, or use the *Status* field in **Filter Sessions…**.

### Session Tagging

Attach freeform labels to sessions for quick filtering and future retrieval.

**Adding tags:** right-click any session → **Add Tag…**, then enter one or more comma-separated labels:

```
#bugfix, topic:auth, kind:decision
```

Tags are normalised (lowercased; a leading `#` is stripped for storage and re-added for display).

**Removing tags:** right-click → **Remove Tag…** (multi-select QuickPick of the session's tags) or **Clear All Tags…**.

**Where tags show up:**
- **Session tree** — coloured `#tag` chips after the metadata line.
- **Session reader header** — tag chips next to the source badge and date.

**Filtering by tag:** right-click → **Filter by Tags** via **Filter Sessions…**, or group the panel by tag ([Sorting & Grouping](#sorting--grouping)).

**Tag the session you are in the middle of:**
- **Command Palette:** `Ctrl+Shift+P` → **Chat Wizard: Tag Active Session**
- **Status bar:** the `$(tag) Tag session` button appears while a chat is live (updated within `chatwizard.activeSessionWindowMinutes`, default 120 minutes)
- **Chat:** `@chatwizard /tag #bugfix, topic:auth`, and `@chatwizard /removeTags #bugfix` to remove them

> **Knowledge Base tags.** Generated KB sessions also receive `kb-category:<type>` and `kb-group:<group>` tags when `chatwizard.kbAutoTagSessions` is enabled — they filter and group like any other tag.

### Regenerating Titles

Copilot and Cline sometimes store a placeholder or an escaped multi-line title. Fix it in place:

- Right-click a session → **✏️ Regenerate Title**
- Right-click a date group → **Regenerate Titles in Group**
- `Ctrl+Shift+P` → **Chat Wizard: Regenerate All Titles**
- Multi-select sessions and run **Regenerate Title** to fix a whole selection

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

Right-click any session for the full action menu:

| Action | Description |
|--------|-------------|
| Pin / Unpin Session | Keep the session at the top of the list |
| Export Session to Markdown | Save this session as a `.md` file |
| Export Selected… | Export the current multi-selection |
| Inject as Context… | Export the session and open a new Copilot Chat pre-filled with it |
| Reveal in Explorer | Show the source file in the VS Code Explorer |
| Archive Session | Force an immediate archive snapshot |
| Delete Archived Session | Remove the archive copy (the live session is unaffected) |
| Add Tag… / Remove Tag… | Attach or remove freeform labels |
| Regenerate Summary | Re-generate the one-line summary |
| Regenerate Title / Regenerate Titles in Group | Fix placeholder or escaped session titles |
| Set Session Status… | Mark as Open / Resolved / Revisit |
| Add Bookmark… / Remove Bookmark… | Bookmark the session (with an optional note) |
| Move Session to Folder… | Organize into a session folder |

Related title-bar actions: **Filter Sessions**, **Group Sessions**, **Configure Sort Order**, **Export All/Selected**, and the per-field sort buttons.

---

## Session Reader

Click any session to open it in the **session reader** — a syntax-highlighted, searchable transcript with per-turn actions. Everything you can do with a conversation lives here.

### Reader Layout

- **Header** — source badge, title, workspace, date, model, message count, token estimate, status chip, tag chips, AI summary, and — when something was removed — `Removed: N turns` plus an **original full conversation** link.
- **Entities row** — always-visible `Entities [type] [entity]` dropdowns (see [Entities Row](#entities-row)).
- **Transcript** — prompts and responses with role labels (`You` / `Copilot`, `Claude`, …), timestamps and syntax-highlighted code blocks.
- **Links are live** — Markdown links and bare `http://`, `https://` and `www.` addresses open in your default browser. Trailing sentence punctuation stays outside the link, balanced parentheses are preserved, and URLs inside inline/fenced code stay verbatim.
- **Turn actions** — hover a turn for **★** (bookmark), **📝** (note), **⧉** (copy-as-reference) and, when the persistent cache is available, **⊗** (remove).

> Long conversations open with the first 50 messages for speed. The sections below explain how to reach, search and curate the rest.

### Turn Labels & References

Every turn carries a stable label — `P1`, `P2`, … for prompts and `R1`, `R2`, … for responses. This is the vocabulary the `/referMessage` chat command expects.

- Hover a turn and click **⧉** to copy its reference (e.g. `P3`) to the clipboard.
- In Copilot Chat, `@chatwizard /referMessage P3` streams that turn back as a blockquote; you can append your own question (`/referMessage P3 why did we do that?`).
- Labels are stable: removing a turn does not renumber the ones around it, so old references keep pointing at the right message.

### Searching the Transcript

1. Press `Ctrl+F` or type in the search box in the sticky toolbar.
2. The reader **loads the rest of the conversation automatically** (the counter says *Loading all messages…*) and re-runs the query when the last batch lands, so the counter and the ▲/▼ navigation cover the whole transcript — not just the rendered excerpt.
3. Use the **whole-word** and **regex** toggles next to the search box to narrow the match; `Enter` jumps to the next hit, `Shift+Enter` to the previous one, and `Esc` clears the query.
4. Picking an entity from the Entities row runs the same search and scrolls to the first occurrence.

### Load All Messages

- The sticky toolbar carries a **Load all messages** button that streams the full transcript in 20-message batches, with a spinner and a *Loading all messages…* label.
- The per-batch **Load more messages…** button stays for incremental reading; it is hidden while a full load runs (it would only append the same ranges).
- The button disappears once everything is loaded.

### Message Bookmarks

Bookmark individual turns so you can jump back to them without scrolling.

**Toggle a bookmark:**
- Hover a message and click **★**, or
- Right-click a session in the Sessions panel → **Add Bookmark…** to bookmark it with an optional note (the note is attached to the session's first message).
- Remove one via right-click → **Remove Bookmark…** (a QuickPick lists the session's bookmarks).

**Jumping back:**
- A **★ Bookmarks** section at the top of the reader lists every bookmark in the conversation; click an entry to scroll to that turn.
- Bookmarked turns are marked with a filled star while the conversation is open.

**Persistence:**
- Bookmarks live in the shared sidecar metadata (`chatwizard-metadata.json`), so they survive restarts and are shared across VS Code, Cursor and Windsurf when `chatwizard.sharedCacheDir` points at the same folder.
- Removing a turn drops a bookmark attached to that turn.

### Inline Annotations

Attach your own note to any turn — a decision, a correction, a reminder of what actually worked.

**Add a note:** hover a message and click **📝**, type in the inline editor, then press **Enter** (or click **Save**).

**Edit or delete:** the rendered note has **✏️** and **🗑️** actions.

**Find them again:**
```
Ctrl+Shift+P → Chat Wizard: Search… → Search Annotations
```

Notes are included in the self-contained HTML export and are stored in the sidecar metadata, so they survive restarts.


### Removing Turns from a Conversation

Long conversations often carry noise — a cancelled prompt, a wrong answer, a
pasted dump that adds nothing. You can remove individual turns from the reader
without touching the original transcript on disk.

**Removing a turn:**
- **Click** a prompt or a response to select it — the turn gets an outline and
  its **⊗ remove** button appears in the header. Click it to delete the turn.
- Or **right-click** the turn → **Remove turn from conversation**.
- Press **Esc** (or click anywhere outside the turns) to clear the selection.

**What happens:**
- The turn disappears from the conversation immediately.
- The conversation header reports it: *Removed: 2 turns*, together with an
  **original full conversation** link.
- The removal is persisted in the chat database (`chatwizard-cache.db`,
  `removed_turns` table), so it survives restarts, re-parsing and source-file
  pruning. Turn indices are preserved, so bookmarks and annotations keep
  pointing at the right turns — the bookmark / note attached to the removed turn
  itself is dropped.
- Removed turns are excluded from full-text/semantic search results, the Prompt
  Library, the Code Blocks panel, and the "User Requests" count.

**Opening the original conversation:**
Click **original full conversation** in the conversation header. Chat Wizard
rebuilds the complete chat — including every removed turn — from the chat
database, writes it to
`<ChatWizard cache folder>/original-conversations/<title>-<id>.md` and opens it
in a text editor. The link is only shown when at least one turn was removed.

> Removing turns requires the persistent cache (`chatwizard.enablePersistentCache`,
> on by default in VS Code). In hosts where the native SQLite module cannot be
> loaded the affordance is hidden, because the removal could not be persisted.

### Entities Row

The always-visible **Entities** row summarises what the conversation mentions and gives you one-click navigation:

| Entity type | Examples |
|-------------|----------|
| Files | `src/auth.ts`, `package.json` |
| Functions / classes | `handleLogin`, `AuthService` |
| Errors | `TypeError: Cannot read`, `SQLITE_BUSY`, `ENOENT`, `403 Forbidden` |
| Decisions | "we chose", "the approach is" |
| Uris | `https://example.com/docs`, `www.…` |
| LLM sub-types | Frameworks, APIs, Concepts, Tools, Languages |

- **Type** lists only types that actually have values, sorted alphabetically.
- **Entity** lists that type's values, de-duplicated and sorted; the internal `[type]` marker is stripped.
- Picking a value fills the search box and jumps to its first occurrence in the transcript.
- Sessions without entities keep the row visible in a disabled *No entities* state.

Entities are also filterable from the MCP server: `chatwizard_search` accepts `entityType` and `entityValue`.

---


## Search

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
- **Source** — cycles `All → Copilot → Claude → Antigravity → Cursor → Cline → Roo Code → Windsurf → Aider → All`. Other sources (Continue.dev, Amazon Q, Gemini Code Assist, Tabnine) are still searched under **All**.
- **Role** — All / Prompts only / Responses only.

> When results are truncated, a banner reports *Showing top N of M results — refine your query*. Regex queries are also time-boxed per session to keep pathological patterns from freezing the window.

### Semantic Search

Finds sessions by **meaning**, not keywords. Useful when you remember the concept but not the exact wording.

**One-time setup:** semantic search is enabled by default. On first use a ~22 MB embedding model is downloaded, **verified** (size + SHA-256 against a manifest) and cached; after that everything runs offline and `transformers.js` is configured to load strictly from disk (`allowRemoteModels = false`).

Sources are tried in order: configured local folder → previously downloaded folder → mirror host / `HF_ENDPOINT` → official Hub → Chat Wizard GitHub release asset. `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured, including CONNECT tunnelling and basic auth, and TLS-inspecting corporate proxies work because Node's trust store is merged with the OS store (`NODE_EXTRA_CA_CERTS` is honoured too).

> **Blocked network?** If the model cannot be obtained, Chat Wizard tells you once — *Fix Model Source… / Retry / Disable* — and keeps working without semantic search. Keyword search, the session tree, analytics and the MCP keyword tools are unaffected, and the failure is not retried more than once a day. See [troubleshooting/semantic-model-download.md](troubleshooting/semantic-model-download.md).

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

Tune sensitivity with `chatwizard.semanticMinScore` (default `0.35`; lower = more results, higher = stricter). Use `chatwizard.semanticIndexMaxAgeDays` (default `365`) to keep very old sessions out of the embedding index only.

**Model controls:**
- `Chat Wizard: Configure AI Model Source…` — pick a local folder or a mirror host.
- `Chat Wizard: Retry Loading the AI Model` — retry after fixing the network.
- `Chat Wizard: Reset AI Model Cache` — discard a corrupt/partial download.

---

## Code Blocks Panel

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

- **Click** a code block → opens the parent session scrolled to that block (optionally highlighted in orange). This is the `chatwizard.openSessionFromCodeBlock` command.
- **Copy icon** on each row → copies the block contents to clipboard
- **Group by language** — toggle via toolbar to bucket blocks under `typescript`, `python`, `sql`, etc.
- **Sort by** — Date, Workspace, Length, Title, or Language
- **Load More Code Blocks** — the panel shows 200 entries at a time; the row at the bottom of the list appends the next page (`chatwizard.loadMoreCodeBlocks`)

---

## Prompt Library

A deduplicated, frequency-ranked archive of every prompt you have ever typed, grouped so near-identical prompts land together.

- **Exact duplicates** collapse into a single entry with a usage count and the number of projects it was used in.
- **Similarity grouping** — the default view clusters prompts by trigram similarity; each cluster expands into its individual **variants**, each with its own frequency and **Copy** button. A **Month** grouping is available from the toolbar when you would rather browse chronologically.
- **Inline search** filters prompts as you type.
- **Copy** on any prompt or variant puts it straight back on your clipboard.
- **Open session** jumps to the conversation the prompt came from, so you can see the answer it produced.

**Example workflow:** you vaguely remember a detailed system prompt you wrote for a refactoring task. Open the Prompt Library, type `refactor`, open the cluster, copy the variant you want, paste it into today's chat.

> Prompts from removed turns are excluded, so curating a conversation also curates this library.

---

## Knowledge Base

The Knowledge Base panel classifies your sessions into reusable knowledge — decisions, learnings, patterns, gotchas and architecture — using the free Copilot LM API first, with an embedding-similarity and heuristic fallback when no LLM is available (which is why quality is noticeably better in VS Code than in hosts without a free model).

### Generating the Knowledge Base

1. Open the **Knowledge Base** panel in the sidebar.
2. Click **⚡ Generate Knowledge Base** — every session is classified with a progress notification (`N / M sessions classified`).
3. The dashboard shows a doughnut chart of category distribution; click a slice to drill into the sessions behind it.
4. After the first run, **new and updated sessions are classified incrementally** (debounced per session), so you do not have to regenerate everything after each chat.

The result is persisted in extension storage, so the dashboard survives reloads. When `chatwizard.kbRefineLabels` is enabled (default), a second LLM pass merges near-duplicate category labels and folds narrow ones into broader categories, which keeps the doughnut readable.

### Auto-Tagging & Export

- **Auto-tagging** (`chatwizard.kbAutoTagSessions`, default `true`) adds `kb-category:<type>` and `kb-group:<group>` tags to classified sessions — use them with the tag filter or the Tag group mode.
- **Export** in the KB dashboard asks for a folder and writes an Obsidian-compatible Markdown knowledge base (YAML frontmatter per entry, clustered entries). Re-running the export is **incremental**: files you have edited and marked `locked: true` in the frontmatter are never overwritten.

> The panel (not the Command Palette) is the entry point — there is no separate KB command.

---

## Analytics & Monitoring

Three panels provide data-driven insight into your AI usage.

### Analytics Dashboard

Open via the sidebar panel or:
```
Ctrl+Shift+P → Chat Wizard: View… → Show Analytics Dashboard
```

**What's shown:**
- Summary cards: total sessions, prompts, responses, estimated tokens, and the time span covered — plus a per-source card for each source that has sessions (Copilot, Claude, Cursor, Cline, Roo Code, Windsurf, Aider, Antigravity).
- Daily activity chart.
- Top projects by token consumption.
- Top 20 most-used terms.
- Longest sessions, by message count and by tokens.
- A footnote reminding you that token counts are estimates.

The dashboard refreshes automatically as new sessions are indexed, and it can also be opened as an editor tab.

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

## Export & Sharing

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

Asks for a folder (ideally inside your Obsidian vault) and writes **one `.md` per indexed session**.

**Output format per file:**
- YAML frontmatter: `title`, `source`, `date`, `tags` (your ChatWizard tags), `summary`, `chatwizard_id`
- Messages as Markdown (`**You:**` / `**Assistant:**` headings)
- File paths referenced by the session are emitted as `[[wikilinks]]`

**Scope:** the command exports all sessions; there is no scope picker. **Existing files are skipped** rather than overwritten, so a re-run only adds what is missing — delete a file first if you want it regenerated.

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
Ctrl+Shift+P → Chat Wizard: Share Session
```

Exports **one session** as a self-contained `.html` file (inline CSS, syntax-highlighted code blocks, source badge, tags and your annotations), letting you pick the destination. The recipient needs no VS Code and no ChatWizard installation.

> Batch export is Markdown-only: use **Export Selected Sessions…** for several sessions at once. HTML sharing is one session at a time, and the export always includes code blocks (there is no per-block redaction step).

---

## MCP Server & AI Integrations

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
| `chatwizard_get_context` | Best single tool — combines semantic + keyword search, returns ranked passages (optionally TF-IDF-reranked) | `topic`, `limit` (1–20, default 5) |
| `chatwizard_search` | Keyword/full-text search across all sessions; one best result per session | `query`, `source`, `workspace`, `limit` (1–50, default 10), `entityType`, `entityValue` |
| `chatwizard_find_similar` | Semantic similarity search (requires semantic search enabled) | `query`, `minScore`, `limit` |
| `chatwizard_get_session` | Fetch a session by ID, truncated | `sessionId`, `maxChars` (default 4 000), `includeCode` (default true) |
| `chatwizard_get_session_full` | Fetch the complete, untruncated session | `sessionId` |
| `chatwizard_list_recent` | List most-recently-updated sessions | `limit`, `source`, `since` |
| `chatwizard_list_sources` | Which tools are indexed and their session counts | _(none)_ |
| `chatwizard_server_info` | Server health, version, session count, uptime | _(none)_ |
| `chatwizard_sessions_for_file` | Sessions that touched a file (absolute or workspace-relative path) | `filePath` |
| `chatwizard_sessions_for_branch` | Sessions on a specific git branch (case-insensitive) | `branch` |
| `chatwizard_sessions_for_work_item` | Sessions for a work-item ID (requires `chatwizard.workItemPattern`) | `workItemId` |

The server also publishes **four MCP prompts** — `chatwizard.queryHistory`, `chatwizard.continueFromHistory`, `chatwizard.getPrompts` and `chatwizard.referMessage` — so MCP clients that support prompts get ready-made entry points. A `/mcp-config` endpoint returns a ready-to-paste client snippet for the current token.

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

```
@chatwizard /getPrompts authentication
```
→ Mines your history for reusable prompts on a topic and returns the ten most general ones, ranked.

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
- If the model could not be downloaded (blocked corporate network), the MCP tool says so — fix it with **Chat Wizard: Configure AI Model Source…** or a local model folder (see [troubleshooting/semantic-model-download.md](troubleshooting/semantic-model-download.md))

**"Downloading AI model…" never finishes**
- This is the model download being blocked or intercepted. The notification now closes with an error instead of hanging, and the extension keeps working without semantic search
- Options: **Chat Wizard: Configure AI Model Source…** → mirror host (`https://hf-mirror.com`) or a local model folder; or set `HTTPS_PROXY`/`HTTP_PROXY` before starting VS Code
- A previous bad download can be cleared with **Chat Wizard: Reset AI Model Cache**, then **Chat Wizard: Retry Loading the AI Model**

---

## REST API

A lightweight HTTP API for querying your session index programmatically — useful for custom integrations, scripts, and automation.

### Enabling the API

```json
"chatwizard.restApi.enabled": true
```

The read-only API server starts on `http://127.0.0.1:6790` and rejects every method except `GET`. Port configurable via `chatwizard.restApi.port` (default `6790`, must differ from the MCP port). Interactive endpoint documentation is served at `/` (or `/docs`) unless `chatwizard.restApi.enableDocs` is `false`.

### Authentication

Requests must include `Authorization: Bearer <token>`. The token is the same one used by the MCP server — get it from **Chat Wizard: Copy MCP Config to Clipboard** (it is embedded in the snippet). `/health` is the only public endpoint.

CORS preflight (`OPTIONS`) is answered, so browser-based dashboards can call the API.

### Endpoints

| Method | Path | Description | Query parameters |
|--------|------|-------------|------------------|
| `GET` | `/health` | Status, version, session count, uptime (no auth) | — |
| `GET` | `/v1/sessions` | List session summaries, paginated | `limit` (max 200), `offset`, `source` |
| `GET` | `/v1/sessions/:id` | Full session detail | — |
| `GET` | `/v1/sessions/search` | Full-text search | `q` (required), `limit` (default 20) |
| `GET` | `/v1/stats` | Aggregate statistics | — |

Pagination responses include a `next` link when more rows exist.

### Example

```bash
curl -s "http://127.0.0.1:6790/v1/sessions/search?q=performance" \
  -H "Authorization: Bearer <token>" | jq
```

---

## Cloud Sync (Opt-In)

Back up your session index to a private GitHub Gist with AES-256-GCM encryption. Every 5 minutes, the extension checks for changes and syncs automatically.

### Enabling Cloud Sync

```json
"chatwizard.cloudSync.enabled": true,
"chatwizard.cloudSync.type": "gist"
```

### Setup

1. **GitHub personal access token** — create a token with `gist` scope at [github.com/settings/tokens](https://github.com/settings/tokens) and set it as the environment variable `CHATWIZARD_GITHUB_TOKEN`.
2. Restart VS Code — the extension creates the Gist on first sync.

All data is encrypted locally with **AES-256-GCM** using a per-machine key derived from your hostname and the storage path (SHA-256, truncated to 16 hex characters) before it leaves the machine. The Gist ID and the sync state are stored in extension storage, so the extension remembers them across restarts. The SQLite cache database is backed up to the same backend as a restore point (skipped when the compressed database exceeds the Gist 50 MB per-file limit).

A sync runs every **5 minutes**, and only when something changed.

### Supported Backends

| Backend | Status | Credentials |
|---------|--------|-------------|
| GitHub Gist | ✅ Fully functional | `CHATWIZARD_GITHUB_TOKEN` (env var) |
| Amazon S3 | ⚠️ Placeholder — configure via code | — |
| Azure Blob | ⚠️ Placeholder — configure via code | — |

---

## Workspace Digest

Generate a Markdown standup report from your recent AI coding sessions.

```bash
Ctrl+Shift+P → Chat Wizard: Generate Digest
```

The report groups sessions by git branch and model for the window you pick — **Today**, **This week** or **This sprint** (2-week periods starting 2024-01-01) — and lists each session's title, model, duration and key topics. When AI summaries are available they are folded in for richer context. The output opens in a new editor tab as Markdown, ready to paste into Slack, Jira, or a GitHub PR description.

---

## Workspace & File History

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

**Explorer Context Menu:** Right-click any file in the Explorer (or the editor tab) → **Show File Session History**.

**File History Panel:** Lists sessions that touched the file with date, source badge, summary, and **[Open session]** button. When no Chronicle data exists, the panel shows an empty state.

**MCP Tool:** `chatwizard_sessions_for_file` accepts both absolute paths and workspace-relative paths for injecting file-centric context from any MCP client.

---

## Session Lifecycle Management

### Session Retention

Control how much history the UI shows. Retention **hides** old sessions; it never deletes source files or archive copies.

```json
"chatwizard.sessionRetentionDays": 90
```

- Default: `0` (disabled — every session is shown)
- A positive value suppresses sessions older than N days from the tree, search and analytics
- Takes effect on the next reload; the pruning pass runs at startup

Related limits:

| Setting | Default | Effect |
|---------|---------|--------|
| `chatwizard.sessionRetentionDays` | `0` (off) | Hide sessions older than N days from all UI surfaces |
| `chatwizard.semanticIndexMaxAgeDays` | `365` | Keep old sessions out of the embedding index only (they stay in keyword search and the tree) |
| `chatwizard.oldestSessionDate` | _(empty)_ | Only load sessions created on/after this date |
| `chatwizard.maxSessions` | `0` (no limit) | Keep only the N most recently updated sessions |

### Compacted Sessions

When Claude Code compacts a long conversation, it writes a summary entry instead of the original turns. Chat Wizard detects that marker and flags the session with a `· compacted` badge:

- The session stays searchable and keeps its summary and metadata.
- The reader shows the compacted transcript plus the compaction summary.
- Re-indexing the source updates the flag automatically; no Chat Wizard setting compacts or expands sessions.

---

## AI Intelligence

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
| URIs | `http://www.google.com`, `https://example.com/docs`, `www.…` |
| Semantic entities (LLM) | Frameworks, APIs, Concepts, Tools, Languages — stored as `[type] value` |

**In the session reader:** an always-visible one-line **Entities** row shows two dropdowns — `Entities [type] [entity]`:

- **Type** — the entity types that were actually extracted (`Files`, `Functions`, `Errors`, `Decisions`, `Uris`, plus the LLM sub-types `Frameworks`, `APIs`, `Concepts`, `Tools`, `Languages`), sorted alphabetically. Only types with at least one value are listed. Each `[type] value` semantic entity is grouped under its own sub-type (`[tool] Docker` → **Tools**, `[language] TypeScript` → **Languages**); unknown prefixes become their own pluralized type.
- **Entity** — the values of the selected type, sorted alphabetically (duplicates removed). The `[type]` marker is stripped, so the dropdown only shows the entity itself (e.g. `Docker`, not `[tool] Docker`). Picking a value fills the reader's search box with it and runs the search, so the webview scrolls to the first occurrence in the conversation.

When a session has no extracted entities the row stays visible with a disabled **No entities** state.

**In MCP search:** `chatwizard_search` accepts optional `entityType` and `entityValue` parameters to pre-filter sessions by extracted entity before full-text scoring.

---

## Navigation & Shortcuts

Chat Wizard does not register custom keybindings — it relies on VS Code's native tree, editor and webview navigation, so the arrow keys, `Home`/`End`, `PageUp`/`PageDown`, `Ctrl+F` and `Esc` behave exactly as they do everywhere else.

**Sessions / Code Blocks / Commands panels**

| Interaction | Action |
|-------------|--------|
| `↑` / `↓` | Move the selection |
| `Enter` | Open the selected session / code block / log row |
| `→` / `←` | Expand or collapse a group or folder |
| `Ctrl+Click` / `Shift+Click` | Multi-select sessions for batch export |
| `Ctrl+Shift+P` → **Chat Wizard: Filter & Sort…** | Filter, sort and group without leaving the keyboard |

**Session reader**

| Interaction | Action |
|-------------|--------|
| `Ctrl+F` | Search the transcript (auto-loads the rest of the conversation) |
| `Enter` / `Shift+Enter` | Next / previous match while the search box is focused |
| `Esc` | Clear the search or the turn selection |
| `Tab` | Move between the toolbar search box, the Entities dropdowns, and the transcript |

**Command Palette groups** — every action is reachable in two keystrokes without memorising command names:

`Chat Wizard: View…` · `Search…` · `Filter & Sort…` · `Session…` · `Folder & Archive…` · `Export…` · `Settings…`

---

## Did You Know Tips

A 🐿️ squirrel mascot in the status bar cycles through useful tips about ChatWizard features at regular intervals.

### How It Works

- The status bar shows 🐿️ **Did you know?** with a tip taken from the user guide's own section headings
- A new tip appears every **10 minutes** (`chatwizard.didYouKnowInterval`, default `600` seconds) while you work
- Clicking the squirrel opens the matching section of the user guide
- Tips are parsed from `user-guide.md` at runtime (H2 + H3 headings, de-duplicated, TOC skipped), so they stay in sync as this guide evolves

### Fallback Tips

If the guide cannot be read (packaging issue, restricted file access), a built-in set of tips covers semantic search, the MCP server, tagging, file history and export formats.

### Disabling

Set `chatwizard.didYouKnowInterval` to `0` to turn the nudge off (or any larger value to make it rarer).

---

## Settings Reference

Every setting the extension contributes, grouped the way VS Code groups them. Defaults are the shipped values.

### Data scope & performance

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.enabled` | `true` | Master switch — when `false`, nothing is indexed or watched |
| `chatwizard.oldestSessionDate` | `""` | Only load sessions created on/after this date (`YYYY-MM-DD`) |
| `chatwizard.maxSessions` | `0` | Keep only the N most recently updated sessions (`0` = no limit) |
| `chatwizard.maxLineLengthChars` | `1000000` | Maximum length of a single JSONL line; longer lines become a notice placeholder |
| `chatwizard.enablePersistentCache` | `true` | Use the SQLite session cache (`chatwizard-cache.db`), FTS5 search and incremental parsing; required for turn removal |
| `chatwizard.sharedCacheDir` | `""` | Share the cache, metadata, log-event store and archive across VS Code / Cursor / Windsurf (default: `%LOCALAPPDATA%\ChatWizard`, `~/Library/Application Support/ChatWizard`, `~/.local/share/chatwizard`) |
| `chatwizard.logLevel` | `"INFO"` | Output-channel verbosity: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `chatwizard.enableTelemetry` | `false` | Write local-only usage events to a JSONL file in extension storage (never transmitted) |

### Sources

Every source has an on/off toggle; most have a path override. Empty path = platform default.

| Source | Toggle | Path override |
|--------|--------|---------------|
| GitHub Copilot | `chatwizard.indexCopilot` | `chatwizard.copilotStoragePath` |
| Claude Code | `chatwizard.indexClaude` | `chatwizard.claudeProjectsPath` |
| Cline | `chatwizard.indexCline` | `chatwizard.clineStoragePath` |
| Roo Code | `chatwizard.indexRooCode` | `chatwizard.rooCodeStoragePath` |
| Cursor | `chatwizard.indexCursor` | `chatwizard.cursorStoragePath` |
| Windsurf | `chatwizard.indexWindsurf` | `chatwizard.windsurfStoragePath` |
| Aider | `chatwizard.indexAider` | `chatwizard.aiderSearchRoots` (array), `chatwizard.aiderSearchDepth` (default `3`) |
| Google Antigravity | `chatwizard.indexAntigravity` | `chatwizard.antigravityBrainPath` |
| Continue.dev | `chatwizard.indexContinue` | `chatwizard.continueStoragePath` |
| Amazon Q Developer | `chatwizard.indexAmazonQ` | `chatwizard.amazonQStoragePath` |
| Gemini Code Assist | `chatwizard.indexGeminiCodeAssist` | `chatwizard.geminiCodeAssistStoragePath` |
| Tabnine | `chatwizard.indexTabnine` | _(auto-discovered)_ |

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.indexChronicle` | `true` | Enrich Copilot sessions with Chronicle checkpoint summaries (requires `indexCopilot`) |
| `chatwizard.chronicle.enableLocalIndex` | `true` | Auto-enable Copilot's `chat.localIndex.enabled`, needed for branch data |

### Search

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.enableSemanticSearch` | `true` | Topic-similarity search with the local embedding model |
| `chatwizard.semanticMinScore` | `0.35` | Similarity threshold (0–1); lower = more results |
| `chatwizard.semanticModelPath` | `""` | Local model folder — skips the download entirely |
| `chatwizard.semanticModelMirror` | `""` | Mirror host (e.g. `https://hf-mirror.com`) when huggingface.co is blocked |
| `chatwizard.mcp.reranker.enabled` | `true` | TF-IDF rerank of `chatwizard_get_context` results |
| `chatwizard.workItemPattern` | `""` | Regex that extracts work-item IDs (e.g. `[A-Z]+-\d+`, `AB#\d+`, `#\d+`) |

### Knowledge Base

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.kbAutoTagSessions` | `true` | Add `kb-category:` / `kb-group:` tags to classified sessions |
| `chatwizard.kbRefineLabels` | `true` | Second LLM pass that merges near-duplicate category labels |


### Watch logs (Commands panel)

The Commands panel has no separate enable flag: it reuses the source toggles above (Copilot, Cline / Roo Code, Aider, Windsurf). Events are stored in `chatwizard-log-events.db` next to the session cache.

### MCP server

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.mcpServer.enabled` | `false` | Start the local MCP server |
| `chatwizard.mcpServer.port` | `6789` | Listening port (restart required) |
| `chatwizard.mcpServer.allowTokenRotation` | `false` | Permit **Chat Wizard: Rotate MCP Token** |

### REST API & Cloud Sync

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.restApi.enabled` | `false` | Start the read-only REST API |
| `chatwizard.restApi.port` | `6790` | REST port (must differ from the MCP port) |
| `chatwizard.restApi.enableDocs` | `true` | Serve the endpoint documentation at `/` |
| `chatwizard.cloudSync.enabled` | `false` | Encrypted backup of the session index and cache DB |
| `chatwizard.cloudSync.type` | `"gist"` | Cloud backend (`gist` is the only implemented one) |

### Archive & retention

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.archive.maxAgeDays` | `0` | Prune archived sessions older than N days (`0` = off) |
| `chatwizard.archive.maxSizeMB` | `0` | Cap the archive size, oldest first (`0` = off) |
| `chatwizard.sessionRetentionDays` | `0` | Hide sessions older than N days from the UI (`0` = off) |
| `chatwizard.semanticIndexMaxAgeDays` | `365` | Keep old sessions out of the embedding index only |

### Tagging & File History

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.activeSessionWindowMinutes` | `120` | Look-back window for the “tag the active session” button |
| `chatwizard.codeLens.enabled` | `true` | Show “N ChatWizard sessions touched this file” CodeLens |

### Appearance

| Setting | Default | Description |
|---------|---------|-------------|
| `chatwizard.userMessageColor` | `#007acc` | Accent colour for user message borders and labels |
| `chatwizard.codeBlockHighlightColor` | `#EA5C00` | Highlight when jumping to a code block (blank = disabled) |
| `chatwizard.scrollToFirstCodeBlock` | `true` | Auto-scroll to the first code block when opening from Code Blocks |
| `chatwizard.tooltipLabelColor` | `""` | Label colour in session hover tooltips (blank = theme default) |
| `chatwizard.didYouKnowInterval` | `600` | Seconds between 🐿️ nudges (`0` = disabled) |

---


## Commands Reference

The palette stays deliberately short: **seven category commands** each open a QuickPick, plus the handful of standalone commands listed below. Everything else — per-field sort buttons, grouping toggles, paging, tag / folder / archive actions and the Commands-panel row actions — lives in the view toolbars and context menus, so the palette never grows into a wall of near-identical entries. Commands that need a session use the row currently selected in the Sessions panel when you run them from the palette.

### Command-palette groups

Each of the seven category commands opens a QuickPick with these actions:

| Group | Actions inside |
|-------|----------------|
| **Chat Wizard: View…** | Code Blocks · Prompt Library · Analytics Dashboard · Timeline |
| **Chat Wizard: Search…** | Full-Text Search · Search Annotations · Find Sessions by Topic (Semantic) |
| **Chat Wizard: Filter & Sort…** | Filter Sessions… · Configure Sort Order… · Filter Code Blocks… |
| **Chat Wizard: Session…** | Set Session Status… · Filter by Status… · Add/Remove Bookmark… · Add/Remove/Clear Tags · Tag Active Session · Regenerate Title · Regenerate All Titles · Regenerate Summary · Pin/Unpin · Group Sessions… · Inject as Context… · Reveal in Explorer · Add Annotation… · Generate Digest |
| **Chat Wizard: Export…** | Export All Sessions… · Export Selected Sessions… · Export Session Excerpt… · Export Session to Markdown · Export Selected from Tree… · Export to Obsidian · Export to Notion · Forget Notion API Key |
| **Chat Wizard: Folder & Archive…** | Create Folder · Create Subfolder · Rename Folder · Delete Folder · Move Session to Folder… · Archive Session · Delete Archived Session · Show Archive Statistics |
| **Chat Wizard: Settings…** | Manage Watched Workspaces · Rescan Sessions · Start MCP Server · Stop MCP Server · Copy MCP Config to Clipboard · Rotate MCP Token · Set Up Global Copilot Instructions · Connect GitHub Copilot · Show File Session History |

### Standalone palette commands

| Command | What it does |
|---------|--------------|
| **Chat Wizard: Configure AI Model Source…** | Pick a local model folder or a mirror host |
| **Chat Wizard: Retry Loading the AI Model** | Retry after fixing the network/proxy |
| **Chat Wizard: Reset AI Model Cache** | Discard a corrupt or partial model download |
| **Chat Wizard: Rotate MCP Token** | Invalidate the old MCP token and issue a new one |
| **Chat Wizard: Generate Digest** | Build a standup/PR draft for today, this week or this sprint |
| **Chat Wizard: Share Session** | Export one session as a self-contained HTML file |
| **Chat Wizard: Link Session** / **Unlink Session** | Manage bidirectional session links in the metadata store |
| **Chat Wizard: Show Terminal Commands** | Open the Commands panel on the terminal-command section |
| **Chat Wizard: Show LLM Tool Calls** | Open the Commands panel on the tool-call section |
| **Chat Wizard: Show Unified Timeline** | Open the Commands panel on the timeline section |
| **Chat Wizard: Show Diff Explorer** | Open the Commands panel on the changes section |
| **Chat Wizard: Filter Unified Timeline…** | Restrict the timeline to one event kind |
| **Chat Wizard: Run in Terminal** | Re-run a captured command |
| **Chat Wizard: Refresh Commands** | Refresh every Commands section |
| **Chat Wizard: Show Details for Selection** | Open the shared detail window for the selected row |
| **Chat Wizard: Filter Agent Logs…** | Open the log filter menu (search, agent, failures, clear) |
| **Chat Wizard: Search Agent Logs…** | Free-text filter over every log facet |
| **Chat Wizard: Filter Agent Logs by Agent…** | Restrict to one AI tool |
| **Chat Wizard: Show Failures Only** | Toggle failed commands / tool calls / errors |
| **Chat Wizard: Clear Agent Log Filters** | Reset all Commands filters |
| **Chat Wizard: Show Agent Log Stats** | Markdown report with totals, success rate and per-agent/per-session breakdowns |

### Context-menu and toolbar actions

These stay out of the palette because they act on the item you are pointing at:

| Area | Actions |
|------|---------|
| Session context menu | Pin/Unpin · Export to Markdown · Export Selected… · Inject as Context… · Reveal in Explorer · Archive Session · Delete Archived Session · Add/Remove Tag · Regenerate Summary · Regenerate Title(s) · Set Session Status… · Add/Remove Bookmark… · Move Session to Folder… |
| Session title bar | Filter Sessions · Group Sessions… · Configure Sort Order · per-field sort buttons · Export All · Export Selected · Create Folder · Filter by Status |
| Code Blocks title bar | Filter Code Blocks · Group/Ungroup · sort by Date / Workspace / Length / Session Title / Language |
| Commands title bar | Refresh Commands · Filter Agent Logs… · Show Details for Selection |
| Logs row menus | Copy · Open Session · Show Details · Run in Terminal · Open Visual Diff · Open Patch · Copy Change · Open File |

### Sort variants

Each sort button cycles `command` → `.asc` → `.desc`:

- Sessions: `chatwizard.sortByDate`, `sortByWorkspace`, `sortByLength`, `sortByTitle`, `sortByModel`
- Code Blocks: `chatwizard.cbSortByDate`, `cbSortByWorkspace`, `cbSortByLength`, `cbSortByTitle`, `cbSortByLanguage`
- Grouping toggles: `chatwizard.enableSessionGrouping` / `disableSessionGrouping`, `enableCbGrouping` / `disableCbGrouping`

---

## Quick Reference

| I want to… | Do this |
|------------|---------|
| Search past sessions by keyword | `Ctrl+Shift+P` → **Chat Wizard: Search… → Full-Text Search** (prefix `/` for regex) |
| Search by meaning instead of words | **Chat Wizard: Search… → Find Sessions by Topic (Semantic)** |
| Find a snippet the AI wrote | **Code Blocks** panel → filter by language → click the block |
| Reuse a past prompt | **Prompt Library** → search → copy (or open the cluster's variant) |
| See every command/tool call/diff the agent ran | **Commands** panel (or `Chat Wizard: Show Terminal Commands`) |
| Re-run a captured command | Commands → row → **Run in Terminal** |
| Compare a captured change | Commands → **Diff Explorer** → **Open Visual Diff** |
| Tag the session I am in right now | Status bar **Tag session**, `Chat Wizard: Tag Active Session`, or `@chatwizard /tag #label` |
| See which sessions touched a file | Right-click the file → **Show File Session History** |
| Group sessions by branch / ticket / tag / folder | Sessions toolbar → **Group Sessions…** |
| Hide noise from a long conversation | Open it → select a turn → **⊗** (or right-click → **Remove turn**) |
| Quote a specific turn in a new chat | Hover the turn → **⧉**, then `@chatwizard /referMessage P3` |
| Return to a specific message later | Hover it → **★**; use the **★ Bookmarks** jump list |
| Add my own note to a turn | Hover it → **📝**; find notes with **Search Annotations** |
| Bookmark / annotate from the palette | Select the session, then **Session… → Add Bookmark… / Add Annotation…** |
| See token usage and top models | **Analytics** and **Model Usage** panels |
| Write my standup | **Chat Wizard: Generate Digest** |
| Build a knowledge base of decisions | **Knowledge Base** panel → **Generate Knowledge Base** → Export |
| Share a conversation readably | **Chat Wizard: Share Session** (single, self-contained HTML) |
| Move sessions into another tool | **Export…** → Export All / Selected / Obsidian / Notion |
| Give Copilot / Claude my history | Enable the MCP server → **Copy MCP Config** → paste into the client |
| Ask Copilot using my history without MCP | `@chatwizard /queryHistory <question>` |
| Back up my history | `chatwizard.cloudSync.enabled` + `CHATWIZARD_GITHUB_TOKEN` |
| Query history from a script | `chatwizard.restApi.enabled` → `GET /v1/sessions/search` |
| Rebuild everything from scratch | **Chat Wizard: Settings… → Rescan Sessions** |
| Only index recent sessions | `chatwizard.oldestSessionDate` (or `chatwizard.sessionRetentionDays` to hide old ones) |


---

## Known Limitations

- **Token counts are estimates** — characters ÷ 4 for Claude/Gemini-style sessions, words × 1.3 for GPT-style sessions. They will not match provider billing.
- **Copilot session parsing** replays an append-only operation log; very large sessions can take a little longer on the first index build (the SQLite cache makes later starts instant).
- **Claude Code epoch/empty sessions** (created 1970-01-01, or with zero messages) are skipped, matching Claude Code's own placeholder behaviour.
- **Cursor and Windsurf** keep chats in private SQLite schemas that can change in any release; a future IDE update may require a matching Chat Wizard update. They are read through a native driver with a WASM fallback, so no local rebuild is required.
- **Knowledge Base quality depends on an LLM.** In VS Code it uses the free Copilot LM API; where no free model is available (e.g. Cursor) it falls back to embedding/heuristic classification, which is noticeably coarser.
- **Semantic search needs its model** (~22 MB, downloaded once). Without it, keyword search, the tree, analytics and the MCP keyword tools keep working; only similarity search is disabled.
- **The search-panel source filter** cycles through Copilot, Claude, Antigravity, Cursor, Cline, Roo Code, Windsurf and Aider. Sessions from the other sources are still searched under *All*.
- **Removing turns requires the persistent cache** (`chatwizard.enablePersistentCache`, default on), because both the removal and the archived original live in the chat database.
- **HTML sharing is single-session** and always includes code blocks — there is no per-block redaction step.
- **Cloud Sync ships with GitHub Gist only**; S3 and Azure Blob are interfaces waiting for an implementation.
- **Zed AI is not indexed yet** — a parser exists in the codebase, but ingestion is not wired up.
- **Session linking** stores bidirectional links in the metadata but has no reader/panel surface yet: no badge to click, and the Obsidian export does not emit them. Treat it as groundwork for a future UI.

## Feedback

Found a bug or missing documentation? [Open an issue](https://github.com/veverke/chatwizard/issues) — every report is read. A [two-minute survey](https://forms.gle/Mj4JtMsYLdxQds1R6) also shapes what gets built next.

**The survey prompt** appears once a day at most, 30 minutes after the extension activates, with **Take it**, **Already taken** and **Later** actions. Choosing *Already taken* stops it permanently on that machine.

