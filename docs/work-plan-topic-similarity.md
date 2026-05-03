# ChatWizard — Semantic / Vector Search Work Plan

_Created: April 2026_

---

## Overview

The current search engine is an inverted index + trigrams that requires exact keyword matches. This work plan covers adding **local, fully offline, embedding-based similarity search** powered by `@xenova/transformers` running in Node.js inside the extension host process.

The goal is natural-language queries like _"find sessions where I discussed authentication patterns"_ that work without knowing the exact words used.

### Core constraints (non-negotiable)

- **Zero network after first model download** — once the model is cached, the extension never makes a network call
- **Opt-in only** — feature is disabled by default (`chatwizard.enableSemanticSearch: false`); first use shows a one-time consent dialog before downloading
- **Reads existing `Session` / `SessionIndex` APIs** — no changes to the parsing or indexing pipeline
- **Does not degrade existing search** — keyword and semantic search are separate modes; keyword remains the default

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Library | `@xenova/transformers` v2 | Proven in Node.js, model loading built-in, pure-JS fallback available |
| ONNX backend | `onnxruntime-web` WASM (default in `@xenova/transformers`) | No native binary to compile or ship per platform; no changes to `rebuild-native.js` or CI; ~80–150 ms/embed is acceptable for background queue use |
| Model | `Xenova/all-MiniLM-L6-v2` (int8 quantized) | ~22 MB download, 384-dim embeddings, purpose-built for semantic similarity, ~30–50 ms/inference on CPU |
| Model cache location | `globalStorageUri/models/` | Inside extension storage — not the OS-level HF cache |
| Embedding granularity | One vector per **session** | Per-message embeddings would spike memory; per-session is the practical trade-off |
| Session text | `title + messages[].content`, hard-truncated to 2048 chars | User messages are most signal-dense; tokenizer handles token truncation internally |
| Vector persistence | Custom binary file at `globalStorageUri/semantic-embeddings.bin` | Survives restarts; incremental updates on session add/remove |
| Search algorithm | Cosine similarity against all stored vectors, top-20 | Simple, correct, fast at realistic session counts (<50 K) |
| UI | New `chatwizard.semanticSearch` command + `$(sparkle)` toggle in existing `SearchPanel` | Semantic results are session-level, so a distinct panel clarifies the difference |
| Background indexing | Async queue, one session at a time, after main batch completes | Does not block activation or degrade keyword search |

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Implementation Order

Phase 0 is the only true prerequisite — it defines all TypeScript contracts and build config. Once it is merged, **Phases 1–4 are fully independent and can be worked in parallel**. Phase 5 is the single convergence point.

```
Phase 0 — Foundation: contracts + build config   ← must complete first
    │
    ├─► Phase 1 — EmbeddingEngine                ┐
    ├─► Phase 2 — SemanticIndex                  │  fully parallel
    ├─► Phase 3 — SemanticIndexer                │  each codes to Phase 0 interfaces
    └─► Phase 4 — SemanticSearchPanel            ┘
            │
            └─► Phase 5 — Extension Wiring       ← converges all four tracks
```

Within each phase, tasks are listed as atomic units. Tasks inside a phase that do not call each other out as prerequisites are independent and **should be implemented in parallel** — assign them to different people or work them concurrently.

---

## Phase 0 — Foundation: Contracts & Build Config ✅

**Goal:** Define all TypeScript interfaces that the parallel phases will code against, and get the new npm packages into the build pipeline. This is the only strictly sequential prerequisite.

**Depends on:** Nothing.

### Tasks — Contracts (independent of build tasks)

- [x] Add `SemanticSearchResult` to `src/search/types.ts`:
  ```ts
  export interface SemanticSearchResult {
      sessionId: string;
      score: number; // cosine similarity, 0–1
  }
  ```
