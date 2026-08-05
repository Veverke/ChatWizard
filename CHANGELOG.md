# Change Log

## [1.6.0] - 2026-08-05

### Knowledge Base (Feature 23)

> **Note:** KB generation requires a populated session index — run `ChatWizard: Generate Knowledge Base` from the KB dashboard panel after the extension has fully loaded.

- **`ChatWizard: Generate Knowledge Base`** — classifies all indexed sessions into Decision / Learning / Pattern / Gotcha / Architecture types using local heuristics (no LLM call). Clusters by tag (primary) and embedding similarity (fallback). Generates a structured knowledge-base dashboard with doughnut chart, drill-down table, and export.
- **KB dashboard webview** — sidebar and full-panel views showing per-type distribution, drill-down into individual entries, and a Generate / Regenerate button.
- **Two-tier classifier** — heuristic-based (`KbClassifier`) as the primary engine, with an LLM-based fallback (`KbLlmClassifier`) for sessions where heuristics are inconclusive. Configurable via `chatwizard.kb.useLlmFallback` (default: `true`).
- **Markdown export** (`KbExporter`) — KB entries are emitted as Obsidian-compatible Markdown with YAML frontmatter, per-chapter organization, and a `locked: true` flag to preserve user edits on re-generation. Incremental runs append new entries; existing locked entries are never overwritten.
- **`@chatwizard /generateKB`** slash command — triggers KB generation from the chat panel.
- **Auto-classify on startup** — a background job runs classification after the initial batch of sessions is loaded, so the KB dashboard is populated without manual action.

### SQLite Persistent Cache (Feature 24)

- **`chatwizard.enablePersistentCache`** setting (default: `true`) — replaces the purely in-memory session index with a local SQLite store (`chatwizard-cache.db`). Sessions are parsed once; all subsequent startups load from the cache, dramatically reducing cold-start latency for power users (10K+ sessions).
- **FTS5 full-text search** — ranked BM25 search via SQLite FTS5 virtual table replaces the in-memory substring scan with relevance-ranked results, at zero additional code.
- **Incremental parsing** — byte-offset-aware JSONL parsing only re-reads changed files; unchanged sessions load from cache in under 200ms.
- **`chatwizard.sharedCacheDir`** setting — share the SQLite cache across IDEs (VS Code, Cursor, Windsurf) by pointing to a common directory outside any single IDE's app-data.
- **Cache health diagnostics** — structured logging of cache hit rates, session counts, and schema version at startup. A corrupt DB is silently discarded; the extension falls back to full re-parse without crashing.
- Cache-backed archive restoration and cloud sync both automatically use the cached session index.

### Workspace Digest / Standup Reports (Feature 26)

- **`ChatWizard: Generate Digest`** command — produces a copy-pasteable standup or PR description from your session timeline. Supports three time windows: Today, This Week, and This Sprint.
- **Sidecar summary integration** — AI-generated session summaries (Feature 18) are included in the digest output when available, providing richer, more contextual daily reports.
- Output opens in a new editor tab as Markdown; ready to paste into Slack, Jira, or GitHub PR descriptions.

### Session Status, Bookmarks, Annotations & Linking (Features 28–31)

- **Session Status lifecycle** — right-click any session → **Set Session Status** to mark it as `Open`, `Resolved`, or `Revisit`. Status badges appear inline in the session tree. The **Filter Sessions…** dialog includes a "Filter by Status" option.
- **Bookmarks** (`Feature 29`) — mark specific messages within a session for quick navigation. Right-click → **Add Bookmark** (with optional note). Session reader scrolls to and highlights bookmarked messages.
- **Inline Annotations** (`Feature 30`) — attach a personal note to any session (`ChatWizard: Add Annotation` / `Remove Annotation`). Annotations are stored in sidecar metadata and displayed in the session reader.
- **Session Linking** (`Feature 31`) — explicitly link two sessions (bidirectional) to create a conversation graph. Right-click → **Link Session** shows a QuickPick of all indexed sessions. Linked sessions are surfaced in the session reader header for forward/backward navigation.
- **Response Rating** (`Feature 32`) — per-response thumbs-up/thumbs-down stored in sidecar metadata. Search results can be filtered to only highly-rated responses.

