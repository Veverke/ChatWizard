# ChatWizard — Scalability Work Plan

## Overview

ChatWizard's current architecture was designed for a typical developer with a few hundred chat sessions. As AI-assisted coding becomes central to daily workflow, session counts grow exponentially — a power user accumulates thousands of sessions and tens of thousands of messages within months. This document identifies every scalability bottleneck across all UI flows and data layers, and prescribes targeted remediation by priority.

**Growth model to design for:**
| Tier | Sessions | Messages | Code Blocks | Prompts |
|------|----------|----------|-------------|---------|
| Light user today | ~200 | ~5K | ~1K | ~800 |
| Heavy user today | ~2K | ~50K | ~10K | ~8K |
| Heavy user (6 months) | ~10K | ~250K | ~50K | ~40K |
| Heavy user (2 years) | ~50K | ~1.25M | ~250K | ~400K |

The extension must remain responsive at the "Heavy user (6 months)" tier and degrade gracefully beyond it.

---

## S1 — O(n²) Prompt Clustering ✦ CRITICAL ✅ COMPLETED

**File:** [src/prompts/similarityEngine.ts](src/prompts/similarityEngine.ts)

**Problem:** The greedy clustering loop compares every new prompt to every existing cluster representative. Each comparison calls `trigramSimilarity()` which is O(text length). Combined complexity: **O(n² × avg_text_length)**.

| Prompts | Estimated time |
|---------|----------------|
| 500 | ~0.3s |
| 2,000 | ~5s (noticeable freeze) |
| 10,000 | ~2–5 min (UI unresponsive) |
| 40,000 | hours |

**Root cause:** No pre-filtering before similarity computation; all pairs evaluated.

### Tasks
- [x] Extract trigram sets once per entry upfront and cache them (eliminates redundant set construction inside the hot loop)
- [x] Add a MinHash sketch (8–16 hash functions) per entry; use Jaccard estimate as a cheap pre-filter — only run full `trigramSimilarity` if MinHash estimate ≥ `threshold - 0.15`
- [x] Alternatively, build a bucket index keyed on the 3 most-frequent trigrams; limit candidate search to entries sharing at least one bucket key
- [x] Cap cluster computation at 5,000 entries; surface a "too many prompts to cluster — showing top 5,000" banner in the UI when exceeded
- [x] Move clustering to a worker thread or `setImmediate`-chunked loop to avoid blocking the extension host during computation
- [x] Add a result cache keyed on `(indexVersion, threshold)` — skip recomputation if index hasn't changed since last cluster build
- [x] Unit test: clustering 5,000 entries must complete in < 2 seconds

**Effort:** ~1 week
**Complexity:** High

---

## S2 — No Pagination / Lazy Loading in TreeViews ✦ HIGH ✅ COMPLETED

**Files:**
- [src/views/sessionTreeProvider.ts](src/views/sessionTreeProvider.ts)
- [src/views/codeBlockTreeProvider.ts](src/views/codeBlockTreeProvider.ts)

**Problem:** `getChildren()` returns all items at once regardless of count. VS Code's TreeView does virtualize DOM rendering, but every refresh still allocates full arrays, runs full sort, and dispatches O(n) change events.

At 10,000 sessions, the sorted array allocation and comparator runs dominate every refresh cycle — including live updates triggered by incoming file watcher events.

### Tasks
- [x] Implement a `PagedSessionTreeProvider` that returns at most 200 items per page; append a virtual `⋯ Load more (N remaining)` item at the end
- [x] Treat sort/filter state changes as an invalidation that resets to page 1, not a full re-sort of the visible array — compute the sorted order lazily via an index into the pre-sorted master list
- [x] For `CodeBlockTreeProvider`, group by session at the top level (already done); ensure children of a collapsed session are not computed until first expand (use `undefined` children with `collapsibleState = Collapsed`)
- [x] Cache the sorted session order between refreshes; only re-sort when the sort stack or session IDs change
- [x] Add a filter debounce (150 ms) so rapid keystrokes in the filter box don't trigger repeated full re-sorts
- [x] Unit test: `getChildren()` with 20,000 sessions must return in < 50 ms

**Effort:** ~1 week
**Complexity:** Medium

---

## S3 — Analytics Engine Recomputes on Every Panel Open ✦ HIGH ✅ COMPLETED