- [x] Create `src/search/semanticContracts.ts` — export shared constants and interfaces:
  - `SEMANTIC_DIMS = 384` — embedding dimension; all phases import this instead of hardcoding
  - `SEMANTIC_MAX_CHARS = 2048` — session text truncation ceiling
  - `IEmbeddingEngine` — `isReady: boolean`, `load(onProgress?): Promise<void>`, `embed(text): Promise<Float32Array>`
  - `ISemanticIndex` — `size: number`, `add()`, `remove()`, `has()`, `search()`, `save()`, `load()`
  - `ISemanticIndexer` — `isReady: boolean`, `indexedCount: number`, `initialize()`, `scheduleSession()`, `removeSession()`, `search()`, `dispose()`

### Tasks — Build config (independent of contract tasks)

- [x] Add `@xenova/transformers` to `dependencies` in `package.json`
- [x] Add `--external:@xenova/transformers` to the `bundle` and `bundle:watch` esbuild scripts in `package.json`
- [x] Add `!node_modules/@xenova/transformers/**` to `.vscodeignore`

### Tasks — package.json manifest (independent of both above groups)

- [x] Add `chatwizard.semanticSearch` command declaration to the `"commands"` array
- [x] Add `chatwizard.enableSemanticSearch` boolean setting to `"configuration"` (default: `false`, description: `"Enable local semantic (natural language) search. Downloads a ~22 MB model on first use."`)

### Deliverables

- `src/search/types.ts` updated with `SemanticSearchResult`
- `src/search/semanticContracts.ts` — all shared constants + interfaces
- `package.json` — one new dependency (`@xenova/transformers`), updated esbuild externals, new command + setting
- `.vscodeignore` — updated to include `node_modules/@xenova/transformers`
- Confirmed: `npm run compile` and `npm run bundle` pass with no new errors
- Confirmed: `npm run package:vsix:win32-x64` produces a valid VSIX

### Manual Testing

1. Run `npm run bundle` — confirm no errors about missing modules or unresolved imports.
2. Run `npm run compile` — confirm TypeScript compilation succeeds with zero new errors.
3. Launch the Extension Development Host — confirm the extension activates normally (Output → "Chat Wizard" channel shows the normal startup log; no new errors).
4. Inspect the generated VSIX — confirm it contains `node_modules/@xenova/transformers` entries.
5. Confirm `chatwizard.semanticSearch` appears in the Command Palette (does nothing yet — that is expected).
6. Confirm `chatwizard.enableSemanticSearch` appears in the VS Code Settings UI under "Chat Wizard".

### Unit Tests

No executable logic is introduced in this phase; build pipeline and type-check serve as verification.

---

## Phase 1 — EmbeddingEngine ✅

**Goal:** Implement `IEmbeddingEngine` — a thin wrapper around `@xenova/transformers` that loads the ONNX model and produces normalized embeddings.

**Depends on:** Phase 0 (for `IEmbeddingEngine`, `SEMANTIC_DIMS`, `SEMANTIC_MAX_CHARS`).
**Parallel with:** Phases 2, 3, 4.

**New file:** `src/search/embeddingEngine.ts`

### Tasks (each independently assignable after the class skeleton exists)

- [ ] **Class skeleton** — `EmbeddingEngine` implementing `IEmbeddingEngine`; constructor accepts `cacheDir: string` and stores it; declares private fields; no I/O
- [ ] **`isReady` getter** — returns `true` only after `load()` resolves successfully
- [ ] **`load()` method** — sets `env.cacheDir`, calls `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`; forwards download progress to the optional `onProgress` callback; idempotent (resolves immediately if already loaded); does not catch errors
- [ ] **`embed()` method** — clips input to `SEMANTIC_MAX_CHARS`, calls the loaded pipeline with `{ pooling: 'mean', normalize: true }`, returns a `Float32Array` of length `SEMANTIC_DIMS`; throws if `isReady` is false
- [ ] **Unit tests** — `test/suite/embeddingEngine.test.ts`; mock `@xenova/transformers` for the fast suite; add a real-model integration suite gated by `CW_RUN_INTEGRATION_TESTS=1`