### Duplicate & Related Session Detection (Feature 33)

- **`DuplicateDetector`** — detects when the same conversation was split across sessions (e.g. Claude vs. Cursor for the same task). Uses TF-IDF content similarity (threshold: 0.7 cosine) and metadata heuristics (same title prefix, same start time window).
- Duplicates are flagged in the session tree with a `· duplicate` badge. The analytics panel excludes duplicates from session counts for more accurate metrics.

### Outcome / Follow-Up Tracking (Feature 34)

- **Action item extraction** (`ActionItemExtractor`, `ActionItemLlmExtractor`) — after session indexing, a background job scans session content for action items, decisions, and follow-up tasks using keyword heuristics and an optional LLM pass.
- **`ActionItemVerifier`** — LLM-based verification pass checks whether extracted action items are genuine (no false positives from code blocks or documentation text).
- Action items appear in the session reader as a collapsible "Action Items" section with checkbox state persisted in sidecar metadata.

### Session Sharing (Feature 36)

- **`ChatWizard: Share Session`** — export any session as a standalone HTML bundle. The HTML file is fully self-contained (inline CSS, no external dependencies) and renders the full conversation with source badges, tags, and annotations — no ChatWizard installation required for the recipient.
- Accessible via right-click → **Share Session** on any tree item, or the Command Palette with a session ID prompt.

### Session Retention Controls (Feature 43)

- **`chatwizard.sessionRetentionDays`** — suppress sessions older than N days from all surfaces (tree, search, analytics) without deleting source files. Default: `0` (no limit).
- **`chatwizard.semanticIndexMaxAgeDays`** — exclude old sessions from the semantic search index only (keeps the embedding vector store lean). Default: `365` days.
- Both settings take effect on next reload; pruning runs at startup and applies to all loaded sessions.

### REST API Server (Feature 44)

- **`chatwizard.restApi.enabled`** setting (default: `false`) — exposes a read-only REST API on a configurable port (`chatwizard.restApi.port`, default `6790`), independent of the MCP server. Enables external scripts, dashboards, and CI/CD to query the session index without VS Code being open.
- **Swagger UI** — enabled via `chatwizard.restApi.enableDocs` (default: `true`). Browse and test all endpoints at `http://localhost:{port}/docs/`.
- Endpoints: `GET /sessions` (list with pagination), `GET /sessions/:id`, `GET /sources`, `GET /stats`, `GET /search?q=…`, `GET /health`.
- Uses the same bearer token as the MCP server for authentication.

### Cloud Sync (Feature 27)

- **`chatwizard.cloudSync.enabled`** setting (default: `false`) — optional encrypted sync of the session index to the user's own cloud backend. Key is derived locally; the cloud provider never sees plaintext session content.
- **`chatwizard.cloudSync.type`** — supports `gist` (GitHub Gist) backend. Additional backends can be added by implementing the `CloudBackend` interface.
- **DB backup sync** — the SQLite cache DB is also backed up to the same cloud backend, providing a full restoration point.
- API key stored in VS Code `SecretStorage` — never in `settings.json`.

### Folder Organisation

- **`ChatWizard: Create Folder`** — create named folders to organize sessions into a custom hierarchy. Supports subfolders and drag-and-drop assignment.
- **`Group by Folder` mode** — a new group mode in the Sessions panel toolbar that organizes sessions by their folder assignment. Sessions not assigned to any folder appear under `(uncategorized)`.
- **Drag-and-drop** — drag sessions onto folders to assign them; drag folders into other folders to create nested hierarchies. Context menu commands: Rename Folder, Delete Folder (sessions move to uncategorized), Move Session to Folder.
- Persisted to `chatwizard-folders.json` in `globalStorageUri`; survives window reloads and shares between VS Code and compatible IDEs.

