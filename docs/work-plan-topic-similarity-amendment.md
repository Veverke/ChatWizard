# ChatWizard — Semantic Search Amendment: Fine-Grained Embeddings + Scope Toggle

_Created: April 2026 — supersedes initial per-user-message draft_

---

## Problem Statement

The original implementation embeds one vector **per session** by joining `title + all message content` and truncating to `SEMANTIC_MAX_CHARS = 2048`. This approach has two compounding defects discovered during manual testing:

1. **Model token cap makes the char limit irrelevant.** `all-MiniLM-L6-v2` silently truncates input at **256 tokens** (≈ 1000–1300 characters of mixed prose/code). The 2048-char limit overshoots the model's real capacity — everything after the first ~10 messages is never embedded.

2. **Session-level pooling produces blurry vectors.** Averaging a whole conversation into one vector yields a centroid that represents "VS Code extension development" for almost every session in a single-project workspace. The model cannot distinguish "unit testing" from "chat organization" or "extension icon" from "marketplace publishing" because all sessions share the same broad domain vocabulary. Queries consistently surface false positives at scores 0.25–0.33.

### Test evidence

| Query | Bad result returned | Expected result |
|---|---|---|
| `unit testing` | "Improving Chat Organization and Grouping Strategies" | Sessions where unit testing was the primary topic |
| `how do I release a version?` | "Committing changes to extension.js" | Sessions about publishing, VSIX, semver |
| `extension icon` | "Missing extension in marketplace" | Sessions focused on icon assets/design |

---

## Solution

**Index at fine-grained level; let users choose search scope at query time.**

Two distinct use cases drive topic similarity search:
- *"I remember asking about X"* → search user messages
- *"I'm looking for explanations of Y"* → search AI responses

Both are served by indexing both turn types at fine granularity and exposing a scope toggle in the search UI.

### Indexing granularity

| Turn type | Unit of embedding | Why |
|---|---|---|
| **User messages** | One vector per message | Questions are short (20–100 tokens), focused, fit well within the 256-token window |
| **AI responses** | One vector per paragraph (split on `\n\n`) | Responses are long (often > 256 tokens); paragraph-level chunking keeps each vector within the window and preserves topical focus |

Indexing always covers **both** turn types. Scope is a search-time filter only — no re-indexing when the user changes scope.

### Search scope (UI toggle in quick-pick)

| Scope | Vectors searched | Best for |
|---|---|---|
| **Both** _(default)_ | All vectors | General topic discovery |
| **My questions** | User message vectors only | "I remember asking about X" |
| **AI responses** | Assistant paragraph vectors only | "I'm looking for explanations of Y" |

Aggregation always returns **sessions** ranked by the highest-scoring vector found within them for the active scope.

### Granularity comparison

| Granularity | User search quality | AI response search quality | Memory at 8 K sessions | Verdict |
|---|---|---|---|---|
| Session (current) | Poor — blurry centroid | Poor — blurry centroid | ~12 MB | Too coarse |
| One vector per full message | Good | Poor — 256-token cap truncates long responses | ~240 MB | Doesn't solve AI-response search |
| **User msgs + AI paragraphs** | **Good** | **Good** | **~540 MB** | **Chosen** |

Memory: 384 floats × 4 bytes = 1.5 KB/vector. At ~5 user messages + ~8 AI responses × ~5 paragraphs each = ~45 vectors/session × 8 K sessions ≈ 540 MB. Accepted for now; a `semanticIndexMaxAgeDays` retention setting (tracked separately in `whats-next.md`) will bound this as usage grows.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ✅ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Implementation Order

Tasks A and B are the only strict prerequisites. Once B is merged, C through F are fully independent and can be worked in parallel. G is merged into B (both touch `semanticContracts.ts`).

```
A — types.ts              (add SemanticMessageResult)
  └─► B+G — semanticContracts.ts   (updated interfaces, SemanticScope, threshold, remove SEMANTIC_MAX_CHARS)
                ├─► C — semanticIndex.ts          ┐
                ├─► D — semanticIndexer.ts         │  fully parallel
                ├─► E — semanticSearchPanel.ts     │
                └─► F — extension.ts               ┘
```

| Task | Depends on | Parallel with |
|---|---|---|
| A — `types.ts` | Nothing | — |
| B+G — `semanticContracts.ts` | A | — |
| C — `semanticIndex.ts` | B | D, E, F |
| D — `semanticIndexer.ts` | B | C, E, F |
| E — `semanticSearchPanel.ts` | B | C, D, F |
| F — `extension.ts` | B | C, D, E |

