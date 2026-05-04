# ChatWizard — MCP Server Mode Work Plan

_Created: May 2026_

---

## Overview

**MCP Server Mode** exposes ChatWizard's session index as a [Model Context Protocol](https://modelcontextprotocol.io/) server so that AI tools — GitHub Copilot, Claude, Cursor, Continue, Windsurf, and any other MCP-aware agent — can query your past conversations as live context when answering new questions.

Every other feature in ChatWizard makes it a better *viewer*. This feature makes it *useful inside the tools developers are already in*. It multiplies the value of everything already built — the session index, topic similarity search, and full-text engine — without requiring the user to switch tabs or run a manual query.

It also makes ChatWizard's cross-tool aggregation a genuine superpower: no single AI coding tool can see what you discussed in a competing tool, but ChatWizard indexes all of them. An agent connected to ChatWizard's MCP server sees your full history across Copilot, Claude, Cursor, Windsurf, Cline, Aider, and all other indexed sources simultaneously.

### Core constraints (non-negotiable)

- **100% local** — the MCP server binds to `localhost` only; no traffic leaves the machine
- **Read-only** — the server exposes query tools only; no tool may modify session data or any source file
- **Opt-in** — disabled by default (`chatwizard.mcpServer.enabled: false`); users explicitly enable it
- **Auth-gated** — every request requires a bearer token generated on first start and stored in `globalStorageUri`; prevents other local processes from querying the index without consent
- **Zero new indexing cost** — all tools delegate to the existing `FullTextSearchEngine` and `SemanticIndexer`; no duplicate work

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` (official) | Handles protocol framing, tool schema, and transport negotiation |
| Transport | HTTP + SSE on `localhost` | Universal: works with Copilot, Claude Desktop, Continue, and any other MCP client; stdio would require spawning a subprocess per client |
| Default port | `6789` (configurable) | Unlikely to conflict; user can override via `chatwizard.mcpServer.port` |
| Auth | Bearer token (random 32-byte hex) | Generated once, stored in `globalStorageUri/mcp-token.txt`; user copies it into their tool's MCP config |
| Tool granularity | One tool per logical operation | Keeps each tool's schema minimal and its description precise — models call the right tool more reliably |
| Session content truncation | 4000 chars per session in `get_session` results | Prevents context window overflow; full content available via `get_session_full` |
| Result limits | Default top-10, max 50 | Balances context richness against token cost in the calling model |
| Server lifecycle | Start on extension activate when enabled; stop on deactivate | Consistent availability; no manual start/stop needed |

---

## Use Cases

**1. Avoiding repeated explanations of project decisions**
You spent a session with Cursor explaining why the project uses event-sourcing instead of direct DB mutations. Three weeks later you open a new Copilot session. Without MCP, Copilot has no memory of that decision and may suggest code that violates it. With MCP, Copilot retrieves the relevant past session and answers in context: _"Based on your earlier decision to use event-sourcing for auditability, here's how I'd approach this..."_

**2. Debugging with prior art**
You hit a "SQLITE_BUSY: database is locked" error. In the past you resolved a similar issue in an Aider session by switching to WAL mode — but that was two months ago. With MCP, your current agent queries ChatWizard's index, finds the old session, and opens with: _"You solved an identical lock contention issue on 2026-03-11 by enabling WAL mode — want me to apply the same fix?"_

**3. Consistent code style across sessions and tools**
A Claude Code session from last month contains a detailed exchange where you established naming conventions, error handling patterns, and your preferred async style for this codebase. Every new agent session in any tool can retrieve those conventions at start-up and apply them without you re-explaining them.

**4. Prompt engineering feedback loop**
You've tried four different prompting strategies for getting a model to produce clean SQL migrations. ChatWizard has all four sessions. The agent calls `chatwizard_find_similar` before drafting a prompt, sees which phrasings produced the best results, and reuses the most effective one.

**5. Cross-tool continuity**
You started planning a feature in a Copilot session, roughed out the implementation in Cursor, and hit a blocker that you discussed in Claude. No single tool knows the full story. An MCP-aware agent calls `chatwizard_search` with the feature name, stitches those sessions together, and opens with a coherent brief: _"Here's what you worked through across three tools — want to pick up from the blocker?"_

**6. Regression triage**
A test that passed three weeks ago is now failing. You search by the test name and find two sessions where you modified the relevant code path. The agent recovers the original rationale from those sessions before suggesting a fix, avoiding "fixes" that re-introduce the original problem.

**7. Onboarding a new team member (shared setup)**
A lead developer exports their ChatWizard index (Phase 2 export) and the new hire imports it. Their MCP-connected agent immediately has access to months of architectural decisions, rejected approaches, and solved gotchas — without any documentation-writing effort.

**8. "What did I try last time?" for recurring problems**
Every developer has problems they solve, forget, and solve again. With the MCP server running, an agent can proactively surface _"you asked about this exact error in April — here's what worked"_ the moment a familiar error message appears in a new session.

**9. Cost-aware model routing**
The `chatwizard_list_recent` tool can filter by model. An agent framework can inspect which model you used for similar past tasks, see which produced the best outcomes (via future response-rating data), and auto-select the cheapest model that historically performs well for this type of task.

**10. Project archaeology across a long engagement**
Six months into a project, you can ask: _"What were all the approaches we considered for the caching layer?"_ The agent calls `chatwizard_find_similar("caching layer architecture")`, retrieves the relevant sessions across all tools used, and produces a decision log — without any manual tagging or documentation having been required.

---

## Tool Catalogue

These are the MCP tools the server will expose. Each tool is a distinct callable with a JSON Schema input definition.

| Tool name | Purpose | Key inputs | Key outputs |
|---|---|---|---|
| `chatwizard_search` | Full-text keyword search | `query`, `limit`, `source?`, `workspaceId?` | Array of matching sessions with title, source, date, snippet |
| `chatwizard_find_similar` | Topic similarity (embedding) search | `query`, `limit`, `minScore?` | Array of semantically similar sessions |
| `chatwizard_get_session` | Get session content (truncated) | `sessionId`, `maxChars?` | Full session messages up to `maxChars` |
| `chatwizard_get_session_full` | Get complete session content | `sessionId` | All messages, no truncation |
| `chatwizard_list_recent` | List recently updated sessions | `limit`, `source?`, `since?` | Lightweight session summaries |
| `chatwizard_get_context` | Smart context: best snippets for a topic | `topic`, `limit` | Top passages across sessions, with session attribution |
| `chatwizard_list_sources` | List which AI tools are indexed | — | Array of source names + session counts |
| `chatwizard_server_info` | Server metadata / health check | — | Version, session count, index status |

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Implementation Order

Phase 0 defines the contracts and wires the package. Phases 1–3 are fully independent once Phase 0 is merged. Phase 4 is the convergence point.

```
Phase 0 — Foundation: contracts + package setup   ← must complete first
    │
    ├─► Phase 1 — Tool Implementations            ┐
    ├─► Phase 1.5 — Prompt Definitions             │  fully parallel
    ├─► Phase 2 — HTTP/SSE Server                 │
    └─► Phase 3 — Auth & Config                   ┘
            │
            └─► Phase 4 — Extension Wiring + UX   ← converges all tracks