**Files:**
- [src/analytics/analyticsEngine.ts](src/analytics/analyticsEngine.ts)
- [src/analytics/analyticsPanel.ts](src/analytics/analyticsPanel.ts)
- [src/analytics/analyticsViewProvider.ts](src/analytics/analyticsViewProvider.ts)

**Problem:** `AnalyticsPanel.build()` fetches all sessions and runs full computation every time the panel is shown. No caching. At 10,000 sessions with 50 messages each, this is ~500K token-counting operations, taking 500ms–2s on open.

Additionally, every index change event (live file watcher update) triggers a full rebuild in `analyticsViewProvider.ts`.

### Tasks
- [x] Add a `lastBuiltAt: number` and `lastIndexVersion: number` cache key to `AnalyticsPanel`; skip rebuild if both match the current state
- [x] Introduce an `AnalyticsCache` class that stores the computed `AnalyticsData` and only invalidates when `SessionIndex` emits an `'add'` or `'remove'` event for a session newer than the cache timestamp
- [x] For live updates in the sidebar view, debounce the rebuild trigger with a 5-second delay (analytics staleness tolerance is much higher than search)
- [x] Pre-compute and store token counts on each `Session` object when it is first parsed; eliminate repeated `countTokens()` calls during analytics
- [x] Move the analytics computation to a `setImmediate`-chunked iterator that yields to the event loop every 100 sessions to prevent UI stalls
- [x] Unit test: repeated `build()` calls with unchanged index must be a cache hit with < 1 ms overhead

**Effort:** ~4 days
**Complexity:** Medium

---

## S4 — getAllCodeBlocks() Allocates Full Array on Every Call ✦ HIGH ✅ COMPLETED

**File:** [src/index/sessionIndex.ts](src/index/sessionIndex.ts)

**Problem:** `getAllCodeBlocks()` iterates all sessions and all messages to build a fresh array on every invocation. Called from `CodeBlocksPanel`, `CodeBlockTreeProvider`, and `refresh()` — potentially multiple times per second during live updates.

At 50,000 code blocks, each call allocates ~10MB of temporary objects and triggers GC pressure.

### Tasks
- [x] Add a private `_codeBlockCache: IndexedCodeBlock[] | null` field; set it to `null` on any `upsert` or `remove` call
- [x] In `getAllCodeBlocks()`, return the cached array if non-null; otherwise rebuild and store
- [x] Expose a `getCodeBlockCount(): number` that reads the cache size without allocating a new array — use this in tree item badge counts
- [x] Similarly cache `getAllPrompts()` with invalidation on session mutations
- [x] Unit test: two consecutive `getAllCodeBlocks()` calls with no intervening mutations must return the same array reference

**Effort:** ~2 days
**Complexity:** Low

---

## S5 — Inverted Index Removal is O(total_tokens) ✦ HIGH ✅ COMPLETED

**File:** [src/search/fullTextEngine.ts](src/search/fullTextEngine.ts)

**Problem:** `_removeFromInvertedIndex()` iterates every token in the entire inverted index to find postings that belong to the removed session. At 250,000 tokens indexed, removing a single session scans all of them.

This matters when a user archives sessions or the watcher detects deleted files.

### Tasks
- [x] Maintain a reverse map: `sessionTokens: Map<sessionId, Set<token>>` that is populated during indexing
- [x] In `_removeFromInvertedIndex(sessionId)`, look up `sessionTokens.get(sessionId)` to get the exact set of tokens to clean — iterate only those tokens instead of all 250K
- [x] Delete the `sessionTokens` entry after cleanup
- [x] Verify the memory overhead of the reverse map is acceptable (one `Set<string>` per session — O(unique_tokens_per_session) ≈ O(messages × avg_tokens) ≈ 5–20KB per session)
- [x] Unit test: removing a session from a 10,000-session index must complete in < 5 ms

**Effort:** ~2 days
**Complexity:** Low-Medium

---

## S6 — Webview HTML Full Regeneration on Every Update ✦ HIGH ✅ COMPLETED

**Files:**
- [src/analytics/analyticsPanel.ts](src/analytics/analyticsPanel.ts)
- [src/prompts/promptLibraryPanel.ts](src/prompts/promptLibraryPanel.ts)
- [src/timeline/timelineViewProvider.ts](src/timeline/timelineViewProvider.ts)
- [src/codeblocks/codeBlocksPanel.ts](src/codeblocks/codeBlocksPanel.ts)

