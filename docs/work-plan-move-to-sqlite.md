# ChatWizard — Move to SQLite Persistent Cache Work Plan

_Created: May 2026_

---

## Background & Motivation

Today `SessionIndex` is a pure in-memory store. Every activation re-parses every source
file from scratch (JSONL, JSON, `.vscdb`) and loads all sessions into a `Map<string, Session>`.
This works for a few hundred sessions but hits several structural ceilings as usage grows:

| Problem | Current state | At scale |
|---|---|---|
| Cold-start cost | Acceptable (<1 s) | 5–30 s+ for 10K sessions |
| Copilot JSONL re-parsing | Every line re-read per activation | O(total bytes) regardless of new content |
| `SessionIndex.search()` | Substring scan over all message content | O(n × message_length), can't be persisted |
| Analytics aggregation | All sessions must be in memory | Prevents streaming / partial loads |
| Tags / KB / notes | No durable sidecar storage | Blocks `work-plan-kb-and-tagging.md` |
| MCP SQL interface | Re-indexes every session_store call | Freshness lag, redundant work |

The fix: add a **SQLite persistent store** between raw source files and the in-memory index.
Sessions are parsed once, stored in a local DB, and on subsequent activations only
_changed_ files are re-parsed. The in-memory `SessionIndex` is populated from the DB
at startup — no source-file re-reads for unchanged sessions.

### DB as canonical — decided

Two storage models were considered:

| | Approach A | **Approach B (chosen)** |
|---|---|---|
| JSON files | Intermediate on-disk layer per session | Export artifact only, generated on demand |
| DB role | Query index derived from JSON | Canonical store; single source of truth |
| Writes per parse | Source → JSON file + DB row | Source → DB row only |
| Portability | JSON folder always available | Export command produces JSON/NDJSON when user asks for it |
| Consistency targets | Three things in sync | Two things in sync |

**Why B:** the JSON intermediate layer in A only earns its keep if something consumes it.
Nothing currently does. Writing per-session JSON files on every parse is speculative I/O.
SQLite is already portable as a single file — it opens in DB Browser, DBeaver, Python,
and any BI tool without conversion. JSON export becomes an explicit user-triggered
operation rather than a silent side effect of every re-parse.

**Export path (on demand):**
```
chatwizard-cache.db
    → "Export sessions" command → sessions.ndjson  (newline-delimited, streamable)
    → Or: copy chatwizard-cache.db directly        (SQLite file is self-contained)
```

### Why SQLite (not NoSQL)

`better-sqlite3` is already bundled — it powers the Cursor and Windsurf parsers. No new
native dependency is required.

| Factor | SQLite | Document DB (LevelDB/NeDB) |
|---|---|---|
| Already bundled | ✅ `better-sqlite3` | ❌ new dep |
| Structured schema | ✅ Session/Message types are stable | ✗ benefit lost |
| JOINs (sessions × messages × tags) | ✅ SQL | ✗ app-level joins |
| FTS5 full-text search | ✅ built-in, ranked | ❌ extra lib |
| No server | ✅ embedded | ✅ |
| MCP already speaks SQL | ✅ `session_store_sql` tool | ❌ mismatch |

---

## Proposed Schema

