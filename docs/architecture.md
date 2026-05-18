# ChatWizard — Architecture

## 1. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js (Electron) | VS Code extension host |
| Language | TypeScript 5.3 | All source code |
| Extension API | VS Code API ^1.85.0 | UI, commands, webviews, file watchers |
| Bundler | esbuild | Single-file `dist/extension.js` output |
| MCP transport | `@modelcontextprotocol/sdk` ^1.29.0 | HTTP/SSE server for AI tool calls |
| Semantic search | `@xenova/transformers` ^2.17.2 | Local embedding model (no external calls) |
| SQLite | `better-sqlite3` ^12.8.0 | Read Cursor and Windsurf `.vscdb` databases |
| Testing | Mocha + `@vscode/test-electron` | Unit and integration tests |
| Coverage | c8 | Istanbul-compatible coverage reports |

---

## 2. Application Architecture

### 2.1 High-Level Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                        │
│                                                                      │
│  extension.ts  (activation, wiring, command registration)            │
│       │                                                              │
│  ┌────┴─────────────────────────────────────────────────────────┐    │
│  │                     Core Services                            │    │
│  │  SessionIndex   SidecarMetadataStore   WorkspaceScopeManager │    │
│  └────┬────────────────────┬───────────────────────────────┬────┘    │
│       │                    │                               │         │
│  ┌────┴─────┐   ┌──────────┴──────────┐   ┌───────────────┴──────┐  │
│  │ Watcher  │   │  Search / Analysis  │   │  UI / View Layer     │  │
│  │ & Parsers│   │  FullTextEngine     │   │  TreeProviders       │  │
│  │ Readers  │   │  SemanticIndexer    │   │  WebviewPanels       │  │
│  └──────────┘   │  CodeBlockEngine    │   │  Sidebar Views       │  │
│                 └─────────────────────┘   └──────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────┐   ┌────────────────────────────┐     │
│  │  MCP Server (HTTP / SSE)   │   │  VS Code Chat Participant  │     │
│  │  tools + prompts           │   │  @chatwizard               │     │
│  └────────────────────────────┘   └────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Descriptions

#### `extension.ts` — Entry Point & Wiring
The single activation function. It creates every service instance, registers all VS Code commands and view providers, connects the change-listener chain between `SessionIndex` and all consumers (search engines, UI panels, tree views), and starts the file watcher. Nothing else in the codebase performs registration; all side-effectful VS Code API calls live here.

---

#### `SessionIndex` (`src/index/sessionIndex.ts`)
The central in-memory store. Holds the full `Session` object for every indexed session in a `Map<id, Session>`. Exposes:
- `upsert` / `remove` / `batchUpsert` — write operations
- `get` / `getAllSummaries` / `getAllCodeBlocks` / `getAllPrompts` — read operations
- `addChangeListener` / `addTypedChangeListener` — event bus used by all downstream consumers

The typed event bus (`upsert | remove | batch | clear`) lets each consumer (search engine, code block engine, tree views, analytics panels) react to incremental changes without polling.

---

#### `SidecarMetadataStore` (`src/index/sidecarMetadataStore.ts`)
Persists user-managed metadata (custom titles, pins, tags) to a JSON file in VS Code's `globalStorageUri`. This keeps user data separate from source files so nothing is written back to the AI assistant's own storage. On startup, the store is loaded and its cache is injected into `SessionIndex` so title overrides and pin state are reflected in the tree before any user interaction.

---

#### `ChatWizardWatcher` / `startWatcher` (`src/watcher/fileWatcher.ts`)
Runs the initial bulk scan and registers VS Code `FileSystemWatcher` instances. On startup it discovers all workspaces for each supported source, calls the matching parser for every session file found, and batch-upserts the results into `SessionIndex`. Afterwards it watches for file creation, change, and deletion events and updates the index incrementally. Includes symlink traversal guards (OWASP path-traversal mitigation) that reject any resolved path that escapes the expected storage root.

---

#### `WorkspaceScopeManager` (`src/watcher/workspaceScope.ts`)
Tracks which workspace IDs are currently "in scope" (the current VS Code project or a user-selected set). The watcher consults the scope manager to decide whether to index a discovered workspace, allowing users to limit the view to only relevant projects.

---