### Deliverables

- `src/search/embeddingEngine.ts` — `EmbeddingEngine` class
- `test/suite/embeddingEngine.test.ts`

### Manual Testing

1. Add a temporary block in `extension.ts` (remove before merging):
   ```ts
   const eng = new EmbeddingEngine(context.globalStorageUri.fsPath + '/models');
   await eng.load(msg => channel.appendLine(msg));
   const v = await eng.embed('test authentication patterns');
   channel.appendLine(`Embed dims: ${v.length}, first value: ${v[0]}`);
   ```
2. Launch the Extension Development Host — confirm the Output channel shows download progress on first run, then `Embed dims: 384` with a float value on subsequent runs (model cached).
3. Disable network after first run and restart VS Code — confirm the model loads from cache without any network call.

### Unit Tests

Write unit tests in `test/suite/embeddingEngine.test.ts` covering all public methods and edge cases of `EmbeddingEngine`. Use a mocked `@xenova/transformers` stub for fast tests; add a real-model integration suite gated by `CW_RUN_INTEGRATION_TESTS=1`.

---

## Phase 2 — SemanticIndex ✅

**Goal:** Implement `ISemanticIndex` — an in-memory vector store with binary file persistence so embeddings survive VS Code restarts.

**Depends on:** Phase 0 (for `ISemanticIndex`, `SemanticSearchResult`, `SEMANTIC_DIMS`).
**Parallel with:** Phases 1, 3, 4.

**New file:** `src/search/semanticIndex.ts`

Binary file format used by `save()` / `load()`:
```
[4 bytes] magic: 0x43 0x57 0x53 0x45  ("CWSE")
[4 bytes] version: 1 (uint32 LE)
[4 bytes] dims: 384 (uint32 LE)
[4 bytes] entry count N (uint32 LE)
[N entries]
  [4 bytes] sessionId byte length (uint32 LE)
  [variable] sessionId bytes (UTF-8)
  [384 × 4 bytes] float32 embedding (little-endian)
```

### Tasks (each independently assignable after the class skeleton exists)

- [ ] **Class skeleton** — `SemanticIndex` implementing `ISemanticIndex`; internal store is `Map<string, Float32Array>`
- [ ] **`add()`, `remove()`, `has()`, `size`** — basic CRUD on the internal map; all four are independent of each other
- [ ] **`search()` method** — iterates all stored vectors; computes cosine similarity as `dot(a, b)` (both inputs are pre-normalized so this is sufficient); returns top-K results sorted descending by score
- [ ] **`save()` method** — serializes the internal map to the binary format above using `Buffer` / `fs.promises.writeFile`
- [ ] **`load()` method** — deserializes the binary file; validates magic bytes, version, and dims; starts empty without throwing on missing file, corrupt data, or dims mismatch (logs a warning on dims mismatch)
- [ ] **Unit tests** — `test/suite/semanticIndex.test.ts`; no external dependencies needed, fully self-contained

### Deliverables

- `src/search/semanticIndex.ts` — `SemanticIndex` class
- `test/suite/semanticIndex.test.ts`

### Manual Testing

Add a temporary block in `extension.ts` (remove before merging):

1. Create a `SemanticIndex`, add 3 dummy 384-dim `Float32Array` entries with known session IDs, call `save('/tmp/test-cw.bin')`.
2. Create a new `SemanticIndex`, call `load('/tmp/test-cw.bin')`, call `search()` with one of the stored vectors — confirm the matching session ID is rank 1 in the Output channel.
3. Inspect `/tmp/test-cw.bin` with a hex viewer: confirm magic `43 57 53 45` at offset 0, version `01 00 00 00` at offset 4, dims `80 01 00 00` at offset 8.
4. Delete the file and call `load()` — confirm no crash and `size === 0`.
5. Truncate the file to 3 bytes and call `load()` — confirm no crash and `size === 0`.

### Unit Tests