```sql
-- Core tables
CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    workspace_id  TEXT NOT NULL,
    workspace_path TEXT,
    title         TEXT NOT NULL,
    model         TEXT,
    file_path     TEXT NOT NULL,
    file_size_bytes INTEGER,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    parse_errors  TEXT,    -- JSON array of strings, nullable
    source_notes  TEXT     -- JSON array of strings, nullable
);

CREATE TABLE messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content       TEXT NOT NULL,
    timestamp     TEXT,
    message_index INTEGER NOT NULL,
    skipped       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE code_blocks (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    message_index        INTEGER NOT NULL,
    block_index_in_message INTEGER NOT NULL DEFAULT 0,
    language             TEXT NOT NULL DEFAULT '',
    content              TEXT NOT NULL
);

-- User-owned metadata (survives source file changes)
CREATE TABLE tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File-level parse state (incremental parsing)
CREATE TABLE parse_state (
    file_path    TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    last_mtime   INTEGER NOT NULL,  -- epoch ms
    last_size    INTEGER NOT NULL,
    last_offset  INTEGER NOT NULL DEFAULT 0  -- byte offset (JSONL append-only sources)
);

-- FTS5 virtual table — full-text search over message content
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    session_id UNINDEXED,
    message_id UNINDEXED,
    role       UNINDEXED
);

-- Indices
CREATE INDEX idx_sessions_source       ON sessions(source);
CREATE INDEX idx_sessions_workspace    ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated_at   ON sessions(updated_at DESC);
CREATE INDEX idx_messages_session_id   ON messages(session_id, message_index);
CREATE INDEX idx_code_blocks_session   ON code_blocks(session_id);
CREATE INDEX idx_tags_session          ON tags(session_id);
```

**DB location:** `context.globalStorageUri/chatwizard-cache.db`  
(Same directory used by `SemanticIndex` for its binary embedding file.)

---

## Architecture

```
Source files (JSONL / JSON / state.vscdb)        [unchanged on disk, never written to]
        │
        ▼
[FileSystemWatcher]  ──→  changed file detected
        │
        ▼
[CacheManager]  ──  check parse_state (mtime + size)
        │                  │
        │  unchanged ──────┘  load from DB (no file I/O)
        │
        │  changed / new
        ▼
[Parser]  (existing parsers, unchanged public API)
        │
        ▼
[CacheManager.upsertSession()]  ──→  DB: sessions + messages + code_blocks + FTS
        │
        ▼
[SessionIndex.upsert()]  ──→  in-memory Map (unchanged consumer API)


                    ┌─ on user request ─────────────────────────┐
                    │  "Export sessions"                        │
                    ▼                                           │
             sessions.ndjson / .json                           │
             (portability, Obsidian, external BI)              │
                                                               │
             OR: copy chatwizard-cache.db directly ───────────┘
```

The `SessionIndex` public API does **not change**. All callers (tree views, search,
analytics, MCP tools) continue to work without modification.

---

## Components

### `src/cache/cacheManager.ts` (new)

Owns the SQLite connection and all read/write operations.

```typescript
interface CacheManager {
    // Startup: load all sessions from DB into the provided index
    loadAll(index: SessionIndex): Promise<void>;

    // Called after a source file is re-parsed
    upsertSession(session: Session): void;
    upsertSessions(sessions: Session[]): void;
    removeSession(sessionId: string): void;

    // Incremental parse support
    getParseState(filePath: string): ParseState | undefined;
    setParseState(filePath: string, state: ParseState): void;

    // Full-text search (supplements / replaces SessionIndex.search)
    searchFts(query: string, limit?: number): FtsResult[];

    // User metadata
    addTag(sessionId: string, label: string): void;
    removeTag(sessionId: string, label: string): void;
    getTagsForSession(sessionId: string): string[];

    addNote(sessionId: string, note: string): void;
    getNotes(sessionId: string): SessionNote[];

    close(): void;
}
```

### `src/cache/schemaVersion.ts` (new)

Single integer schema version constant. On activation, if the DB schema version is
lower than the current constant, drop and rebuild the DB (full re-parse triggered).
This avoids complex migration logic in v1.

### `SessionIndex` changes (minimal)

- No public API changes.
- `search()` delegates to `CacheManager.searchFts()` when a cache is available,
  falling back to the existing substring scan if not.

### Watcher integration

`src/watcher/` — after a parse produces sessions, pass them to `CacheManager` before
calling `SessionIndex.upsert()`. The `parse_state` table is updated atomically with
the session upsert in a single transaction.

---

## Incremental JSONL Parsing