### Command Palette Groups

- Five top-level category commands declutter the `Ctrl+Shift+P` palette: **Sessions**, **Search & Discovery**, **Analytics & KB**, **Export**, and **Server**. Each opens a QuickPick sub-menu that delegates to the underlying leaf command.
- All leaf commands remain fully accessible via toolbar buttons, context menus, and keyboard shortcuts — only the flat command palette is condensed.
- Contributed via `src/commands/paletteCommands.ts` and `src/commands/paletteCommandsData.ts`.

### "Did You Know" Nudge

- The squirrel mascot (`BrandingStatusBarItem`) now cycles through section headings from `docs/user-guide.md` at a configurable interval (`chatwizard.didYouKnowInterval`, default 300 seconds).
- Clicking the nudge opens the corresponding section in the user guide. The nudge list deduplicates headings and skips TOC entries.
- Configurable via `chatwizard.didYouKnowEnabled` (default: `true`).

### Cross-Instance Embedding Safety

- A global lock file (`semantic-embeddings.lock`) in `globalStorageUri` serializes bulk embedding across multiple VS Code instances. Prevents two windows from simultaneously rebuilding the same embedding file and corrupting the vector store.
- Lock timeout: 30 seconds. If another instance holds the lock, the second instance skips the bulk rebuild and uses the existing embeddings.

### Performance & Robustness

- **Faster embedding vector loading** — the `SemanticIndexer` now loads pre-built embedding files directly from disk instead of re-indexing on every startup. Cache-hit path completes in under 500ms for 5K+ sessions.
- **Disappearing-chat fix** — file-watcher notifications are now debounced at the file-system level, preventing transient rename/create events from removing sessions from the index.
- **Coverage gate** — CI enforces ≥90% line coverage across all modules. Several uncovered paths were brought up to threshold.
- **Code quality** — 5 Copilot PR review recommendation batches applied across scalability, archive, tagging, and KB subsystems.

---

## [1.5.0] - 2026-05-25

### Three new AI tool sources

- **Continue.dev support** — indexes conversations stored by the Continue.dev extension at `~/.continue/sessions/` (all platforms). Configurable via `chatwizard.indexContinue` / `chatwizard.continueStoragePath`.
- **Amazon Q Developer support** — indexes Amazon Q Developer chat sessions. Platform-aware path discovery for Windows, macOS, and Linux. Configurable via `chatwizard.indexAmazonQ` / `chatwizard.amazonQStoragePath`.
- **Gemini Code Assist support** — indexes conversations from the Google Gemini Code Assist VS Code extension. Fully distinct from the existing Antigravity source; path discrimination prevents cross-contamination. Configurable via `chatwizard.indexGeminiCodeAssist` / `chatwizard.geminiCodeAssistStoragePath`.
- All three new sources participate fully in full-text search, prompt library, code block extraction, analytics, model usage, timeline, source filtering, session archive, and the MCP server.

### Chronicle Phase 3 — File-Centric History

- **File History status bar** — when Chronicle data is populated, the status bar shows `$(comment) N sessions` for the active file. The item is hidden when the file has no history. Clicking it opens the new **File History panel** listing sessions that touched the file with dates, source badges, and summaries.
- **File History CodeLens** — a `$(history) N ChatWizard sessions touched this file` lens at the top of files with Chronicle history. Gated behind `chatwizard.codeLens.enabled` (default: `true`).
- **Explorer context menu** — right-click any file → **ChatWizard: Show File History** opens the File History panel. Also available from the editor tab context menu.
- **`chatwizard_sessions_for_file` MCP tool** — new MCP tool returning sessions that touched a given file; accepts both absolute paths and workspace-relative paths.
- **Path normalisation utility** (`pathNormaliser.ts`) — handles Windows drive letters, mixed slash styles, and trailing slashes; shared by the status bar, CodeLens, and MCP tool.

### Chronicle Phase 4 — Branch & Work Item Grouping