Write unit tests in `test/suite/semanticIndex.test.ts` covering all public methods of `SemanticIndex`, binary serialization round-trips, and graceful handling of missing/corrupt/version-mismatched files. No external dependencies required.

---

## Phase 3 — SemanticIndexer ✅

**Goal:** Implement `ISemanticIndexer` — the orchestrator that owns `IEmbeddingEngine` and `ISemanticIndex`, manages the async embedding queue, shows status bar progress, and persists the index.

**Depends on:** Phase 0 (for `ISemanticIndexer`, `IEmbeddingEngine`, `ISemanticIndex`, `SEMANTIC_MAX_CHARS`).
**Parallel with:** Phases 1, 2, 4.
**Note:** Phases 1 and 2 must be complete before integration-testing this phase end-to-end, but the `SemanticIndexer` code itself is written against the interfaces defined in Phase 0, so implementation proceeds without waiting.

**New file:** `src/search/semanticIndexer.ts`

### Tasks (each independently assignable after the class skeleton exists)

- [ ] **Class skeleton** — `SemanticIndexer` implementing `ISemanticIndexer`; constructor accepts `storagePath: string` and factory functions `(cacheDir: string) => IEmbeddingEngine` and `() => ISemanticIndex` (dependency injection enables unit testing without real implementations)
- [ ] **`isReady` / `indexedCount` getters** — delegate to internal engine and index state
- [ ] **`initialize()` method** — checks for model cache dir to determine first-use; shows VS Code consent dialog (`"Download"` / `"Cancel"`); on cancel resolves without error and marks session as declined; calls `engine.load()` with a status bar progress item; calls `index.load(storagePath + '/semantic-embeddings.bin')`; sets `isReady = true`
- [ ] **`buildText()` private method** — concatenates `session.title` + `"\n"` + all `message.content` joined by `"\n"`; clips to `SEMANTIC_MAX_CHARS`; independent of all other methods
- [ ] **`scheduleSession()` method** — skips if `index.has(session.id)`; pushes to internal async FIFO queue; queue processor embeds one session at a time via `engine.embed(buildText(session))` then calls `index.add()`; debounces `save()` by 5 s after each add; shows/updates a status bar item `"$(loading~spin) Chat Wizard: semantic indexing… X/N"` while the queue is non-empty; disposes the status bar item when the queue drains
- [ ] **`removeSession()` method** — calls `index.remove()` synchronously; schedules a debounced `save()` (5 s)
- [ ] **`search()` method** — rejects if `isReady` is false; embeds `queryText` via `engine.embed()`; delegates to `index.search(queryVector, topK ?? 20)`
- [ ] **`dispose()` method** — drains/cancels the queue; disposes the status bar item; flushes a final `save()`
- [ ] **Unit tests** — `test/suite/semanticIndexer.test.ts`; inject stub `IEmbeddingEngine` and stub `ISemanticIndex` via the constructor factory functions; no real model or file I/O needed

### Deliverables

- `src/search/semanticIndexer.ts` — `SemanticIndexer` class
- `test/suite/semanticIndexer.test.ts`

### Manual Testing

Wire the indexer temporarily in `extension.ts` (remove before merging):

1. Set `chatwizard.enableSemanticSearch: true`.
2. Launch the Extension Development Host — confirm: consent dialog on first use; status bar message `"Chat Wizard: semantic indexing… 0/N"` appears; disappears when the queue drains; Output channel logs `"Semantic index saved"` after the debounce.
3. Restart VS Code — confirm: model loads from cache; status bar message does not reappear (sessions already indexed are skipped).
4. Add a new session in Copilot/Claude — confirm the session is embedded and logged within a few seconds.
5. Add a temporary `chatwizard.testSemanticSearch` command that calls `semanticIndexer.search('authentication patterns')` and logs results — confirm non-empty results appear.

### Unit Tests

Write unit tests in `test/suite/semanticIndexer.test.ts` covering all public methods of `SemanticIndexer`. Inject stub implementations of `IEmbeddingEngine` and `ISemanticIndex` via the constructor factory parameters; no real model or file I/O is needed.