```

---

## Phase 0 — Foundation: Contracts & Package Setup ✅

**Goal:** Define all TypeScript interfaces and get `@modelcontextprotocol/sdk` into the build pipeline. This is the strict prerequisite for all other phases.

**Depends on:** Nothing.

### Tasks — Contracts

- [x] Create `src/mcp/mcpContracts.ts` — define the following interfaces:
  ```ts
  export interface McpToolInput {
      [key: string]: unknown;
  }

  export interface McpToolResult {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
  }

  export interface IMcpTool {
      readonly name: string;
      readonly description: string;
      readonly inputSchema: object; // JSON Schema
      execute(input: McpToolInput): Promise<McpToolResult>;
  }

  export interface IMcpServer {
      readonly isRunning: boolean;
      readonly port: number;
      start(): Promise<void>;
      stop(): Promise<void>;
  }
  ```

- [x] Add `McpServerConfig` to `src/types/index.ts`:
  ```ts
  export interface McpServerConfig {
      enabled: boolean;
      port: number;
      tokenPath: string; // absolute path to bearer token file
  }
  ```

### Tasks — Build config

- [x] Add `@modelcontextprotocol/sdk` to `dependencies` in `package.json`
- [x] Add `--external:@modelcontextprotocol/sdk` to `bundle` and `bundle:watch` esbuild scripts
- [x] Confirm `npm run compile` and `npm run bundle` pass with no new errors

### Tasks — package.json manifest

- [x] Add `chatwizard.mcpServer.enabled` boolean setting (default: `false`, description: `"Start a local MCP server so AI tools can query your chat history as context."`)
- [x] Add `chatwizard.mcpServer.port` number setting (default: `6789`, description: `"Port for the local MCP server. Restart VS Code after changing."`)
- [x] Add `chatwizard.startMcpServer` command (title: `"Chat Wizard: Start MCP Server"`)
- [x] Add `chatwizard.stopMcpServer` command (title: `"Chat Wizard: Stop MCP Server"`)
- [x] Add `chatwizard.copyMcpConfig` command (title: `"Chat Wizard: Copy MCP Config to Clipboard"`)

### Deliverables

- `src/mcp/mcpContracts.ts`
- `package.json` updated (dependency, esbuild externals, 3 commands, 2 settings)
- `npm run compile` and `npm run bundle` pass clean

---

## Phase 1 — Tool Implementations ✅

**Goal:** Implement each MCP tool as an independent class implementing `IMcpTool`. Tools are pure data transformers — they accept a typed input, query the existing index/search engines, and return formatted text. No HTTP code here.

**Depends on:** Phase 0 (for `IMcpTool`, `McpToolInput`, `McpToolResult`).  
**Parallel with:** Phases 2, 3.

**New directory:** `src/mcp/tools/`

Each tool file is independently assignable. All tools follow the same pattern: implement `IMcpTool`, inject the relevant engine(s) through the constructor, format results as readable Markdown-style text in `McpToolResult.content`.

### Task — `SearchTool` (`src/mcp/tools/searchTool.ts`)

- [x] Accepts `{ query: string, limit?: number, source?: string, workspaceId?: string }`
- [x] Delegates to `FullTextSearchEngine.search()`
- [x] Formats each result as:
  ```
  [Session: <title>] | Source: <source> | Date: <updatedAt>
  Snippet: <first 300 chars of matching content>
  ID: <sessionId>
  ```
- [x] Input validation: `query` must be non-empty string; `limit` clamped to 1–50

### Task — `FindSimilarTool` (`src/mcp/tools/findSimilarTool.ts`)

- [x] Accepts `{ query: string, limit?: number, minScore?: number }`
- [x] Delegates to `SemanticIndexer.search()`
- [x] Returns error text (not a thrown exception) if semantic search is not enabled or indexer not ready
- [x] Formats results the same as `SearchTool` with an additional `Similarity: <score>` field

### Task — `GetSessionTool` (`src/mcp/tools/getSessionTool.ts`)

- [x] Accepts `{ sessionId: string, maxChars?: number }` (default `maxChars`: 4000)
- [x] Looks up session in `SessionIndex`
- [x] Formats as a structured conversation transcript: role labels, message content, truncated at `maxChars` with a `[truncated — use chatwizard_get_session_full for complete content]` note
- [x] Returns `isError: true` with a descriptive message if `sessionId` not found

### Task — `GetSessionFullTool` (`src/mcp/tools/getSessionFullTool.ts`)

- [x] Same as `GetSessionTool` but no truncation
- [x] Separate tool so calling models can choose cost/completeness tradeoff explicitly

### Task — `ListRecentTool` (`src/mcp/tools/listRecentTool.ts`)

- [x] Accepts `{ limit?: number, source?: string, since?: string }` (`since` is an ISO date string)
- [x] Queries `SessionIndex.getAll()`, filters, sorts by `updatedAt` descending
- [x] Returns lightweight summaries: title, source, date, message count, sessionId

### Task — `GetContextTool` (`src/mcp/tools/getContextTool.ts`)

- [x] Accepts `{ topic: string, limit?: number }`
- [x] Runs `FindSimilarTool` first (if semantic search enabled), then `SearchTool` as fallback/supplement
- [x] Deduplicates by sessionId, merges results, returns top passages with source attribution
- [x] This is the "smart" tool intended for agents that want maximum relevance with a single call

### Task — `ListSourcesTool` (`src/mcp/tools/listSourcesTool.ts`)

- [x] No inputs
- [x] Queries `SessionIndex` to count sessions by source
- [x] Returns a table of source names + session counts + most recent session date

### Task — `ServerInfoTool` (`src/mcp/tools/serverInfoTool.ts`)

- [x] No inputs
- [x] Returns: extension version, total session count, indexed sources, semantic search enabled/ready, server uptime

### Task — Unit tests

- [x] `test/suite/mcp/tools/searchTool.test.ts` — real `FullTextSearchEngine`; tests input validation, result formatting, empty results, source filter
- [x] `test/suite/mcp/tools/getSessionTool.test.ts` — real `SessionIndex`; tests found/not-found, truncation, full variant
- [x] `test/suite/mcp/tools/listRecentTool.test.ts` — real `SessionIndex`; tests filtering, sorting, limit clamping
- [x] `test/suite/mcp/tools/findSimilarTool.test.ts` — stub `ISemanticIndexer`; tests ready/not-ready paths, formatting, error handling
- [x] `test/suite/mcp/tools/listSourcesTool.test.ts` — covers `ListSourcesTool` and `ServerInfoTool`

### Deliverables

- `src/mcp/tools/` — 8 tool files ✅
- `test/suite/mcp/tools/` — 5 test files, 50 tests, all passing ✅

---

## Phase 1.5 — Prompt Definitions ⬜

**Goal:** Implement MCP Prompts — predefined, argument-driven templates that MCP clients surface as slash commands (e.g. `/check-regression`, `/pick-up-where-i-left-off`). Unlike Tools (which agents invoke autonomously), Prompts are user-initiated: the user types a command, provides arguments, and receives a pre-assembled context block ready for the model to act on immediately.

This is a distinct MCP primitive from Tools. The SDK's `server.prompt()` method registers them. Clients that support slash commands (Claude Desktop, Continue) expose them directly in the chat input; clients that don't (some Cursor versions) fall back to treating them as regular tool calls.

**Depends on:** Phase 0, Phase 1 (prompts compose tool calls internally).  
**Parallel with:** Phases 2, 3.

**New file:** `src/mcp/prompts/mcpPrompts.ts`

### Prompt catalogue

| Slash command | Arguments | What it does |
|---|---|---|
| `/check-regression` | `test` (test name or error message) | Searches for past sessions containing the test name or error; returns relevant sessions pre-formatted as context so the model opens with prior art already loaded |
| `/pick-up-where-i-left-off` | `topic?` (optional) | Lists the 5 most recent sessions, optionally filtered by topic; formats them as a brief summary the model can use to orient itself |
| `/what-did-i-decide-about` | `topic` | Runs `chatwizard_find_similar` + `chatwizard_search` on the topic; returns the most relevant decision-oriented excerpts with attribution |
| `/how-did-i-solve` | `problem` | Same as above but framed toward solution retrieval rather than decisions; optimised for error messages and bug descriptions |
| `/summarise-work-on` | `topic` | Returns a structured summary of all sessions touching the topic — what was tried, what was decided, what remains open — formatted for pasting into a PR or standup |

### Tasks

- [ ] **Prompt registry interface** — add `IMcpPrompt` to `src/mcp/mcpContracts.ts`:
  ```ts
  export interface McpPromptArgument {
      name: string;
      description: string;
      required: boolean;
  }
  export interface IMcpPrompt {
      readonly name: string;
      readonly description: string;
      readonly arguments: McpPromptArgument[];
      render(args: Record<string, string>): Promise<McpToolResult>;
  }
  ```
- [ ] **`McpServer` update** (Phase 2 task, noted here as a dependency) — add `registerPrompt(prompt: IMcpPrompt): void` and wire `server.prompt()` calls alongside the existing `server.tool()` calls
- [ ] **`CheckRegressionPrompt`** — searches by `args.test`; combines `SearchTool` + `FindSimilarTool` results; formats as: _"Here are the sessions most relevant to `{test}`. Review them before suggesting a fix:"_ followed by the session list
- [ ] **`PickUpWhereLeftOffPrompt`** — calls `ListRecentTool`; formats as a chronological brief of the last 5 sessions
- [ ] **`WhatDidIDecideAboutPrompt`** — calls `GetContextTool`; filters result passages for decision-signalling language ("decided", "went with", "chose", "rejected")
- [ ] **`HowDidISolvePrompt`** — calls `GetContextTool` then `GetSessionTool` on the top result for fuller context
- [ ] **`SummariseWorkOnPrompt`** — calls `FindSimilarTool` then `GetSessionTool` on each result; assembles a structured summary with section headers: _What was tried_, _What was decided_, _Open questions_

### Deliverables

- `src/mcp/prompts/mcpPrompts.ts` — 5 prompt implementations
- `src/mcp/mcpContracts.ts` updated with `IMcpPrompt`

---

## Phase 2 — HTTP/SSE Server ✅

**Goal:** Implement the MCP-compliant HTTP server that registers all tools from Phase 1 and handles the SSE transport required by the MCP protocol.

**Depends on:** Phase 0 (for `IMcpServer`).  
**Parallel with:** Phases 1, 3.

**New file:** `src/mcp/mcpServer.ts`

### Tasks

- [x] **`McpServer` class skeleton** — implements `IMcpServer`; constructor accepts `config: McpServerConfig`, a tool registry `IMcpTool[]`, and a logger callback
- [x] **Tool registry** — `register(tool: IMcpTool): void`; stores tools in a `Map<string, IMcpTool>` keyed by `tool.name`
- [x] **MCP SDK wiring** — uses `@modelcontextprotocol/sdk`'s low-level `Server` class with `SSEServerTransport`; registers all tools via `setRequestHandler(ListToolsRequestSchema)` and `setRequestHandler(CallToolRequestSchema)` using raw JSON schemas from `IMcpTool.inputSchema`
- [x] **`start()` method** — creates an `http.Server`; binds to `127.0.0.1` (never `0.0.0.0`) on `config.port`; attaches MCP SSE transport; sets `isRunning = true`; handles `EADDRINUSE` with a clear error message pointing to the port config setting
- [x] **`stop()` method** — closes the HTTP server; sets `isRunning = false`; resolves cleanly even if not running
- [x] **Auth middleware** — every request checks `Authorization: Bearer <token>` against the token loaded from `config.tokenPath`; responds `401` on mismatch; responds `503` if token file not yet created; skips check for `/health` and `/mcp-config` endpoints
- [x] **`/health` endpoint** — returns `200 OK` with `{ status: "ok", sessions: N }` — used by clients to verify connectivity before adding ChatWizard to their MCP config
- [x] **`/mcp-config` endpoint** — returns a generic JSON snippet (`url`, `authorization`, `endpoints`) a user can use as a starting point; full tool-specific snippets are generated by `McpConfigHelper` (Phase 3) via the `chatwizard.copyMcpConfig` command
- [x] **Error handling** — tool executor catches thrown errors and returns them as `isError: true` results rather than HTTP 500s; `EADDRINUSE` produces a descriptive message pointing to the port config setting

### Unit Tests

- [x] `test/suite/mcp/mcpServer.test.ts` — 28 tests covering:
  - Lifecycle: `isRunning`/`port` state before/after start and stop, idempotency, restart, logger callback, EADDRINUSE error message
  - `/health` endpoint: 200 response, unauthenticated access, `sessions` count from callback
  - `/mcp-config` endpoint: 200 response, JSON content-type, correct URL/port/token/endpoints in body, unauthenticated access
  - Auth middleware: 401 on missing/wrong/malformed token, 503 when no token file exists
  - Tool registry: constructor tools, `register()`, overwrite, multiple tools
  - Unknown paths: 401 before auth check, 404 after auth

### Smoke Tests

- [x] `scripts/smoke-test-mcp-server.mjs` — 20 assertions covering all 4 Phase 2 manual testing scenarios (all pass)

### Deliverables

- `src/mcp/mcpServer.ts` — `McpServer` class (~200 lines) ✅
- `test/suite/mcp/mcpServer.test.ts` — 28 tests, all passing ✅
- `scripts/smoke-test-mcp-server.mjs` — smoke test script, all passing ✅

---

## Phase 3 — Auth & Config ✅

**Goal:** Implement bearer token generation/persistence and the `McpConfigHelper` that produces ready-to-paste config snippets for each supported AI tool.

**Depends on:** Phase 0 (for `McpServerConfig`).  
**Parallel with:** Phases 1, 2.

**New file:** `src/mcp/mcpAuthManager.ts`  
**New file:** `src/mcp/mcpConfigHelper.ts`

### Tasks — `McpAuthManager` (`src/mcp/mcpAuthManager.ts`)

- [x] `getOrCreateToken(tokenPath: string): Promise<string>` — reads token from file if it exists; generates a `crypto.randomBytes(32).toString('hex')` token and writes it if not; returns the token string
- [x] `rotateToken(tokenPath: string): Promise<string>` — generates and writes a fresh token; returns it; called when the user explicitly requests a token rotation
- [x] Never logs or surfaces the raw token to the Output channel (only its length and creation date)

### Tasks — `McpConfigHelper` (`src/mcp/mcpConfigHelper.ts`)

- [x] `getConfigSnippet(tool: 'copilot' | 'claude' | 'cursor' | 'continue' | 'generic', port: number, token: string): string` — returns a ready-to-paste JSON or YAML block for the specified tool
- [x] Copilot format: VS Code `settings.json` `"github.copilot.chat.mcpServers"` entry
- [x] Claude Desktop format: `claude_desktop_config.json` `"mcpServers"` entry
- [x] Continue format: `.continue/config.json` `"mcpServers"` entry  
- [x] Cursor format: `.cursor/mcp.json` entry
- [x] Generic format: a plain `{ url, authorization }` block

### Deliverables

- `src/mcp/mcpAuthManager.ts` ✅
- `src/mcp/mcpConfigHelper.ts` ✅
- `test/suite/mcp/mcpAuthManager.test.ts` — 12 tests, all passing ✅
- `test/suite/mcp/mcpConfigHelper.test.ts` — 36 tests, all passing ✅
- `scripts/smoke-test-phase3.mjs` — 34 assertions, all passing ✅

---

## Phase 4 — Extension Wiring & UX ✅

**Goal:** Wire all Phase 1–3 components together in `extension.ts`; implement the three commands; add a status bar indicator; produce the `chatwizard.copyMcpConfig` quick-pick flow.

**Depends on:** Phases 1, 2, 3.

### Tasks — Extension wiring (`extension.ts`)

- [x] On `activate()`: read `chatwizard.mcpServer.enabled`; if true, instantiate `McpServer` with all 8 tools, call `server.start()`, store in `context.subscriptions`
- [x] Register `chatwizard.startMcpServer` command — starts the server if not already running; shows an information message: _"MCP server started on port 6789. Use 'Copy MCP Config' to set up your AI tool."_
- [x] Register `chatwizard.stopMcpServer` command — stops the server; shows confirmation message
- [x] Register `chatwizard.copyMcpConfig` command — see quick-pick flow below
- [x] Pass the `SessionIndex`, `FullTextSearchEngine`, and `SemanticIndexer` instances into the tool constructors; tools are wired at start-up, not on every request

### Tasks — Status bar item

- [x] Create a `vscode.StatusBarItem` aligned `Right` with priority `50`
- [x] When server is **running**: text `$(broadcast) MCP`, tooltip `"ChatWizard MCP server running on port 6789 — click to stop"`, command `chatwizard.stopMcpServer`, color default
- [x] When server is **stopped**: text `$(broadcast) MCP`, tooltip `"ChatWizard MCP server is stopped — click to start"`, command `chatwizard.startMcpServer`, color `new vscode.ThemeColor('statusBarItem.warningBackground')`
- [x] Hide the status bar item entirely when `chatwizard.mcpServer.enabled` is `false` and server has never been started this session

### Tasks — `chatwizard.copyMcpConfig` quick-pick flow

- [x] Show `vscode.window.showQuickPick` with options: `GitHub Copilot`, `Claude Desktop`, `Cursor`, `Continue`, `Generic (URL + token)`
- [x] On selection, call `McpConfigHelper.getConfigSnippet()` and copy to clipboard via `vscode.env.clipboard.writeText()`
- [x] Show an information message: _"Config copied! Paste it into your tool's MCP configuration."_ with a `Show instructions` button
- [x] `Show instructions` opens a read-only virtual document (or Markdown preview) with step-by-step setup instructions for the chosen tool, including where to find the config file and how to restart the tool to pick up the change

### Tasks — First-run consent

- [x] When `chatwizard.startMcpServer` is called for the first time (no token file exists), show a modal warning:
  > _"The MCP server will listen on localhost only. A bearer token will be generated and stored in your VS Code extension storage. Only tools you configure with this token can query your chat history. Continue?"_
- [x] `Cancel` aborts; `Enable` proceeds, generates token, starts server, sets `chatwizard.mcpServer.enabled: true` in global settings

### Deliverables

- `extension.ts` updated with MCP wiring (server instantiation, 3 commands, status bar) ✅
- `src/mcp/mcpConfigHelper.ts` — `getSetupInstructions()` per tool ✅
- `src/search/semanticContracts.ts` — `NullSemanticIndexer` for disabled-semantic-search path ✅
- All 3 commands working end-to-end ✅
- Status bar item correctly reflects server state ✅
- `test/suite/mcp/mcpPhase4.test.ts` — 46 tests covering instructions, NullSemanticIndexer, all 8 tools ✅
- `scripts/smoke-test-phase4.mjs` — 52 assertions, all passing ✅

---

## Phase 5 — Documentation & Setup Guides ⬜

**Goal:** Write user-facing documentation so users can self-serve MCP setup for each supported AI tool.

**Depends on:** Phase 4 (final tool names, port, config format confirmed).

### Tasks

- [ ] Add `## MCP Server` section to `README.md` — one-paragraph explanation, quick-start steps (enable setting → copy config → paste → restart tool)
- [ ] Create `docs/mcp-setup-guide.md` — per-tool setup instructions with screenshots for:
  - GitHub Copilot (VS Code `settings.json`)
  - Claude Desktop (`claude_desktop_config.json`)
  - Cursor (`.cursor/mcp.json`)
  - Continue (`.continue/config.json`)