#### Readers (`src/readers/`)
One reader module per supported AI assistant. Readers know the file-system conventions of their target (where storage lives, what the directory and file naming pattern is) and return a list of files or workspace descriptors for the watcher to process. They do not parse content.

| Module | Discovers |
|---|---|
| `copilotWorkspace.ts` | VS Code global storage `.jsonl` files |
| `claudeWorkspace.ts` | `~/.claude/projects/` JSONL files |
| `clineWorkspace.ts` | Cline and Roo Code task JSON directories |
| `cursorWorkspace.ts` | Cursor `workspaceStorage` `.vscdb` SQLite databases |
| `windsurfWorkspace.ts` | Windsurf SQLite databases |
| `aiderWorkspace.ts` | `.aider.chat.history.md` files |
| `antigravityWorkspace.ts` | Google Antigravity JSON/markdown conversations |
| `chronicleWorkspace.ts` | Copilot Chronicle checkpoint SQLite databases |

---

#### Parsers (`src/parsers/`)
One parser module per source. A parser takes a file path (or database connection) and returns a structured `Session` object with typed `Message[]`, extracted `CodeBlock[]`, timestamps, model name, workspace ID, and any non-fatal parse errors. Parsers are pure functions with no VS Code API dependency, making them straightforward to unit-test.

---

#### `FullTextSearchEngine` (`src/search/fullTextEngine.ts`)
An in-memory inverted-index engine. Tokenises session content at index time, filters English stop words, and discards hapax tokens (tokens appearing in only one session) to reduce noise and memory use. At query time it supports:
- **AND mode** (all terms must match)
- **OR mode** (relaxed matching for longer queries)
- **Regex mode** with ReDoS protection (pattern length limit, structural catastrophic-pattern detector, per-query timeout)

Results are scored, ranked, and paginated.

---

#### `SemanticIndexer` + `EmbeddingEngine` + `SemanticIndex` (`src/search/`)
Optional component (disabled by default, controlled by `chatwizard.enableSemanticSearch`). Uses `@xenova/transformers` to generate local vector embeddings for each session without any external network call. Embeddings are persisted to `semantic-embeddings.bin` in global storage and survive extension restarts. At query time the engine computes a query embedding and returns the *k* nearest sessions by cosine similarity. A proxy object (`semanticProxy`) decouples the live indexer reference from the MCP tools so the feature can be toggled at runtime without restarting the extension.

---

#### `CodeBlockSearchEngine` (`src/codeblocks/codeBlockSearchEngine.ts`)
Indexes all `IndexedCodeBlock` objects extracted from sessions. Supports filtering by language, content substring, session source, and message role. Consumed by both the Code Blocks tree view and the Code Blocks webview panel.

---

#### MCP Server (`src/mcp/mcpServer.ts`)
An HTTP server bound to `127.0.0.1` only, implementing the Model Context Protocol over SSE transport. All non-health endpoints require a bearer token (written to `mcp-token.txt` in global storage by `McpAuthManager`). External AI assistants (GitHub Copilot in another VS Code window, Claude Desktop, Cursor, etc.) connect to this server to call tools against the live session index.

**Tools exposed:**

| Tool | Description |
|---|---|
| `chatwizard_search` | Full-text keyword search across all sessions |
| `chatwizard_find_similar` | Semantic similarity search (optional) |
| `chatwizard_get_session` | Retrieve session summary by ID |
| `chatwizard_get_session_full` | Retrieve complete session with messages |
| `chatwizard_list_recent` | List most recent sessions |
| `chatwizard_get_context` | Combined keyword + semantic context lookup |
| `chatwizard_list_sources` | List indexed sources and session counts |
| `chatwizard_server_info` | Server status, version, uptime |

**MCP Prompts** (`src/mcp/prompts/`): Pre-built prompt templates (`query_history`, `continue_from_history`, `get_prompts`) that pre-fetch context before the model responds.

---

#### VS Code Chat Participant (`src/mcp/chatParticipant.ts`)
Registers `@chatwizard` as a native VS Code chat participant. Shares the same prompt and tool implementations as the MCP server so the two surfaces stay in sync. No HTTP server is required; it calls tool logic directly.

---

#### View Layer (`src/views/`, `src/analytics/`, `src/timeline/`, `src/search/`, `src/prompts/`, `src/codeblocks/`)
All UI surfaces. Two patterns are used:

