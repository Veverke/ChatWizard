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
| ONNX backend | `onnxruntime-node` (native binary) | Same pattern as `better-sqlite3`; per-platform VSIX already in place |
| WASM fallback | `onnxruntime-web` WASM | If native binary shipping proves too complex, same API, ~2× slower, cross-platform by default |
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

## Phase 0 — Dependency & Build Config ⬜

**Goal:** Get `@xenova/transformers` and `onnxruntime-node` into the project without breaking the existing build, bundle, or packaging pipeline.

**Depends on:** Nothing — purely additive.

### Tasks

- [ ] Add `@xenova/transformers` to `dependencies` in `package.json`
- [ ] Add `onnxruntime-node` to `dependencies` in `package.json`
- [ ] Add `--external:@xenova/transformers --external:onnxruntime-node` to the `bundle` esbuild script
- [ ] Add the same externals to the `bundle:watch` esbuild script
- [ ] Add `!node_modules/@xenova/transformers/**` to `.vscodeignore` (include in VSIX)
- [ ] Add `!node_modules/onnxruntime-node/**` to `.vscodeignore` (include in VSIX)
- [ ] Extend `scripts/rebuild-native.js` to rebuild `onnxruntime-node` alongside `better-sqlite3`
- [ ] Add `chatwizard.semanticSearch` command declaration to `package.json` `"commands"` array
- [ ] Add `chatwizard.enableSemanticSearch` boolean setting to `package.json` `"configuration"` (default: `false`)
- [ ] Verify `npm run compile` and `npm run bundle` still succeed with the new externals
- [ ] Verify `npm run package:vsix:win32-x64` produces a valid VSIX (size increase expected; confirm <50 MB delta)

### Deliverables

- `package.json` with two new runtime dependencies and updated esbuild externals
- `.vscodeignore` updated to include the new `node_modules` subtrees in the VSIX
- `scripts/rebuild-native.js` updated to rebuild `onnxruntime-node`
- Confirmed: existing `npm run bundle` and `npm run compile` pass with no new errors
- Confirmed: VSIX packages successfully per platform

### Manual Testing

1. Run `npm run bundle` — confirm no errors about missing modules or unresolved imports.
2. Run `npm run compile` — confirm TypeScript compilation succeeds with zero new errors.
3. Launch the Extension Development Host — confirm the extension activates normally (check the Output → "Chat Wizard" channel for the normal startup log; no new errors).
4. Inspect the generated VSIX — confirm it contains `node_modules/@xenova/transformers` and `node_modules/onnxruntime-node` entries.
5. Confirm the `chatwizard.semanticSearch` command appears in the Command Palette (even though it does nothing yet).
6. Confirm `chatwizard.enableSemanticSearch` appears in VS Code Settings UI under "Chat Wizard".

### Unit Tests

No logic introduced in this phase; build pipeline checks serve as verification.

---

## Phase 1 — Core Embedding Engine ⬜

**Goal:** A thin, testable TypeScript wrapper around `@xenova/transformers` that loads the model, embeds text, and can be imported without side-effects.

**Depends on:** Phase 0

**New file:** `src/search/embeddingEngine.ts`

### Tasks

- [ ] Create `EmbeddingEngine` class
- [ ] In constructor: accept `cacheDir: string` and store it; no I/O in the constructor
- [ ] Implement `load(onProgress?: (msg: string) => void): Promise<void>`:
  - Set `env.cacheDir` to the provided `cacheDir` before the first `pipeline()` call
  - Call `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` to download/load the model
  - `onProgress` receives status strings for UI feedback (e.g. `"Downloading model… 45%"`)
  - Idempotent: if already loaded, resolves immediately
  - Does **not** catch errors — callers decide how to surface them
- [ ] Implement `embed(text: string): Promise<Float32Array>`:
  - Hard-clips input to `MAX_CHARS = 2048` chars before passing to the model
  - Passes `{ pooling: 'mean', normalize: true }` options to the pipeline
  - Returns a 384-element `Float32Array` (normalized, ready for cosine similarity)
  - Throws if called before `load()` completes