- **By Branch / By Work Item group modes** — the Sessions panel toolbar now includes two additional group-by modes alongside the existing date grouping. Sessions with no branch are grouped under `(no branch)`; unmatched sessions under `(unassigned)`.
- **`chatwizard.workItemPattern`** setting — configure a regex to extract work-item IDs from branch names and commit messages (e.g. `[A-Z]+-\d+` for Jira, `AB#\d+` for Azure DevOps, `#\d+` for GitHub Issues). Invalid regex values surface a warning notification without crashing.
- **`chatwizard_sessions_for_branch` MCP tool** — returns sessions on a specific git branch (case-insensitive match).
- **`chatwizard_sessions_for_work_item` MCP tool** — returns sessions whose branch or commit matches the work-item pattern and extracted ID. Returns a structured `{ error: "NO_PATTERN" }` (not a thrown exception) when `chatwizard.workItemPattern` is not configured.

### Session Archive

- Every indexed session is mirrored to ChatWizard's own local storage (`globalStorageUri/archive/`). When a source tool prunes its history, ChatWizard continues serving those sessions from its own copy — labelled `· archived` in the tree with a tooltip explaining the source is unavailable.
- Strategy A (file-per-session sources — Copilot, Claude, Cline, Roo Code, Aider, Antigravity, Continue.dev): raw file bytes are archived after a successful parse; updated on each watcher event.
- Strategy B (SQLite sources — Cursor, Windsurf): session JSON is archived after each parse; restored directly without re-running the parser.
- **`ChatWizard: Show Archive Statistics`** command — shows total archived sessions, total bytes, and oldest archived date.
- **`Archive Session`** / **`Delete Archived Session`** context menu actions on session tree items.
- Pruning settings (both default to `0` = disabled): `chatwizard.archive.maxAgeDays` (remove sessions older than N days) and `chatwizard.archive.maxSizeMB` (cap total archive size, removing oldest first). Pruning runs at startup after archive-only sessions are loaded.

### Session Tagging

- **Add / remove tags** via right-click → **Add Tag…** or **Remove Tag…** on any session tree item. Tags are freeform (`#bugfix`, `topic:auth`, `kind:decision`); comma-separated input is split and normalised (lowercased, leading `#` stripped for storage, restored on display).
- **Tag chips in tree and reader** — up to 3 chips shown inline in the session tree item description; overflow displayed as `+N more`. Tags also appear in the session reader header alongside the source badge and date.
- **Tag filter** — the existing **Filter Sessions…** command (`chatwizard.filterSessions`) now includes a "Filter by tags" option.
- **`ChatWizard: Tag Active Session`** command — targets the session being actively written without requiring navigation to the history tree. A `$(tag) Tag session` status bar button appears while a session is live (within `chatwizard.activeSessionWindowMinutes`, default 120) and disappears when the session goes idle.
- **`@chatwizard /tag`** — type `/tag label1, label2` in the Copilot Chat panel to tag the active session inline and receive a confirmation message. **`@chatwizard /removeTags`** removes tags the same way.
- Pin state migration — existing pinned sessions are migrated to the new `chatwizard-metadata.json` store on first run; no manual action required.

### AI-Generated Session Summaries _(Beta)_

> **Beta:** end-to-end testing is incomplete. The feature is functional but may exhibit edge cases with very large indexes or unusual session content. Feedback welcome.

- Every session now displays a one-line auto-generated summary as the tree-item tooltip and as a paragraph in the session reader header. Generation is fully transparent: the background job runs after indexing finishes and never blocks startup or navigation.
- Three-tier generation strategy (tried in order):
  1. Chronicle `checkpoints.overview` — free, instant, no LLM call.
  2. VS Code LM API (Copilot subscription) — cheapest available model, one-shot prompt (`"Summarise this coding session in one sentence, max 15 words"`). Max 5 concurrent calls; rate-limited.
  3. TF-IDF keyword heuristic — fully offline fallback; works without a Copilot subscription. LM API errors are never surfaced as user notifications.
