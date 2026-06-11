# ChatWizard — P3 Work Plan (H2 2026)

_Created: June 2026_  
_Source: P3 section of [whats-next.md](whats-next.md)_

---

## Overview

This plan covers all **P3 — H2 2026** features from the master roadmap (features #23–#45).
Each feature is broken into atomic, independently-implementable tasks with UT coverage,
e2e tests, manual verification steps, and a completion gate.

**Effort key:** XS < 1 day · S = 1–3 days · M = 1–2 weeks · L = 3–6 weeks  
**File path conventions:** all paths are workspace-relative from `c:\_\ChatWizard`.

---

## Pre-flight: Implementation Status Audit

Before beginning P3 work, each feature was checked against the current codebase to determine
whether it (or a significant part of it) is already implemented.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 23 | KB entry classification + KB generation | ⬜ Not started | No KB types, classifiers, or export code found. |
| 24 | SQLite persistent cache | ⬜ Not started | `better-sqlite3` is used only for reading external DBs (Chronicle, Cursor, Windsurf). No `chatwizard-cache.db` write path exists. |
| 25 | Git/branch linkage | ⬜ Not started | `activeBranch.branchName` is parsed from Cursor's `state.vscdb` (`src/parsers/cursor.ts`) but is never stored on `Session`, surfaced in the tree, or used for grouping. No git HEAD polling exists. |
| 26 | Workspace Digest / Standup Reports | ⬜ Not started | No command, no report generator found. |
| 27 | Cloud sync (opt-in) | ⬜ Not started | No S3/Azure Blob/GitHub Gist integration anywhere in the codebase. |
| 28 | Session status lifecycle | ✅ Implemented | Status picker, filter by status, context value, tree item display |
| 29 | Bookmarks within a session | ⬜ Not started | No bookmark model or reader jump-to support. |
| 30 | Inline annotations | ⬜ Not started | No annotation model or reader rendering. |
| 31 | Session linking | ⚠️ Stub only | `linkedSessionIds?: string[]` exists in `src/types/index.ts` but is never populated, persisted, or surfaced in the UI. The MCP tool `chatwizard_get_linked` does not exist. Full implementation required. |
| 32 | Response rating | ⬜ Not started | No thumbs-up/down model or UI. |
| 33 | Duplicate / related session detection | ⬜ Not started | No similarity clustering or cross-session deduplication pass post-index. |
| 34 | Outcome / follow-up tracking | ⬜ Not started | No action-item extraction or MCP tool `chatwizard_get_action_items`. |
| 35 | Keyboard-only navigation | ⬜ Not started | No `j/k` bindings or `/` jump-to-search in session tree or reader webview. |
| 36 | Session sharing | ⬜ Not started | No shareable link or exportable HTML bundle mechanism. |
| 37 | Post-session cost tips & analytics | ⚠️ Code complete, disabled | `SessionCostAdvisor`, `SessionCostAdvisorNotifier`, and `SessionCostAdvicePanel` are fully implemented. The notifier is commented out in `src/extension.ts` with the note _"disabled for 1.5.0 — testing deferred to P3"_. **This feature needs testing + re-enabling only**, not re-implementation. |
| 38 | MCP tools: `includeCode` flag | ⬜ Not started | No `includeCode` parameter on any MCP tool. |
| 39 | MCP `/mcp-config` auth hardening | ⚠️ Partially done | All MCP endpoints except `/health` and `/mcp-config` already require a bearer token (confirmed in `src/mcp/mcpServer.ts`). The `/mcp-config` endpoint itself is still unauthenticated — that is the remaining gap. Only a small guard needs to be added. |
| 40 | Antigravity `.pb` (protobuf) support | ⬜ Not started | No `.pb` file reader or wire-type 2 byte scanner. |
| 41 | Zed AI source support | ⬜ Not started | No Zed reader, parser, or `SessionSource` value. |
| 42 | Tabnine Chat source support | ⬜ Not started | No Tabnine reader, parser, or `SessionSource` value. |
| 43 | Session retention controls | ⬜ Not started | No `chatwizard.sessionRetentionDays` or `chatwizard.semanticIndexMaxAgeDays` settings. |
| 44 | API / programmatic access | ⬜ Not started | MCP server exists but no standalone REST endpoint operable outside of VS Code. |
| 45 | Compacted session detection & visibility | ⬜ Not started | No `"type":"summary"` detection in `src/parsers/claude.ts`; no compacted badge or reader block. |

### Key findings

- **Feature 37** is the only P3 feature that is **substantially complete** — it just needs
  testing and re-enabling (see Feature 37 section for the exact re-enable checklist).
- **Feature 39** is ~80% done — only the `/mcp-config` endpoint gap remains (XS effort).
- **Feature 31** has a type-level stub (`linkedSessionIds`) but zero real implementation.
- All other features (#23–#36, #38, #40–#45) are entirely unimplemented.

---

## Table of Contents

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| [23](#feature-23--kb-entry-classification--kb-generation) | KB entry classification + KB generation | L | ⬜ |
| [24](#feature-24--sqlite-persistent-cache) | SQLite persistent cache | L | ⬜ |
| [25](#feature-25--gitbranch-linkage) | Git/branch linkage | M | ⬜ |
| [26](#feature-26--workspace-digest--standup-reports) | Workspace Digest / Standup Reports | M | ⬜ |
| [27](#feature-27--cloud-sync-opt-in) | Cloud sync (opt-in) | L | ⬜ |
| [28](#feature-28--session-status-lifecycle) | Session status lifecycle | S | ✅ |
| [29](#feature-29--bookmarks-within-a-session) | Bookmarks within a session | S | ⬜ |
| [30](#feature-30--inline-annotations) | Inline annotations | S | ⬜ |
| [31](#feature-31--session-linking) | Session linking | M | ⚠️ Stub |
| [32](#feature-32--response-rating) | Response rating | S | ⬜ |
| [33](#feature-33--duplicate--related-session-detection) | Duplicate / related session detection | M | ⬜ |
| [34](#feature-34--outcome--follow-up-tracking) | Outcome / follow-up tracking | S | ⬜ |
| [35](#feature-35--keyboard-only-navigation) | Keyboard-only navigation | S | ⬜ |
| [36](#feature-36--session-sharing) | Session sharing | M | ⬜ |V
| [37](#feature-37--post-session-cost-tips--analytics) | Post-session cost tips & analytics | S | ⚠️ Re-enable only |
| [38](#feature-38--mcp-tools-includecode-flag) | MCP tools: `includeCode` flag | S | ⬜ |
| [39](#feature-39--mcp-mcp-config-auth-hardening) | MCP `/mcp-config` auth hardening | XS | ⚠️ Partial |
| [40](#feature-40--antigravity-pb-protobuf-support) | Antigravity `.pb` (protobuf) support | S | ⬜ |
| [41](#feature-41--zed-ai-source-support) | Zed AI source support | S | ⬜ |
| [42](#feature-42--tabnine-chat-source-support) | Tabnine Chat source support | M | ⬜ |
| [43](#feature-43--session-retention-controls) | Session retention controls | S | ⬜ |
| [44](#feature-44--api--programmatic-access) | API / programmatic access | M | ⬜ |
| [45](#feature-45--compacted-session-detection--visibility) | Compacted session detection & visibility | S | ⬜ |

---

## Feature 23 — KB Entry Classification + KB Generation

_Effort: L · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1) and Feature 13 (session tagging, P2)_

### Context

Sessions contain implicit knowledge: decisions made, patterns discovered, gotchas hit,
architectural choices. This feature classifies each session into one of five types using
local heuristics (no LLM), clusters classified sessions by tags and embedding similarity,
and exports the result as an Obsidian-compatible Markdown knowledge base. Incremental
re-runs append new entries; user edits are preserved via `locked: true` frontmatter.

---

### Task 23-A — Define KB entry types and classifier interface

**File:** `src/types/kb.ts` (new)

```ts
export type KbEntryType = 'decision' | 'learning' | 'pattern' | 'gotcha' | 'architecture';

export interface KbEntry {
    sessionId: string;
    type: KbEntryType;
    title: string;         // derived from session title or first user message
    summary: string;       // 1–3 sentence summary of the knowledge
    tags: string[];        // from sidecar metadata tags
    clusterId?: string;    // assigned during clustering pass
    locked?: boolean;      // user marked — skip on re-run
    createdAt: string;     // ISO-8601
}
```

**Acceptance:** Types compile; `KbEntryType` covers all five categories.

---

### Task 23-B — Implement session classifier

**File:** `src/analytics/kbClassifier.ts` (new)

```ts
export function classifySession(session: Session): KbEntryType
```

Heuristic rules (evaluated in order; first match wins) applied against the concatenated
text of the first 10 messages, lowercased:

| Type | Signal phrases |
|------|----------------|
| `decision` | "i decided", "we chose", "we went with", "the reason we", "trade-off", "alternative" |
| `gotcha` | "gotcha", "footgun", "be careful", "watch out", "don't forget", "turns out", "fixed by" |
| `architecture` | "architecture", "component", "service", "layer", "schema", "system design", "dependency graph" |
| `pattern` | "pattern", "template", "reusable", "abstraction", "convention", "strategy" |
| `learning` | fallthrough — any session not matching the above |

**Acceptance:** `classifySession` returns the correct type for one representative fixture
session per category; returns `'learning'` for a neutral conversational session.

---

### Task 23-C — Implement embedding-based clustering

**File:** `src/analytics/kbClusterer.ts` (new)

```ts
export function clusterEntries(
    entries: KbEntry[],
    embeddingFn: (text: string) => Float32Array
): Map<string, KbEntry[]>
```

- **Primary:** group by the first tag from sidecar metadata. Sessions without tags form a
  `'general'` bucket.
- **Refinement:** within each tag group, sub-cluster by cosine similarity of session
  embeddings (threshold 0.65, greedy single-linkage).
- `clusterId` is either the tag name or `'general-N'` for untagged sub-clusters.

**Acceptance:** All entries sharing tag `'auth'` land in the same cluster; untagged entries
with high embedding similarity land in the same sub-cluster.

---

### Task 23-D — Implement KB Markdown exporter

**File:** `src/export/kbExporter.ts` (new)

```ts
export async function exportKbAsync(
    entries: KbEntry[],
    clusters: Map<string, KbEntry[]>,
    outputDir: string,
    options: { incrementalUpdate: boolean }
): Promise<void>
```

Output structure:
```
<outputDir>/
  index.md             — table of contents
  decisions/<id>.md
  learnings/<id>.md
  patterns/<id>.md
  gotchas/<id>.md
  architecture/<id>.md
```

Each file uses YAML frontmatter:
```yaml
---
sessionId: <id>
type: decision
tags: [auth, jwt]
createdAt: 2026-06-01T10:00:00Z
locked: false
---
# <title>

<summary>

---
_Source: ChatWizard session · [Open in VS Code](vscode://chatwizard/session/<id>)_
```

Incremental update: skip any file with `locked: true` in its frontmatter.

**Acceptance:** Correct directory structure is produced; `locked: true` files are not
overwritten on a second run; `index.md` links to every entry.

---

### Task 23-E — Wire command and UI

**File:** `src/commands/` + `package.json`

Register command `chatwizard.generateKb` — "ChatWizard: Generate Knowledge Base".

Flow:
1. QuickPick to select output directory (default: `<workspace>/.chatwizard-kb`).
2. Run classifier + clusterer + exporter with a progress notification.
3. On success, offer "Open Output Folder" button.

**Acceptance:** Command appears in palette; KB is generated at the chosen path; progress
notification is shown.

---

### UT coverage — Feature 23

- `classifySession` returns correct type for one fixture session per category.
- `classifySession` returns `'learning'` for a session with no signal phrases.
- `clusterEntries` groups entries sharing the same tag into one cluster.
- `clusterEntries` sub-clusters untagged high-similarity entries together.
- `exportKbAsync` creates expected files for a two-entry fixture.
- `exportKbAsync` with `incrementalUpdate: true` does not overwrite a `locked: true` file.

---

### e2e tests — Feature 23

1. Run `chatwizard.generateKb` against a fixture index with 10 sessions spanning all 5 types.
2. Assert `index.md` contains 10 links.
3. Assert each type subdirectory contains the correct number of files.
4. Run again with one file marked `locked: true` — assert that file is unchanged.

---

### Manual tests — Feature 23

1. Run "ChatWizard: Generate Knowledge Base" on a real session index — verify the KB structure.
2. Open `index.md` in Obsidian — verify wikilinks resolve correctly.
3. Mark a file `locked: true`; re-run the command — verify the file is not overwritten.

---

### Completion gate — Feature 23

- [ ] Tasks 23-A through 23-E implemented and passing lint.
- [ ] All UT assertions pass.
- [ ] e2e scenario passes.
- [ ] Manual: KB generated correctly; locked files preserved; Obsidian wikilinks valid.
- [ ] **Feature 23 complete.**

---

---

## Feature 24 — SQLite Persistent Cache

_Effort: L · Priority: P3 · No blockers (should be completed before Feature 27)_

### Context

The in-memory session index is rebuilt from scratch on every VS Code startup, causing
cold-start latency for power users (10K+ sessions). Replacing it with a
`chatwizard-cache.db` SQLite store means sessions are parsed once and loaded from the DB on
subsequent startups. An FTS5 virtual table provides BM25-ranked full-text search. The schema
also adds proper tables for tags, notes, and code blocks (prerequisites for P3 features).

---

### Task 24-A — Define the SQLite schema

**File:** `src/index/sqliteSchema.ts` (new)

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT,
    updated_at TEXT,
    message_count INTEGER,
    token_estimate INTEGER,
    workspace_path TEXT,
    sidecar_json TEXT,
    raw_json TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS tags (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS code_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    language TEXT,
    content TEXT
);

CREATE TABLE IF NOT EXISTS parse_state (
    source_path TEXT PRIMARY KEY,
    last_byte_offset INTEGER NOT NULL DEFAULT 0,
    last_mtime TEXT
);
```

Store `user_version` pragma for schema migration (see Task 24-E).

**Acceptance:** Schema is created without errors in a fresh DB; all tables and the FTS5
virtual table exist after init.

---

### Task 24-B — Implement `SqliteCacheStore`

**File:** `src/index/sqliteCacheStore.ts` (new)

```ts
export class SqliteCacheStore {
    constructor(dbPath: string) {}
    open(): void
    close(): void
    upsertSession(session: Session): void
    removeSession(id: string): void
    getAllSummaries(): SessionSummary[]
    getSession(id: string): Session | undefined
    searchFts(query: string, limit?: number): SessionSummary[]
    getParseState(sourcePath: string): { lastByteOffset: number; lastMtime: string } | undefined
    setParseState(sourcePath: string, offset: number, mtime: string): void
}
```

- Open with `{ fileMustExist: false }` — creates DB on first run.
- `upsertSession` writes to `sessions` and updates `sessions_fts` (delete + re-insert for
  FTS5 updates).
- `searchFts` uses `SELECT id FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank`.
- `getParseState` / `setParseState` power incremental JSONL parsing (byte-offset aware).

**Acceptance:** All methods work against a test DB; FTS5 search returns results ranked by
BM25 score.

---

### Task 24-C — Integrate `SqliteCacheStore` into `SessionIndex`

**File:** `src/index/sessionIndex.ts`

Replace the `Map<string, Session>` in-memory store with `SqliteCacheStore`. On startup:
1. Open the DB at `globalStorageUri/chatwizard-cache.db`.
2. Load all summaries (IDs + titles) into a lightweight in-memory map for tree rendering.
3. For full session access (reader, search context), fetch from DB on demand.

Incremental parsing: before parsing a JSONL source, check `parse_state` for the file's last
byte offset; start reading from that offset; update `parse_state` after each session written.

**Acceptance:** Cold-start time is ≤ 500 ms for a 10K-session corpus on second launch
(all sessions already in DB, zero re-parsing).

---

### Task 24-D — Migrate full-text search to FTS5

**File:** `src/search/fullTextEngine.ts`

Add a `SqliteFtsEngine` implementing the existing `ISearchEngine` interface, wrapping
`SqliteCacheStore.searchFts()`. The existing in-memory inverted-index engine remains as
a fallback during first activation before any sessions are written to the DB.

**Acceptance:** FTS5 search returns the same top results as the in-memory engine for
representative queries against a fixture corpus.

---

### Task 24-E — DB migration / version guard

**File:** `src/index/sqliteCacheStore.ts`

On `open()`, compare `PRAGMA user_version` to the expected schema version constant. If the
stored version is lower, drop and recreate all tables, then update the pragma. Log the
migration so the Output panel shows a clear message.

**Acceptance:** Bumping the schema version constant triggers a full DB rebuild on next startup
without any corrupt data being surfaced.

---

### UT coverage — Feature 24

- `SqliteCacheStore.upsertSession` + `getSession` round-trip preserves all Session fields.
- `searchFts` ranks a session with exact query token above one with only partial overlap.
- `getParseState` returns `undefined` for an unknown path.
- `setParseState` + `getParseState` round-trip preserves values.
- Schema version bump triggers table recreation without crashing.

---

### e2e tests — Feature 24

1. Index 100 fixture sessions; close and reopen the extension; assert all sessions are
   present without re-parsing source files (check parse_state byte offsets unchanged).
2. Add a new fixture session file; assert only the new session is parsed (incremental).
3. FTS5 search returns BM25-ranked results consistent with in-memory engine.
4. Delete a fixture session file; assert the session is removed from the DB.

---

### Manual tests — Feature 24

1. Activate with a real large corpus; measure startup time before and after (Output panel
   timestamps) — verify measurable improvement on second startup.
2. Verify search results appear ranked by relevance rather than insertion order.
3. Delete `chatwizard-cache.db` from `globalStorageUri`; restart — verify full re-index
   completes without errors.

> **Pre-flight note:** `better-sqlite3` native module must be pre-built for the VS Code
> Node.js version. Use the existing `scripts/rebuild-native.js` pattern. Test on Windows
> specifically — WAL lock behavior differs from macOS/Linux.

---

### Completion gate — Feature 24

- [ ] Tasks 24-A through 24-E implemented and passing lint.
- [ ] All UT assertions pass.
- [ ] e2e: cold-start, incremental parse, ranked search, deletion scenarios pass.
- [ ] Manual: startup improvement measurable; no data loss on DB deletion.
- [ ] **Feature 24 complete.**

---

---

## Feature 25 — Git/Branch Linkage

_Effort: M · Priority: P3 · No blockers_

### Context

Record the active git branch and HEAD commit at session-open time for all sources. Tag
sessions by branch in the tree view. Show repository state in the session reader.

**Note:** `activeBranch.branchName` is already parsed from Cursor's `state.vscdb`
(`src/parsers/cursor.ts`) but is never stored on `Session` or surfaced in the UI. This
feature wires up that existing data and adds git HEAD polling for all other sources.

---

### Task 25-A — Add `gitContext` to the `Session` type

**File:** `src/types/index.ts`

```ts
export interface GitContext {
    branch: string;
    headCommit?: string;   // short SHA (7 chars)
    repoRoot?: string;
}

// Add to Session interface:
gitContext?: GitContext;
```

**Acceptance:** Type compiles; existing Session construction is unaffected (field is optional).

---

### Task 25-B — Implement `GitContextReader`

**File:** `src/utils/gitContextReader.ts` (new)

```ts
export async function readGitContextAsync(
    workspacePath: string
): Promise<GitContext | undefined>
```

- Execute `git -C <workspacePath> rev-parse --abbrev-ref HEAD` for branch name.
- Execute `git -C <workspacePath> rev-parse --short HEAD` for commit hash.
- Return `undefined` gracefully when git is absent or the path is not a repo.
- Cap subprocess execution at 2 seconds.

**Acceptance:** Returns correct branch + commit for a real git repo; returns `undefined`
for a non-git directory.

---

### Task 25-C — Populate `gitContext` during indexing

**File:** `src/index/sessionIndex.ts`

When a session is first indexed:
- **Copilot sessions:** use Chronicle `sessions.branch` field if available (Chronicle Phase 4).
- **Cursor sessions:** wire `activeBranch.branchName` already parsed by `src/parsers/cursor.ts`
  into `session.gitContext.branch`.
- **All other sources:** call `readGitContextAsync(session.workspacePath)` once per unique
  workspace path (cache results for 5 minutes to avoid repeated subprocess calls).

**Acceptance:** Sessions from a git-tracked workspace have `gitContext.branch` populated;
sessions from a non-git workspace have `gitContext === undefined`.

---

### Task 25-D — Branch grouping in session tree

**File:** `src/views/sessionTreeProvider.ts`

Add a "Group by Branch" option to the existing Group Sessions QuickPick. When active, the
tree shows one top-level node per unique branch name with sessions as children. Sessions with
`gitContext === undefined` are grouped under `(no branch)`.

**Acceptance:** Tree groups sessions by branch; "(no branch)" group contains git-less sessions.

---

### Task 25-E — Show git context in session reader header

**File:** `src/webview/` (session reader)

Add a `$(git-branch) <branchName> · <shortSHA>` line in the session reader header when
`gitContext` is available.

**Acceptance:** Sessions with `gitContext` show branch + commit in the reader header;
sessions without show nothing extra.

---

### UT coverage — Feature 25

- `readGitContextAsync` with a temp dir (git init + commit) returns correct branch and commit.
- `readGitContextAsync` with a non-git directory returns `undefined` without throwing.
- `readGitContextAsync` when git binary is absent returns `undefined` without throwing.
- Session index populates `gitContext.branch` for a Cursor fixture with `activeBranch` data.

---

### e2e tests — Feature 25

1. Index two fixture sessions tagged with branches `feature/auth` and `main`.
2. Enable "Group by Branch" — assert two branch groups are visible.
3. Open session reader for a session with `gitContext` — assert the branch line appears.

---

### Manual tests — Feature 25

1. Open a workspace in a git repo; verify session tree shows branch grouping option and groups
   are correct.
2. Open a session reader — verify branch/commit line is visible.
3. Switch git branch and open a new session — verify the new session shows the updated branch.

---

### Completion gate — Feature 25

- [ ] Tasks 25-A through 25-E implemented.
- [ ] All UT assertions pass.
- [ ] e2e: branch grouping and reader header verified.
- [ ] Manual: branch visible in tree and reader; switching branches reflected.
- [ ] **Feature 25 complete.**

---

---

## Feature 26 — Workspace Digest / Standup Reports

_Effort: M · Priority: P3 · Depends on: Feature 18 (session summaries, P2) for richer output; Feature 25 for branch grouping_

### Context

A command that generates a copy-pasteable standup update or PR description from the timeline
and session summaries for a chosen time window (today / this week / this sprint).

---

### Task 26-A — Implement `DigestBuilder`

**File:** `src/analytics/digestBuilder.ts` (new)

```ts
export type DigestWindow = 'today' | 'thisWeek' | 'thisSprint';

export interface DigestEntry {
    sessionId: string;
    title: string;
    summary: string;      // from Feature 18 or first assistant message as fallback
    branch?: string;
    date: string;
}

export function buildDigest(
    sessions: Session[],
    window: DigestWindow,
    now?: Date
): { entries: DigestEntry[]; markdown: string }
```

Output format:
```markdown
## What I worked on [today]

### feature/auth (2 sessions)
- **JWT refresh token** — Added refresh token rotation with Redis.
- **Auth middleware refactor** — Extracted middleware to reduce duplication.

### main (1 session)
- **Hotfix: null pointer in user service** — Fixed NPE in getUserById.

_Generated by ChatWizard · 2 Jun 2026_
```

Fall back to the first assistant message text (truncated to 120 chars) when no summary exists.

**Acceptance:** `buildDigest` filters sessions by window; groups by branch when available;
falls back gracefully for sessions without summaries.

---

### Task 26-B — Register `chatwizard.generateDigest` command

**File:** `src/commands/` + `package.json`

Flow:
1. QuickPick: "Today", "This Week", "This Sprint".
2. Run `buildDigest` with a progress notification.
3. Open a new untitled Markdown editor with the output.
4. Show an info message with a "Copy to Clipboard" action button.

**Acceptance:** Command appears in palette; output opens in an untitled Markdown editor;
Copy button copies the content to clipboard.

---

### UT coverage — Feature 26

- `buildDigest('today')` includes only sessions from today (UTC).
- `buildDigest('thisWeek')` includes sessions from current Monday onward.
- `buildDigest` groups sessions by branch when `gitContext` is available.
- `buildDigest` falls back to first assistant message when no session summary exists.

---

### e2e tests — Feature 26

1. Run `chatwizard.generateDigest` with a fixture index containing sessions from today,
   yesterday, and last week.
2. Assert "today" output contains only today's sessions.
3. Assert output Markdown starts with `## What I worked on`.

---

### Manual tests — Feature 26

1. Run "ChatWizard: Generate Workspace Digest" → "Today" — verify standup output looks correct.
2. Run with "This Week" — verify more sessions appear.
3. Click "Copy to Clipboard" — paste into a text editor and verify content.

---

### Completion gate — Feature 26

- [ ] Tasks 26-A and 26-B implemented.
- [ ] All UT assertions pass.
- [ ] e2e: window filtering and output format verified.
- [ ] Manual: standup output looks correct; copy to clipboard works.
- [ ] **Feature 26 complete.**

---

---

## Feature 27 — Cloud Sync (Opt-In)

_Effort: L · Priority: P3 · Depends on: Feature 24 (SQLite cache — sync uploads the DB artifact)_

### Context

Optional, encrypted sync of the session index (not source files) to user's own storage:
S3, Azure Blob, or GitHub Gist. Keys are managed locally. Enables cross-machine history
without compromising the privacy-first brand. This is the key Individual Pro tier feature.

---

### Task 27-A — Define sync configuration and provider interface

**File:** `src/sync/syncProvider.ts` (new)

```ts
export type SyncBackend = 's3' | 'azureBlob' | 'githubGist';

export interface SyncConfig {
    backend: SyncBackend;
    encryptionKey: string;     // 32-byte hex — stored in VS Code SecretStorage
    // S3
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;   // stored in SecretStorage
    // Azure Blob
    azureConnectionString?: string;
    azureContainer?: string;
    // GitHub Gist
    githubToken?: string;         // stored in SecretStorage
    githubGistId?: string;
}

export interface ISyncProvider {
    upload(localPath: string, remoteName: string): Promise<void>
    download(remoteName: string, localPath: string): Promise<void>
    listRemote(): Promise<string[]>
}
```

**Acceptance:** Interface compiles; `SyncConfig` covers all three backends.

---

### Task 27-B — Implement AES-256-GCM encryption layer

**File:** `src/sync/syncEncryption.ts` (new)

```ts
export function encryptFile(inputPath: string, outputPath: string, key: Buffer): Promise<void>
export function decryptFile(inputPath: string, outputPath: string, key: Buffer): Promise<void>
```

Use Node.js built-in `crypto.createCipheriv('aes-256-gcm', ...)`. Prepend a 12-byte random
IV and a 16-byte GCM auth tag to the output file. Never store the key on disk — read from
VS Code `SecretStorage` at call time.

**Acceptance:** `encrypt` → `decrypt` round-trip produces identical output to the original
input. Tampered ciphertext fails decryption with an error (auth tag mismatch).

---

### Task 27-C — Implement S3 sync provider

**File:** `src/sync/s3SyncProvider.ts` (new)

Uses the AWS SDK v3 `@aws-sdk/client-s3` (add as a dependency). Uploads the encrypted DB
blob to `s3://<bucket>/chatwizard-index/<machineId>.db.enc`. Downloads and decrypts on a
new machine.

**Acceptance:** Upload and download work against a real S3 bucket in integration tests
(skipped in CI; guarded by `CHATWIZARD_TEST_S3_BUCKET` env var).

---

### Task 27-D — Implement GitHub Gist sync provider

**File:** `src/sync/gistSyncProvider.ts` (new)

Uses the GitHub REST API (no extra npm dependency — plain `fetch`). Stores the encrypted
blob as a binary-encoded Base64 file in a private Gist. Size limit: 10 MB (GitHub Gist
limit) — show a warning and skip sync if the DB exceeds this.

**Acceptance:** Upload and download work against the GitHub Gist API in integration tests
(guarded by `CHATWIZARD_TEST_GITHUB_TOKEN` env var).

---

### Task 27-E — Sync scheduler and VS Code settings

**File:** `src/sync/syncScheduler.ts` (new) + `package.json` settings

Settings:
- `chatwizard.sync.enabled` (boolean, default `false`)
- `chatwizard.sync.backend` (`'s3' | 'azureBlob' | 'githubGist'`)
- `chatwizard.sync.intervalMinutes` (number, default `60`)

On activation, if sync is enabled, start a timer that calls `uploadAsync()` every N minutes.
On first enable, run a `downloadAsync()` to pull remote state before uploading.

Register commands:
- `chatwizard.syncNow` — "ChatWizard: Sync Now"
- `chatwizard.syncConfigure` — opens the settings UI for sync configuration

**Acceptance:** Sync runs on the configured interval; manual sync command works; errors are
surfaced as warning toasts (never block the extension).

---

### UT coverage — Feature 27

- `encryptFile` + `decryptFile` round-trip produces identical content.
- Decryption of a tampered ciphertext throws an error.
- `SyncScheduler` does not start when `chatwizard.sync.enabled` is `false`.
- `SyncScheduler` calls `uploadAsync` after the configured interval elapses (use fake timers).

---

### e2e tests — Feature 27

Integration tests (require env vars, skipped in CI without them):
1. S3: upload DB → verify object exists → download → decrypt → verify content matches original.
2. Gist: upload → list remote → download → verify content matches original.

---

### Manual tests — Feature 27

1. Configure sync to GitHub Gist; run `chatwizard.syncNow` — verify the Gist is created.
2. On a second machine, configure the same Gist ID and token; run `chatwizard.syncNow` —
   verify sessions from the first machine appear.
3. Disable sync (`chatwizard.sync.enabled: false`) — verify no automatic upload occurs.

> **Pre-flight note:** AWS SDK v3 adds ~3 MB to the VSIX. Consider lazy-loading the S3
> provider only when `backend === 's3'` to avoid VSIX size regression for non-S3 users.

---

### Completion gate — Feature 27

- [ ] Tasks 27-A through 27-E implemented.
- [ ] Encryption round-trip UT passes; tamper detection UT passes.
- [ ] Scheduler UT (fake timers) passes.
- [ ] Integration tests pass (with env vars) for at least one backend.
- [ ] Manual: cross-machine sync verified on at least one backend.
- [ ] **Feature 27 complete.**

---

---

## Feature 28 — Session Status Lifecycle

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Mark sessions as `open`, `resolved`, or `revisit` to track which threads are still active.
Filter the session tree by status. Status is stored in sidecar metadata.

---

### Task 28-A — Add `status` to `SessionMetadata`

**File:** `src/types/index.ts`

```ts
export type SessionStatus = 'open' | 'resolved' | 'revisit';

// Add to SessionMetadata:
status?: SessionStatus;
```

**Acceptance:** Type compiles; existing sidecar metadata is unaffected (field is optional,
defaults to `undefined` which behaves as `'open'`).

---

### Task 28-B — Add status commands and context menu

**File:** `src/commands/` + `package.json`

Register three commands:
- `chatwizard.setStatusOpen` — "Mark as Open"
- `chatwizard.setStatusResolved` — "Mark as Resolved"
- `chatwizard.setStatusRevisit` — "Mark for Revisit"

Wire into the session tree item right-click context menu.

**Acceptance:** Right-clicking a session shows the three status options; selecting one updates
the sidecar metadata and refreshes the tree item.

---

### Task 28-C — Show status badge in tree item and reader

**File:** `src/views/sessionTreeProvider.ts` + `src/webview/`

- Tree item: append a small icon/badge after the title (`$(check)` for resolved, `$(eye)`
  for revisit, nothing for open).
- Session reader header: show the current status as a chip with a "Change" button.

**Acceptance:** Status badge appears correctly in the tree for each status value; reader
header shows the status chip.

---

### Task 28-D — Filter tree view by status

**File:** `src/views/sessionTreeProvider.ts`

Add a "Filter by Status" option to the existing filter QuickPick (alongside filter by source
and date already present). Options: "All", "Open", "Resolved", "Revisit".

**Acceptance:** Selecting "Resolved" shows only resolved sessions; "All" restores the full
list.

---

### UT coverage — Feature 28

- Setting status to `'resolved'` persists in sidecar metadata and is read back correctly.
- Tree filter with `status: 'revisit'` returns only sessions with that status from a fixture
  containing all three status values.

---

### e2e tests — Feature 28

1. Set a fixture session status to `'resolved'` via command.
2. Filter by "Resolved" — assert only that session appears.
3. Change status to `'revisit'` — assert the session moves to the correct filter group.

---

### Manual tests — Feature 28

1. Right-click a session in the tree — verify three status options appear.
2. Mark as "Resolved" — verify the `$(check)` badge appears in the tree.
3. Filter by "Revisit" — verify only revisit sessions are shown.
4. Open the session reader for a resolved session — verify the status chip is visible.

---

### Completion gate — Feature 28

- [ ] Tasks 28-A through 28-D implemented.
- [ ] UT: status persistence and tree filter pass.
- [ ] e2e: status change + filter verified.
- [ ] Manual: status badge, context menu, and filter all work correctly.
- [ ] **Feature 28 complete.**

---

---

## Feature 29 — Bookmarks Within a Session

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Mark a specific exchange inside a long session. Jump to the bookmark in the session reader.
Stored in sidecar metadata. Targets power users with sessions of 100+ messages.

---

### Task 29-A — Add `bookmarks` to `SessionMetadata`

**File:** `src/types/index.ts`

```ts
export interface SessionBookmark {
    messageIndex: number;      // 0-based index into session.messages
    note?: string;             // optional user note
    createdAt: string;         // ISO-8601
}

// Add to SessionMetadata:
bookmarks?: SessionBookmark[];
```

**Acceptance:** Type compiles; existing metadata is unaffected.

---

### Task 29-B — Add bookmark UI in session reader

**File:** `src/webview/` (session reader)

- Add a bookmark icon button (`$(bookmark)`) to each message card's action row.
- Clicking toggles the bookmark on/off (sends `bookmarkMessage` message to the extension host).
- Bookmarked messages display a filled bookmark icon and a subtle highlight.
- A "Bookmarks" jump list in the reader sidebar lists all bookmarks with a one-click scroll-to.

**Acceptance:** Bookmark button toggles correctly; bookmarked messages are visually distinct;
jump list scrolls to the correct message.

---

### Task 29-C — Persist bookmarks in sidecar metadata

**File:** Extension host handler for `bookmarkMessage` webview message.

On toggle: read current sidecar metadata → add or remove the `SessionBookmark` entry →
write back to sidecar. Send an updated bookmarks list back to the webview.

**Acceptance:** Bookmarks survive VS Code restart; toggling off removes the bookmark from
sidecar.

---

### UT coverage — Feature 29

- Adding a bookmark for message index 5 creates a `SessionBookmark` with correct `messageIndex`.
- Toggling the same bookmark off removes it from the array.
- Bookmarks survive serialization/deserialization round-trip via sidecar JSON.

---

### e2e tests — Feature 29

1. Bookmark message index 3 in a fixture session — verify sidecar contains the bookmark.
2. Reopen the session reader — verify the bookmarked message has the filled icon.
3. Click the jump-list entry — verify the reader scrolls to message 3.

---

### Manual tests — Feature 29

1. Open a long session; bookmark several messages — verify they highlight.
2. Close and reopen the reader — verify bookmarks persist.
3. Click a jump-list entry — verify scroll behavior.

---

### Completion gate — Feature 29

- [ ] Tasks 29-A through 29-C implemented.
- [ ] UT: add, toggle-off, and round-trip assertions pass.
- [ ] e2e: persist and jump-to-bookmark verified.
- [ ] Manual: bookmark icon, persistence, and jump list all work.
- [ ] **Feature 29 complete.**

---

---

## Feature 30 — Inline Annotations

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Attach a personal note to any message: _"I ended up not using this approach because…"_.
Displayed inline in the session reader as a small comment thread. Stored in sidecar metadata.

---

### Task 30-A — Add `annotations` to `SessionMetadata`

**File:** `src/types/index.ts`

```ts
export interface MessageAnnotation {
    messageIndex: number;
    text: string;
    createdAt: string;      // ISO-8601
    updatedAt?: string;
}

// Add to SessionMetadata:
annotations?: MessageAnnotation[];
```

---

### Task 30-B — Add annotation UI in session reader

**File:** `src/webview/` (session reader)

- Add an "Add note" icon (`$(comment)`) to each message card's action row.
- Clicking opens an inline editable textarea below the message.
- Saving sends `saveAnnotation` to the extension host; cancelling discards changes.
- Existing annotations are rendered as a light-yellow comment block below the message,
  with an "Edit" and "Delete" button.

**Acceptance:** Annotation textarea opens inline; saved annotations render correctly; edit
and delete work.

---

### Task 30-C — Persist annotations in sidecar metadata

On `saveAnnotation`: read sidecar → upsert annotation (match by `messageIndex`) → write back.
On delete: remove matching entry. Send updated annotation back to the webview.

**Acceptance:** Annotations survive VS Code restart; edits update `updatedAt`; deletion
removes the entry.

---

### UT coverage — Feature 30

- Adding an annotation for message index 2 creates a `MessageAnnotation` with correct fields.
- Updating the same annotation sets `updatedAt` and preserves `createdAt`.
- Deleting an annotation removes it from the array.

---

### e2e tests — Feature 30

1. Add an annotation to message 2 in a fixture session — verify sidecar contains it.
2. Reopen the reader — verify the annotation block renders below the message.
3. Delete the annotation — verify it is removed from sidecar.

---

### Manual tests — Feature 30

1. Click "Add note" on a message — verify the textarea opens inline.
2. Type and save — verify the annotation block appears.
3. Restart VS Code — verify the annotation persists.
4. Click "Edit" — verify the textarea is pre-filled; save changes.
5. Click "Delete" — verify the annotation block disappears.

---

### Completion gate — Feature 30

- [ ] Tasks 30-A through 30-C implemented.
- [ ] UT: add, update, and delete assertions pass.
- [ ] e2e: persist and render verified.
- [ ] Manual: inline textarea, edit, delete, and persistence all work.
- [ ] **Feature 30 complete.**

---

---

## Feature 31 — Session Linking

_Effort: M · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Explicitly link two sessions (_"this continued in session X"_), creating a conversation
graph. Navigate forward/backward through linked sessions. Expose via MCP tool
`chatwizard_get_linked`.

**Note:** `linkedSessionIds?: string[]` already exists in `src/types/index.ts` as a stub.
It is never populated, persisted, or surfaced. Full implementation is required.

---

### Task 31-A — Wire `linkedSessionIds` to sidecar metadata

The existing `linkedSessionIds` field on `Session` was added as a stub. Move it to
`SessionMetadata` (sidecar) so links are persisted independently of source files and survive
re-indexing.

**File:** `src/types/index.ts` — remove `linkedSessionIds` from `Session`; add to
`SessionMetadata`:

```ts
// SessionMetadata:
linkedSessionIds?: string[];
```

**Acceptance:** Migration: on first load, if a `Session` has a non-empty `linkedSessionIds`,
copy it to sidecar metadata and clear the source field.

---

### Task 31-B — Add link/unlink commands and UI

**File:** `src/commands/` + `package.json`

Register:
- `chatwizard.linkSession` — "ChatWizard: Link Session to Another"

Flow: show a QuickPick of all indexed sessions; selecting one adds a bidirectional link
(both sessions' sidecar metadata are updated).

Also add "Linked Sessions" section to the session reader sidebar listing all linked sessions
with titles and dates. Clicking navigates to the linked session reader.

**Acceptance:** Linking A to B adds B to A's `linkedSessionIds` and A to B's; reader sidebar
shows the link in both sessions.

---

### Task 31-C — Implement `chatwizard_get_linked` MCP tool

**File:** `src/mcp/tools/getLinkedTool.ts` (new)

```ts
// Input: { sessionId: string }
// Output: Array<{ sessionId, title, source, date, summary }>
```

Returns all sessions linked to the given session. Returns empty array (not an error) if no
links exist.

**Acceptance:** MCP tool returns correct linked sessions for a fixture session with two links;
returns `[]` for an unlinked session.

---

### Task 31-D — Forward/backward navigation in session reader

**File:** `src/webview/` (session reader)

In the reader header, add `$(arrow-left) Previous` and `$(arrow-right) Next` navigation
arrows when the current session is part of a link chain (ordered by `updatedAt`). These
arrows are only shown when at least one linked session exists.

**Acceptance:** Navigation arrows appear for linked sessions; clicking opens the linked
session reader.

---

### UT coverage — Feature 31

- Linking A to B updates sidecar metadata for both A and B.
- Unlinking removes the entry from both.
- `chatwizard_get_linked` returns correct session data for a fixture with two links.
- `chatwizard_get_linked` returns `[]` for an unlinked session.

---

### e2e tests — Feature 31

1. Link two fixture sessions via `chatwizard.linkSession`.
2. Open session A reader — assert session B appears in the linked sessions sidebar.
3. Open session B reader — assert session A appears.
4. Call `chatwizard_get_linked` MCP tool — assert correct response.

---

### Manual tests — Feature 31

1. Link two sessions via right-click → "Link Session to Another".
2. Open each reader — verify the linked session appears in the sidebar.
3. Click the linked session in the sidebar — verify navigation.
4. Call `chatwizard_get_linked` from an MCP client — verify correct output.

---

### Completion gate — Feature 31

- [ ] Tasks 31-A through 31-D implemented.
- [ ] UT: bidirectional link, unlink, and MCP tool assertions pass.
- [ ] e2e: link, sidebar display, and MCP tool verified.
- [ ] Manual: link/unlink UI, reader navigation, and MCP tool all work.
- [ ] **Feature 31 complete.**

---

---

## Feature 32 — Response Rating

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Per-response thumbs-up / thumbs-down for personal recall. Filter search results to
highly-rated responses. Used as a training signal for the reranker (Feature 21).

---

### Task 32-A — Add `ratings` to `SessionMetadata`

**File:** `src/types/index.ts`

```ts
export interface MessageRating {
    messageIndex: number;
    rating: 1 | -1;     // 1 = thumbs up, -1 = thumbs down
    createdAt: string;
}

// Add to SessionMetadata:
ratings?: MessageRating[];
```

---

### Task 32-B — Add rating UI in session reader

**File:** `src/webview/` (session reader)

Add `$(thumbsup)` / `$(thumbsdown)` icon buttons to each assistant message card. Clicking one
sends `rateMessage` to the extension host. The selected icon gets a filled/active state.

**Acceptance:** Rating buttons appear on assistant messages only; selecting one highlights it;
clicking the same button again removes the rating.

---

### Task 32-C — Persist ratings and expose in search

**File:** Extension host `rateMessage` handler + `src/search/fullTextEngine.ts`

Persist ratings in sidecar metadata. In the full-text search result ranker, boost sessions
where the matched message has a `rating: 1` by a configurable factor (default: 1.5×).

**Acceptance:** A highly-rated session ranks above an equally-relevant unrated session in
search results; ratings survive VS Code restart.

---

### UT coverage — Feature 32

- Rating message 4 with `+1` creates a `MessageRating` entry in sidecar.
- Rating the same message with `-1` replaces the previous rating.
- Clicking the active rating again removes it (toggles off).
- Search ranking boosts a session with a +1 rating for the matching message.

---

### e2e tests — Feature 32

1. Rate a fixture session's message index 2 with thumbs-up.
2. Search for a term present in that message — assert the rated session ranks first vs. an
   equally-matching unrated session.

---

### Manual tests — Feature 32

1. Open a session reader; rate an assistant response with thumbs-up — verify the icon fills.
2. Rate the same message thumbs-down — verify thumbs-up deactivates and thumbs-down fills.
3. Click the active thumbs-down again — verify both buttons return to inactive state.
4. Search for a term from the rated message — verify the rated session appears first.

---

### Completion gate — Feature 32

- [ ] Tasks 32-A through 32-C implemented.
- [ ] UT: persist, replace, toggle, and ranking boost assertions pass.
- [ ] e2e: ranked search with ratings verified.
- [ ] Manual: toggle behavior, persistence, and ranking effect all work.
- [ ] **Feature 32 complete.**

---

---

## Feature 33 — Duplicate / Related Session Detection

_Effort: M · Priority: P3 · No blockers (benefits from Feature 24 SQLite for performance)_

### Context

Detect when the same conversation was split across sessions (e.g. Claude vs. Cursor for the
same task, or a session continued across tool restarts). Surface them as related in the tree
and session reader.

---

### Task 33-A — Implement similarity clustering

**File:** `src/analytics/duplicateDetector.ts` (new)

```ts
export interface RelatedSessionPair {
    sessionIdA: string;
    sessionIdB: string;
    similarity: number;      // 0–1, cosine of session embedding centroids
    reason: 'high-similarity' | 'same-topic-cross-source' | 'time-proximity';
}

export function detectRelatedSessions(
    sessions: Session[],
    embeddingFn: (text: string) => Float32Array,
    threshold?: number        // default: 0.80
): RelatedSessionPair[]
```

Strategy:
1. Compute centroid embedding for each session (average of per-message embeddings).
2. Pairwise cosine similarity above `threshold` → `'high-similarity'`.
3. Same-day sessions from different sources with similarity > 0.65 → `'same-topic-cross-source'`.
4. Sessions within 30 minutes of each other with same source → `'time-proximity'`.

Cap at comparing 1,000 sessions maximum (performance guard).

**Acceptance:** Two fixture sessions with overlapping content score above 0.80; two sessions
with different topics score below 0.50.

---

### Task 33-B — Store related pairs and surface in tree

**File:** `src/index/sessionIndex.ts` + `src/views/sessionTreeProvider.ts`

Run `detectRelatedSessions` once after full index load (background task, 30-second delay).
Store pairs in memory (or SQLite if Feature 24 is complete). Add a `$(link)` badge to tree
items that have at least one related session.

**Acceptance:** Sessions with detected related sessions show the `$(link)` badge.

---

### Task 33-C — Show related sessions in session reader

**File:** `src/webview/` (session reader)

Add a "Related Sessions" section in the session reader sidebar, listing related sessions with
similarity score and reason label. Clicking navigates to the related session reader.

**Acceptance:** Related sessions appear in the sidebar with their similarity score and reason.

---

### UT coverage — Feature 33

- `detectRelatedSessions` returns a pair with `similarity > 0.80` for two fixture sessions
  with near-identical content.
- `detectRelatedSessions` returns no pair for fixture sessions with unrelated content.
- The `'same-topic-cross-source'` reason is assigned when two same-day cross-source sessions
  have similarity 0.70.

---

### e2e tests — Feature 33

1. Load two fixture sessions with overlapping content (threshold: 0.80) — assert a related
   pair is detected.
2. Load two unrelated sessions — assert no pair is detected.
3. Open the session reader for a session with a related partner — assert the sidebar shows
   the partner.

---

### Manual tests — Feature 33

1. Activate with a real session corpus — verify that visually similar sessions (same project,
   same week) get the `$(link)` badge.
2. Open a related session pair in readers side by side — verify the content overlap is real.
3. Click a related session in the sidebar — verify navigation.

---

### Completion gate — Feature 33

- [ ] Tasks 33-A through 33-C implemented.
- [ ] UT: similarity detection and reason assignment pass.
- [ ] e2e: pair detection and sidebar display verified.
- [ ] Manual: badge and sidebar visible; navigation works.
- [ ] **Feature 33 complete.**

---

---

## Feature 34 — Outcome / Follow-Up Tracking

_Effort: S · Priority: P3 · Depends on: Feature 9 (sidecar metadata, P1)_

### Context

Lightweight checklist of action items extracted from or manually appended to a session.
Exposed via the `chatwizard_get_action_items` MCP tool.

---

### Task 34-A — Add `actionItems` to `SessionMetadata`

**File:** `src/types/index.ts`

```ts
export interface ActionItem {
    id: string;
    text: string;
    done: boolean;
    createdAt: string;
    source: 'extracted' | 'manual';
}

// Add to SessionMetadata:
actionItems?: ActionItem[];
```

---

### Task 34-B — Implement action item extractor

**File:** `src/analytics/actionItemExtractor.ts` (new)

```ts
export function extractActionItems(session: Session): ActionItem[]
```

Scan assistant messages for phrases indicating tasks:
- "you should", "next step", "todo:", "action:", "follow up", "don't forget", "make sure to",
  "you'll need to", "remember to"

Extract the sentence containing the phrase. Deduplicate by lowercased normalized text.
Cap at 20 items per session.

**Acceptance:** Extractor finds action items from a fixture session containing actionable
assistant messages; returns `[]` for a purely conversational session.

---

### Task 34-C — Action item UI in session reader

**File:** `src/webview/` (session reader)

Add an "Action Items" panel at the top of the session reader (collapsed by default if no
items). Shows extracted items as checkboxes. Users can:
- Check off items (updates sidecar `done` flag).
- Add manual items.
- Delete items.

**Acceptance:** Extracted items appear; manual items can be added; checking off persists in
sidecar.

---

### Task 34-D — Implement `chatwizard_get_action_items` MCP tool

**File:** `src/mcp/tools/getActionItemsTool.ts` (new)

```ts
// Input: { sessionId: string; includeDone?: boolean }
// Output: Array<{ id, text, done, source }>
```

**Acceptance:** MCP tool returns correct action items for a fixture session; `includeDone:
false` filters out completed items.

---

### UT coverage — Feature 34

- `extractActionItems` returns items from a fixture session with actionable phrases.
- `extractActionItems` returns `[]` for a purely conversational fixture.
- Checking off an item sets `done: true` in sidecar; unchecking sets it back.
- `chatwizard_get_action_items` with `includeDone: false` excludes done items.

---

### e2e tests — Feature 34

1. Load a fixture session with 3 actionable phrases — assert 3 items are extracted.
2. Mark one item done — assert sidecar reflects `done: true`.
3. Call `chatwizard_get_action_items` MCP tool — assert correct response including `source`.

---

### Manual tests — Feature 34

1. Open a session with action-oriented assistant messages — verify extracted items appear.
2. Add a manual item; check it off — verify persistence after restart.
3. Call `chatwizard_get_action_items` from an MCP client — verify correct output.

---

### Completion gate — Feature 34

- [ ] Tasks 34-A through 34-D implemented.
- [ ] UT: extraction, done toggle, and MCP tool assertions pass.
- [ ] e2e: extraction, persistence, and MCP tool verified.
- [ ] Manual: checklist UI, manual add, and MCP tool all work.
- [ ] **Feature 34 complete.**

---

---

## Feature 35 — Keyboard-Only Navigation

_Effort: S · Priority: P3 · No blockers_

### Context

Vim-style `j/k` navigation in the session tree and reader; `/` to jump to search.
Standard expectation for developer tools — absence is friction for power users.

---

### Task 35-A — Session tree keyboard shortcuts

**File:** `src/webview/` or `src/views/sessionTreeProvider.ts`

The VS Code tree view (native `TreeView`) already supports arrow key navigation. Add:
- `j` → move focus down one item (equivalent to `↓`)
- `k` → move focus up one item (equivalent to `↑`)
- `/` → focus the global search input (`chatwizard.focusSearch` command)

Bind via `keybindings` in `package.json`, scoped to `focusedView == 'chatwizard.sessionsView'`.

**Acceptance:** `j/k` navigate the session tree when it is focused; `/` focuses the search
input.

---

### Task 35-B — Session reader keyboard shortcuts

**File:** `src/webview/` (session reader — client-side JS)

In the session reader webview, add `keydown` event listeners:
- `j` → scroll down one message card
- `k` → scroll up one message card
- `g` → jump to top
- `G` → jump to bottom (shift+g)
- `/` → focus the reader's own search/filter input (if present)

Guard with `event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA'` to
avoid interfering with annotation/action-item text inputs.

**Acceptance:** `j/k/g/G` work in the session reader webview without interfering with
text inputs.

---

### UT coverage — Feature 35

- `keydown` handler does not fire navigation when `event.target` is an `INPUT`.
- `keydown` `j` calls the scroll-down function exactly once.

---

### e2e tests — Feature 35

1. Focus the session tree; press `j` — assert the selection moves down one item.
2. Press `k` — assert the selection moves up one item.
3. Press `/` — assert the search input is focused.

---

### Manual tests — Feature 35

1. Focus the session tree; press `j` and `k` repeatedly — verify smooth navigation.
2. Press `/` — verify the search panel opens with focus.
3. Open a long session reader; press `j/k` — verify message-by-message scrolling.
4. Press `G` — verify jump to bottom; `g` — verify jump to top.
5. Click in an annotation text area; press `j` — verify navigation does NOT trigger.

---

### Completion gate — Feature 35

- [ ] Tasks 35-A and 35-B implemented.
- [ ] UT: input guard and scroll handler assertions pass.
- [ ] e2e: tree navigation and search focus verified.
- [ ] Manual: all keybindings work; text input guard works.
- [ ] **Feature 35 complete.**

---

---

## Feature 36 — Session Sharing

_Effort: M · Priority: P3 · No blockers_

### Context

Generate a read-only shareable link (or exportable HTML bundle) for a specific session.
The HTML bundle opens without any ChatWizard installation. Drives organic growth.

---

### Task 36-A — Implement HTML bundle exporter

**File:** `src/export/sessionHtmlExporter.ts` (new)

```ts
export async function exportSessionAsHtml(
    session: Session,
    outputPath: string,
    options: { includeAnnotations: boolean; theme: 'light' | 'dark' | 'auto' }
): Promise<void>
```

Produce a single self-contained HTML file:
- Inline CSS (derived from `cwTheme.ts` brand colors).
- Renders all messages with proper user/assistant styling.
- If `includeAnnotations: true`, renders inline annotation blocks.
- A header block showing session title, source, date, and a "Generated by ChatWizard" banner.
- No JavaScript required — pure static HTML.

**Acceptance:** Output HTML renders correctly in a browser; no external dependencies loaded;
no JavaScript in the output.

---

### Task 36-B — Register `chatwizard.shareSession` command

**File:** `src/commands/` + `package.json`

Flow:
1. QuickPick asking: "Save as HTML bundle" or "Copy shareable link" (future — for now only
   HTML is implemented; link option shows "Coming soon").
2. For HTML: open a save dialog pre-filled with `<session-title>.html`.
3. After save, offer "Open in Browser" and "Show in Explorer" buttons.

Wire into session tree right-click context menu.

**Acceptance:** Command produces a valid HTML file at the chosen path; "Open in Browser"
opens it in the default browser.

---

### Task 36-C — Redaction option

**File:** `src/export/sessionHtmlExporter.ts`

Add `options.redactCodeBlocks: boolean`. When `true`, replace fenced code block content with
`[code block redacted]` in the output HTML. Protects proprietary code from accidental exposure
when sharing with external parties.

**Acceptance:** With `redactCodeBlocks: true`, no fenced code block content appears in the
HTML output.

---

### UT coverage — Feature 36

- `exportSessionAsHtml` produces a file containing the session title in an `<h1>` tag.
- Output HTML contains no `<script>` tags.
- With `redactCodeBlocks: true`, no code block content appears in the output.
- With `includeAnnotations: true`, annotation text appears in the output.

---

### e2e tests — Feature 36

1. Export a fixture session with 5 messages — assert the HTML file exists and contains all 5
   messages.
2. Export with `redactCodeBlocks: true` — assert no code content is present.
3. Export with `includeAnnotations: true` and a session with one annotation — assert
   annotation text is present.

---

### Manual tests — Feature 36

1. Right-click a session → "Share Session" → save as HTML.
2. Open the HTML file in Chrome/Firefox — verify it renders correctly without internet access.
3. Test in both light and dark system themes.
4. Export with redaction; open in browser — verify code blocks are replaced.

---

### Completion gate — Feature 36

- [ ] Tasks 36-A through 36-C implemented.
- [ ] UT: title, no-script, redaction, and annotation assertions pass.
- [ ] e2e: export, message count, redaction, and annotation scenarios pass.
- [ ] Manual: HTML renders correctly offline in Chrome/Firefox; redaction works.
- [ ] **Feature 36 complete.**

---

---

## Feature 37 — Post-Session Cost Tips & Analytics

_Effort: S · Priority: P3 · Status: Code complete — re-enable and test only_

### Context

`SessionCostAdvisor`, `SessionCostAdvisorNotifier`, and `SessionCostAdvicePanel` are all
implemented in `src/analytics/sessionCostAdvisor.ts`, `src/ui/sessionCostAdvisorNotifier.ts`,
and `src/ui/sessionCostAdvicePanel.ts`. The feature was disabled for 1.5.0 pending testing.

This feature section is **testing + re-enabling only**. No new implementation is needed.

---

### Re-enable checklist

Follow the re-enable steps documented in `src/extension.ts` (search for `disabled for 1.5.0`):

1. **`src/extension.ts`** — Uncomment the two `disabled for 1.5.0` blocks:
   - `SessionCostAdvisorNotifier` instantiation (Feature 20-J block).
   - `chatwizard.analyzeSelectedPrompt` command registration block (Feature 20-D block).
2. **`package.json`** — Restore `chatwizard.analyzeSelectedPrompt` command declaration and
   its `editor/context` menu entry; restore `analyzePrompt` in the `@chatwizard` participant
   commands list.
3. **`README.md`** — Restore the "Prompt Cost Analysis" feature bullet, `/analyzePrompt`
   mention, comparison-table row, and release note entry.
4. **`docs/user-guide.md`** — Restore TOC entry #18, the `/analyzePrompt` usage example,
   the "18. Prompt Cost Analysis" section, the command table row, and the Quick Reference row.
   Renumber sections back to 18/19/20.

---

### Outstanding tests (must complete before re-exposing)

Per `docs/done/work-plan-whats-next-P2.md` → Feature 20:

#### Unit Tests

- [ ] `SessionCostAdvisor.advise()` returns a tip when token cost exceeds threshold.
- [ ] `SessionCostAdvisor.advise()` returns `null` when cost is below threshold.
- [ ] `SessionCostAdvisorNotifier` fires on session close (mock `LiveSessionTracker`).
- [ ] Cost advice panel renders the tip text in its HTML output.

#### E2E Tests

- [ ] Simulate a session close event with a high-cost fixture session — assert info message
  appears with the tip text.
- [ ] Simulate a low-cost session — assert no message appears.

#### Manual Tests

1. Open a session that used many tokens; close it — verify the cost tip info message appears.
2. Click "View Details" — verify the `SessionCostAdvicePanel` webview opens with the cost
   breakdown.
3. Open a short session; close it — verify no message appears (below threshold).
4. Verify the `/analyzePrompt` command appears in the `@chatwizard` participant command list.
5. Run `@chatwizard /analyzePrompt` — verify the token count and similarity analysis are shown.

---

### Completion gate — Feature 37

- [ ] All four re-enable steps completed (code + docs).
- [ ] All unit tests pass.
- [ ] E2E tests pass.
- [ ] Manual tests performed; no regressions in cost display or `/analyzePrompt`.
- [ ] **Feature 37 complete.**

---

---

## Feature 38 — MCP Tools: `includeCode` Flag

_Effort: S · Priority: P3 · No blockers_

### Context

Add `includeCode: boolean` to `GetContextTool`, `GetSessionTool`, and `GetSessionFullTool`.
When `false`, strip fenced code blocks and long inline code spans before returning content.
Reduces token cost by 50–80% for code-heavy sessions.

---

### Task 38-A — Implement code-stripping utility

**File:** `src/utils/contentFilter.ts` (new)

```ts
export function stripCodeBlocks(content: string): string
```

- Remove fenced code blocks: ` ``` ... ``` ` (multiline).
- Remove inline code spans longer than 40 characters.
- Replace each removed block with a placeholder: `[code block omitted]`.

**Acceptance:** Fixture text with 3 fenced code blocks → 3 `[code block omitted]`
placeholders; regular prose is preserved.

---

### Task 38-B — Add `includeCode` parameter to the three MCP tools

**Files:**
- `src/mcp/tools/getContextTool.ts`
- `src/mcp/tools/getSessionTool.ts`
- `src/mcp/tools/getSessionFullTool.ts`

Add `includeCode` (boolean, default `true`) to each tool's input schema. When `false`, pass
the session message content through `stripCodeBlocks` before assembling the return value.

**Acceptance:** Calling `GetContextTool` with `includeCode: false` returns content where all
fenced code blocks are replaced with placeholders; `includeCode: true` (default) returns
content unchanged.

---

### UT coverage — Feature 38

- `stripCodeBlocks` removes all fenced blocks from a fixture string.
- `stripCodeBlocks` removes inline code spans > 40 chars.
- `stripCodeBlocks` preserves prose and inline code ≤ 40 chars.
- `GetContextTool` with `includeCode: false` returns no raw fenced code blocks.
- `GetContextTool` with `includeCode: true` (default) returns content unchanged.

---

### e2e tests — Feature 38

1. Call `GetContextTool` with `includeCode: false` against a fixture session with code —
   assert output contains `[code block omitted]` and no backtick fences.
2. Call with `includeCode: true` — assert output contains the original code.

---

### Manual tests — Feature 38

1. Call `GetContextTool` via an MCP client with `includeCode: false` — measure the response
   size vs. `includeCode: true` for a code-heavy session.
2. Verify that an AI agent using `chatwizard_get_context` with `includeCode: false` still
   produces sensible answers (code omission does not break context).

---

### Completion gate — Feature 38

- [ ] Tasks 38-A and 38-B implemented.
- [ ] All UT assertions pass.
- [ ] e2e: code-stripping and default behavior verified.
- [ ] Manual: token reduction measurable; agent responses still coherent.
- [ ] **Feature 38 complete.**

---

---

## Feature 39 — MCP `/mcp-config` Auth Hardening

_Effort: XS · Priority: P3 · Status: Partially implemented — one endpoint gap remains_

### Context

All MCP endpoints except `/health` and `/mcp-config` already require a bearer token
(confirmed in `src/mcp/mcpServer.ts`). The `/mcp-config` endpoint is unauthenticated —
a local port scanner can enumerate server capabilities. Adding a bearer token check closes
this gap.

---

### Task 39-A — Add bearer token check to `/mcp-config`

**File:** `src/mcp/mcpServer.ts`

In the `/mcp-config` request handler, call the existing `requireAuth()` helper (or inline
the same bearer token check used by other endpoints) before returning the config JSON.

The config snippet already embeds the bearer token, so clients that have the token can still
call this endpoint — the guard only blocks unauthenticated enumeration.

Update `docs/user-guide.md` and `src/mcp/mcpConfigHelper.ts` help text to note that
`/mcp-config` now requires the token (any client fetching the config must include the
`Authorization: Bearer <token>` header).

**Acceptance:** A GET to `/mcp-config` without the `Authorization` header returns `401`.
A GET with a valid token returns the config JSON as before.

---

### UT coverage — Feature 39

- GET `/mcp-config` without `Authorization` header → 401.
- GET `/mcp-config` with `Authorization: Bearer <valid-token>` → 200 with JSON body.
- GET `/mcp-config` with `Authorization: Bearer <wrong-token>` → 401.

---

### e2e tests — Feature 39

1. Start the MCP server; GET `/mcp-config` without a token — assert 401.
2. GET `/mcp-config` with the correct token — assert 200 and valid JSON.

---

### Manual tests — Feature 39

1. Run `curl http://127.0.0.1:<port>/mcp-config` without headers — verify 401 response.
2. Run with `-H "Authorization: Bearer <token>"` — verify config JSON is returned.
3. Verify that MCP client tools (Claude Desktop, Cursor MCP config) can still fetch the
   config when configured with the token.

---

### Completion gate — Feature 39

- [ ] Task 39-A implemented.
- [ ] UT: 401/200 assertions pass.
- [ ] e2e: auth guard verified.
- [ ] Manual: curl test passes; existing MCP clients unaffected.
- [ ] **Feature 39 complete.**

---

---

## Feature 40 — Antigravity `.pb` (Protobuf) Support

_Effort: S · Priority: P3 · No blockers_

### Context

Antigravity stores some sessions as binary protobuf (`.pb`) files. Best-effort extraction
using wire-type 2 (length-delimited) scanning recovers message text. Sessions are flagged
`lowFidelity` in metadata.

---

### Task 40-A — Implement wire-type 2 scanner

**File:** `src/parsers/antigravityProtobuf.ts` (new)

```ts
export interface ProtobufScanResult {
    strings: string[];      // all length-delimited text fields found
    lowFidelity: true;
}

export function scanProtobufStrings(buffer: Buffer): ProtobufScanResult
```

Iterate bytes; when a wire-type 2 varint tag is found, read the length prefix and extract
the following bytes. Filter: keep only strings that are valid UTF-8 and at least 20 chars
(to filter out binary blobs). Return all extracted strings.

**Acceptance:** Scanner extracts recognizable text strings from a fixture `.pb` file;
does not throw on a random binary buffer (returns empty strings array).

---

### Task 40-B — Build a `Session` from scanned strings

**File:** `src/parsers/antigravityProtobuf.ts`

```ts
export function parseAntigravityPbFile(pbPath: string): ParseResult
```

- Read the file; call `scanProtobufStrings`.
- Construct a `Session` with `source: 'antigravity'` and `lowFidelity: true` in metadata.
- Treat each extracted string as an `assistant` message (role cannot be determined without
  schema knowledge).
- Title: first extracted string truncated to 80 chars.

**Acceptance:** Parser produces a non-empty `Session` from a fixture `.pb` file with
`lowFidelity: true`; returns a `ParseResult` with errors for an unreadable file.

---

### Task 40-C — Discover and index `.pb` files

**File:** `src/readers/antigravityWorkspace.ts`

Add discovery of `~/.gemini/antigravity/**/*.pb` files alongside the existing `brain/`
and `conversations/` discovery. Register a `FileSystemWatcher` for `.pb` files.

**Acceptance:** `.pb` sessions appear in the tree with a `· low fidelity` badge; existing
`brain/` and `conversations/` sessions are not affected.

---

### UT coverage — Feature 40

- `scanProtobufStrings` returns non-empty strings from a fixture `.pb` buffer.
- `scanProtobufStrings` does not throw on a zero-byte buffer.
- `parseAntigravityPbFile` returns `lowFidelity: true` in session metadata.
- Discovery finds `.pb` files in a fixture directory; returns `[]` when directory is absent.

---

### e2e tests — Feature 40

1. Place a fixture `.pb` file in the test Antigravity directory — assert a session appears
   in the tree with `· low fidelity` badge.
2. Place a malformed (random bytes) `.pb` file alongside a valid one — assert the valid
   session is indexed and the malformed one produces a logged error without crashing.

---

### Manual tests — Feature 40

1. If Antigravity has `.pb` files, activate the extension — verify low-fidelity sessions
   appear in the tree with the badge.
2. Open one — verify the message content is partially readable (not binary garbage).

---

### Completion gate — Feature 40

- [ ] Tasks 40-A through 40-C implemented.
- [ ] UT: scanner, parser, and discovery assertions pass.
- [ ] e2e: low-fidelity session appears; malformed file does not crash.
- [ ] Manual: `.pb` sessions visible in tree with badge.
- [ ] **Feature 40 complete.**

---

---

## Feature 41 — Zed AI Source Support

_Effort: S · Priority: P3 · No blockers_

### Context

Index AI conversations stored by the Zed editor. Growing audience among Rust/performance-
focused developers. No competitor indexes Zed sessions.

---

### Task 41-A — Research Zed session file format

Before implementing, run `scripts/probe-*` style investigation against a Zed installation
to determine:
- Location of Zed AI session files (likely `~/.config/zed/conversations/` or similar).
- File format (JSON, JSONL, SQLite, or other).
- Schema: how are user/assistant turns represented?

Document findings as a comment block at the top of `src/readers/zedWorkspace.ts`.

**Acceptance:** Format is documented; at least one real Zed session file is captured as a
test fixture in `test/fixtures/zed/`.

---

### Task 41-B — Add `'zed'` to `SessionSource`

**File:** `src/types/index.ts`

```ts
export type SessionSource = 'copilot' | 'claude' | 'antigravity' | 'cursor' | 'cline' |
    'roocode' | 'windsurf' | 'aider' | 'continuedev' | 'amazonq' | 'geminiCodeAssist' |
    'zed';
```

Add CSS brand variable and badge class for Zed to `src/webview/cwTheme.ts`
(suggested color: `#084CCF` — Zed's brand blue).

**Acceptance:** `'zed'` is a valid `SessionSource`; badge class exists in the theme.

---

### Task 41-C — Implement `src/readers/zedWorkspace.ts` and `src/parsers/zed.ts`

Following the pattern of existing readers/parsers (e.g. `continuedevWorkspace.ts` /
`continuedev.ts`):

- `discoverZedConversationsAsync()` — finds all Zed session files.
- `parseZedConversation(filePath)` — parses a single session file into `ParseResult`.

**Acceptance:** Parser correctly maps a fixture Zed session to a `Session`; handles missing
or malformed files without throwing.

---

### Task 41-D — Wire into watcher, index, and UI

Register `FileSystemWatcher` for Zed session files. Add Zed to the analytics badge map,
timeline dropdown, and search source cycle (following the pattern established by P1 Feature 1).

**Acceptance:** Zed sessions appear in the tree, analytics, timeline, and search panels with
the correct brand badge.

---

### UT coverage — Feature 41

- `discoverZedConversationsAsync` returns correct entries from a fixture directory.
- `parseZedConversation` maps a fixture file to a `Session` with correct message count.
- `parseZedConversation` handles a malformed file without throwing.

---

### e2e tests — Feature 41

1. Load a fixture Zed session — assert it appears in the tree with the Zed badge.
2. Search for a term from the session — assert it is returned.

---

### Manual tests — Feature 41

If Zed is installed and has conversation history:
1. Activate the extension — verify Zed sessions appear.
2. Open a Zed session in the reader — verify message rendering.
3. Verify the Zed badge uses the correct brand color.

---

### Completion gate — Feature 41

- [ ] Tasks 41-A through 41-D implemented.
- [ ] File format documented; fixture captured.
- [ ] UT assertions pass.
- [ ] e2e: Zed session visible and searchable.
- [ ] Manual (if Zed installed): sessions appear with correct badge.
- [ ] **Feature 41 complete.**

---

---

## Feature 42 — Tabnine Chat Source Support

_Effort: M · Priority: P3 · No blockers_

### Context

Index Tabnine chat history. Tabnine has significant enterprise market share, particularly in
regulated industries where Copilot is not approved. No competitor indexes Tabnine sessions.

---

### Task 42-A — Research Tabnine session file format

Investigate:
- Location: likely `~/.tabnine/` or VS Code extension storage under `TabNine.tabnine-vscode`.
- Format: check for SQLite, JSON, or JSONL files.
- Schema: user/assistant structure.

Document findings; capture a real fixture in `test/fixtures/tabnine/`.

**Acceptance:** Format documented at top of `src/readers/tabnineWorkspace.ts`; fixture in
`test/fixtures/tabnine/`.

---

### Task 42-B — Add `'tabnine'` to `SessionSource` and theme

**File:** `src/types/index.ts` + `src/webview/cwTheme.ts`

Add `'tabnine'` to the `SessionSource` union. Add CSS brand variable
(`--cw-source-tabnine: #6A1BE2` — Tabnine's purple) and badge class.

---

### Task 42-C — Implement reader, parser, watcher, and UI wiring

Following the same pattern as Feature 41. Includes:
- `src/readers/tabnineWorkspace.ts`
- `src/parsers/tabnine.ts`
- Watcher registration
- Analytics / timeline / search badge wiring

**Acceptance:** Tabnine sessions appear in tree, analytics, timeline, and search with correct
brand badge.

---

### UT coverage — Feature 42

- Discovery, parse, and malformed-file scenarios (same pattern as Feature 41).

---

### e2e tests — Feature 42

Same pattern as Feature 41.

---

### Manual tests — Feature 42

If Tabnine is installed and has chat history:
1. Activate — verify Tabnine sessions appear.
2. Verify badge color.

---

### Completion gate — Feature 42

- [ ] Tasks 42-A through 42-C implemented.
- [ ] Format documented; fixture captured.
- [ ] UT assertions pass.
- [ ] e2e: Tabnine session visible and searchable.
- [ ] Manual (if Tabnine installed): sessions appear with correct badge.
- [ ] **Feature 42 complete.**

---

---

## Feature 43 — Session Retention Controls

_Effort: S · Priority: P3 · No blockers_

### Context

Two independent settings that keep the UI and index manageable for multi-year users
(8K+ sessions/year). Without them, search quality and performance degrade as history grows.

---

### Task 43-A — Add retention settings to `package.json`

```json
"chatwizard.semanticIndexMaxAgeDays": {
    "type": "number",
    "default": 365,
    "description": "Exclude sessions older than this many days from the semantic (embedding) index. They remain in full-text search and the session tree."
},
"chatwizard.sessionRetentionDays": {
    "type": "number",
    "default": 0,
    "description": "Suppress sessions older than this many days from all UI surfaces (tree, search, analytics). 0 = no limit. Source files are never deleted."
}
```

**Acceptance:** Both settings appear in VS Code settings UI with descriptions.

---

### Task 43-B — Apply `semanticIndexMaxAgeDays` in embedding engine

**File:** `src/search/semanticIndex.ts`

When adding a session to the semantic index, skip it if its `updatedAt` is older than
`chatwizard.semanticIndexMaxAgeDays` days from now. Full-text and tree are unaffected.

**Acceptance:** Sessions older than the threshold are absent from semantic search results but
still appear in full-text search and the session tree.

---

### Task 43-C — Apply `sessionRetentionDays` in session index

**File:** `src/index/sessionIndex.ts`

Filter out sessions with `updatedAt` older than `chatwizard.sessionRetentionDays` days from
all `getAllSummaries()`, `search()`, and analytics calls. Source files are never modified.
When `sessionRetentionDays` is `0`, no filtering is applied.

**Acceptance:** Sessions older than `sessionRetentionDays` do not appear in the tree, search,
or analytics panel; setting to `0` restores them.

---

### UT coverage — Feature 43

- `semanticIndex.add()` skips a session whose `updatedAt` exceeds `MaxAgeDays`.
- `semanticIndex.add()` includes a session within `MaxAgeDays`.
- `sessionIndex.getAllSummaries()` excludes sessions older than `retentionDays` when setting
  is non-zero.
- `sessionIndex.getAllSummaries()` includes all sessions when `retentionDays` is `0`.

---

### e2e tests — Feature 43

1. Set `semanticIndexMaxAgeDays: 30`; index a fixture session with `updatedAt` 60 days ago —
   assert it does not appear in semantic search but appears in full-text search.
2. Set `sessionRetentionDays: 30`; assert the same session does not appear in the tree.
3. Set `sessionRetentionDays: 0` — assert the session reappears.

---

### Manual tests — Feature 43

1. Set `chatwizard.sessionRetentionDays: 90` — verify old sessions disappear from the tree.
2. Set to `0` — verify they reappear.
3. Confirm that source files are untouched after applying retention (check file modification
   dates in Explorer).

---

### Completion gate — Feature 43

- [ ] Tasks 43-A through 43-C implemented.
- [ ] UT: MaxAgeDays and retentionDays filtering assertions pass.
- [ ] e2e: semantic/full-text split and retention filtering verified.
- [ ] Manual: settings visible; retention filtering works; source files untouched.
- [ ] **Feature 43 complete.**

---

---

## Feature 44 — API / Programmatic Access

_Effort: M · Priority: P3 · Depends on: Feature 24 (SQLite — the REST API queries the DB directly without VS Code being open)_

### Context

Expose the session index as a read-only REST endpoint beyond the MCP server. Enables external
scripts, CI/CD dashboards, and custom analytics to query ChatWizard data without VS Code
being open.

---

### Task 44-A — Define the REST API surface

**File:** `docs/api.md` (new) — document the API before implementing it.

Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/sessions` | List session summaries (supports `?source=`, `?limit=`, `?since=` query params) |
| GET | `/api/v1/sessions/:id` | Get full session by ID |
| GET | `/api/v1/sessions/:id/messages` | Get messages for a session |
| GET | `/api/v1/search?q=` | Full-text search across sessions |
| GET | `/api/v1/stats` | Analytics summary (session counts by source, date range) |

All endpoints require the same bearer token as the MCP server.

**Acceptance:** `docs/api.md` is complete and accurate before Task 44-B begins.

---

### Task 44-B — Implement REST API in the MCP server

**File:** `src/mcp/mcpServer.ts`

Add route handling for the `/api/v1/*` paths to the existing HTTP server. Reuse the existing
bearer token authentication middleware. Responses are JSON.

**Acceptance:** All five endpoints return correct data when called with a valid bearer token;
return 401 without a token.

---

### Task 44-C — CLI helper script

**File:** `scripts/query-sessions.mjs` (new)

A standalone Node.js script that reads the bearer token from the configured `tokenPath` and
calls the REST API. Usage:

```
node scripts/query-sessions.mjs search "JWT auth"
node scripts/query-sessions.mjs list --source copilot --limit 10
node scripts/query-sessions.mjs get <sessionId>
```

**Acceptance:** Script runs from the command line without VS Code being open (requires the
extension's HTTP server to be running — note this in the script's help text).

---

### UT coverage — Feature 44

- GET `/api/v1/sessions` returns correct session summaries from a fixture index.
- GET `/api/v1/sessions/:id` returns the correct full session.
- GET `/api/v1/search?q=<term>` returns sessions matching the term.
- GET `/api/v1/sessions` without `Authorization` header returns 401.

---

### e2e tests — Feature 44

1. Start the extension server with a fixture index; call `GET /api/v1/sessions` — assert
   correct session count.
2. Call `GET /api/v1/search?q=jwt` — assert sessions containing "jwt" are returned.
3. Call without auth header — assert 401.

---

### Manual tests — Feature 44

1. Start VS Code with the extension active; run the CLI helper:
   `node scripts/query-sessions.mjs search "my query"` — verify results in the terminal.
2. Call a curl request with the bearer token — verify JSON response.

---

### Completion gate — Feature 44

- [ ] Tasks 44-A through 44-C implemented.
- [ ] `docs/api.md` written before coding.
- [ ] UT: all endpoint assertions pass.
- [ ] e2e: search and auth guard verified.
- [ ] Manual: CLI helper and curl both work.
- [ ] **Feature 44 complete.**

---

---

## Feature 45 — Compacted Session Detection & Visibility

_Effort: S · Priority: P3 · No blockers_

### Context

Claude Code sessions can contain a `/compact` summary — a `"type":"summary"` entry in the
JSONL. When this occurs, the model retains a prose summary of earlier turns, but the user
sees only the later turns in the reader. Making compaction visible prevents confusion and
turns a silent data-loss event into a transparent UX.

Three deliverables:
1. Flag compacted sessions in the tree with a `· compacted` badge.
2. Render the compaction summary as a visible block at the top of the session reader.
3. Optionally surface a link to the predecessor session file (same session ID, earlier
   timestamps) if it still exists in the index.

---

### Task 45-A — Detect `"type":"summary"` entries in the Claude parser

**File:** `src/parsers/claude.ts`

During JSONL parsing, check each entry for `"type":"summary"`. When found:
- Store the summary text in `session.compactionSummary: string | undefined`.
- Mark `session.isCompacted: boolean = true`.

Add these fields to the `Session` type in `src/types/index.ts`.

**Acceptance:** A fixture Claude session containing a `"type":"summary"` entry results in
`session.isCompacted === true` and `session.compactionSummary` containing the summary text.

---

### Task 45-B — Add `· compacted` badge to the session tree

**File:** `src/views/sessionTreeProvider.ts`

For sessions with `isCompacted: true`, append `· compacted` to the tree item description
(same pattern as `· archived`). Use a distinct icon or color to differentiate from `·
archived`.

**Acceptance:** Compacted sessions show `· compacted` in the tree; non-compacted sessions
are unaffected.

---

### Task 45-C — Render compaction summary block in session reader

**File:** `src/webview/` (session reader)

At the top of the message list, when `session.isCompacted` is true, render a distinct
"Context summary from earlier conversation" block before the first visible message:

```
┌─────────────────────────────────────────────────────────┐
│ 📋 Context summary from earlier conversation             │
│ ──────────────────────────────────────────────────────  │
│ <compactionSummary text>                                 │
│                                                          │
│ Earlier turns were compacted by Claude Code.             │
└─────────────────────────────────────────────────────────┘
```

Style the block distinctly (e.g. light blue background, `$(info)` icon) so it is clearly
not a regular message.

**Acceptance:** The summary block appears at the top of compacted session readers; normal
sessions show no block.

---

### Task 45-D — Link to predecessor session (optional)

**File:** `src/webview/` (session reader) + `src/index/sessionIndex.ts`

When a compacted session exists, search the index for another session with the same
`workspacePath` and an `updatedAt` timestamp earlier than this session's first message
timestamp. If found, add a "View earlier conversation →" link below the summary block.

If no predecessor is found, show "Earlier turns are no longer available."

**Acceptance:** When a predecessor session exists in the index, the link appears and navigates
to it. When no predecessor exists, the "no longer available" message is shown.

---

### UT coverage — Feature 45

- Claude parser sets `isCompacted: true` and populates `compactionSummary` for a fixture
  JSONL containing a `"type":"summary"` entry.
- Claude parser leaves `isCompacted: undefined` for a JSONL with no summary entry.
- Session tree item description contains `· compacted` for a compacted session.
- Session reader HTML contains the summary block content for a compacted session.

---

### e2e tests — Feature 45

1. Load a fixture Claude session with a `"type":"summary"` entry — assert `isCompacted` is
   set and the tree shows `· compacted`.
2. Open the session reader — assert the summary block appears at the top.
3. Load a fixture that also has a predecessor session (same workspace, earlier timestamp) —
   assert the "View earlier conversation →" link is present.

---

### Manual tests — Feature 45

If Claude Code sessions exist with compaction:
1. Activate the extension — verify compacted sessions show `· compacted` in the tree.
2. Open one — verify the summary block appears at the top with the correct text.
3. If a predecessor exists, click "View earlier conversation →" — verify navigation.

---

### Completion gate — Feature 45

- [ ] Tasks 45-A through 45-D implemented.
- [ ] UT: parser detection, tree badge, and reader block assertions pass.
- [ ] e2e: badge, summary block, and predecessor link verified.
- [ ] Manual: compacted sessions visually distinct; summary block renders correctly.
- [ ] **Feature 45 complete.**

---

---

## Appendix A — Infrastructure Fixes (Completed)

These fixes were applied before feature implementation began and must remain functional.

### Fixture Paths

- ✅ Zed parser tests — fixtures now use correct path `test/fixtures/zed/`
- ✅ Tabnine parser tests — fixtures now use correct path `test/fixtures/tabnine/`
- ✅ Compacted session tests — fixtures now use correct path `test/fixtures/compacted/`
- ✅ Build pipeline — `pretest` script runs `node test/copy-fixtures.mjs` to copy `test/fixtures/` → `out/test/fixtures/` automatically

### EPERM on Windows (gitContextReader)

- ✅ Added `rmRetry()` wrapper that retries `fs.rmSync` up to 5 times with 200ms busy-wait, working around Windows file handle locking after `git` commands

### better-sqlite3 Native Module

The module `better-sqlite3` requires compilation for VS Code's Electron version:
- **VS Code test version**: 1.123.0 / 1.123.1 → **Electron 42.2.0** (Node ABI 146)
- **Problem**: `node-gyp` rebuild requires Python (✓ available 3.12.10) **and** Visual Studio Build Tools with C++ workload (not installed)
- **Impact**: 77 tests blocked (windsurfWorkspaceDiscovery, cursorWorkspaceDiscovery, chronicle tests)
- **Fix**: Install **"Visual Studio Build Tools 2022"** with **"Desktop development with C++"** workload, then run `npm run rebuild:native`

---

## Appendix B — Type Definitions Status

All P3 feature types are already defined in `src/types/index.ts`:
- `SessionBookmark` — Feature 29
- `MessageAnnotation` — Feature 30
- `MessageRating` — Feature 32
- `ActionItem` — Feature 34
- `GitContext` — Feature 25
- `status` field on `SessionMetadata` — Feature 28
- `linkedSessionIds`, `annotations` fields on `SessionMetadata` — Features 28, 29, 30, 31

---

## Appendix C — Manual Testing Checklist

Run these after each feature implementation to verify no regressions:

- [ ] Open session viewer — verify rendering for all 14 sources
- [ ] Session tree — sort, filter, group, search
- [ ] Code Blocks view — list, filter, sort, open session
- [ ] Prompt Library — browse and copy prompts
- [ ] Analytics dashboard — verify charts and tables
- [ ] Timeline view — scroll through chronological view
- [ ] MCP server — start, verify tools, stop
- [ ] Archive — archive and restore sessions
- [ ] Tags — add/remove/filter by tags
- [ ] Export — single session, batch, Obsidian
- [ ] Semantic search — verify topic search results
- [ ] Chronicle — verify checkpoint summaries load
- [ ] Copilot integration — verify session discovery
- [ ] Settings — verify all configuration options

---

## P3 Completion Gate

All P3 features are complete when:

- [ ] Features 23–45 all have their individual completion gates checked.
- [ ] No regressions introduced in P1/P2 features (run full test suite).
- [ ] `whats-next.md` master roadmap updated with P3 completion status.
- [ ] `CHANGELOG.md` updated with P3 release notes.
- [ ] **P3 complete — ready for P4 planning or Individual Pro launch preparation.**