---

## Changes Required

### A — `src/search/types.ts` ✅

Add a result type that carries full vector identity:

```ts
export interface SemanticMessageResult {
    sessionId: string;
    role: 'user' | 'assistant';
    messageIndex: number;    // 0-based index of the message within session.messages
    paragraphIndex: number;  // always 0 for user messages; paragraph offset for assistant messages
    score: number;           // cosine similarity, 0–1
}
```

`SemanticSearchResult` (session-level) is **retained** — it is the aggregated output promoted from the best `SemanticMessageResult` per session.

---

### B — `src/search/semanticContracts.ts` ✅

1. Import `SemanticMessageResult` from `./types`.
2. Add scope type: `export type SemanticScope = 'both' | 'user' | 'assistant';`
3. Update `ISemanticIndex`:
   - `add(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number, embedding: Float32Array): void`
   - `remove(sessionId: string): void` — removes **all** vectors for the session
   - `has(sessionId: string): boolean` — true if any vector for the session exists
   - `search(queryEmbedding: Float32Array, topK: number, minScore?: number, scope?: SemanticScope): SemanticMessageResult[]`
4. Update `ISemanticIndexer`:
   - `scheduleSession(session: Session): void` — indexer is responsible for splitting messages; caller no longer builds text
   - `search(query: string, topK: number, minScore?: number, scope?: SemanticScope): Promise<SemanticSearchResult[]>`
5. Remove `SEMANTIC_MAX_CHARS` — individual messages and paragraphs fit within 256 tokens without a hard char cap.

---

### C — `src/search/semanticIndex.ts` ✅

**Composite key format:** `"sessionId::role::messageIndex::paragraphIndex"`

Examples:
- User message at index 2: `"abc123::user::2::0"`
- AI response at index 1, paragraph 3: `"abc123::assistant::1::3"`

Changes:
1. `add(sessionId, role, messageIndex, paragraphIndex, embedding)` — store key is the composite string above
2. `remove(sessionId)` — delete all keys starting with `"${sessionId}::"`
3. `has(sessionId)` — true if any key starts with `"${sessionId}::"`
4. `search(queryEmbedding, topK, minScore, scope)`:
   - Skip keys whose role part does not match scope (`'user'` skips assistant keys, `'assistant'` skips user keys, `'both'` skips nothing)
   - Parse composite key to populate `SemanticMessageResult` fields
   - Return `SemanticMessageResult[]` sorted descending by score, sliced to `topK`

**Binary file format:**

```
[4 bytes] magic: 0x43 0x57 0x53 0x45  ("CWSE")
[4 bytes] version: 2 (uint32 LE)
[4 bytes] dims: 384 (uint32 LE)
[4 bytes] entry count N (uint32 LE)
[N entries]
  [4 bytes] composite key byte length (uint32 LE)
  [variable] composite key bytes (UTF-8) — "sessionId::role::msgIdx::paraIdx"
  [384 × 4 bytes] float32 embedding (little-endian)
```

`load()` on an unrecognised version logs a warning and starts empty.

---

### D — `src/search/semanticIndexer.ts` ✅

**`QueueEntry`** — updated shape:
```ts
interface QueueEntry {
    sessionId: string;
    role: 'user' | 'assistant';
    messageIndex: number;
    paragraphIndex: number;
    text: string;
}
```

**`scheduleSession(session: Session)`** — replaces `scheduleSession(sessionId, text)`:
- Skip if `index.has(session.id)` (all vectors for the session already present)
- For each message in `session.messages`:
  - If `role === 'user'`: push one entry `{ sessionId, role: 'user', messageIndex: i, paragraphIndex: 0, text: msg.content }`
  - If `role === 'assistant'`: split `msg.content` on `\n\n`; push one entry per non-empty paragraph with its `paragraphIndex`

**`_runQueue()`** — call `index.add(entry.sessionId, entry.role, entry.messageIndex, entry.paragraphIndex, embedding)`

**`search(query, topK, minScore, scope = 'both')`**:
1. Embed the query
2. Call `index.search(queryVector, topK * 10, minScore, scope)` — over-fetch to ensure enough unique sessions after aggregation
3. Aggregate: for each `sessionId`, keep the highest-scoring `SemanticMessageResult` → `SemanticSearchResult[]`
4. Sort descending by score, slice to `topK`

---