- **Regenerate Summary** context menu action re-clears and re-generates the summary for a specific session.

### Entity Extraction from Sessions _(Beta)_

> **Beta:** end-to-end testing is incomplete. Regex-based extraction may produce false positives on sessions that contain large pasted code blocks. Feedback welcome.

- After indexing, a background job extracts structured entities from session content: **file paths**, **function/class names**, **error codes**, and **decision phrases**. Extraction is fully offline and stored in `chatwizard-metadata.json` with a version field — bumping the extractor version invalidates cached results.
- **Entity chips in the session reader** — a collapsible "Entities" section shows auto-extracted chips (distinct visual style from user tags). File path chips are clickable and open the file in the editor.
- **Entity-filtered MCP search** — `chatwizard_search` now accepts optional `entityType` (`"filePaths"` | `"functionNames"` | `"errors"` | `"decisions"`) and `entityValue` parameters; sessions not containing the entity are excluded before full-text scoring.

### Prompt Cost Analysis

- **`@chatwizard /analyzePrompt <draft prompt>`** — new chat participant command that analyzes a draft prompt **without any LLM calls**. Returns:
  - Token count and estimated cost (input + output) at current GPT-4o and Claude Sonnet rates.
  - Similarity check against your chat history — warns if you've asked something very similar before, with a link to the past session.
  - Quality flags: large pasted code block (suggest referencing the file by path), open-ended scope (`list all`, `explain everything`), multiple questions in one prompt.
  - Model suggestion when a cheaper model (e.g. GPT-4o mini, Claude Haiku) would be sufficient.
- **`ChatWizard: Analyze Selected Prompt`** — select any text in any editor, right-click → **Analyze Selected Prompt** (or Command Palette). Results appear in an information message with a "View Details" link that opens a full analysis webview.
- Price table (`modelPriceTable.ts`) covers GPT-4o, GPT-4o mini, Claude Sonnet, Claude Haiku, Gemini 1.5 Pro, and Gemini 2.0 Flash; labeled with a `// Last updated:` date to make staleness visible.

### Obsidian & Notion Export

- **`ChatWizard: Export Sessions to Obsidian`** — exports sessions as Obsidian-compatible Markdown (one `.md` file per session under `chatwizard/<source>/YYYY-MM-DD-<title-slug>.md`). Each file has a YAML frontmatter block (`title`, `source`, `date`, `tags`, `summary`, `chatwizard_id`) and wikilinks for file paths found in session content. A scope picker lets you export all sessions, pinned sessions only, or sessions filtered by tag.
- **`ChatWizard: Export Sessions to Notion`** — exports sessions to a Notion database via the public Notion API (user-supplied API key and database ID). The API key is stored in VS Code `SecretStorage` — never in `settings.json` or any file that could be committed to git. Rate-limited to 3 req/s. **`ChatWizard: Forget Notion API Key`** clears the stored credential.

### `@chatwizard` Chat Participant — new slash commands

- **`/referMessage <P{N} | R{N}>`** — quotes a specific turn from the current live chat thread by its turn label. `@chatwizard /referMessage P2` streams back the second user prompt as a Markdown blockquote so the model has it as explicit context. `R` references quote assistant responses. Out-of-range references return a friendly message (e.g. `"No R5 found. This thread has 3 responses so far."`) — not an error.
- **`/tag`** and **`/removeTags`** — see Session Tagging above.
- **`/analyzePrompt`** — see Prompt Cost Analysis above.
- **Clickable file links in `/continueFromHistory`** — files listed under "last time you were editing" are now emitted as VS Code native file pills (`stream.anchor()`), not plain text. Degrades gracefully to inline code when the file no longer exists on disk.

### MCP Server — enhancements