- [ ] Expose `get isReady(): boolean`
- [ ] Export a `MAX_DIMS = 384` constant (used by `SemanticIndex` to validate saved files)

### Deliverables

- `src/search/embeddingEngine.ts` — `EmbeddingEngine` class with `load()`, `embed()`, `isReady`, `MAX_DIMS`
- `test/suite/embeddingEngine.test.ts` — unit tests (see below)

### Manual Testing

1. Write a temporary activation call in `extension.ts` (comment it out before committing):
   ```ts
   const eng = new EmbeddingEngine(context.globalStorageUri.fsPath + '/models');
   await eng.load(msg => channel.appendLine(msg));
   const v = await eng.embed('test authentication patterns');
   channel.appendLine(`Embed dims: ${v.length}, first value: ${v[0]}`);
   ```
2. Launch the Extension Development Host with `chatwizard.enableSemanticSearch: true`.
3. Confirm the Output channel shows download progress messages on first run.
4. Confirm the channel shows `Embed dims: 384` with a float value on subsequent runs (model cached).
5. Disable Wi-Fi after first run and restart VS Code — confirm the model loads from cache with no network call.

### Unit Tests

Write unit tests in `test/suite/embeddingEngine.test.ts` covering all public methods and edge cases of `EmbeddingEngine`. Use a mocked `@xenova/transformers` stub for fast tests; add a real-model integration suite gated by `CW_RUN_INTEGRATION_TESTS=1`.

---

## Phase 2 — Semantic Index with Persistence ⬜

**Goal:** An in-memory vector store that can serialize/deserialize embeddings to a compact binary file, so embeddings survive VS Code restarts.

**Depends on:** Phase 1 (for `MAX_DIMS`)

**New file:** `src/search/semanticIndex.ts`

### Tasks

- [ ] Define `SemanticSearchResult` interface in `src/search/types.ts`:
  ```ts
  export interface SemanticSearchResult {
      sessionId: string;
      score: number; // cosine similarity, 0–1
  }
  ```
- [ ] Create `SemanticIndex` class
- [ ] Internal store: `Map<string, Float32Array>` (sessionId → embedding)
- [ ] Implement `add(sessionId: string, vector: Float32Array): void`
- [ ] Implement `remove(sessionId: string): void`
- [ ] Implement `has(sessionId: string): boolean`
- [ ] Implement `get size(): number`
- [ ] Implement `search(queryVector: Float32Array, topK: number): SemanticSearchResult[]`:
  - Iterates all stored vectors
  - Computes cosine similarity (both vectors are pre-normalized, so `dot(a, b)` is sufficient)
  - Returns top-K results sorted descending by score
- [ ] Implement `save(filePath: string): Promise<void>` — binary format:
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
- [ ] Implement `load(filePath: string): Promise<void>`:
  - Reads and validates the magic bytes and version
  - If the `dims` field ≠ 384, logs a warning and starts with an empty index (model changed)
  - If the file does not exist or is corrupt, silently starts empty — never throws

### Deliverables

- `src/search/types.ts` updated with `SemanticSearchResult`
- `src/search/semanticIndex.ts` — `SemanticIndex` class
- `test/suite/semanticIndex.test.ts` — unit tests (see below)

### Manual Testing

There is no UI surface yet. Manually verify via a temporary test harness in `extension.ts`:

1. Add a temporary block that:
   - Creates a `SemanticIndex`, adds 3 dummy 384-dim float arrays with known session IDs
   - Calls `save('/tmp/test-index.bin')`
   - Creates a new `SemanticIndex` and calls `load('/tmp/test-index.bin')`
   - Calls `search()` with one of the stored vectors and confirms the matching session ID is rank 1
   - Logs results to the Output channel
2. Manually inspect `/tmp/test-index.bin` with a hex viewer: confirm magic bytes `43 57 53 45` at offset 0, version `01 00 00 00` at offset 4, dims `80 01 00 00` (384 = 0x180) at offset 8.
3. Delete the file and call `load()` — confirm the extension does not crash and the index is empty.
4. Corrupt the file (truncate it) and call `load()` — confirm the extension does not crash.