---

## Phase 4 — SemanticSearchPanel ✅

**Goal:** Implement the user-facing quick-pick panel and add the mode-toggle button to the existing `SearchPanel`.

**Depends on:** Phase 0 (for `ISemanticIndexer`, `SemanticSearchResult`).
**Parallel with:** Phases 1, 2, 3.
**Note:** Phase 3 must be complete before manual end-to-end testing, but the panel code is written against `ISemanticIndexer` from Phase 0.

**New file:** `src/search/semanticSearchPanel.ts`
**Modified file:** `src/search/searchPanel.ts`

### Tasks (each independently assignable)

- [ ] **`SemanticResultItem` type** — `extends vscode.QuickPickItem` carrying `{ summary: SessionSummary; score: number }`; export from `semanticSearchPanel.ts`
- [ ] **Panel lifecycle** — `SemanticSearchPanel.show(context, indexer, sessionIndex)` creates a `vscode.QuickPick<SemanticResultItem>`, sets placeholder `'Semantic search — describe a topic or question…'`, registers `onDidHide` to dispose; independent of search logic
- [ ] **Result mapping** — private function `buildItems(results, summaryMap)` maps `SemanticSearchResult[]` to `SemanticResultItem[]`; label format: `$(sourceIcon)  title`; description format: `workspace · date · Score: XX%` (score as `Math.round(score * 100)`); independent of panel lifecycle
- [ ] **Search-on-change handler** — `onDidChangeValue` debounced 400 ms; if indexer not ready shows a single `$(loading~spin) Semantic index still building (X/N)` info item; otherwise calls `indexer.search(value, 20)` and passes results to `buildItems`; independent of source filter
- [ ] **Source filter button** — mirrors the existing `SourceFilterState` logic from `SearchPanel`; filters `SemanticResultItem[]` client-side after the search returns; independent of search-on-change handler
- [ ] **`onDidAccept` handler** — calls `vscode.commands.executeCommand('chatwizard.openSession', item.summary)`; independent of all other tasks
- [ ] **`$(sparkle)` mode-toggle in `SearchPanel`** — adds a third button to the existing `SearchPanel` quick-pick in `src/search/searchPanel.ts`; tooltip `'Switch to Semantic Search'`; on click: `vscode.commands.executeCommand('chatwizard.semanticSearch')` then `quickPick.hide()`; this task touches a separate file and is fully independent of all `SemanticSearchPanel` tasks
- [ ] **Unit tests** — `test/suite/semanticSearchPanel.test.ts`; use a synchronous stub `ISemanticIndexer`

### Deliverables

- `src/search/semanticSearchPanel.ts` — `SemanticSearchPanel` class
- `src/search/searchPanel.ts` — `$(sparkle)` toggle button added
- `test/suite/semanticSearchPanel.test.ts`

### Manual Testing

1. Ensure `chatwizard.enableSemanticSearch: true` and the indexer has finished indexing.
2. Run `Chat Wizard: Semantic Search` from the Command Palette — confirm the quick-pick opens with the correct placeholder.
3. Type `"authentication"` — confirm results appear within ~500 ms, each showing title, workspace, date, and `Score: XX%`.
4. Verify the source filter button cycles All → Copilot → Claude → All and filters results client-side without re-querying.
5. Press Enter on a result — confirm the session webview opens.
6. Open `chatwizard.search` — confirm the `$(sparkle)` button is present; click it and confirm it switches to the semantic panel.
7. Type before indexing completes — confirm the "still building (X/N)" info item is shown.
8. With `chatwizard.enableSemanticSearch: false`, run `chatwizard.semanticSearch` — confirm an info notification explains how to enable the feature.

### Unit Tests

Write unit tests in `test/suite/semanticSearchPanel.test.ts` covering `SemanticSearchPanel` behaviour. Use a synchronous stub `ISemanticIndexer` that returns fixture data.

---