- **3 new MCP tools** (total: **11 tools**): `chatwizard_sessions_for_file`, `chatwizard_sessions_for_branch`, `chatwizard_sessions_for_work_item` (see Chronicle sections above).
- **Optional reranker for `chatwizard_get_context`** — a TF-IDF cross-pass re-ranks candidates after the semantic + keyword merge for higher-quality results. Off by default; enable via `chatwizard.mcp.reranker.enabled`. Timing is logged to the output channel (`[Reranker] N candidates reranked in Xms`).

### Session Reader improvements

- **Turn labels** — every message bubble now displays a `P{N}` / `R{N}` label (user prompts and assistant responses numbered independently from 1). Hovering a bubble reveals a **⧉ copy-as-reference** button that writes a structured reference string (`[Session: <title>] P3 ↳ "First line..." "...last line."`) to the clipboard.
- **Summary paragraph** in the session header (from AI-generated summaries above — Beta).
- **Entity chips** collapsible section (from entity extraction above — Beta).
- **Tag chips** in the session header (from session tagging above).

### UI & developer experience

- **Squirrel mascot status bar** — a persistent 🐿️ icon on the right side of the status bar. Pulses briefly (320 ms) when a notable event occurs (session indexed, index ready, new version available, etc.). Pulses every 20 s as a gentle idle heartbeat. Clicking navigates to the ChatWizard panel.
- **`Group Sessions…` command** — cycles through group modes (date, branch, work item, none) from the Sessions panel toolbar.
- **`Reveal in Explorer`** context menu action — reveals the session source file in the VS Code Explorer.
- VS Code 1.121 API compatibility fixes.

---

## [1.4.0] - 2026-05-05