### Unit Tests

Write unit tests in `test/suite/semanticIndex.test.ts` covering all public methods of `SemanticIndex`, binary serialization round-trips, and graceful handling of missing/corrupt/version-mismatched files.

---

## Phase 3 — Background Indexing Orchestrator ⬜

**Goal:** A single class that owns the embedding engine and the semantic index, manages the async work queue, persists the index, and exposes a clean `search(queryText)` interface for the UI layer.

**Depends on:** Phase 1 (EmbeddingEngine), Phase 2 (SemanticIndex)

**New file:** `src/search/semanticIndexer.ts`

### Tasks

- [ ] Create `SemanticIndexer` class
- [ ] Constructor: accepts `storagePath: string`; no I/O
- [ ] Implement `initialize(): Promise<void>`:
  - Instantiates `EmbeddingEngine` with `storagePath + '/models'`
  - Shows VS Code consent dialog if model has never been downloaded (check if model cache dir exists):
    > _"Semantic search requires downloading a ~22 MB model file from Hugging Face Hub. It will be saved to your extension storage and never downloaded again. Download now?"_
    - Buttons: `Download` / `Cancel`
    - If user cancels: resolves without error, sets `isEnabled = false` for the session; do not disable the setting — show dialog again next session
  - Calls `EmbeddingEngine.load()` with a status bar progress message
  - Calls `SemanticIndex.load(storagePath + '/semantic-embeddings.bin')`
  - Sets `isReady = true`
- [ ] Implement `scheduleSession(session: Session): void`:
  - If `SemanticIndex.has(session.id)`, skip (already indexed; avoids re-embedding on every restart)
  - Pushes to internal async queue
  - Queue processor: one session at a time; calls `EmbeddingEngine.embed(buildText(session))` then `SemanticIndex.add()`; debounces `save()` by 5 s after each add
  - Updates a VS Code status bar item during bulk indexing: `"$(loading~spin) Chat Wizard: semantic indexing… X/N"`; disposes when queue drains
- [ ] Implement `removeSession(sessionId: string): void`:
  - Calls `SemanticIndex.remove(sessionId)` synchronously
  - Schedules a debounced `save()` (5 s)
- [ ] Implement `search(queryText: string, topK?: number): Promise<SemanticSearchResult[]>`:
  - Embeds `queryText`, delegates to `SemanticIndex.search()`
  - Rejects if `isReady` is false (caller must handle)
- [ ] Implement `get isReady(): boolean`
- [ ] Implement `get indexedCount(): number` (delegates to `SemanticIndex.size`)
- [ ] Implement `dispose(): void` — cancels the queue, disposes the status bar item, calls a final synchronous save
- [ ] Implement private `buildText(session: Session): string`:
  - Concatenates `session.title` + space + all `message.content` joined by `"\n"`
  - Hard-clips to `MAX_CHARS = 2048` chars

### Deliverables

- `src/search/semanticIndexer.ts` — `SemanticIndexer` class
- `test/suite/semanticIndexer.test.ts` — unit tests (see below)

### Manual Testing

Wire the indexer to the real index temporarily in `extension.ts`:

1. Set `chatwizard.enableSemanticSearch: true`.
2. Launch the Extension Development Host — confirm:
   - The consent dialog appears (if model has never been downloaded).
   - A status bar message `"Chat Wizard: semantic indexing… 0/N"` appears while sessions are being embedded.
   - The status bar item disappears when the queue drains.
   - The Output channel logs `"Semantic index saved"` after the debounce period.
3. Restart VS Code — confirm:
   - The model loads from cache (no download progress messages).
   - The status bar message does not reappear (sessions already in the index are skipped).
4. Add a new session (send a message in Copilot/Claude) — confirm the session is scheduled and embedded within a few seconds.
5. Call `semanticIndexer.search('authentication patterns')` from a temporary command and confirm non-empty results are logged.

