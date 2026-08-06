# ChatWizard — Code Complexity Improvements

Date: 2026-05-17
Scope: Top 10 complexity and long-run performance issues identified in the v1.4.0 source tree. Items are sorted by severity. Each item includes the affected file(s), a description of the problem, and a recommended fix.

---

## Background

The extension is functionally solid and well-covered by unit tests, but several structural choices that were acceptable at a small scale will become maintenance and performance bottlenecks as the number of supported AI sources, indexed sessions, and active users grows. The items below represent the highest-leverage investments for the next engineering cycle.

---

## Item 1 — God File: `extension.ts` (1,859 lines)

**Severity: Critical**
**File**: `src/extension.ts`

**Problem**
The single `activate()` function instantiates every component, registers every command (sortBy*, cbSortBy*, filter, export, MCP start/stop, pin, tag, rescan…), wires every event listener, and contains inline callback logic. Every feature change touches this file. It has no unit tests. Build times and merge-conflict frequency grow proportionally with it.

**Fix**
Decompose into focused registrars:
- `src/commands/registrar.ts` — `registerAllCommands(context, deps)`
- `src/listeners/registrar.ts` — `registerAllListeners(context, deps)`
- `src/providers/activator.ts` — constructs and returns all view/tree providers
- `activate()` becomes a coordinator of ≤ 150 lines that calls the above

**Measurable goal**: `extension.ts` line count ≤ 200; all registrar modules independently testable.

---

## Item 2 — Monolithic Watcher: `fileWatcher.ts` (1,305 lines)

**Severity: Critical**
**File**: `src/watcher/fileWatcher.ts`

**Problem**
`buildInitialIndex()` and `start()` handle file discovery, change-detection registration, and parse-dispatch for all 8 AI sources serially in one class. Adding a 9th source requires editing this file. Sources cannot be independently toggled, tested, or parallelised at the class level. The serial initial-index pass means startup time scales linearly with the number of enabled sources.

**Fix**
Introduce a `ISourceWatcher` strategy interface:
```typescript
interface ISourceWatcher {
    buildIndex(): Promise<void>;
    startWatching(): void;
    dispose(): void;
}
```
Implement `CopilotSourceWatcher`, `ClaudeSourceWatcher`, etc. `fileWatcher.ts` becomes a thin orchestrator that runs `buildIndex()` calls in parallel (via `Promise.all`) and calls `startWatching()` on each.

**Measurable goal**: Initial indexing of N sources takes `max(t_source)` instead of `sum(t_source)`.

---

## Item 3 — Repeated `getAllSummaries()` per change event

**Severity: High**
**File**: `src/index/sessionIndex.ts`, `src/extension.ts`

**Problem**
Every index mutation fires a plain change notification that triggers 6+ listeners (tree provider, analytics view, model usage view, timeline view, session description, code block description). Each listener independently calls `index.getAllSummaries()`, which allocates a new array from `Map.values()`, maps all sessions to summaries, and sorts — O(n log n) work repeated 6 times per event. With 2,000 sessions this is ~12,000 sort comparisons per file-change during a live-watch session.

**Fix**
- Add a `getSummariesCached(): SessionSummary[]` that returns a stable reference (recomputed only when `_sortedCache` is null).
- Coalesce rapid mutations (e.g. batch-upsert during initial index) with a single `setTimeout(..., 0)` debounce before firing plain change listeners.

**Measurable goal**: One sort allocation per batch event regardless of listener count.

---

## Item 4 — Linear scan in `SemanticIndex.has()` and `remove()`

**Severity: High**
**Files**: `src/search/semanticIndex.ts`

**Problem**
`has(sessionId)` iterates the full `_store` map checking `.startsWith(prefix)` — O(N) for every check. `remove()` similarly iterates the full store. Both are called in the hot path of `scheduleSession()` (called for every session during initial index). With 30,000 embedding entries, every `has()` call scans the full map.

**Fix**
Maintain a secondary `Set<string>` of indexed session IDs:
```typescript
private readonly _indexedSessions = new Set<string>();
```
Update `add()`, `remove()`, and `load()` to keep it in sync. `has()` becomes a single `_indexedSessions.has(sessionId)` O(1) lookup.

**Measurable goal**: `has()` and `remove()` O(1) regardless of corpus size.

---

## Item 5 — Double `getAllCodeBlocks()` call per change event

**Severity: High**
**File**: `src/extension.ts` (lines ~298–301)

**Problem**
The `codeBlockListener` calls `index.getAllCodeBlocks()` twice in the same callback: once to rebuild the engine (`codeBlockEngine.index(...)`) and again to check `.length === 0` for the empty-state message. Each call traverses all sessions and all messages, allocating a new array.

**Fix**
```typescript
const codeBlockListener = index.addChangeListener(() => {
    const blocks = index.getAllCodeBlocks();   // one call, one allocation
    codeBlockEngine.index(blocks);
    CodeBlocksPanel.refresh(index, codeBlockEngine);
    codeBlockTreeView.description = codeBlockProvider.getDescription();
    codeBlockTreeView.message = blocks.length === 0 ? makeEmptyStateMsg('code blocks') : undefined;
});
```

**Measurable goal**: Zero; a one-line fix.

---

## Item 6 — Full token-count recompute on every analytics refresh

**Severity: Medium**
**File**: `src/analytics/analyticsEngine.ts`

**Problem**
`computeAnalytics()` calls `countTokens(msg.content, source)` for every message of every session each time the index changes — even when only one session was added. Token counting is O(message length) and not cheap. With 2,000 sessions × 50 messages, a single file-watch event triggers 100,000 tokenization calls.

