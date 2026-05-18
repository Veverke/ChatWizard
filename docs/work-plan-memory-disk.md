# ChatWizard — Memory & Disk Consumption Improvements

Date: 2026-05-17
Scope: Top 10 memory and disk consumption issues identified in the v1.4.0 source tree. Items are sorted by severity. Each item estimates the magnitude of the problem and provides a concrete remediation path.

---

## Background

As a VS Code extension, ChatWizard runs in the shared extension host process alongside every other installed extension. Excessive memory or CPU use degrades the entire editor. The extension currently loads all session content eagerly, maintains multiple redundant in-memory indexes, and holds rendered HTML caches without eviction — all of which grow linearly (or worse) with the user's accumulated AI chat history. The items below represent the highest-leverage reductions.

---

## Item 1 — All session content held in memory simultaneously

**Severity: Critical**
**File**: `src/index/sessionIndex.ts` — `sessions: Map<string, Session>`

**Problem**
`SessionIndex.sessions` holds the complete `Session` object for every indexed session, including full `messages` arrays with complete content strings. For a user with 2,000 sessions averaging 50 messages of 2 KB each, the raw map holds roughly **200 MB** of raw text. This is loaded eagerly at startup and never released while VS Code is open.

**Fix**
Split the in-memory model into two tiers:
1. **Hot tier** (`SessionSummary`): always in memory — lightweight, no message content.
2. **Cold tier** (`Session`): loaded on demand when a session is opened or searched; released after a configurable idle timeout (e.g. 5 minutes of no access).

Introduce a `SessionContentStore` that lazily reads the source file (already recorded in `session.filePath`) and caches the last N accessed sessions. The full `Session` object in `SessionIndex.sessions` is replaced by the summary; the content store is consulted only when needed.

**Measurable goal**: Baseline memory for 2,000 sessions reduced from ~200 MB to < 20 MB (summaries only).

---

## Item 2 — All semantic embeddings held in memory at once

**Severity: Critical**
**File**: `src/search/semanticIndex.ts` — `_store: Map<string, Float32Array>`

**Problem**
`SemanticIndex._store` holds a 384-dimensional float32 vector for every indexed message paragraph of every session. Estimate: 1,000 sessions × 30 paragraphs × 384 floats × 4 bytes ≈ **45 MB** in the embedding map alone, growing linearly without bound. No eviction policy exists; the entire map lives in memory for the lifetime of VS Code.

**Fix — Short term**: Limit semantic indexing to the most recent N sessions (configurable, default 500). Oldest sessions are dropped from the in-memory store and fall back to full-text search.

**Fix — Long term**: Replace the flat in-memory map with a memory-mapped binary file or an on-disk approximate-nearest-neighbour index (e.g. HNSW via `hnswlib-node`). Queries hit disk-backed structures; only the active query vector is in hot memory.

**Measurable goal**: Embedding memory capped at a configurable limit regardless of corpus size.

---

## Item 3 — `semantic-embeddings.bin` grows without compaction

**Severity: High**
**File**: `src/search/semanticIndex.ts` — `save()` / `load()`

**Problem**
The embeddings binary file is saved on a 5-second debounce and restored at startup, but no mechanism removes entries for sessions that no longer exist in the source AI tool. A user who deletes old Copilot workspaces will accumulate stale embeddings indefinitely. The file grows monotonically with no GC.

**Fix**
During `initialize()`, after loading the persisted index, cross-reference against the live session IDs in `SessionIndex`. Call `remove()` for any session ID present in the embedding store but absent from the main index. Schedule the resulting compacted state for a deferred `save()`. This can be done once per VS Code startup with negligible overhead.

**Measurable goal**: `semantic-embeddings.bin` contains no entries for sessions not present in the main index after startup.

---

## Item 4 — FTS engine retains full `Session` objects alongside the inverted index

**Severity: High**
**File**: `src/search/fullTextEngine.ts` — `sessions: Map<string, Session>`

**Problem**
`FullTextSearchEngine.sessions` is a `Map<string, Session>` holding all session data. This is a **second full copy** of the session content that already exists in `SessionIndex`. The FTS engine only needs the inverted index structures for search and the session file path for snippet extraction. Storing full sessions doubles the in-process text footprint — an additional ~200 MB for a large history.

**Fix**
Remove the `sessions` map from `FullTextSearchEngine`. The `search()` method already returns `sessionId` references; callers look up the full session from `SessionIndex` when a snippet or full content is needed. Retain only a `Map<string, string>` of `sessionId → title` for result enrichment without requiring the full session.

**Measurable goal**: `FullTextSearchEngine` retains no `content` strings; memory footprint reduced by ~50%.

---

## Item 5 — Three webviews with `retainContextWhenHidden: true`

**Severity: High**
**Files**: `src/analytics/analyticsPanel.ts:29`, `src/codeblocks/codeBlocksPanel.ts:43`, `src/prompts/promptLibraryPanel.ts:32`

**Problem**
`retainContextWhenHidden: true` prevents VS Code from destroying the webview's underlying renderer process when the panel is hidden. Each retained webview holds the full serialized JSON payload (all code blocks, all prompts, full analytics data) in a separate renderer memory space. For a user with large histories, this means three persistent renderer processes each holding tens of megabytes of data even when the panels are not visible.

**Fix**
Remove `retainContextWhenHidden: true` from all three panels. The `ready` message → `update` data flow already in place handles re-population on reveal. Test that the round-trip is < 200 ms with typical data (it should be — all data is in-process and `postMessage` is synchronous).

**Measurable goal**: Zero retained renderer processes for hidden panels; three renderer footprints eliminated when panels are collapsed.

---

## Item 6 — Static render cache in `SessionWebviewPanel` has no eviction