Copilot JSONL files are append-only. The `parse_state.last_offset` column stores the
byte offset of the last successfully parsed line. On a watcher event:

1. Read `parse_state` for the file.
2. If `mtime` and `size` match → skip entirely.
3. If `size > last_size` (append detected) → open file, seek to `last_offset`, parse
   only new lines, update `last_offset`.
4. If `size < last_size` (file replaced/truncated) → full re-parse.

This reduces re-parse I/O from O(total file size) to O(new bytes) for the common case.

---

## FTS5 Search Integration

`SessionIndex.search()` currently performs a full in-memory substring scan. The FTS5
table enables ranked, persisted full-text search:

```sql
SELECT s.id, s.title, s.source, s.updated_at,
       snippet(messages_fts, 0, '<b>', '</b>', '…', 20) AS snippet
FROM messages_fts
JOIN sessions s ON s.id = messages_fts.session_id
WHERE messages_fts MATCH ?
ORDER BY rank
LIMIT 50;
```

Benefits:
- Sub-millisecond response regardless of corpus size.
- BM25 ranking (most relevant matches first).
- Snippet extraction for search result previews.
- No re-index on restart.

---

## Migration & Rollout

### Phase 1 — Schema + CacheManager (write path)
- [ ] Define schema in `src/cache/schema.sql` (or inline in `cacheManager.ts`)
- [ ] Implement `CacheManager` with `better-sqlite3` (sync API, no async overhead)
- [ ] Wire `upsertSession` / `upsertSessions` into watcher callbacks (write to DB after parse)
- [ ] Update `parse_state` atomically with each upsert (single transaction)
- [ ] Unit tests: upsert → query round-trip, cascade delete, FTS insert

### Phase 2 — Read path (startup from DB)
- [ ] Implement `loadAll()`: query `sessions` + `messages` + `code_blocks`, reconstruct
      `Session` objects, bulk-upsert into `SessionIndex`
- [ ] Schema version check on activation: rebuild if version mismatch
- [ ] Integration test: cold start with populated DB matches cold start from files

### Phase 3 — Incremental JSONL parsing
- [ ] Add `last_offset` logic to Copilot parser + watcher
- [ ] Benchmark cold-start time before/after at 1K / 5K / 10K sessions

### Phase 4 — FTS5 search
- [ ] Replace `SessionIndex.search()` substring scan with `CacheManager.searchFts()`
  when cache is available
- [ ] Add snippet field to `SessionSummary` (optional, for search result previews)
- [ ] Update search panel UI to show snippets

### Phase 5 — User metadata (enables KB + Tagging work plan)
- [ ] Expose `addTag` / `removeTag` / `getTagsForSession` via `CacheManager`
- [ ] Surface tag UI in session tree / detail view
- [ ] `session_notes` table consumed by KB generation pipeline

### Phase 6 — Portability export command
- [ ] Implement `exportSessions(outputPath, format: 'ndjson' | 'json')` in `CacheManager`
- [ ] Add command palette entry: "ChatWizard: Export sessions as JSON"
- [ ] Progress notification for large corpora (10K+ sessions)

### Phase 7 — Dashboard (free tier: predefined charts)
- [ ] Replace current `analyticsPanel.ts` static rendering with Chart.js or Apache ECharts
- [ ] Predefined panels driven by SQL aggregates (no in-memory load required):
  - Activity heatmap: `GROUP BY date(timestamp)`
  - Model usage over time: `GROUP BY model, date(updated_at)`
  - Sessions per source/workspace: `GROUP BY source, workspace_id`
  - Top languages (code blocks): `GROUP BY language ORDER BY COUNT(*) DESC`
  - Prompt length distribution: `AVG/MAX(length(content)) GROUP BY role`
- [ ] Charts receive JSON from extension host via `postMessage`; no DB access in webview

### Phase 8 — Advanced BI (paid tier)