- **Tree providers** (`SessionTreeProvider`, `CodeBlockTreeProvider`): VS Code native `TreeDataProvider` implementations. Support sort stacks (up to 3 criteria), filters, date-group headers, pagination ("Load more"), pinning, drag-and-drop reordering, and file decoration warnings.
- **Webview panels / sidebar views**: React-style shell HTML + message-passing. Each panel has a `getShellHtml()` static method (registered as a `WebviewPanelSerializer`) so VS Code can restore a clean panel on restart instead of replaying stale cached HTML.

| Panel / View | Content |
|---|---|
| Session Viewer | Renders a single session's messages with syntax-highlighted code blocks |
| Search Panel | Full-text search UI with highlighted snippets |
| Semantic Search Panel | Vector similarity search UI |
| Analytics Panel | Session counts, token usage, model distribution |
| Model Usage View | Per-model breakdown |
| Timeline View | Chronological activity chart |
| Prompt Library | Extracted user prompts, searchable |
| Code Blocks Panel | Browseable, filterable code block gallery |

---

#### Export (`src/export/`)
Commands for exporting sessions to Markdown or other formats.

---

#### Telemetry (`src/telemetry/telemetryRecorder.ts`)
Local-only, opt-in recorder. Writes structured events to a JSON file in global storage. No data ever leaves the machine.

---

## 3. Key Data Types (`src/types/index.ts`)

```typescript
type SessionSource = 'copilot' | 'claude' | 'cline' | 'roocode'
                   | 'cursor' | 'windsurf' | 'aider' | 'antigravity';

interface Session {
    id: string;              // Derived from file path or internal ID
    title: string;           // First user prompt (or custom override)
    source: SessionSource;
    workspaceId: string;     // Opaque hash or path
    workspacePath?: string;  // Resolved workspace root
    model?: string;          // e.g. "claude-sonnet-4-5", "gpt-4o"
    messages: Message[];
    filePath: string;        // Absolute path to source file
    createdAt: string;       // ISO timestamp
    updatedAt: string;       // ISO timestamp
    parseErrors?: string[];
    chronicleData?: ChronicleData;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    codeBlocks: CodeBlock[];
    timestamp?: string;
}

interface CodeBlock {
    language: string;
    content: string;
    sessionId: string;
    messageIndex: number;
    blockIndexInMessage?: number;
}
```

---

## 4. Flow Diagrams

### 4.1 Startup & Initial Index

```
activate()
    │
    ├─► Create SessionIndex, SidecarMetadataStore
    │       │
    │       └─► load() sidecarStore → inject cache into index
    │
    ├─► Register WebviewView providers (sidebar panels)
    │
    ├─► Build FullTextSearchEngine, CodeBlockEngine, SemanticIndexer (if enabled)
    │   └── All subscribe to index.addTypedChangeListener()
    │
    ├─► Build SessionTreeProvider, CodeBlockTreeProvider
    │   └── Restore persisted sort/filter/pin state from globalState
    │
    ├─► startWatcher(index, channel, scopeManager)
    │       │
    │       ├─► discoverCopilotWorkspacesAsync()  ──┐
    │       ├─► discoverClaudeWorkspacesAsync()     │
    │       ├─► discoverClineTasksAsync()           ├─► per-source
    │       ├─► discoverCursorWorkspacesAsync()     │   discovery
    │       ├─► discoverWindsurfWorkspacesAsync()   │
    │       ├─► discoverAiderHistoryFilesAsync()  ──┘
    │       │
    │       ├─► parse each file with matching parser
    │       │
    │       └─► index.batchUpsert(sessions)
    │               │
    │               └─► fires 'batch' event → all listeners update
    │
    ├─► Register MCP server, VS Code chat participant
    │
    └─► Register all commands (sort, filter, pin, search, export …)
```

---

### 4.2 Live File Change → Index Update

```
File system event (create / change / delete)
    │
    ▼
ChatWizardWatcher
    │
    ├─[security check]─► symlink guard: resolved path within base dir?
    │                      └── No → drop event
    │
    ├─[scope check]───► workspaceId in active scope?
    │                      └── No → drop event
    │
    ├─[parse]─────────► parser(filePath) → Session | null
    │
    ├─[upsert]────────► index.upsert(session)
    │                       │
    │                       └─► fires 'upsert' typed event
    │                               │
    │                               ├── FullTextSearchEngine.index(session)
    │                               ├── SemanticIndexer.scheduleSession(session)
    │                               ├── codeBlockEngine.index(allCodeBlocks)
    │                               ├── TreeProviders.refresh()
    │                               └── Webview panels refresh (analytics, timeline …)
    │
    └─[delete]────────► index.remove(sessionId) → fires 'remove' typed event
```