### Unit Tests

Write unit tests in `test/suite/semanticIndexer.test.ts` covering all public methods of `SemanticIndexer`. Use a mocked `EmbeddingEngine` stub and a real `SemanticIndex` backed by a temporary directory.

---

## Phase 4 — UI: Semantic Search Panel ⬜

**Goal:** A keyboard-accessible quick-pick panel that shows session-level semantic results with similarity scores.

**Depends on:** Phase 3 (SemanticIndexer)

**New file:** `src/search/semanticSearchPanel.ts`

### Tasks

- [ ] Create `SemanticSearchPanel` class with a static `show(context, semanticIndexer, index)` method
- [ ] Create a `vscode.window.createQuickPick<SemanticResultItem>()` where `SemanticResultItem extends vscode.QuickPickItem` and carries `{ summary: SessionSummary; score: number }`
- [ ] Set placeholder: `'Semantic search — describe a topic or question…'`
- [ ] On `onDidChangeValue` (debounced 400 ms):
  - If the indexer is not ready: show a single info item `'$(loading~spin) Semantic index still building (X/N sessions indexed)'`
  - Otherwise: call `semanticIndexer.search(value, 20)`, build items
- [ ] Result items:
  - `label`: `$(sourceIcon)  sessionTitle`
  - `description`: `workspace · date · Score: XX%` (score formatted as `Math.round(score * 100)`)
  - `detail`: (empty — semantic results have no matching message snippet)
- [ ] Add a source filter button (same `SourceFilterState` logic as `SearchPanel`) to narrow results client-side after the semantic search returns
- [ ] On `onDidAccept`: call `vscode.commands.executeCommand('chatwizard.openSession', item.summary)`
- [ ] On `onDidHide`: dispose the quick-pick
- [ ] Add the `$(sparkle)` mode-toggle button to the **existing** `SearchPanel` in `src/search/searchPanel.ts`:
  - Tooltip: `'Switch to Semantic Search'`
  - On click: execute `chatwizard.semanticSearch` and call `quickPick.hide()`

### Deliverables

- `src/search/semanticSearchPanel.ts` — `SemanticSearchPanel` class
- `src/search/searchPanel.ts` modified with the semantic mode-toggle button
- `test/suite/semanticSearchPanel.test.ts` — unit tests (see below)

### Manual Testing

1. Ensure `chatwizard.enableSemanticSearch: true` and the indexer has finished indexing at least a handful of sessions.
2. Run `Chat Wizard: Semantic Search` from the Command Palette — confirm the quick-pick opens with the correct placeholder.
3. Type `"authentication"` — confirm results appear within ~500 ms (400 ms debounce + embed time), each showing title, workspace, date, and a `Score: XX%` percentage.
4. Verify the source filter button cycles through All → Copilot → Claude → All and filters results client-side.
5. Press Enter on a result — confirm the session webview opens.
6. Open the normal `chatwizard.search` panel — confirm the `$(sparkle)` button is present in the toolbar; click it and confirm it switches to the semantic search panel.
7. Type in the semantic panel before indexing is complete — confirm the "still building (X/N)" info item is shown instead of results.
8. With `chatwizard.enableSemanticSearch: false`, run `chatwizard.semanticSearch` — confirm a notification is shown explaining how to enable the feature.

### Unit Tests

Write unit tests in `test/suite/semanticSearchPanel.test.ts` covering `SemanticSearchPanel` behaviour. Use a stubbed `SemanticIndexer` that resolves synchronously with fixture data.

---

## Phase 5 — Extension Wiring ⬜

**Goal:** Connect `SemanticIndexer` and `SemanticSearchPanel` into `extension.ts` and register the new command.

**Depends on:** Phase 3 (SemanticIndexer), Phase 4 (SemanticSearchPanel)

**File changed:** `src/extension.ts`

### Tasks