Two paths are available, serving different personas. Both are 100% local — no cloud.

#### Path 1 — In-editor (Paid Local+)
- [ ] Integrate [Perspective.js](https://perspective.finos.org/) (FINOS / J.P. Morgan)
  — WebAssembly pivot table + charts, runs entirely in the webview, no server
- [ ] Feed sessions + messages as Arrow/JSON data into Perspective table
- [ ] Capabilities unlocked:
  - Self-service pivot: user drags dimensions/measures without a code change
  - Cross-filtering: clicking a language filters all other panels simultaneously
  - Saveable custom dashboard layouts
  - Embedded SQL editor panel (query directly against DB via extension host relay)
- [ ] Gate behind `chatwizard.enableAdvancedAnalytics` setting (paid tier flag)

#### Path 2 — Standalone (Paid Power)
- [ ] **[Evidence.dev](https://evidence.dev/)** — ChatWizard generates a static BI site
  from SQL query templates against the SQLite file; writes to a temp folder and opens
  in the browser. No running server after generation. Full multi-page data app with
  proper charts, tables, and SQL-templated pages. Requires Node (already present).
- [ ] **[Metabase](https://www.metabase.com/)** (optional heavy option) — ships as a
  single JAR, connects directly to SQLite. ChatWizard offers a "Launch Metabase" button
  that downloads the JAR on first use and manages the process lifecycle. Provides:
  - True SQL IDE with schema browser, autocomplete, query history
  - Alerting + scheduled reports (Slack/email on metric threshold)
  - Shareable dashboards via `localhost` URL (team use case)
  - Hundreds of chart types (geo maps, Gantt, flame graphs, network)
  - Multi-source data blending (sessions DB + CSV + GitHub API in one chart)
  - Cost: ~300 MB download; Java required

#### Server-side BI trade-off

| Capability | Perspective.js (Path 1) | Evidence.dev (Path 2a) | Metabase (Path 2b) |
|---|---|---|---|
| Install required | None | Node (present) | Java + 300 MB JAR |
| Runs inside VS Code | ✅ | ❌ browser tab | ❌ browser tab |
| Self-service pivot | ✅ | ❌ | ✅ |
| Cross-filtering | ✅ | ❌ | partial |
| Full SQL IDE | relay only | templated SQL | ✅ full IDE |
| Alerting / scheduling | ❌ | ❌ | ✅ |
| Shareable URLs | ❌ | static files | ✅ localhost |
| Data never touches network | ✅ | ✅ | ✅ |
| Generation / startup | instant | ~5–30 s build | server cold-start |

**Evidence.dev** is the recommended Path 2 starting point: it produces full BI-quality
output with no permanent server, no Java, and no process to manage — ChatWizard builds
it on demand and opens the result. Metabase remains available for teams or users who
need alerting and genuine SQL IDE capability.

---

## Lightweight charts vs full BI — the gap

Lightweight charting libraries (Chart.js, Apache ECharts) render **developer-coded, static
charts**. The questions are decided at build time; adding a new chart requires a code
change and a release. They are the right choice for the built-in analytics panel.

Full BI adds:

| Capability | Chart.js / ECharts | Perspective.js | Evidence.dev | Metabase |
|---|---|---|---|---|
| Predefined charts | ✅ | ✅ | ✅ | ✅ |
| Self-service pivot | ❌ | ✅ | ❌ | ✅ |
| Cross-filtering | ❌ | ✅ | ❌ | partial |
| Saveable layouts | ❌ | ✅ | SQL templates | ✅ |
| SQL IDE | ❌ | relay | templated | ✅ full |
| Alerting | ❌ | ❌ | ❌ | ✅ |
| Sharing | ❌ | ❌ | static files | ✅ |
| Bundle / install cost | ~300 KB | ~2 MB wasm | Node | Java + 300 MB |
| Stays inside VS Code | ✅ | ✅ | ❌ | ❌ |

**Tier summary:**

| Tier | Technology | Key differentiator |
|---|---|---|
| Free | Chart.js / Apache ECharts | Curated SQL-backed charts, no in-memory load |
| Paid — Local+ | Perspective.js (wasm) | Self-service pivot, cross-filter, stays in VS Code |
| Paid — Power | Evidence.dev or Metabase | Full BI app outside VS Code; Evidence = no server, Metabase = alerting + SQL IDE |

---

## UI Architecture: WebviewView → WebviewPanel migration

The BI roadmap makes this a prerequisite. VS Code sidebar `WebviewView` panels are
constrained to ~280px width by the workbench layout. Chart.js charts survive it with
`maintainAspectRatio: true`; pivot tables, heatmaps, Gantt-style timelines, and
Perspective.js do not.

### Current state

Four rich panels live as sidebar `WebviewViewProvider` instances:

| Panel | Type today | Full-panel variant exists? |
|---|---|---|
| Analytics | `WebviewViewProvider` (sidebar) | ✅ `AnalyticsPanel` |
| Prompt Library | `WebviewViewProvider` (sidebar) | ✅ `PromptLibraryPanel` |
| Model Usage | `WebviewViewProvider` (sidebar) | ❌ sidebar only |
| Timeline | `WebviewViewProvider` (sidebar) | ❌ sidebar only |

Session viewer and Code Blocks are already full `WebviewPanel` — no change needed.

### Target state

```
Sidebar (stays narrow — navigator only)     Editor area (full width)
─────────────────────────────────────────   ────────────────────────────────────
Sessions tree                               Analytics          (WebviewPanel)
Code Block tree                             Model Usage        (WebviewPanel)
Search / filter                             Timeline           (WebviewPanel)
                                            Prompt Library     (WebviewPanel)
                                            Code Blocks        (WebviewPanel — already)
                                            Session viewer     (WebviewPanel — already)
```

The sidebar becomes a pure **navigator**. All rich data surfaces open in the editor
area where they get full width and can grow as the dashboard evolves.

### Migration tasks
- [ ] Add `ModelUsagePanel` full `WebviewPanel` class (modelled on `AnalyticsPanel`, ~50 lines)
- [ ] Add `TimelinePanel` full `WebviewPanel` class
- [ ] Simplify or remove sidebar `WebviewView` versions of Analytics, ModelUsage, Timeline,
      PromptLibrary — replace sidebar slot with a minimal launch-button view, or remove
      entirely and open panels from tree toolbar / command palette
- [ ] Update `package.json` contributes to reflect view changes
- [ ] This is a **prerequisite for Phase 8** (Perspective.js is unusable at 280px)

---

## Non-goals

- **No writes to source files** — DB is a derived cache + user-metadata store only.
- **No cloud sync** — all local, no network calls.
- **No WAL replication** — single writer (extension host), no concurrency concerns.
- **No complex migrations** — schema version bump triggers full rebuild in v1.
- **No ORM** — raw `better-sqlite3` prepared statements; the schema is simple and stable.

---

## Open Questions

1. **DB size at scale** — with FTS5 the DB stores a copy of all message content.
   Estimate: ~2 KB/message average → 10K sessions × 25 messages = ~500 MB.
   May need a `chatwizard.cacheMaxSizeMb` config to cap FTS indexing.

2. **Semantic index colocation** — the binary `SemanticIndex` file lives next to the DB.
   Should embeddings move into a `embeddings` table (BLOB column) for unified cleanup?

3. **WAL mode** — should `PRAGMA journal_mode=WAL` be enabled? Safer for crash recovery
   and allows concurrent reads during watcher writes. Likely yes.

4. **Workspace-scoped vs global** — current plan is one global DB in `globalStorageUri`.
   Alternative: one DB per workspace. Global is simpler; workspace-scoped is more
   isolatable. Decision deferred to implementation.