---

### 4.3 Full-Text Search Request

```
User types in Search Panel
    │
    ▼
SearchPanel.handleMessage({ type: 'search', query, options })
    │
    ▼
FullTextSearchEngine.search(SearchQuery)
    │
    ├─► tokenise query
    ├─► look up posting lists in inverted index
    ├─► score & rank candidate sessions (AND / OR / regex)
    ├─► apply pagination (page, pageSize)
    └─► return SearchResponse { results, totalCount, page }
            │
            ▼
    sessionWebviewPanel.postMessage({ type: 'results', data })
            │
            ▼
    Webview renders results with highlighted snippets
```

---

### 4.4 MCP Tool Call

```
AI assistant (Copilot, Claude, Cursor …)
    │
    │  HTTP POST /sse  (bearer token)
    ▼
McpServer  (bound to 127.0.0.1:port)
    │
    ├─► validate bearer token
    ├─► parse JSON-RPC CallToolRequest
    ├─► look up tool by name in _tools Map
    │
    ▼
IMcpTool.call(args, context)
    │
    ├── SearchTool       → FullTextSearchEngine.search()
    ├── FindSimilarTool  → SemanticIndexer.search()
    ├── GetSessionTool   → SessionIndex.get()
    ├── ListRecentTool   → SessionIndex.getAllSummaries()
    └── GetContextTool   → SearchTool + FindSimilarTool combined
    │
    ▼
JSON-RPC CallToolResult
    │
    ▼
AI assistant receives structured context
```

---

### 4.5 Session Rendering

```
User clicks session in tree view
    │
    ▼
chatwizard.openSession command
    │
    ▼
SessionIndex.get(sessionId) → Session
    │
    ▼
SessionWebviewPanel.show(context, session, searchTerm?)
    │
    ├─► getShellHtml() → minimal HTML shell sent to webview
    ├─► webview fires 'ready'
    └─► extension posts { type: 'render', session: renderedHtml }
            │
            ▼
    sessionRenderer.render(session)
        │
        ├─► markdown → HTML  (code blocks syntax-highlighted)
        ├─► timestamps formatted
        └─► search term highlighted if present
```

---

## 5. Storage Locations