- [ ] Import `SemanticIndexer` and `SemanticSearchPanel`
- [ ] After `const engine = new FullTextSearchEngine();`, read the `chatwizard.enableSemanticSearch` config and conditionally instantiate `SemanticIndexer`
- [ ] Add a `SessionIndex` typed change listener for semantic updates:
  - `batch` event → `scheduleSession()` for each session not already in the index
  - `upsert` event → `scheduleSession()`
  - `remove` event → `removeSession()`
  - `clear` event → dispose the current indexer and create a fresh one; delete the persisted binary file
- [ ] Register the `chatwizard.semanticSearch` command:
  - If `semanticIndexer` is not instantiated (setting is `false`): show `vscode.window.showInformationMessage("Enable 'chatwizard.enableSemanticSearch' in Settings to use semantic search.")` with a `"Open Settings"` button
  - Otherwise: call `SemanticSearchPanel.show(context, semanticIndexer, index)`
- [ ] Listen to `vscode.workspace.onDidChangeConfiguration` for `chatwizard.enableSemanticSearch`:
  - Turned on at runtime: instantiate and initialize a new `SemanticIndexer`, schedule all currently indexed sessions
  - Turned off at runtime: dispose the indexer, null the reference
- [ ] Push `semanticIndexer` onto `context.subscriptions` (calls `dispose()` on extension deactivation)

### Deliverables

- `src/extension.ts` updated with semantic indexer wiring and new command registration
- `test/suite/semanticWiring.test.ts` — unit tests (see below)

### Manual Testing

1. Launch Extension Development Host with `chatwizard.enableSemanticSearch: false`.
2. Run `Chat Wizard: Semantic Search` from Command Palette — confirm the info message appears with `"Open Settings"` button.
3. Enable `chatwizard.enableSemanticSearch: true` via Settings (no restart) — confirm the semantic indexer starts and the status bar progress appears.
4. Run `Chat Wizard: Semantic Search` — confirm the panel opens and returns results.
5. Disable the setting again at runtime — confirm the status bar item disappears and the command shows the info message again.
6. Deactivate the extension (reload window) — confirm `dispose()` is called (check Output channel for "Semantic index saved" or equivalent).
7. Create a new session in Copilot/Claude with a distinctive topic — confirm it appears in semantic search results within ~10 seconds.
8. Delete a session file on disk — confirm the session is removed from the semantic index (no stale results).

### Unit Tests

Write unit tests in `test/suite/semanticWiring.test.ts` covering the wiring logic in `extension.ts`. Use mocked `SemanticIndexer` and `SessionIndex` stubs.

---

## Open Questions

These must be resolved before Phase 0 begins:

1. **WASM vs native backend** — Start with WASM (`onnxruntime-web`) to skip per-platform native binary compilation, then switch to native once the feature is validated? WASM eliminates `onnxruntime-node` from the build matrix entirely at the cost of ~2× slower inference (~100 ms/embed instead of ~40 ms).

2. **Hybrid search (stretch goal)** — Should semantic and keyword results eventually be merged in a single ranked list (reciprocal rank fusion), or always kept as separate modes? Hybrid is more powerful but significantly more complex — worth deferring to a v2 of this feature.

3. **Model language coverage** — `all-MiniLM-L6-v2` is English-optimised. `paraphrase-multilingual-MiniLM-L12-v2` (~120 MB) handles multilingual sessions. Is the expected user base primarily English?

4. **Result presentation** — Semantic results are session-level (no matching message snippet). On accepting a result, should the command open the session directly (current plan), or highlight the session in the Sessions tree first?

---

## Implementation Order Summary

```
Phase 0 — Dependencies & build config      (no logic, no tests)
  └─► Phase 1 — EmbeddingEngine             (core embedding, unit-tested with mocks + integration)
        └─► Phase 2 — SemanticIndex          (vector store + binary persistence, unit-tested)
              └─► Phase 3 — SemanticIndexer  (orchestrator, unit-tested with mocked engine)
                    └─► Phase 4 — UI Panel   (QuickPick, unit-tested with mocked indexer)
                          └─► Phase 5 — Wiring (extension.ts integration, unit-tested with mocks)
```

Each phase can be code-reviewed and merged independently before the next begins.