- [ ] Add CHANGELOG entry for the release that ships MCP Server Mode
- [ ] Update `whats-next.md` to mark MCP Server Mode as complete

### Deliverables

- `README.md` updated
- `docs/mcp-setup-guide.md` created
- `CHANGELOG.md` updated

---

## Open Questions

| Question | Status | Notes |
|---|---|---|
| Should `chatwizard_get_context` use a reranker pass after the semantic + keyword merge? | Open | Would improve result quality but adds latency. Defer to post-launch feedback. |
| Should the `/mcp-config` HTTP endpoint be protected by auth? | Open | Currently unprotected — it reveals the token URL path but not the token itself. Acceptable given localhost-only binding. |
| Continue.dev and Cursor MCP config formats — are they stable? | Open | Verify against their latest docs before Phase 3 implementation. |
| Should session content in tool results strip code blocks for brevity? | Open | May help token efficiency; a `includeCode: boolean` input param on `GetContextTool` could make it opt-in. |
| Token rotation UX — should there be a command for it? | Open | `chatwizard.rotateMcpToken` is a low-priority add for Phase 4 if time allows. |
| Does MCP supersede the Topic Similarity panel for interactive users? | Resolved | No — they serve different interaction models. The panel serves users who want to browse sessions directly without an AI intermediary, or who are not running an MCP-connected tool. The MCP `chatwizard_find_similar` tool *calls* `SemanticIndexer.search()` directly — MCP depends on Topic Similarity; it does not replace it. For users already inside an MCP-connected assistant, the panel becomes less necessary but remains useful for session navigation and reading. |