- **MCP Server Mode** — expose your full chat history as a [Model Context Protocol](https://modelcontextprotocol.io/) server so that AI tools can query past conversations as live context when answering new questions. The server binds to `localhost` only, is disabled by default, and requires a bearer token for every request.
  - Enable via `chatwizard.mcpServer.enabled: true` (default `false`). Port configurable via `chatwizard.mcpServer.port` (default `6789`).
  - **8 MCP tools:** `chatwizard_search` (full-text), `chatwizard_find_similar` (semantic), `chatwizard_get_session` (truncated content), `chatwizard_get_session_full` (no truncation), `chatwizard_list_recent`, `chatwizard_get_context` (smart context), `chatwizard_list_sources`, `chatwizard_server_info`.
  - **2 MCP prompts:** `chatwizard.queryHistory`, `chatwizard.continueFromHistory` — slash-command–style prompts exposed via the MCP prompts protocol so any MCP-capable client can invoke them.
  - **3 new commands:** `Chat Wizard: Start MCP Server`, `Chat Wizard: Stop MCP Server`, `Chat Wizard: Copy MCP Config to Clipboard`.
  - **Config clipboard flow** — `Copy MCP Config` shows a quick-pick (GitHub Copilot, Claude Desktop, Cursor, Continue, Generic) and copies a ready-to-paste JSON snippet to the clipboard, then opens per-tool setup instructions in a read-only document.
  - **Status bar indicator** — a `$(broadcast) MCP` item reflects server state and provides one-click start/stop.
  - **First-run consent modal** — on first start, a modal explains what the server does before generating the bearer token.
  - **Token rotation** — new `Chat Wizard: Rotate MCP Token` command regenerates the bearer token, immediately invalidating the old one. Gated by the `chatwizard.mcpServer.allowTokenRotation` setting (default `false`). All AI tools must be reconfigured with the new token after rotation.
  - **`NullSemanticIndexer`** — semantic tool paths degrade gracefully when semantic search is disabled.
  - See [docs/mcp-setup-guide.md](docs/mcp-setup-guide.md) for per-tool setup instructions.

- **`@chatwizard` Copilot Chat Participant** — a native VS Code chat participant that surfaces ChatWizard's history search directly inside Copilot Chat, with no MCP server required. Type `@chatwizard` in the Copilot Chat panel to use either slash command:
  - `/queryHistory <question or error>` — unified two-phase history query. Phase 1 retrieves the top-3 best-scoring matching sessions and shows them in a ranked table with **✅ Yes — use history** / **❌ No — get general guidance** buttons. Clicking Yes (Phase 2) fetches the full content of all three sessions, consolidates them, semantically derives the core question being asked, and delivers a grounded answer. Handles both Q&A and troubleshooting in a single command.
  - `/continueFromHistory [topic]` — orients to recent work by listing the 5 most recent sessions (optionally filtered by topic) and proposing the 3 most valuable next actions.
  - Both slash commands are also exposed as **MCP prompts** for any MCP-capable client.

- **`Chat Wizard: Connect GitHub Copilot`** command (`chatwizard.connectCopilot`) — one-click shortcut to configure and enable the ChatWizard MCP server for GitHub Copilot.
- **`Chat Wizard: Set Up Global Copilot Instructions`** command (`chatwizard.setupGlobalInstructions`) — creates or updates the global Copilot instructions file (`.instructions.md`) to automatically prime every Copilot session with ChatWizard context-retrieval guidance.
- **VS Code Insiders support** — Copilot workspace storage discovery now automatically covers both VS Code stable (`Code`) and VS Code Insiders (`Code - Insiders`) installs. Sessions from both variants are indexed together without any additional configuration.
- **Improved full-text search relevance** — stop-word filtering removes ~80 common English words (articles, conjunctions, pronouns, generic computing terms) from query tokenisation so topically distinctive terms drive scoring. Basic de-pluralisation (`errors` → `error`, `hooks` → `hook`) broadens matches without adding noise.
- **Extension update notifier** — on activation, ChatWizard silently checks the VS Code Marketplace for a newer version (rate-limited to once per 24 hours via `globalState`). When a new version is available, an information notification appears with a direct **Open in Marketplace** link. No version data or usage information is sent; the check uses the public Marketplace REST API and is fire-and-forget.

## [1.3.0] - 2026-04-30

- **Topic similarity search** — new `Find Sessions by Topic` command (`chatwizard.semanticSearch`) finds past sessions by topic rather than keywords, powered by a local `Xenova/all-MiniLM-L6-v2` ONNX model (~22 MB, downloaded on first use after a consent prompt; `@xenova/transformers` bundled externally). Disabled by default; enable via `chatwizard.enableSemanticSearch`. The index stores one vector per user message and one per paragraph of each AI response (split on `\n\n`), keeping each embedding within the model's 256-token window. Vectors are persisted to `semantic-embeddings.bin` using a composite key `"sessionId::role::messageIndex::paragraphIndex"` per entry. Minimum similarity score is configurable via `chatwizard.semanticMinScore` (default `0.35`; recommended range `0.30–0.45`). A scope toggle cycles `Both → My questions → AI responses → Both` to restrict the search to user-message or assistant-paragraph vectors. Model loading and background indexing surface progress via `vscode.window.withProgress`. The full-text search quick-pick (`chatwizard.search`) shows a `$(sparkle)` button to switch directly to topic similarity search.
- **Search results deduplicated by session** — the keyword search quick-pick (`chatwizard.search`) now shows at most one result per session (the highest-scoring hit), eliminating duplicate entries when multiple snippets from the same session matched the query.

- **Google Antigravity support** — indexes agent conversations from Google Antigravity (Google’s VS Code-fork AI IDE) stored as JSONL step logs at `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/overview.txt`. User messages are extracted from `<USER_REQUEST>` XML envelopes; tool-only model steps are skipped; AI responses come from `PLANNER_RESPONSE` steps that carry text content. Session title is derived from the first user message (max 120 chars). Configurable via `chatwizard.indexAntigravity` and `chatwizard.antigravityBrainPath`.
- Antigravity sessions participate fully in full-text search, the prompt library, code block extraction, analytics, model usage, timeline, and source filtering across all panels.
- Token counting for Antigravity sessions uses the character ÷ 4 Gemini approximation (same as Claude) rather than the GPT word-based heuristic.
- `modelUsageEngine`: Antigravity sessions with no model field fall back to the label `Gemini Auto`.
- Antigravity brand icon (gradient “A” arch in Google Blue / Yellow / Red) added to `resources/icons/`.
- `--cw-antigravity` CSS variable and `.cw-badge-antigravity` badge class added to the shared theme (Google Blue `#4285F4` dark / `#1a73e8` light).
- Analytics panel: added “Antigravity Sessions” summary card; per-source session counter is now explicit for all sources rather than using a catch-all `else` branch.
- Timeline: Antigravity added to the source filter dropdown and `SRC_LABEL` map; timeline entries get the `cw-badge-antigravity` badge.
- Search panel: source filter cycle expanded to include Antigravity (`All → Copilot → Claude → Antigravity → All`).

## [1.2.0] - 2026-04-21

- **CI: unit tests on every release** — the release workflow now runs the full test suite on each target platform (Windows, Linux, macOS x64, macOS arm64) before building the VSIX, catching regressions before publication.
- **Cline support** — indexes Cline (`saoudrizwan.claude-dev`) task history from `api_conversation_history.json` per task; mixed text/tool-use content is handled with tool calls silently skipped; model and workspace path read from `ui_messages.json`. Configurable via `chatwizard.indexCline` and `chatwizard.clineStoragePath`.
- **Roo Code support** — indexes Roo Code (`rooveterinaryinc.roo-cline`) task history using the same parser as Cline (identical storage format, different extension ID). Configurable via `chatwizard.indexRooCode` and `chatwizard.rooCodeStoragePath`.
- **Cursor support** — indexes Cursor chat and agent sessions from SQLite `state.vscdb` files (`composer.composerData` key); one `state.vscdb` can contain multiple sessions. Requires the bundled `better-sqlite3` native module. Configurable via `chatwizard.indexCursor` and `chatwizard.cursorStoragePath`.
- **Windsurf support** — indexes Windsurf (Codeium) Cascade sessions from SQLite `state.vscdb` files (`cascade.sessionData` key); reuses the same `better-sqlite3` driver as Cursor. Configurable via `chatwizard.indexWindsurf` and `chatwizard.windsurfStoragePath`.
- **Aider support** — discovers and indexes `.aider.chat.history.md` files in all open VS Code workspace folders and any directories listed in `chatwizard.aiderSearchRoots`; scans up to `chatwizard.aiderSearchDepth` levels deep (default 3, max 5); model read from `.aider.conf.yml` when present. Configurable via `chatwizard.indexAider`, `chatwizard.aiderSearchRoots`, and `chatwizard.aiderSearchDepth`.
- All five new sources participate fully in full-text search, the prompt library, code block extraction, analytics, model usage, timeline, and workspace management.
- Cursor-native model IDs normalised: `cursor-fast` → `Cursor Fast`, `cursor-small` → `Cursor Small`.
- `better-sqlite3` native module bundled with the extension; VSIX packages are built per OS to include the correct platform binary.
- **Session Reader streaming** — large sessions (500+ messages) now load only the most-recent messages on open, with a banner to load earlier history on demand; content is streamed to the webview in small batches so the panel is interactive immediately.
- **Tree view pagination** — Sessions and Code Blocks panels now load items in pages; a "Load More (N remaining)" entry appears at the bottom so the UI stays fast regardless of session count.
- **Session grouping by date** — the Sessions panel now groups sessions into date buckets (Today, Yesterday, This Week, This Month, Older) by default; a toolbar toggle switches between grouped and flat-list views, with the choice persisted across restarts.
- **Code block grouping by language** — the Code Blocks panel now groups entries by language by default; a toolbar toggle switches between grouped and flat-list views, with the choice persisted across restarts.
- **Prompt clustering performance** — near-duplicate detection now uses a MinHash pre-filter to skip full trigram comparison on unrelated pairs, runs in async `setImmediate`-chunked batches to avoid blocking the extension host, caps computation at 5,000 entries, and caches results until the prompt index changes.

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