**Severity: Medium**
**File**: `src/views/sessionWebviewPanel.ts` — `_renderCache: Map<string, (string|null)[]>`

**Problem**
`SessionWebviewPanel._renderCache` is a static `Map<string, (string|null)[]>` keyed by `sessionId::updatedAt`. It accumulates rendered HTML arrays for every session ever opened during the VS Code session and is never evicted. Each entry holds an array of per-message HTML strings. A user who opens 200 sessions during a coding session retains all their rendered HTML indefinitely.

**Fix**
Bound the cache with a simple LRU eviction policy (Map preserves insertion order):
```typescript
const RENDER_CACHE_MAX = 50;
// Before inserting:
if (SessionWebviewPanel._renderCache.size >= RENDER_CACHE_MAX) {
    const oldest = SessionWebviewPanel._renderCache.keys().next().value;
    SessionWebviewPanel._renderCache.delete(oldest);
}
```

**Measurable goal**: `_renderCache.size` ≤ 50 at all times.

---

## Item 7 — Token counts recomputed from scratch on every analytics refresh

**Severity: Medium**
**File**: `src/analytics/analyticsEngine.ts`

**Problem**
`computeAnalytics()` calls `countTokens(msg.content, source)` for every message of every session on every index change event. Token-count results are never cached. With 2,000 sessions × 50 messages, a single live-watch file event triggers 100,000 tokenization operations and allocates thousands of intermediate strings.

**Fix**
Cache per-session token totals in `SessionSummary`:
```typescript
interface SessionSummary {
    // existing fields …
    userTokens?: number;
    assistantTokens?: number;
}
```
Compute them once in `toSummary()` at parse time. `computeAnalytics()` reads from the cached fields — O(1) per session instead of O(messages).

**Measurable goal**: Analytics refresh allocates no token-count strings for unchanged sessions.

---

## Item 8 — `chatwizard-metadata.json` accumulates stale entries without compaction

**Severity: Medium**
**File**: `src/index/sidecarMetadataStore.ts`

**Problem**
`SidecarMetadataStore` serializes the full `Map<sessionId, SessionMetadata>` on every write. No mechanism removes entries for sessions that no longer exist in any AI tool's storage. Over months of use, the file accumulates stale pin/tag/custom-title entries for long-deleted sessions. The file size grows monotonically, slowing `JSON.parse` and `JSON.stringify` on every save.

**Fix**
In `save()`, prune entries whose `sessionId` is no longer present in `SessionIndex`. Alternatively, run a compaction pass once per VS Code startup (compare stored session IDs against `index.size` keys) and write the pruned map back to disk.

**Measurable goal**: `chatwizard-metadata.json` contains no entries for sessions absent from the main index.

---

## Item 9 — Two redundant reverse maps in `FullTextSearchEngine`

**Severity: Medium**
**File**: `src/search/fullTextEngine.ts` — `invertedIndex`, `sessionTokens`, `tokenDocSessions`, `hapaxStore`

**Problem**
`tokenDocSessions: Map<string, Set<string>>` (token → sessions) and `sessionTokens: Map<string, Set<string>>` (session → tokens) both serve as reverse maps maintained in parallel. Together they consume O(tokens × avg_doc_freq + sessions × avg_tokens_per_session) memory. For a large corpus this can reach tens of thousands of Set entries.

**Fix**
Evaluate whether `tokenDocSessions` can be derived lazily from `invertedIndex` (which already maps tokens to posting strings containing session IDs). Document-frequency counting could be maintained as a simple `Map<string, number>` (token → count) instead of a full `Set<string>` of session IDs — reducing memory per token from a Set object (~56 bytes overhead + 8 bytes per sessionId string pointer) to a single number.

**Measurable goal**: `tokenDocSessions` replaced by `Map<string, number>` — Set overhead eliminated.

---

## Item 10 — Multiple simultaneous change listeners fire on every single-session upsert

**Severity: Low**
**File**: `src/extension.ts` — 8+ listeners on `SessionIndex`

**Problem**
`SessionIndex` has 8+ registered change listeners (search index, semantic index, code block engine, prompt library, analytics, timeline, session description, model usage). Every single-session live-watch upsert fires all of them, triggering tree refreshes, analytics rebuilds, and prompt library updates even when the user is not looking at those views. This creates unnecessary CPU and allocation pressure during active AI coding sessions.

**Fix**
Introduce a coalescing debounce (100–200 ms) on the plain change notification in `SessionIndex._notifyListeners()`. Typed events (`upsert`, `remove`, `batch`) continue to fire immediately for correctness; plain change events (used by views for refresh) are debounced so a burst of rapid upserts produces a single refresh cycle.

**Measurable goal**: During a live-watch session generating 10 upserts/second, views refresh at most 5–10 times/second instead of 10× all-listeners/second.

---

## Tracking

| # | Item | Severity | Status | Target version |
|---|------|----------|--------|----------------|
| 1 | Lazy session content loading (summary hot tier) | Critical | Not started | — |
| 2 | Cap / externalize semantic embedding memory | Critical | Not started | — |
| 3 | Compact `semantic-embeddings.bin` on startup | High | Not started | — |
| 4 | Remove full `Session` objects from FTS engine | High | Not started | — |
| 5 | Remove `retainContextWhenHidden` from 3 panels | High | Not started | — |
| 6 | Bounded LRU eviction for `_renderCache` | Medium | Not started | — |
| 7 | Cache token counts in `SessionSummary` | Medium | Not started | — |
| 8 | Compact sidecar metadata on startup | Medium | Not started | — |
| 9 | Replace `tokenDocSessions` Set with count map | Medium | Not started | — |
| 10 | Debounce plain change listener notifications | Low | Not started | — |