## Phase 5 — Extension Wiring ✅

**Goal:** Integrate the four parallel tracks into `extension.ts` — register the command, wire `SessionIndex` events to the indexer, and handle runtime config changes.

**Depends on:** Phases 1, 2, 3, 4 all complete.

**Modified file:** `src/extension.ts`

### Tasks (each independently assignable)

- [ ] **Import and instantiation** — import `SemanticIndexer` and `SemanticSearchPanel`; after `const engine = new FullTextSearchEngine();`, conditionally instantiate `SemanticIndexer` based on `chatwizard.enableSemanticSearch` config
- [ ] **`SessionIndex` event listener** — register a typed change listener: `batch` → `scheduleSession()` for each session not already in the index; `upsert` → `scheduleSession()`; `remove` → `removeSession()`; `clear` → dispose and recreate the indexer, delete the persisted binary file; push the listener to `context.subscriptions`
- [ ] **`chatwizard.semanticSearch` command handler** — if indexer not instantiated: show `vscode.window.showInformationMessage` with an `"Open Settings"` button; otherwise call `SemanticSearchPanel.show(context, semanticIndexer, index)`
- [ ] **Runtime config change listener** — listen to `vscode.workspace.onDidChangeConfiguration` for `chatwizard.enableSemanticSearch`; on enable: instantiate, initialize, and schedule all currently indexed sessions; on disable: dispose and null the reference; push to `context.subscriptions`
- [ ] **Lifecycle** — push `semanticIndexer` onto `context.subscriptions` so `dispose()` is called on extension deactivation
- [ ] **Unit tests** — `test/suite/semanticWiring.test.ts`; mock `SemanticIndexer` and `SemanticSearchPanel`

### Deliverables

- `src/extension.ts` updated
- `test/suite/semanticWiring.test.ts`

### Manual Testing

1. Launch Extension Development Host with `chatwizard.enableSemanticSearch: false` — confirm the command shows the info message with `"Open Settings"`.
2. Enable `chatwizard.enableSemanticSearch: true` via Settings without restarting — confirm the indexer starts and the status bar progress appears.
3. Run `Chat Wizard: Semantic Search` — confirm the panel opens and returns results.
4. Disable the setting at runtime — confirm the status bar item disappears and the command reverts to showing the info message.
5. Reload the window — confirm `dispose()` is called (Output channel logs `"Semantic index saved"` or equivalent).
6. Create a new session in Copilot/Claude — confirm it appears in semantic search results within ~10 seconds.
7. Delete a session file on disk — confirm the session no longer appears in semantic search results.

### Unit Tests

Write unit tests in `test/suite/semanticWiring.test.ts` covering the wiring logic in `extension.ts`. Mock both `SemanticIndexer` and `SemanticSearchPanel`.

---

## Resolved Decisions

1. **WASM vs native backend** ✅ — **Use WASM (`onnxruntime-web`).** `@xenova/transformers` defaults to WASM in Node.js with no extra configuration; no native binary to compile or ship, no changes to `rebuild-native.js` or the per-platform CI jobs. The ~80–150 ms/embed cost vs ~30–50 ms native is acceptable because embedding runs in a silent background queue. Switching to native later is a one-line config change if profiling shows it is needed. **Impact on Phase 0:** `onnxruntime-node` is NOT added as a dependency; `rebuild-native.js` is NOT changed; `.vscodeignore` only needs `!node_modules/@xenova/transformers/**`.

2. **Search modes** ✅ — Keyword (exact/regex) and semantic search remain **strictly separate modes**. No hybrid ranking. The `$(sparkle)` toggle in `SearchPanel` switches between them; results are never mixed.

3. **Model language coverage** ✅ — **English only** for now. `Xenova/all-MiniLM-L6-v2` (int8 quantized, ~22 MB) is the chosen model.

4. **Result presentation on accept** ✅ — Pressing Enter on a semantic search result **opens the session directly in the webview panel** via `chatwizard.openSession`. No tree-view detour.
