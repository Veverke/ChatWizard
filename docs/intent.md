# ChatWizard — Extension Intent & Planned Features

## Target Audience

Developer-power-users who actively use **GitHub Copilot Chat** and/or **Claude Code** inside VS Code and want to search, browse, and analyse their accumulated conversation history across projects.

Both extensions are first-class, equal targets — every feature must work for Copilot Chat sessions, Claude Code sessions, or both simultaneously.

---

## Problem Statement

VS Code AI chat extensions (GitHub Copilot Chat, Claude Code) accumulate large amounts of conversation history that is:

- Not searchable across sessions
- Not searchable within a session (no Ctrl+F equivalent in chat panels)
- Scattered across multiple workspaces with no unified view
- Effectively lost over time — developers cannot find prompts or responses they recall having

## Approach

AI chat extensions write session data to disk as structured files. Rather than attempting to scrape or inject into chat UI panels (which are sandboxed webviews inaccessible to other extensions), this extension reads that data directly from the file system and builds a unified search index over it.

### Data Sources

| Source | Location | Format |
|---|---|---|
| GitHub Copilot Chat (per workspace) | `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` | JSONL operation log |
| Copilot session index | `%APPDATA%/Code/User/workspaceStorage/<hash>/state.vscdb` | SQLite |
| Copilot workspace mapping | `%APPDATA%/Code/User/workspaceStorage/<hash>/workspace.json` | JSON |
| Claude Code sessions | `~/.claude/projects/**/*.jsonl` | JSONL |

Sessions are watched live via `FileSystemWatcher` so the index stays current as conversations happen.

---

## Goals

1. Make accumulated AI chat history searchable and useful
2. Distinguish between what the **user asked** and what the **LLM answered**
3. Surface usage analytics and token consumption across sessions
4. Provide export to structured Markdown for navigation via VS Code Outline

---

## Planned Features

### 1. Unified Search

Full-text search across all sessions, all workspaces, all supported chat extensions. Triggered via `Ctrl+Shift+H`.

- **1.1** Identify sessions/messages where the user's **prompt** contains the search term
- **1.2** Identify sessions/messages where the **LLM response** contains the search term
- Results show: source icon ($(github) / $(hubot)), session title, workspace, date, and a content snippet prefixed with role ("You:  …" or "Claude:  …" / "Copilot:  …")
- Match position highlighted within the snippet (explicit range highlight — not just fuzzy)
- **Source filter button**: cycle through All / Copilot only / Claude only with a distinct icon for each state
- **Message-type filter button**: cycle through All / Prompts only / Responses only with a distinct icon for each state
- **Regex support**: prefix the query with `/` to enable regex mode (e.g. `/refactor.*class`)
- Debounced live search (300 ms) — results stabilise after typing stops

---

### 2. Session Management Panel

A VS Code TreeView listing all sessions across all workspaces.

**Tree items:**
- Session title, source icon (GitHub Copilot or Claude Code), workspace, date, message count, file size in KB
- Hover tooltip: Title, Source, Model, Workspace, Updated, Size, prompt/response counts, pinned status
- Click to open the session reader view

**Sorting:**
- Sort by: Date, Workspace, Session Length, Title (A–Z), AI Model, Source
- Direction toggle: each sort button shows ↑ or ↓; clicking toggles direction
- Composite sort: "Configure Sort Order" picker lets the user define up to 3 sort criteria in priority order
- Sort stack persists across VS Code restarts

**Filtering:**
- Filter visible sessions by: title substring, date range, model substring, min/max message count
- Active filters displayed in the tree subtitle alongside the sort description
- Filter dialog accessible from the toolbar filter button

**Pinning & reordering:**
- Right-click any session → "Pin Session": locks it at the top of the list with a 📌 pin icon
- Right-click a pinned session → "Unpin Session" to restore sort order
- Pinned sessions persist across VS Code restarts
- Drag-and-drop to manually reorder items within the tree

**Session reader view (Webview):**
- Full Markdown rendering: headings (H1–H6), bold, italic, strikethrough, inline code, fenced code blocks with language labels, pipe tables, 4-space indented code blocks, blockquotes, ordered/unordered lists, horizontal rules, links
- User messages visually distinguished from AI responses (accent color configurable)
- Aborted/cancelled response placeholder when a user turn has no following AI reply
- Loading spinner while HTML is being built
- Empty messages filtered before display

**Extension settings:**
- `chatwizard.userMessageColor` — accent color for user message border and label (color picker in Settings UI, default `#007acc`)
- `chatwizard.tooltipLabelColor` — color for tooltip field label text (Title:, Source:, etc.), leave blank for theme default

---

### 3. Code Block Extraction

Index all fenced code blocks across all sessions.

- Filterable by language (TypeScript, Python, bash, etc.)
- Searchable by content
- One-click copy to clipboard
- Shows originating session and date
- Solves the common problem of losing useful snippets the AI generated

---

### 4. Prompt Library

Extract every user-turn prompt across all sessions.

- Deduplicated and clustered by similarity
- Searchable
- Copy to clipboard for re-use in any chat window
- Shows frequency — surfaces prompts asked repeatedly across sessions

---

### 5. Export to Markdown

Export any session or set of sessions to a `.md` file.

- H2 per user prompt, H3 per AI response
- Code blocks preserved with language labels
- VS Code Outline panel provides immediate navigation by prompt/response heading
- This is the primary "navigation" workaround given no control over the original chat UI

---

### 6. Analytics / Usage Stats

Aggregate statistics computed from the session index.

**Session-level metrics:**
- Total sessions, prompts, responses per workspace
- User prompt count / LLM response count per session
- **Token count per session** — computed client-side using the same BPE tokenizer the chat extensions ship locally (`js-tiktoken` for Copilot/GPT models, `@anthropic-ai/tokenizer` for Claude)
- Tokens broken down by: user prompts vs. LLM responses
- Longest sessions by message count and token count

**Aggregate metrics:**
- Activity over time (sessions/prompts per day, week, month)
- Daily/weekly/monthly token usage totals
- Most active projects
- Most frequent terms in user prompts
- Useful for tracking consumption against plan rate limits

---

### 7. Duplicate / Similar Prompt Detection

Identify prompts that are semantically equivalent across sessions.

- Basic TF-IDF or trigram similarity (no ML dependency required)
- "You asked something equivalent to this N times across M projects"
- Helps users consolidate knowledge and avoid redundant prompting

---

### 8. Timeline View

Chronological feed of all sessions across all workspaces.

- "What was I working on last Tuesday?"
- Each entry: project, session title, first prompt, message count

---

## Out of Scope

The following were considered and ruled out:

- **Ctrl+F / find within Copilot or Claude chat panels** — chat UIs are sandboxed webviews; cross-extension DOM access is not possible
- **Highlighting or annotating within the original chat UI** — same reason; no access to the rendering context
- **Injecting context menus into other extensions' webviews** — not supported by VS Code's extension API
- **Cloud sync or external data transmission** — all processing is local; no data leaves the machine

---

## Architecture Notes

- All session data remains on the local file system; the extension only reads, never writes to source files
- `FileSystemWatcher` provides live updates as sessions are written during active chats
- Copilot JSONL files are append-only operation logs (not snapshots) and require log replay to reconstruct conversation state
- Token counting uses the tokenizer vocab files already present on disk from the Copilot Chat extension installation