| Data | Location |
|---|---|
| Copilot sessions | `%APPDATA%\Code\User\workspaceStorage\<hash>\GitHub.copilot-chat\` |
| Claude sessions | `~/.claude/projects/` (or configured path) |
| Cline / Roo Code tasks | VS Code global storage for the respective extension |
| Cursor sessions | `%APPDATA%\Cursor\User\workspaceStorage\<hash>\state.vscdb` |
| Windsurf sessions | Similar SQLite path under Windsurf app data |
| Aider history | `.aider.chat.history.md` files in project roots |
| Antigravity | Platform-specific app data directory |
| Sidecar metadata (pins, titles) | `context.globalStorageUri / sidecar-metadata.json` |
| Semantic embeddings | `context.globalStorageUri / semantic-embeddings.bin` |
| MCP bearer token | `context.globalStorageUri / mcp-token.txt` |
| Local telemetry | `context.globalStorageUri / telemetry.json` |

---

## 6. Security Design

| Threat | Mitigation |
|---|---|
| Path traversal via symlinks | `ChatWizardWatcher` resolves all symlinks with `fs.realpathSync` and verifies the result stays within the expected base directory before reading any file |
| ReDoS via user-supplied regex | Pattern length capped at 200 chars; structural catastrophic-pattern detector (`RE_REDOS_PATTERNS`); per-query hard timeout of 1 s |
| MCP unauthorized access | Bearer token required on all endpoints except `/health`; server bound to `127.0.0.1` only; token stored in extension's private global storage |
| Oversized session files | Per-source configurable line-size limit; lines exceeding the limit are stored as `skipped` placeholder messages rather than parsed |
| Data exfiltration | Telemetry is local-only and opt-in; semantic embeddings are generated by a bundled local model; no network calls are made by the extension itself |

---

## 7. Extension Points

### 7.1 New AI Assistant Support

Adding support for a new AI assistant requires three files:
1. **`src/readers/<name>Workspace.ts`** — discover storage paths and enumerate session files
2. **`src/parsers/<name>.ts`** — parse a session file into a `Session` object
3. **`src/watcher/configPaths.ts`** — add the default storage path resolver
4. Register the new reader/parser pair in `ChatWizardWatcher.startAll()` inside `fileWatcher.ts` and add the source label to `src/types/index.ts` (`SessionSource`).

### 7.2 New View Types

1. Implement `vscode.TreeDataProvider` (for a tree panel) or create a webview panel class with a `getShellHtml()` static method and a message-passing `handleMessage()` handler
2. Register the provider via `vscode.window.registerWebviewViewProvider` or `registerWebviewPanelSerializer` in `extension.ts`
3. Add the corresponding `contributes.views` entry and any toolbar commands to `package.json`
4. Subscribe to `index.addChangeListener()` so the view refreshes automatically when the session index updates

### 7.3 Search Enhancements

1. Extend the `SearchQuery` interface in `src/search/types.ts` with new filter or ranking fields
2. Add the matching algorithm logic inside `FullTextSearchEngine` (or a new engine class) in `src/search/`
3. Update `SearchPanel` to pass the new query parameters from the webview UI
4. Update the webview HTML/JS in the search panel to surface the new controls

---

## 8. Performance Design

### 8.1 Lazy & Incremental Loading
- Sessions are indexed in a streaming batch via `setImmediate`-based chunking so the extension host is never blocked for more than one event-loop tick at a time
- Tree views paginate results ("Load more") rather than rendering all sessions at once
- Webview panels render on demand — no content is prepared until a panel is opened

### 8.2 Caching
- `SessionIndex` caches `getAllCodeBlocks()` and `getAllPrompts()` results in `_codeBlockCache` / `_promptCache`; caches are invalidated on every `upsert`, `remove`, or `batchUpsert`
- Semantic embeddings are persisted to `semantic-embeddings.bin` and reloaded on restart, avoiding full re-embedding after a window reload
- Tree provider sort/filter/pin state is persisted to `globalState` so it is restored instantly on activation without re-computation

### 8.3 Background Processing
- All workspace discovery functions (`discoverCopilotWorkspacesAsync`, etc.) are async and run concurrently at startup via `Promise.all`
- Parser calls during the initial scan are non-blocking; results stream into the index as each file is processed
- The `SemanticIndexer` queues embedding work via `scheduleSession()` and processes it asynchronously, keeping the main index responsive
- Long operations (bulk title regeneration, export) use `vscode.window.withProgress` to report progress without blocking the UI

---

## 9. Testing

All tests live under `test/e2e/` and run inside the VS Code extension host via `@vscode/test-electron`.

### 9.1 Unit / Component Tests (`test/e2e/`)
- **Parser tests** — `copilotParser.test.ts`, `claudeParser.test.ts`, `clineParser.test.ts`, `cursorParser.test.ts`, `windsurfParser.test.ts`, `aiderParser.test.ts`, `antigravityParser.test.ts` — verify each parser produces correct `Session` objects from fixture files
- **Engine tests** — `searchEngine.test.ts`, `analyticsEngine.test.ts`, `embeddingEngine.test.ts`, `codeBlockSearch.test.ts`, `semanticIndexer.test.ts` — verify search, analytics, and embedding logic
- **Provider / view tests** — `modelUsageViewProvider.test.ts`, `timelineViewProvider.test.ts`, `treeViewPagination.test.ts`, `sessionIndex.test.ts` — verify tree provider sort, filter, and pagination behaviour
- **Workspace discovery tests** — `claudeWorkspaceDiscovery.test.ts`, `cursorWorkspaceDiscovery.test.ts`, etc. — verify readers locate the correct files under mock directory trees

### 9.2 Integration Tests (`test/e2e/integration/`)
End-to-end workflow tests that exercise multiple layers together (file watcher → parser → index → search).

### 9.3 Test Fixtures (`test/fixtures/`)
Sample session files in each source format (JSONL, JSON, Markdown, SQLite) covering normal data, malformed lines, oversized lines, and edge cases used across all parser and engine tests.

### 9.4 Helpers (`test/helpers/`)
Shared test utilities (mock VS Code contexts, temp-directory scaffolding, fixture loaders).
