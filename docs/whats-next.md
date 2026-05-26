# ChatWizard — Master Roadmap

_Last updated: May 2026_

> **This is the merged master roadmap**, consolidating all `work-plan-*.md` and `whats-next-corporate.md` into a single ranked feature table.  
> Features are sorted by Priority tier (P1 → P4), which balances **Added Value × Urgency ÷ Effort**.
>
> **Effort key:** XS < 1 day · S = 1–3 days · M = 1–2 weeks · L = 3–6 weeks · XL = 2+ months  
> **Priority key:** P1 = Do Now · P2 = Next Quarter · P3 = H2 2026 · P4 = 2027+ / Corporate

---

## 1. Master Feature Roadmap

### P1 — Do Now (high value, low effort)

| # | Feature | Description | Added Value & Product Impact | Competitive Gap Addressed | Effort |
|---|---------|-------------|------------------------------|--------------------------|--------|
| 1 | **Multi-source UI fixes** (Cursor / Cline / Roo Code / Windsurf / Aider) | Analytics panel shows only Copilot + Claude + Antigravity session counts; timeline source filter and search-panel cycle omit these five sources; badge styling falls back to Claude purple for all of them. Four targeted fixes: add per-source session cards, add dropdown options, expand filter cycle, add brand CSS variables. _Source: work-plan-cursor-fixes.md_ | Correctness — users with Cursor/Cline/Roo/Windsurf sessions see wrong data or cannot filter. Fixing this is a prerequisite for all future multi-source analytics work. | Copilot Chat History (single-source tools) all surface the right source data for their one source. ChatWizard appears broken by comparison when session counts are wrong. | S |
| 2 | **Chat participant: live progress messages** (`stream.progress`) | All three chat participant commands are silent for 2–3 seconds while searching. Add progress messages at each pipeline stage ("Searching 847 sessions…", "Found 3 relevant sessions — generating answer…"). _Source: work-plan-chat-response-stream-features.md_ | Eliminates the most common friction point reported with the @chatwizard participant — perceived hang with no feedback. | GitHub Copilot's own built-in commands all show live progress. ChatWizard looks unpolished by comparison. | XS |
| 3 | **Chat participant: inline action buttons** (`stream.button`) | After `/queryHistory` results, surface **[Open in ChatWizard]** and **[Export answer]** buttons. After `/continueFromHistory`, surface **[Pick up where I left off →]** and **[Open last session]** buttons. _Source: work-plan-chat-response-stream-features.md_ | Converts the chat participant from read-only output into an action hub. Users stay in the chat panel instead of switching to the session tree. | Copilot's own responses use inline buttons extensively. VS Code Agent apps all use them. ChatWizard output looks like a text wall by comparison. | S |
| 4 | **Copilot Chronicle Phase 1 — search quality boost** | Index `checkpoints.work_done`, `checkpoints.technical_details`, and `checkpoints.overview` from Copilot's own `session-store.db` (the Chronicle SQLite store). Checkpoint text is dense and topically focused, dramatically improving search precision over raw conversation turns. Gracefully degrades when Chronicle is not available. _Source: work-plan-extra-chat-data.md_ | Direct improvement to `chatwizard_get_context` quality — the single most-called MCP tool. Better context → better AI agent answers → stronger daily usage habit. | No competitor reads this store. Pure differentiation for Copilot-heavy users. | S |
| 5 | **Copilot Chronicle Phase 2 — enhanced `/continueFromHistory`** | Return `checkpoints.next_steps` and `checkpoints.work_done` directly from the Chronicle store when available, eliminating the LLM inference step for the continuation summary. Zero extra cost, faster response, more accurate than a re-derived summary. _Source: work-plan-extra-chat-data.md_ | Makes `/continueFromHistory` reliably accurate for Copilot sessions (currently depends on what the LLM can reconstruct from raw turns). The AI already summarized the session at compaction time — we just surface it. | Copilot's own `/continue` equivalent has access to Chronicle data. ChatWizard should match it. | S |
| 6 | **Antigravity `conversations/` JSON support** | Antigravity writes full chat conversations to `~/.gemini/antigravity/conversations/*.json` — this directory was missed during original Antigravity research. Add a new reader + parser for the structured JSON files (role/content pairs). Deduplicate with existing `brain/` data by conversation UUID. _Source: work-plan-fill-antigravity-gaps.md_ | Upgrades Antigravity coverage from partial agent-trace logs to full conversation history. Antigravity users get the same fidelity as Copilot/Claude users. | ChatSync (competitor extension) already reads this directory. | S |
| 7 | **Mermaid diagram generation in architecture queries** | Detect architecture/design questions in `/queryHistory` (keyword heuristic) and add a prompt hint instructing the LLM to include a Mermaid diagram. VS Code renders `\`\`\`mermaid` blocks natively in chat — no stream API change needed. _Source: work-plan-chat-response-stream-features.md_ | High-impression, zero-infrastructure feature. Architecture diagrams inline in chat is a demo moment that drives word-of-mouth. | Unique to ChatWizard — no other session-history tool renders diagrams from past conversations. | S |
| 8 | **Session title normalization** | Give users a way to regenerate session titles so each one reflects what was actually discussed. Three-tier strategy: (1) Copilot Chronicle `checkpoints.overview` (no LLM call), (2) VS Code LM API via user's existing Copilot subscription, (3) offline TF-IDF heuristic. Multi-topic format: `"3 topics: Docker setup → React hooks → TS generics"`. Titles stored in sidecar metadata, never written to source files. _Source: work-plan-normalize-session-titles.md_ | Directly addresses the most frustrating Copilot UX problem: cryptic UUID/first-prompt titles that make sessions unsearchable. Improves session tree usability dramatically. | Pieces auto-generates descriptions for every saved item. Copilot titles are notoriously poor — this closes the gap for all Copilot users. | M |
| 9 | **Sidecar metadata model** (Phase 0 prerequisite) | Define `SessionMetadata` interface and `chatwizard-metadata.json` storage layer in `globalStorageUri`. Provides the write destination for tags, annotations, custom titles, linked sessions, and status flags — all without touching source files. Migrate existing pin state on first load. _Source: work-plan-kb-and-tagging.md_ | Foundational — unlocks tagging, title normalization, inline annotations, session linking, and KB generation in a single data model. Without this, those features cannot be built. | Required infrastructure; no direct competitive relevance. | S |