**Problem:** Every refresh regenerates the full HTML string and reassigns `webview.html`. This causes a full webview navigation/reload, resetting scroll position, destroying in-progress interactions, and allocating large intermediate strings (30–100 KB per panel).

### Tasks
- [x] Replace full `webview.html` reassignment with `webview.postMessage({ type: 'update', data: ... })` for incremental data refreshes
- [x] In each webview's JavaScript, handle the `update` message by re-rendering only the changed DOM sections (clear + rebuild individual `<section>` or `<tbody>` nodes, not the entire document)
- [x] Keep the initial `webview.html` load as a static shell with loading state; subsequent data pushes arrive via `postMessage`
- [x] For the Timeline view, send only the newly added entries rather than all months on each update
- [x] For the Analytics view, send the updated `AnalyticsData` JSON object and let the client-side Chart.js instance update existing datasets rather than recreating charts
- [x] Unit test: a `postMessage`-driven update must not reset the webview scroll position

**Effort:** ~1.5 weeks
**Complexity:** Medium-High

---

## S7 — Session Webview Loads Entire Session Content at Once ✦ HIGH ✅ COMPLETED

**File:** [src/views/sessionWebviewPanel.ts](src/views/sessionWebviewPanel.ts)

**Problem:** When a session is opened, `_markdownToHtml()` converts the entire session content — potentially hundreds of messages, each with multi-paragraph responses and code blocks — into a single HTML string before the webview receives anything. A session with 200 messages and average 1KB content per message generates ~200KB of HTML in one synchronous call, blocking the extension host for 1–2 seconds.

### Tasks
- [x] Implement a virtual scroll / message-window approach: send only the first 50 messages on initial open, then stream additional messages via `postMessage` as the user scrolls toward the top or bottom
- [x] Add an "oldest messages first" vs "newest messages first" mode; default to newest-first (most useful) so initial render is fast without loading all history
- [x] Use `setImmediate` chunking to interleave markdown conversion with the event loop — process 20 messages per chunk, post each chunk to the webview as it's ready
- [x] Cache the rendered HTML per session (keyed on session ID + `updatedAt`); avoid re-rendering unchanged sessions when the panel is re-focused
- [x] For very large sessions (> 500 messages), show a "Showing last 200 messages — [Load all]" banner
- [x] Unit test: opening a 500-message session must display first content within 200 ms

**Effort:** ~1.5 weeks
**Complexity:** High

---

## S8 — Markdown Renderer Makes Multiple Regex Passes ✦ MEDIUM ✅ COMPLETED

**File:** [src/views/messageRenderer.ts](src/views/messageRenderer.ts) (extracted from `sessionWebviewPanel.ts`)

**Problem:** `_markdownToHtml()` runs 10+ sequential regex replacements over the full content string, then iterates all lines with additional per-line regex matches. For a 100KB message, this is ~1M character comparisons per render.

### Tasks
- [x] Replace the hand-rolled regex chain with a single-pass line scanner that classifies each line once and dispatches to the appropriate renderer
- [x] Pre-compile all regexes as module-level constants so they are compiled once, not on every `_markdownToHtml()` call
- [x] Extract a `MessageRenderer` class with a benchmark test; target < 5ms for a 10KB message
- [x] Consider adopting a lightweight Markdown library (e.g., `marked` or `micromark`) as a compile-time dependency to replace the hand-rolled implementation — smaller, faster, and better tested

**Effort:** ~4 days
**Complexity:** Medium

---

## S9 — Synchronous File Discovery at Activation ✦ MEDIUM ✅ COMPLETED

**File:** [src/watcher/fileWatcher.ts](src/watcher/fileWatcher.ts)

**Problem:** On extension activation, `collectCopilotSessions()` and `collectClaudeSessions()` use synchronous `fs.readdirSync` / `fs.readFileSync` in nested loops. For a developer with 100+ VS Code workspaces, this blocks the extension host thread for several seconds during startup, delaying other extensions and the editor's responsiveness.

### Tasks
- [x] Convert `collectCopilotSessions()` and `collectClaudeSessions()` to use `async/await` with `fs.promises.readdir` / `fs.promises.readFile`
- [x] Parallelise workspace discovery with `Promise.all()` across workspaces — reading 100 workspace directories concurrently vs sequentially is 10–50× faster on SSDs
- [x] Emit a progress notification ("ChatWizard: indexing sessions… 234/1200") using `vscode.window.withProgress` during the initial load
- [x] Implement incremental startup: activate the tree view immediately with an empty/loading state; populate in the background rather than blocking `activate()`
- [x] Unit test: activation with 200 workspace directories must complete the initial index build in < 3 seconds on a simulated filesystem