### E — `src/search/semanticSearchPanel.ts` ✅

Add a **scope toggle button** to the quick-pick alongside the existing source filter button.

1. Import `SemanticScope` from `semanticContracts`.
2. Add scope state: `let scope: SemanticScope = 'both'`
3. Add `scopeButton` cycling: `both → user → assistant → both`
4. Pass `scope` to `indexer.search(value, 10, minScore, scope)` on each query
5. On scope button click: advance scope, update button icon/tooltip, **re-run the current query** (scope changes the vector pass, not just a client-side filter)

Scope button appearance:

| Scope | Icon | Tooltip |
|---|---|---|
| `both` | `$(list-unordered)` | `Scope: Both — click for My questions only` |
| `user` | `$(comment)` | `Scope: My questions — click for AI responses only` |
| `assistant` | `$(hubot)` | `Scope: AI responses — click for Both` |

---

### F — `src/extension.ts` ✅

1. Remove `buildSemanticText()` export — no longer needed.
2. Update all `scheduleSession()` call sites to pass the full `Session` object.
3. Remove `SEMANTIC_MAX_CHARS` import.

---

### G — `src/search/semanticContracts.ts` + `package.json` ✅

Raise `SEMANTIC_MIN_SCORE` from **0.25 → 0.35**. Fine-grained vectors produce tighter similarity distributions; the 0.25 floor is too permissive at this granularity. Update default in `semanticContracts.ts` and the setting description in `package.json`.

Also remove `SEMANTIC_MAX_CHARS` constant — it is no longer used anywhere.

---

## Files Changed Summary

| File | Change |
|---|---|
| `src/search/types.ts` | Add `SemanticMessageResult` |
| `src/search/semanticContracts.ts` | Add `SemanticScope`; update interfaces; remove `SEMANTIC_MAX_CHARS`; raise `SEMANTIC_MIN_SCORE` to 0.35 |
| `src/search/semanticIndex.ts` | Composite key with role + paragraphIndex; scoped search; binary format v2 |
| `src/search/semanticIndexer.ts` | Queue both turn types; paragraph-split AI responses; scope-aware `search()` with aggregation |
| `src/search/semanticSearchPanel.ts` | Scope toggle button; pass scope to `indexer.search()`; re-query on scope change |
| `src/extension.ts` | Remove `buildSemanticText`; update call sites to pass `Session` |
| `package.json` | Update `semanticMinScore` default description |

`EmbeddingEngine` and `SearchPanel` require **no changes**.

---

## Out of Scope

- **Memory/retention controls** — acknowledged concern (~252 MB at 8 K sessions with both turn types indexed). Deferred to a dedicated `semanticIndexMaxAgeDays` setting, documented in `whats-next.md`. Not part of this amendment.
- **Session archiving** — separate feature, documented in `whats-next.md`.

---

## Testing

### Unit tests to update

| Test file | What changes |
|---|---|
| `test/suite/semanticIndex.test.ts` | Update `add()` / `search()` signatures; composite-key round-trip tests for both roles; scope-filter tests (user-only, assistant-only, both) |
| `test/suite/semanticIndexer.test.ts` | `scheduleSession(session)` with multi-message stub; assert queue has one entry per user message and N paragraph entries per AI response; assert `search()` aggregates to session level; test all three scope values |
| `test/suite/semanticSearchPanel.test.ts` | Scope button cycles correctly; `indexer.search` called with correct scope on change; re-query triggered (not just re-filter) on scope change |

### Manual testing checklist

1. Launch Extension Development Host. Delete any existing `semantic-embeddings.bin` from `globalStorageUri`.
2. Enable `chatwizard.enableSemanticSearch: true` — confirm status bar indexing counter appears and completes.
3. Query `"unit testing"` (scope: Both) — confirm results are sessions where unit testing was discussed; no domain-adjacent false positives.
4. Query `"extension icon"` (scope: Both) — confirm no "Missing extension in marketplace" result.
5. Query `"release version"` (scope: Both) — confirm sessions about publishing/VSIX/changelog.
6. Switch scope to **My questions** — confirm results shift toward sessions where you asked about the topic directly.
7. Switch scope to **AI responses** — confirm results shift toward sessions with detailed AI explanations of the topic.
8. Confirm scope toggle and source filter work independently.
9. Restart VS Code — confirm the binary index loads without re-indexing (status bar does not reappear).
10. Add a new session — confirm it is indexed (both user and AI turns) within a few seconds.