---

### P2 — Next Quarter (high value, medium effort)

| # | Feature | Description | Added Value & Product Impact | Competitive Gap Addressed | Effort |
|---|---------|-------------|------------------------------|--------------------------|--------|
| 10 | **Copilot Chronicle Phase 3 — file-centric history** | New MCP tool `chatwizard_sessions_for_file`. When a file is opened in the editor, surface a status bar item or inline CodeLens: "3 chat sessions touched this file". Clicking lists those sessions with dates and summaries. Also adds Explorer right-click context menu entry. _Source: work-plan-extra-chat-data.md_ | Changes ChatWizard from a tool you visit to a tool that meets you where you are. The CodeLens integration is the single most requested class of feature by developer tools (Git Lens, Copilot Lens, etc.). | No other AI history tool does per-file session association. Pure differentiation. | M |
| 11 | **Copilot Chronicle Phase 4 — work item & branch grouping** | Sessions tab gains two new group modes via the **Group Sessions…** QuickPick button: **Group by Branch** (reads `sessions.branch` from Chronicle DB — requires `chatwizard.chronicle.enableLocalIndex = true`) and **Group by Work Item** (applies `chatwizard.workItemPattern` regex to session titles and messages). Both modes are integrated into the existing Sessions tree view, replacing the previous separate "By Context" tab. MCP tools `chatwizard_sessions_for_work_item` and `chatwizard_sessions_for_branch` provide the same data programmatically. _Source: work-plan-extra-chat-data.md_ | "Show me all AI sessions for ticket ABC-1234" is the single most-requested enterprise workflow. Answers the question: _what did we ask AI while building this feature?_ | Pairs naturally with GitHub/JIRA and is a pre-requisite for the Team KB corporate feature. | M |
| 12 | **Session archive (own storage)** | Mirror every indexed session into `globalStorageUri/archive/` on first parse. When source tool prunes old sessions, ChatWizard still loads them from its own copy. Archived sessions get a subtle `· archived` badge. Opt-in pruning via `chatwizard.archive.maxAgeDays`/`maxSizeMB`. _Source: work-plan-session-archive.md_ | Delivers on ChatWizard's core promise of being the **source of truth** for AI chat history. Without this, Claude Code / Cursor users silently lose sessions when those tools prune. Drives retention. | Recall records everything permanently. No VS Code competitor archives AI sessions. First-mover advantage. | M |
| 13 | **Session tagging / labels** | Add/remove user-defined labels (`#bugfix`, `topic:auth`, `kind:decision`) via right-click context menu and QuickPick. Filter the session tree by tag. Tag chips displayed in tree items and reader header. Stored in sidecar metadata (depends on Feature 9). _Source: work-plan-kb-and-tagging.md_ | The most-requested missing organisation feature. Pinning is the only tool currently — tags fill the entire curation space between "flat list" and "full KB". Directly drives engagement. | Pieces has rich metadata per snippet. ChatWizard has only pinning. Tags close this gap immediately. | M |
| 14 | **Chat participant: clickable file links** (`stream.anchor`) | Replace plain-text file paths in `/continueFromHistory` output with VS Code native file anchor pills (blue pill links). Primary use: `"Last time you were editing [jwtHandler.ts](anchor)"`. Requires Chronicle Phase 2 for `important_files` data. _Source: work-plan-chat-response-stream-features.md_ | Makes the chat participant output actionable — one click opens the file where last work happened. Transforms continuation from informational to immediately useful. | Copilot's own output uses file anchors everywhere. ChatWizard output should match that quality bar. | S |
| 15 | **Continue.dev source support** | Index AI conversations from Continue.dev (`~/.continue/sessions/`). Large open-source user base; well-defined JSONL format mapping cleanly to existing `Session` type. _Source: whats-next.md_ | Opens a large user segment currently using a competing tool. Continue.dev has 100K+ VS Code installs. | ChatWizard is the only aggregator; adding Continue.dev makes it the obvious choice for Continue users who also use Copilot/Claude. | M |
| 16 | **Amazon Q Developer source support** | Index Amazon Q Developer conversations (formerly CodeWhisperer). Growing adoption in AWS shops and enterprise. _Source: whats-next.md_ | Enterprise audience with high willingness to pay — direct entry point for the corporate tier. | No competitor indexes Q sessions. | M |
| 17 | **Gemini Code Assist source support** | Index Google Gemini Code Assist VS Code extension conversations. Direct Copilot competitor with fast-growing user base. _Source: whats-next.md_ | Gemini Code Assist users need history search just as much as Copilot users. Growing market segment. | SpecStory (competitor) focuses on Copilot. Covering Gemini is differentiation. | M |
| 18 | **AI-generated session summaries / auto-descriptions** | Auto-generate a one-line contextual summary for every session using the existing VS Code LM API (user's Copilot subscription, no extra key). Display in tree item tooltip and session reader header. Cache in sidecar metadata. For Copilot sessions with Chronicle data: free (no LLM call — use `checkpoints.overview`). _Source: competitive gap vs. Pieces_ | Pieces auto-generates descriptions for every saved snippet. This is the most visible feature gap vs. the top competitor. Closes the gap using infrastructure already available (VS Code LM API + Chronicle). | **Critical gap vs. Pieces for Developers** — their AI descriptions are a headline feature. | M |
| 19 | **Entity extraction from sessions** | After indexing, extract and index structured entities from session content: file paths mentioned, function/class names, error messages/codes, decisions made (`"I decided to…"`, `"we chose X because…"`). Store in session metadata. Surface in search and session reader as structured tags. _Source: competitive gap vs. Pieces_ | Dramatically improves search precision: `find sessions mentioning auth.ts` or `find sessions where I decided to use event-sourcing`. Pieces does this for snippets; ChatWizard can do it for full sessions. | **Critical gap vs. Pieces for Developers** — they extract git repo, file, branch, language server context per snippet. | M |

| 21 | **MCP Phase II: reranker for `chatwizard_get_context`** | Add a cross-encoder reranker pass after the semantic + keyword merge in `GetContextTool`. The cross-encoder scores each candidate against the original query a second time, resolving rank disagreements between engines. _Source: work-plan-mcp-server-phase-II.md_ | Directly improves the quality of AI agent answers that rely on `get_context`. As index size grows (>500 sessions), the precision gain becomes significant. Higher-quality context = better AI outputs = stickier product. | Competes with cloud-based RAG services (Langfuse, PromptLayer) on retrieval quality, without any cloud dependency. | M |
| 22 | **Obsidian / Notion native export** | Export curated sessions (or KB output) as Obsidian-compatible Markdown with YAML frontmatter, wikilinks, and backlinks. Also: one-click export to Notion via public Notion API (user provides their own API key — optional, never required). _Source: competitive gap vs. Recall/Readwise_ | Second-brain tools are the dominant knowledge-management habit for power developers. Meeting users where their notes already live drives adoption from the Obsidian/Notion audience. | **Gap vs. Recall and Readwise** — both integrate natively with Obsidian. ChatWizard's KB output should too. | S |

---

### P3 — H2 2026 (medium-large effort, or medium priority)

| # | Feature | Description | Added Value & Product Impact | Competitive Gap Addressed | Effort |
|---|---------|-------------|------------------------------|--------------------------|--------|
| 23 | **KB entry classification + KB generation** | Classify sessions into Decision / Learning / Pattern / Gotcha / Architecture types using local heuristics (no LLM). Cluster by tags (primary) and embedding similarity (fallback). Export as Obsidian-compatible Markdown KB with chapter per topic cluster. Incremental: re-runs append new entries; user edits preserved via `locked: true` frontmatter. _Source: work-plan-kb-and-tagging.md_ | Turns 2+ years of AI conversation history into a structured personal knowledge base — a genuinely unique capability. No competitor offers this. The KB becomes a moat: once exported, users won't leave. | **Unique differentiator** — no competing tool converts AI sessions into a structured KB. The closest is Pieces' saved snippets, but that is manual curation, not automatic generation. | L |
| 24 | **SQLite persistent cache** | Replace the in-memory session index with a `chatwizard-cache.db` SQLite store. Sessions are parsed once; subsequent startups load from DB. FTS5 virtual table replaces in-memory substring scan with ranked BM25 search. Incremental JSONL parsing (byte-offset aware). Also adds proper schema for tags, notes, code_blocks. _Source: work-plan-move-to-sqlite.md_ | Solves cold-start latency for power users (10K+ sessions over a year of daily use). Enables all future features that need persistence (tags, annotations, KB, archive). FTS5 gives relevance-ranked search results without any extra code. | **Gap vs. Pieces** — Pieces is extremely fast because it uses local ML indexes. SQLite + FTS5 brings ChatWizard's search performance to the same tier. | L |
| 25 | **Git/branch linkage** | At session-open time (from Chronicle `sessions.branch`) or via git HEAD polling, record the active branch and HEAD commit for each session. Tag sessions by branch in the TreeView. In the session reader, show what the repo looked like at that point. _Source: whats-next.md_ | Answers _"what was I discussing on feature/auth?"_ — a daily developer workflow question. Prerequisites for the corporate work-item correlation feature. | **Gap vs. DevChat and GitHub Copilot** — both track branch/commit context natively. | M |
| 26 | **Workspace Digest / Standup Reports** | Command generating _"what I worked on [today / this week / this sprint]"_ from the timeline and session summaries. Output is a copy-pasteable standup update or PR description. _Source: whats-next.md_ | High practical value — saves 5–10 minutes every morning, driving daily activation. | **Gap vs. DevChat** — DevChat generates standup reports from sessions. | M |
| 27 | **Cloud sync (opt-in)** | Optional encrypted sync of the session index (not source files) to user's own S3 / Azure Blob / GitHub Gist. Keys managed locally. Makes history available across machines without compromising the privacy-first brand. _Source: whats-next.md_ | The number-one reason developers might choose Pieces over ChatWizard is cross-machine history. Opt-in sync closes this gap without abandoning the privacy-first architecture. | **Critical gap vs. Pieces** — Pieces syncs across all devices and has a web UI. This is the most significant single acquisition gap. | L |
| 28 | **Session status lifecycle** | Mark sessions as `open`, `resolved`, or `revisit`. Used to track which threads are still active. Filter tree view by status. _Source: whats-next.md_ | Turns the session list into a lightweight task tracker. Users revisiting sessions with unresolved code no longer have to remember what was resolved. | Minimal competitive precedent — opportunity to differentiate. | S |
| 29 | **Bookmarks within a session** | Mark a specific exchange inside a long session. Jump-to-bookmark in the session reader. Stored in sidecar metadata. _Source: whats-next.md_ | Power-user feature for sessions with 100+ messages. Prevents re-reading to find a key answer. | Gap vs. Pieces — Pieces stores the full context of a saved snippet, implying precise retrieval. ChatWizard has no within-session anchoring. | S |
| 30 | **Inline annotations** | Attach a personal note to any message: _"I ended up not using this approach because…"_. Displayed inline in the session reader as a small comment thread. Stored in sidecar metadata. _Source: whats-next.md_ | Converts sessions from read-only archives into living documents. The annotation becomes part of the knowledge base. | **Gap vs. Recall** — Recall lets you annotate captured memories. | S |
| 31 | **Session linking** | Explicitly link two sessions (_"this continued in session X"_), creating a conversation graph. Navigate forward/backward through linked sessions. MCP tool `chatwizard_get_linked`. _Source: whats-next.md_ | Answers the problem of long projects spread across dozens of sessions. Gives continuity to a conversation that VS Code session management breaks apart. | Unique differentiator — no competitor models session relationships as a graph. | M |
| 32 | **Response rating** | Per-response thumbs-up / thumbs-down for personal recall ("this answer was wrong / excellent"). Filter search results to only highly-rated responses. Used as training signal for the reranker. _Source: whats-next.md_ | Personal feedback loop. Over time, the reranker learns which sessions/responses were valuable and surfaces them first. | **Gap vs. PromptLayer** — PromptLayer has explicit response rating built-in for prompt evaluation. | S |
| 33 | **Duplicate / related session detection** | Detect when the same conversation was split across sessions (e.g. Claude vs. Cursor for the same task). Surface them as related in the tree view and session reader. _Source: whats-next.md_ | Reduces noise in large session collections. Improves analytics accuracy (doesn't double-count the same logical conversation). | Unique to ChatWizard's multi-source position — no competitor aggregates cross-tool so deduplication is uniquely valuable. | M |
| 34 | **Outcome / follow-up tracking** | Lightweight checklist of action items extracted from or appended to a session. `chatwizard_get_action_items` MCP tool. _Source: whats-next.md_ | Turns AI conversations into trackable work items without leaving VS Code. | **Gap vs. DevChat** — DevChat extracts tasks from conversations. | S |
| 35 | **Keyboard-only navigation** | Vim-style `j/k` in the session tree and reader; `/` to jump to search. _Source: whats-next.md_ | Power-user retention feature. Keyboard-only users are typically the most vocal community members. | Standard expectation for any developer tool — absence is friction. | S |
| 36 | **Session sharing** | Generate a read-only shareable link (or exportable HTML bundle) for a specific session. The link opens a read-only web view of the session — no ChatWizard installation required for the recipient. _Source: competitive gap vs. Pieces, DevChat_ | Teams reviewing AI-generated code review decisions or architectural choices need a way to share without "install this extension first". Drives organic growth. | **Gap vs. Pieces and DevChat** — both support sharing. ChatWizard has no sharing mechanism. | M |
| 37 | **Post-session cost tips & analytics** | After a session closes, if the estimated token cost exceeded a threshold, surface a one-line actionable tip. Extend the Analytics view with a "cost efficiency" dimension: average output tokens per input token per prompt type. _Source: work-plan-cost-effective-prompts.md_ | Passive cost awareness without requiring the user to invoke `/analyzePrompt`. Drives behavioural change at scale (post-session nudge is lower friction than pre-send analysis). | **Gap vs. PromptLayer / Langfuse** — both provide cost analytics. ChatWizard does it locally. | S |
| 38 | **MCP tools: `includeCode` flag** | Add an `includeCode: boolean` parameter to `GetContextTool`, `GetSessionTool`, and `GetSessionFullTool`. When `false`, strip fenced code blocks and long inline code spans before returning content. Reduces token cost by 50–80% for code-heavy sessions. _Source: work-plan-mcp-server-phase-II.md_ | For users on pay-per-token plans, this can cut daily AI costs significantly when ChatWizard context is included in agent chains. | Gap vs. cloud RAG services — all of them offer content chunking controls. | S |
| 39 | **MCP `/mcp-config` auth hardening** | Add a bearer token check to the `/mcp-config` endpoint (currently unauthenticated). Prevents local port scanners from enumerating server capabilities. _Source: work-plan-mcp-server-phase-II.md_ | Security hygiene. Low priority because the threat model is narrow (attacker can scan ports but not read `globalStorageUri`). | Best-practice for any local server. | XS |
| 40 | **Antigravity `.pb` (protobuf) support** | Best-effort extraction of conversation text from Antigravity's binary protobuf session files using wire-type 2 scan. Lossy but recovers message text. Sessions flagged `lowFidelity` in metadata. _Source: work-plan-fill-antigravity-gaps.md_ | Completeness for Antigravity users — some sessions are only available in `.pb` format. | Fills remaining Antigravity gap. | S |
| 41 | **Zed AI source support** | Index AI conversations stored by the Zed editor. Growing audience among Rust/performance-focused developers. _Source: whats-next.md_ | Expands addressable market into the Zed community. | No competitor indexes Zed sessions. | S |
| 42 | **Tabnine Chat source support** | Index Tabnine chat history. Tabnine has significant enterprise market share. _Source: whats-next.md_ | Enterprise exposure — Tabnine is common in regulated industries where Copilot is not approved. | No competitor indexes Tabnine. | M |
| 43 | **Session retention controls** | Two independent settings: `chatwizard.semanticIndexMaxAgeDays` (exclude old sessions from semantic index only) and `chatwizard.sessionRetentionDays` (suppress from all surfaces without deleting source files). _Source: whats-next.md_ | Keeps the UI and index manageable for multi-year users (8K+ sessions/year). Without this, search quality and performance degrade as history grows. | Standard feature for any history tool. | S |
| 44 | **API / programmatic access** | Expose the session index as a read-only REST endpoint (beyond MCP). Enables external scripts, dashboards, and integrations to query ChatWizard data without VS Code being open. _Source: competitive gap vs. PromptLayer_ | Unlocks a developer ecosystem around ChatWizard data. Scripts that pull session data for CI/CD, dashboards, or custom analytics. | **Gap vs. PromptLayer / Langfuse** — both offer a full API. ChatWizard's MCP server is powerful but VS Code-dependent. | M |
| 45 | **Compacted session detection & visibility** | Detect when a Claude Code session file contains a `/compact` summary (`"type":"summary"` entry in the JSONL). (1) Flag such sessions in the Sessions tree with a `· compacted` badge distinct from `· archived`. (2) In the session reader, render the compaction summary as a visible "Context summary from earlier conversation" block at the top, instead of silently folding it into the session title. (3) Optionally surface a link to the predecessor session file (same session ID, earlier timestamps) if it still exists in the index. _Source: whats-next.md_ | When Claude Code compacts a conversation the model retains a prose summary of earlier turns A–E as its context window, but the user sees only turns F–M. Without this feature the user has no idea there is hidden context shaping the AI's behaviour. Making compaction visible prevents confusion and turns a silent data-loss event into a transparent UX. | Unique to ChatWizard — Claude Code itself has no history viewer. No competitor surfaces compaction context. | S |
| 20 | **Prompt cost analysis** (`@chatwizard /analyzePrompt`) | Before sending a prompt, analyse it locally with zero LLM calls: (1) token count estimate via local tiktoken-compatible tokenizer, (2) similarity check against session history ("you asked this on 3 Apr"), (3) verbosity/open-ended-scope heuristics, (4) model selection suggestion. Exposed as `@chatwizard /analyzePrompt` and "ChatWizard: Analyze Selected Prompt" command. _Source: work-plan-cost-effective-prompts.md_ | GitHub Copilot is moving to pay-per-token. This feature saves real money for heavy users and becomes a headline differentiator when billing kicks in. The zero-LLM constraint is the moat — competitors can't match it without spending tokens to save tokens. | **Unique to ChatWizard** — no other history tool can cross-reference a draft prompt against your personal history before you send it. | M |

> **⚠️ Feature 20 — Testing deferred to P3 (2026-05-26)**
>
> Implementation is **complete** (all code in place) but the feature was **not exposed in 1.5.0** — it requires further end-to-end testing before release. The following changes were made to disable it without removing code:
>
> **What was unwired / removed for 1.5.0:**
> - `package.json` — removed `chatwizard.analyzeSelectedPrompt` command declaration and its `editor/context` menu entry; removed `analyzePrompt` from the `@chatwizard` chat participant commands list.
> - `src/extension.ts` — commented out the `SessionCostAdvisorNotifier` instantiation (Feature 20-J) and the `chatwizard.analyzeSelectedPrompt` command registration block (Feature 20-D). Search for `disabled for 1.5.0` to find both sites.
> - `README.md` — removed "Prompt Cost Analysis" feature bullet, `/analyzePrompt` mention in the `@chatwizard` participant line, comparison-table row, and 1.5.0 release note entry.
> - `docs/user-guide.md` — removed TOC entry #18, the `/analyzePrompt` usage example in the `@chatwizard` section, the entire "18. Prompt Cost Analysis" section, the `chatwizard.analyzeSelectedPrompt` command table row, and the Quick Reference row. Sections 19/20 renumbered to 18/19.
>
> **To re-enable for a future release:**
> 1. Restore the `chatwizard.analyzeSelectedPrompt` command + `editor/context` menu entry in `package.json`.
> 2. Restore the `analyzePrompt` entry in the `@chatwizard` chat participant commands in `package.json`.
> 3. Uncomment both `// disabled for 1.5.0` blocks in `src/extension.ts`.
> 4. Restore documentation in `README.md` and `docs/user-guide.md` (see `docs/done/work-plan-whats-next-P2.md` → Feature 20 completion checklist for full detail).
> 5. Complete the outstanding unit and e2e tests listed in `docs/done/work-plan-whats-next-P2.md` → Feature 20 → Unit Tests / E2E Tests / Manual Tests before re-exposing.

---

### P4 — 2027+ / Corporate Tier

| # | Feature | Description | Added Value & Product Impact | Competitive Gap Addressed | Effort |
|---|---------|-------------|------------------------------|--------------------------|--------|
| 46 | **Team Knowledge Base & Institutional Memory** | Shared layer on top of per-developer local indexes. Developers "promote" sessions to a central team store. Full-text + semantic search across the promoted corpus, scoped to team or project. The team hub acts as an MCP server so AI agents can query team history as context. _Source: whats-next-corporate.md_ | When a senior engineer leaves, their AI sessions don't leave with them. New hires onboard via past sessions. Teams discover each other's relevant prior work. The clearest enterprise "sell". | **Unique** — no competitor offers cross-developer AI session aggregation. | XL |
| 47 | **AI Usage Compliance & Audit Trail** | Read-only, tamper-evident log of what was sent to AI tools: which model, from which workstation, at what time, within which project. Pattern-based sensitive data detection (API keys, PII, internal hostnames). Exportable signed JSON bundles. _Source: whats-next-corporate.md_ | CISOs in regulated industries have an immediate, concrete need. Directly maps to existing DLP workflows. The fastest "signed PO" path for an enterprise deal. | **Unique in VS Code ecosystem** — no competitor addresses AI usage compliance at the session level. | L |
| 48 | **Shared & Governed Prompt Library** | Company-managed prompt template library distributed via a `fetch-from-URL` source. Senior engineers curate and version-control approved prompts. Template variables (`{{jira_ticket}}`, `{{service_name}}`). Usage analytics. _Source: whats-next-corporate.md_ | Consistency + quality + cost control in one feature. Vetted templates are already right-sized and encode company conventions. Also reduces AI spend (prompt efficiency). | **Gap vs. DevChat** — DevChat supports team prompt sharing. | M |
| 49 | **Team & Project-Level Analytics** | Roll per-developer token/model analytics up to team and project dimensions. Sessions per developer per sprint, models used (approved vs. unapproved), token burn vs. commit rate, top topics per project. Management-facing dashboard. _Source: whats-next-corporate.md_ | CTOs are being asked by their CFOs to justify AI tooling spend. ChatWizard is the only tool that sits across all tools and all developers and can answer this. | **Gap vs. PromptLayer / Langfuse** — both offer team analytics. ChatWizard does it on-premise. | L |
| 50 | **Security & Data Governance Policy Engine** | Rule engine configured centrally and deployed via settings or policy file to all VS Code instances. Flag sessions referencing internal IPs, domain names, project codenames. Block-list specific models per workspace. Enforce redaction before team promotion. _Source: whats-next-corporate.md_ | Risk-management layer that makes corporate ChatWizard deployments auditable and defensible to legal/security teams. | No VS Code competitor has a local policy engine for AI tool usage. | L |
| 51 | **Standup / Sprint Digest (team-level)** | Per-developer standup auto-generated from previous day's AI sessions. Sprint retrospective: what categories of problems dominated across the team? Auto-draft PR descriptions correlated to AI sessions. Post to Slack/Teams on a schedule. _Source: whats-next-corporate.md_ | Removes standup preparation friction for the whole team. Also provides sprint-level insights for managers. | **Gap vs. DevChat** — DevChat supports automated standups. | M |
| 52 | **Git / JIRA / ADO work item correlation** | At session-open time, record active branch and HEAD commit; link sessions to work items via branch name conventions (`feature/ABC-1234`). "Show me all AI sessions related to ticket ABC-1234" → full AI-assisted decision history for a feature. ADR generation: extract pivotal exchange → structured Architecture Decision Record. _Source: whats-next-corporate.md_ | The enterprise equivalent of Chronicle Phase 4. Connects AI sessions to the work item system of record. | **Gap vs. GitHub Copilot's own JIRA integration** — GitHub Copilot links Copilot sessions to issues. ChatWizard needs to match this across all sources. | M |
| 53 | **`@chatwizard` Agent app** | Publish a `.agent.md` agent to VS Code Marketplace (or company's internal registry). Developers invoke `@chatwizard` inline in the chat panel — it queries the session index, runs results through the policy engine, and returns grounded answers. Zero manual MCP configuration required. _Source: whats-next-corporate.md_ | Replaces manual MCP configuration with a one-click-install agent that just works. Transforms adoption from "developer sets up MCP" to "IT deploys one agent to 50 seats overnight". | VS Code Agent apps are the future of enterprise AI tool distribution. First-mover advantage. | M |
| 54 | **Corporate deployment hub** | Self-hosted Docker container: receives promoted sessions, serves team-level MCP queries, hosts policy engine and prompt library. Web admin console for managing users, policies, templates, and analytics. SSO/SAML (Azure AD, Okta). Per-seat or site licence validation. _Source: whats-next-corporate.md_ | The commercial product that converts the open-source extension into a B2B revenue stream. All enterprise features depend on this. | **Gap vs. Langfuse / PromptLayer** — both offer self-hosted enterprise deployments. ChatWizard does it locally (no cloud dependency). | XL |
| 55 | **Avante.nvim / CodeCompanion.nvim support** | Index AI sessions from Neovim AI plugins with on-disk session files. First non-VS Code IDE source — expands addressable market beyond VS Code. _Source: whats-next.md_ | Opens the Neovim/terminal developer audience. Neovim users are power users with high word-of-mouth multiplier. | No competitor indexes Neovim AI sessions. | L |
| 56 | **JetBrains AI Assistant support** (separate plugin) | JetBrains AI Assistant has a huge install base (IntelliJ, PyCharm, WebStorm). Requires a separate JetBrains plugin (IntelliJ plugin SDK, different distribution). Highest-effort source expansion but highest total addressable market. _Source: whats-next.md_ | JetBrains has ~10M active users. Even 0.1% adoption is a large number. | **Pieces for Developers has a JetBrains plugin.** This is the single biggest platform gap vs. the top competitor. | XL |
| 57 | **Browser extension** | Access ChatWizard history outside VS Code — in the browser when reviewing GitHub PRs, Confluence pages, Slack threads. Read-only search over local index via native messaging. _Source: competitive gap vs. Pieces, Recall_ | Recall is the dominant tool for "search everything you've seen on your computer". A browser extension makes ChatWizard competitive in this space for AI coding history. | **Gap vs. Pieces and Recall** — both work outside the IDE. ChatWizard is currently editor-locked. | XL |

---

## 2. Competitive Landscape — Top 10 Tools

### 2.1 Top 10 Competing Tools

Research covers the VS Code Marketplace (sorted by installs, May 2026) and the broader developer tool market.

| # | Tool | Type | Install Base | Key Strengths | Where ChatWizard Falls Behind |
|---|------|------|-------------|---------------|-------------------------------|
| 1 | **Pieces for Developers** | VS Code ext + web + desktop + mobile | ~500K+ across platforms | On-device ML for natural language search; full context per snippet (git repo, file, branch); AI descriptions auto-generated; web/desktop/mobile app; JetBrains + Neovim + Chrome + Slack + Teams + Raycast integrations | No web/mobile access; no AI-generated descriptions; no cross-IDE clients; no snippet-level entity extraction |
| 2 | **SpecStory** | VS Code ext | ~21K installs, ⭐5.0 | Auto-saves every AI conversation as Markdown in `.specstory/` folder; zero setup; integrates with git history; clean session-per-file organisation | Single-source (only current session); no search across sessions; no analytics; no multi-tool aggregation; no MCP |
| 3 | **Continue.dev** | VS Code + JetBrains + Neovim ext | ~100K+ VS Code installs | Open-source AI coding assistant; multi-provider (GPT, Claude, Ollama, etc.); history persistence; active community | Not a history search tool — limited session retrieval; no aggregation across tools; no analytics |
| 4 | **DevChat** | VS Code ext | ~30K installs | Team prompt sharing; session history; team analytics; PR description generation; integrations with Git/JIRA | No multi-source aggregation; cloud-dependent for team features; no MCP server; no privacy-first architecture |
| 5 | **Copilot Chat History** (arbuzov) | VS Code ext | ~4.6K installs | Simple viewer for Copilot chat sessions | Single-source (Copilot only); no search, no analytics, no export, no MCP |
| 6 | **Recall** (macOS) | macOS app | ~50K+ (estimate) | Records everything on-screen including AI sessions; powerful local ML search; annotate memories; cross-app (browser, Slack, Notion) | Not VS Code native; captures everything (not AI-session focused); no developer-specific analytics; macOS only |
| 7 | **mem0.ai** | Library + cloud | ~10K GitHub stars | Persistent memory layer for AI agents; auto-extracts and surfaces memories across conversations; API-first | Not a VS Code extension; cloud-based (privacy trade-off); not AI coding session history focused; requires API integration |
| 8 | **PromptLayer / Langfuse** | Cloud web app | ~50K+ (Langfuse) | LLM observability; prompt versioning and A/B testing; team analytics; cost tracking via actual API calls; exportable reports | Cloud-based (not local-first); requires API key integration (not passive session reading); no VS Code extension; no MCP |
| 9 | **Opik — Chat History Exporter** | VS Code ext | ~552 installs | Exports chat history from Cursor and Zencoder; sends to Opik cloud for analysis | Cloud-dependent (sends data externally); limited sources (Cursor + Zencoder only); no search; no privacy guarantee |
| 10 | **CursorChat Downloader / Claude Code History** | VS Code exts | 975–1.7K installs | Single-source viewers/exporters for their respective tools | Single-source; no search, no analytics, no MCP; no aggregation |

### 2.2 ChatWizard's Competitive Position

**Moat (protect at all costs):**
- Only tool that aggregates ALL AI coding tools simultaneously (8+ sources, expanding)
- 100% local, read-only, zero setup — no API key, no account, no network calls
- Privacy-first by architecture (not just by policy)
- MCP server exposes multi-source history as context to all AI agents

**Critical gaps to close (highest competitive urgency):**

| Gap | vs. Competitor(s) | Feature in Roadmap |
|-----|-------------------|-------------------|
| No AI-generated descriptions / summaries | Pieces | #18 (P2) |
| No entity extraction (files, functions, errors) | Pieces | #19 (P2) |
| No web/mobile access | Pieces, Recall | #27 Cloud Sync (P3), #57 Browser ext (P4) |
| No cross-machine sync | Pieces | #27 Cloud Sync (P3) |
| No JetBrains plugin | Pieces, Continue.dev | #56 (P4) |
| No team collaboration | DevChat, PromptLayer | #46–#54 Corporate tier (P4) |
| Search results unranked | Pieces, PromptLayer | #24 SQLite/FTS5 (P3) |
| No actual cost data | PromptLayer, Langfuse | #20 Prompt cost analysis (P3), #37 Post-session tips (P3) |
| No session sharing | Pieces, DevChat | #36 Session sharing (P3) |

---

## 3. Monetization Roadmap

### 3.0 Licensing & Open Core Strategy

**Repo visibility: stays public.** GitHub discoverability, Marketplace search, and community trust all depend on the public repo. Going private harms organic installs. The extension core stays open source under MIT + Commons Clause. The Commons Clause is already correct — it blocks anyone from selling the software itself as a competing service. No license change is needed to charge for Pro features.

**What stays open vs. what goes private:**

| Component | Visibility | Reason |
|---|---|---|
| Core VS Code extension | **Public** (MIT + Commons Clause) | Distribution, community, organic growth |
| Pro feature code in VSIX | Public source, gated by license flag | Ships in the same bundle; gating is behavioural, not structural |
| License validation endpoint | **Private** (minimal server) | Just validates keys; not user data |
| Cloud sync backend | **Private** | It is a service, not a library |
| Team hub / Enterprise hub | **Private** | The commercial product itself |

**Add a CLA before community grows.** Without a Contributor License Agreement, community-contributed code is MIT-only — it cannot be included in proprietary Pro/Enterprise features without each contributor's individual written consent. Add GitHub CLA Assistant (a free GitHub App) now, before this becomes a retroactive problem.

**Payment processor: LemonSqueezy.** Standard choice for indie VS Code extensions. Acts as merchant of record (handles VAT/sales tax globally — you never touch tax), generates license keys natively, exposes a one-call validation API, and handles renewals and cancellations automatically. ~5% + $0.50 per transaction, no monthly cost.

---

### 3.1 Tier Model

| Tier | Who Buys | Price Model | Status |
|------|----------|-------------|--------|
| **Individual (Free)** | Developer | Open source / free | ✅ Current |
| **Individual Pro** | Power developer | VS Code Marketplace paid VSIX or subscription (~$5–10/mo) | 🔜 Next |
| **Team** | Engineering lead, 5–50 devs | Per-seat SaaS or self-hosted licence (~$10–20/seat/mo) | 📋 Planned |
| **Enterprise** | CTO, CISO, 50–500+ devs | Site licence, self-hosted (~$30–50/seat/mo) | 🔮 Future |

> The Commons Clause already in the license protects the commercial angle — no one can resell the core without a commercial agreement.

---

### 3.2 Individual Pro Tier — Feature Prerequisites

**Goal:** Capture the most engaged free users who want persistent, cross-machine, richer history.

**Key monetization features:**
- Cloud sync (opt-in, user's own storage) → cross-machine access without privacy trade-off
- Unlimited session archive (free tier: 90-day rolling archive)
- AI-generated session summaries (LM API calls beyond a free quota)
- Advanced analytics (cost efficiency dashboard, per-model cost estimation)
- Priority support + early access to new features

**Feature prerequisites (must ship before charging):**

```
Session archive (Phase 1–4)          ← #12 (P2)
    │
    ├── Sidecar metadata model        ← #9 (P1)
    │
Session title normalization          ← #8 (P1)
Session tagging / labels             ← #13 (P2)
AI-generated summaries               ← #18 (P2)
Prompt cost analysis                 ← #20 (P2)
SQLite persistent cache              ← #24 (P3) ← required for performance at Pro scale
    │
    └── Cloud sync (opt-in)          ← #27 (P3) ← the key Pro differentiator
```

**Recommended path to Individual Pro launch:** Complete P1 features (sprint 1) → Complete Session Archive + Tagging + AI Summaries (P2, sprint 2–3) → SQLite cache (P3, sprint 4–6) → Cloud sync (P3, sprint 7–8) → Launch Pro tier.

**Estimated time to launch:** 4–6 months from today.

#### Implementation: In-Extension License Gating

Pro features ship inside the same VSIX, gated by a `LicenseService` singleton called once on extension activation. The key is stored in VS Code settings (`chatwizard.licenseKey`), validated against the LemonSqueezy API, and the result cached in `globalState` for 24 hours to avoid a network call on every startup.

```typescript
// src/license/LicenseService.ts
export type Tier = 'free' | 'pro' | 'team';

export class LicenseService {
  private static _tier: Tier = 'free';

  static async activate(context: vscode.ExtensionContext): Promise<void> {
    const cached = context.globalState.get<{ tier: Tier; expiresAt: number }>('chatwizard.licenseCache');
    if (cached && Date.now() < cached.expiresAt) { this._tier = cached.tier; return; }

    const key = vscode.workspace.getConfiguration('chatwizard').get<string>('licenseKey', '');
    if (!key) return; // stays 'free'

    const tier = await this.validateRemote(key);
    this._tier = tier;
    await context.globalState.update('chatwizard.licenseCache', {
      tier, expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
  }

  static get isPro(): boolean { return this._tier === 'pro' || this._tier === 'team'; }
  static get tier(): Tier { return this._tier; }

  private static async validateRemote(key: string): Promise<Tier> {
    try {
      const resp = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key }),
      });
      const json = await resp.json() as { valid: boolean };
      return json.valid ? 'pro' : 'free';
    } catch {
      return 'free'; // graceful degradation — never hard-block on network failure
    }
  }
}
```

Gating a feature at the call site is a single guard:

```typescript
export async function runProFeature(): Promise<void> {
  if (!LicenseService.isPro) {
    const action = await vscode.window.showInformationMessage(
      'Session Archive is a ChatWizard Pro feature.',
      'Upgrade to Pro', 'Learn More'
    );
    if (action === 'Upgrade to Pro') {
      vscode.env.openExternal(vscode.Uri.parse('https://chatwizard.dev/pro'));
    }
    return;
  }
  // ... actual feature code
}
```

**Enforcement model by feature tier:**

| Feature | Gate type | Bypassable by decompiling? |
|---|---|---|
| Session archive | In-extension flag | Yes (Commons Clause violation) |
| Advanced analytics dashboard | In-extension flag | Yes |
| AI summaries beyond free quota | Counter in `globalState` + flag | Yes |
| Cloud sync | **Server-side auth** | No |
| Team KB / hub | **Server-side auth** | No |
| Enterprise compliance / audit | **Server-side auth** | No |

Webpack minification + terser obfuscation makes decompilation annoying in practice. The Commons Clause makes it a license violation. Once cloud sync ships, the enforcement model becomes airtight because the backend physically cannot serve requests without a valid auth token.

---

### 3.3 Team Tier — Feature Prerequisites

**Goal:** Capture engineering teams where one developer uses ChatWizard and shares it with their team.

**Key monetization features:**
- Team Knowledge Base & Institutional Memory (promoted sessions, team search)
- `@chatwizard` Agent app (VS Code Marketplace or private registry distribution)
- Shared & Governed Prompt Library (URL-sourced, zero server needed for Phase 1)
- Team-level Analytics dashboard
- Standup / Sprint Digest (team-level, Slack/Teams integration)
- Git/JIRA/ADO work item correlation

**Feature prerequisites:**

```
Individual Pro prerequisites (above)           ← all required
    │
Copilot Chronicle Phase 3 (file-centric)       ← #10 (P2)
Copilot Chronicle Phase 4 (work item grouping) ← #11 (P2)
Git/Branch Linkage                             ← #25 (P3)
Git / JIRA / ADO correlation                   ← #51 (P4)
Session sharing                                ← #36 (P3)
    │
Shared Prompt Library (URL-sourced)            ← #47 (P4) ← can ship as early Team feature
@chatwizard Agent app                          ← #52 (P4) ← core distribution mechanism
    │
    └── Team Knowledge Base (hub)              ← #45 (P4) ← requires central server
        ├── Team Analytics                     ← #48 (P4)
        └── Standup/Sprint Digest              ← #50 (P4)
```

**Recommended pilot path (before full hub):**
1. **Step 1 (2–3 days):** Shared Prompt Library via `fetch-from-URL` — zero server, immediate value for the team's "AI champion".
2. **Step 2 (2–3 days):** `@chatwizard` Agent app as a `.vsix` — distributes the MCP client to all team members.
3. **Step 3 (1–2 weeks):** Per-developer standup command + Slack webhook — produces daily standups from AI session history.
4. **Step 4 (3–4 weeks):** Minimal hub (Node.js + Docker) for promoted sessions and team MCP queries — the first true Team tier deliverable.

**Estimated time to Team tier launch:** 9–12 months from today (assuming Individual Pro ships first).

---

### 3.4 Enterprise Tier — Feature Prerequisites

**Goal:** Land regulated-industry deals (finance, healthcare, defence) where the CISO sign-off is the blocker.

**Key monetization features:**
- AI Usage Compliance & Audit Trail (the CISO "sell")
- Security & Data Governance Policy Engine
- SSO/SAML (Azure AD, Okta)
- On-premise guarantee (all data stays inside the corporate network)
- Immutable audit exports (signed JSON bundles per sprint/month)
- Per-developer per-model usage reports (exportable to CSV/PDF)
- Model policy enforcement (flag/block unapproved models per workspace)
- Private Agent Registry

**Feature prerequisites:**

```
All Team tier features                         ← required
    │
AI Usage Compliance & Audit Trail              ← #46 (P4) ← the fastest demo for CISOs
Security & Data Governance Policy Engine       ← #49 (P4)
    │
    ├── SSO / SAML authentication              ← required by hub
    ├── Immutable audit export                 ← tamper-evident signed bundles
    ├── Model policy enforcement               ← block-list unapproved models per project
    └── Private Agent Registry                 ← distribute company agents via MDM/SCCM
```

**Fastest proof-of-concept for enterprise sales:**
1. **Sensitive data detection** (2–3 days) — regex/pattern pass on ingestion, report view in extension. A CISO can see the value in a demo with zero server infrastructure.
2. **Team Prompt Library via URL** (3–5 days) — zero server, immediate demo of governed prompts.
3. **`@acme-assistant` Agent app** (2–3 days) — company-branded agent that queries the session index and runs through the policy engine. Distributable as `.vsix` via MDM.
4. **Central hub** (2–3 weeks) — minimal Node.js / Docker hub for the full pilot.

**Estimated time to Enterprise tier GA:** 18–24 months from today (assuming Team tier ships first and a corporate pilot is landed).

---

### 3.5 Monetization Summary Timeline

```
Today                                    Q3 2026                      Q1 2027               2027+
  │                                          │                            │                    │
  ▼                                          ▼                            ▼                    ▼
P1 features                           Individual Pro                 Team Tier           Enterprise GA
(multi-source fixes,                  (cloud sync,                   (Team KB,           (Compliance,
 Chronicle, archive,                   archive, tags,                 Agent app,          Policy engine,
 tagging, summaries,                   summaries,                     Analytics,          SSO, Audit trail,
 cost analysis)                        SQLite)                        Prompt Library)     Private registry)
```

---

## 4. Open Questions / Decisions Deferred

| Question | Background | Recommended trigger to resolve |
|----------|------------|-------------------------------|
| Reranker timing | Cross-encoder adds 50–200 ms per `get_context` call; benefit scales with index size. | User/telemetry signal that result ordering causes bad agent outputs. |
| `/mcp-config` auth | Marginal security gain vs. friction in onboarding docs. | Formal security audit identifies this as a risk vector. |
| `includeCode` defaults | `false` degrades agents that need code; `true` means no one uses `false`. | User feedback citing token cost from code-heavy sessions. |
| AI summary LLM quota (Pro tier) | How many free LM API summary calls before Pro paywall? | A/B test after Individual Pro launch. |
| Team hub self-hosted vs. managed cloud | On-premise is the enterprise differentiator; managed cloud enables SMB sales. | First corporate pilot will reveal the dominant preference. |
| Neovim plugin distribution | Neovim has no extension marketplace — would ship as a Lua plugin via `lazy.nvim` / `packer.nvim`. | Community interest signal (GitHub stars from Neovim users). |