**Effort:** ~4 days
**Complexity:** Medium

---

## S10 — Search Result Sorting Uses Per-Comparator Map Lookups ✦ MEDIUM ✅ COMPLETED

**File:** [src/search/fullTextEngine.ts](src/search/fullTextEngine.ts)

**Problem:** The sort comparator calls `this.sessions.get(sessionId)` on every comparison. For 10,000 results, this is 130,000 Map lookups during sort — each individually cheap but collectively a hidden cost that compounds with other refresh work.

### Tasks
- [x] Before sorting, build a local `Map<sessionId, updatedAt>` from the result set (O(n) one-time cost)
- [x] Use this pre-fetched map in the comparator instead of hitting `this.sessions` repeatedly
- [x] Cap search results at 500 items before sorting; display a "Showing top 500 of N results — refine your query" message when exceeded
- [x] Unit test: searching with 10,000 results must sort in < 50 ms

**Effort:** ~1 day
**Complexity:** Low

---

## S11 — No Limit on Inverted Index Token Count ✦ MEDIUM ✅ COMPLETED

**File:** [src/search/fullTextEngine.ts](src/search/fullTextEngine.ts)

**Problem:** Every unique token across all messages is added to the inverted index with no cap. With 250,000 messages averaging 100 unique tokens each, the index could hold 25 million entries — exceeding available heap and causing OOM crashes.

### Tasks
- [x] Add a minimum document frequency threshold: only index tokens that appear in ≥ 2 sessions (eliminates hapax legomena that are unsearchable in practice)
- [x] Add a maximum token length filter (e.g., skip tokens > 50 chars — these are typically hashes, base64, or minified code fragments that are not useful search terms)
- [x] Expose an `indexStats()` method that reports token count, posting list sizes, and memory estimate — log this at startup for visibility
- [x] Consider a Bloom filter to quickly reject non-existent tokens before index lookup
- [x] Unit test: index of 10,000 messages must hold < 500,000 unique tokens

**Effort:** ~3 days
**Complexity:** Medium

---

## S12 — Timeline View Loads All Entries for Rendering ✦ MEDIUM ✅ COMPLETED

**File:** [src/timeline/timelineViewProvider.ts](src/timeline/timelineViewProvider.ts)

**Problem:** `buildTimeline()` is called on every refresh and returns all timeline entries sorted newest-first. The webview receives all entries in a single `postMessage`. For 50,000 sessions, this is a 50,000-item array serialized to JSON — potentially 5–10 MB of data transferred to the webview.

### Tasks
- [x] Implement month-level virtual pagination in the timeline: initially load the most recent 3 months of entries; add an "Load earlier months" button at the bottom of the feed
- [x] On the extension side, `buildTimeline()` should accept `{ after?: Date, limit?: number }` parameters and return a slice
- [x] On the webview side, append new months to the existing DOM on demand rather than re-rendering all months
- [x] Add a "jump to month" select that triggers a targeted load rather than forcing the user to scroll through all loaded months

**Effort:** ~4 days
**Complexity:** Medium

---

## Summary — Priority Order

| ID | Issue | Effort | Priority | Severity |
|----|-------|--------|----------|----------|
| S1 | O(n²) prompt clustering ✅ | 1 week | P0 | Critical |
| S2 | TreeView no pagination ✅ | 1 week | P0 | High |
| S4 | getAllCodeBlocks() no cache ✅ | 2 days | P0 | High |
| S5 | Inverted index O(n) removal ✅ | 2 days | P0 | High |
| S3 | Analytics no cache ✅ | 4 days | P1 | High |
| S7 | Session webview loads all at once ✅ | 1.5 weeks | P1 | High |
| S6 | Webview full HTML regen ✅ | 1.5 weeks | P1 | High |
| S9 | Synchronous file discovery ✅ | 4 days | P1 | Medium |
| S8 | Markdown multiple regex passes ✅ | 4 days | P2 | Medium |
| S10 | Search sort map lookups ✅ | 1 day | P2 | Medium |
| S11 | No inverted index cap ✅ | 3 days | P2 | Medium |
| S12 | Timeline loads all entries ✅ | 4 days | P2 | Medium |