**Fix**
- Store `userTokens` and `assistantTokens` in `SessionSummary` (computed once at parse time, updated only on upsert of that session).
- `computeAnalytics()` reads pre-computed totals from summaries — O(1) per session.

**Measurable goal**: Analytics refresh time O(changed sessions) instead of O(all sessions × messages).

---

## Item 7 — Unbounded static render cache in `SessionWebviewPanel`

**Severity: Medium**
**File**: `src/views/sessionWebviewPanel.ts`

**Problem**
`SessionWebviewPanel._renderCache` is a static `Map<string, (string|null)[]>` that accumulates rendered HTML per-session-per-version and is never evicted. A user who opens 500 sessions will accumulate thousands of HTML string arrays in the static map for the lifetime of the VS Code window.

**Fix**
Replace with a bounded LRU cache (e.g. 50 entries):
```typescript
// Evict oldest entry when capacity is reached
if (_renderCache.size >= RENDER_CACHE_MAX) {
    _renderCache.delete(_renderCache.keys().next().value);
}
```
`Map` preserves insertion order, so the first key is the oldest.

**Measurable goal**: `_renderCache.size` ≤ 50 at all times.

---

## Item 8 — Full re-tokenization on every session upsert in FTS engine

**Severity: Medium**
**File**: `src/search/fullTextEngine.ts`

**Problem**
`FullTextSearchEngine.index(session)` removes and fully re-tokenizes the session on every upsert, even when only metadata (e.g. a sidecar custom title) changed and message content is identical. For a session with 200 messages, this tokenizes 200 strings unnecessarily on every live-watch file-change event.

**Fix**
Compute a lightweight content fingerprint when indexing:
```typescript
private _contentVersions = new Map<string, number>(); // sessionId → message count
```
Skip re-tokenization when `session.messages.length === cached version`. A more robust approach uses a hash of `session.updatedAt + session.messages.length`.

**Measurable goal**: Re-tokenization skipped for unchanged sessions during live-watch.

---

## Item 9 — Sort + filter runs from scratch on every `getChildren()` call

**Severity: Medium**
**File**: `src/views/sessionTreeProvider.ts`

**Problem**
`_buildOrderedSummaries()` re-applies filters and multi-criterion sort from scratch each call. The `_sortedCache` helps but is invalidated on any mutation, including live-watch single-session upserts. During an active coding session where the AI tool saves frequently, the tree re-sorts and re-filters on every file change — O(n log n) + O(n) per render.

**Fix**
- Introduce a separate `_filteredCache` that is only invalidated when filter settings change (not on sort-order changes).
- Keep `_sortedCache` layered on top. Separate invalidation paths mean a filter change does a full rebuild, but a sort-only change only re-sorts the already-filtered list.
- Debounce the change listener callback with a 100 ms timer to coalesce rapid sequential upserts.

**Measurable goal**: Tree re-render CPU time halved for workloads with frequent single-session live updates.

---

## Item 10 — Fragmented `globalState` persistence (multiple serialization round-trips)

**Severity: Low**
**File**: `src/extension.ts`

**Problem**
Sort stack, pinned IDs, manual order, session group mode, and code-block group mode are each persisted as individual JSON strings via separate `context.globalState.update()` calls. Each user interaction (pin, sort, drag-drop) triggers multiple serialization round-trips. `globalState` is stored in VS Code's SQLite backing store; excessive writes can slow UI responsiveness.

**Fix**
Consolidate into one settings object:
```typescript
interface PersistedUiState {
    sortStack: SortStack;
    pinnedIds: string[];
    manualOrder: string[];
    sessionGroupMode: GroupMode;
    cbGroupMode: CbGroupMode;
}
```
One `globalState.update('uiState', JSON.stringify(state))` call per user action.

**Measurable goal**: Single `globalState.update` call per user interaction instead of 2–5.

---

## Item 11 — Vector Embeddings Built on Every Window Load

**Severity: High**
**File**: `src/search/semanticIndex.ts`, `src/watcher/fileWatcher.ts`

**Problem**
Building vector embeddings for semantic search takes considerable time and happens on every window load, even when the underlying session data has not changed. This causes a noticeable delay at startup for users with large session corpora.

- The embedding-build phase is computationally expensive and blocks or delays the semantic search feature from being available.
- There is no persistence or cache layer for embeddings between VS Code window sessions, so all vectors are recomputed from scratch each time the extension activates.

**Fix**
- Persist the computed embeddings to disk (e.g. alongside the existing index files) and load them on startup instead of recomputing.
- Invalidate and recompute only the embeddings for sessions that have changed since the last save (compare `updatedAt` or a content hash against a stored manifest).
- Fall back to a full rebuild only when the persisted cache is missing or the schema version changes.

**Measurable goal**: Cold-start embedding load time reduced to near-zero for unchanged sessions; only new/modified sessions are re-embedded on activation.

---

## Tracking

| # | Item | Status | Target version |
|---|------|--------|----------------|
| 1 | God File: extract registrars from `extension.ts` | Not started | — |
| 2 | SourceWatcher strategy pattern in `fileWatcher.ts` | Not started | — |
| 3 | Cached/coalesced `getAllSummaries()` per event | Not started | — |
| 4 | O(1) `has()` / `remove()` in `SemanticIndex` | Not started | — |
| 5 | Single `getAllCodeBlocks()` call per listener | Not started | — |
| 6 | Pre-computed token counts in `SessionSummary` | Not started | — |
| 7 | Bounded LRU render cache | Not started | — |
| 8 | Skip FTS re-tokenization for unchanged sessions | Not started | — |
| 9 | Separate filter/sort cache invalidation + debounce | Not started | — |
| 10 | Consolidated `globalState` persistence object | Not started | — |
| 11 | Persist vector embeddings across window loads | Not started | — |
