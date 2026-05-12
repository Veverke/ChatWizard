# Work Plan: Missing Testing Layers

**Status:** Active  
**Priority:** High — multiple runtime bugs went undetected because the test coverage  
did not exercise the layers where those bugs lived.

---

## Background

A series of runtime bugs were discovered and fixed in a single debugging session:

| Bug | Location | Root Cause |
|-----|----------|------------|
| `answerFromHistory` generated generic advice without consent | `chatParticipant.ts` + `contextPrompts.ts` | LLM prompt said "give general guidance if no match"; handler streamed live without accumulating |
| Sources table appeared at **bottom** of response | `chatParticipant.ts` | Handler streamed LLM chunks live; sources appended after |
| Irrelevant "Open:" button | `chatParticipant.ts` | Always showed `existingRefs[0]` regardless of relevance |
| VS Code Insiders sessions invisible | `copilotWorkspace.ts` | `getWorkspaceStorageRoot()` hardcoded to `Code` variant |
| Workspace picker showed 0 / wrong session counts | `manageWorkspaces.ts` | Three sub-bugs: byteMap overwrite, duplicate IDs, Claude filePath-prefix strategy missing |
| `chatwizard.copilotStoragePath` setting ignored | `copilotWorkspace.ts` | Discovery layer never called `resolveCopilotStoragePath()` |

None of these were caught by the existing unit or e2e tests, because those tests  
only covered the happy path with minimal fixtures and did not exercise multi-variant  
paths, accumulation semantics, or stream ordering.

---

## Poorly-Tested Areas — Comprehensive Table

### Layer 1 — Readers / Discovery

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| `getWorkspaceStorageRoots()` — both variants exist | ❌ None | Returns wrong subset or empty | `copilotWorkspaceRoots.test.ts` Suite A |
| `getWorkspaceStorageRoots()` — only stable Code exists | ❌ None | Returns [] or panics | `copilotWorkspaceRoots.test.ts` Suite A |
| `getWorkspaceStorageRoots()` — only Insiders exists | ❌ None | Insiders sessions invisible | `copilotWorkspaceRoots.test.ts` Suite A |
| `getWorkspaceStorageRoots()` — custom `chatwizard.copilotStoragePath` | ❌ None | Custom path silently ignored | `copilotWorkspaceRoots.test.ts` Suite A |
| `discoverCopilotWorkspaces()` — multi-root scan | ❌ None | Only first root scanned | `copilotWorkspaceRoots.test.ts` Suite B |
| `discoverCopilotWorkspacesAsync()` — multi-root scan | Partial (empty-root case only) | Promise.all failure on second root | `asyncFileDiscovery.test.ts` — add multi-root test |
| `discoverClaudeWorkspaces()` — missing home dir | ⚠️ Minimal | Throws; no sessions returned | `claudeWorkspace.test.ts` |
| `discoverCursorWorkspaces()` — no state.vscdb | ⚠️ Minimal | Returns 0 sessions | `cursorWorkspace.test.ts` |
| `readWorkspaceJson()` — percent-encoded Windows path | ❌ None | `%3A` not decoded; path comparison fails | `copilotWorkspace.test.ts` |

### Layer 2 — Session Index

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| `SessionIndex.getAllSummaries()` — returns filePath correctly | ⚠️ Minimal | filePath undefined; Claude prefix match silently fails | `sessionIndex.test.ts` |
| `SessionIndex.upsert()` — same ID updates in-place | ✅ Covered | — | — |
| `SessionIndex.search()` — empty query | ❌ None | Throws or returns all sessions | `sessionIndex.test.ts` |
| `SessionIndex.search()` — multi-workspace scope filtering | ⚠️ Partial | Scope filter bypassed; wrong-workspace results shown | `sessionIndex.test.ts` |

### Layer 3 — Manage Workspaces Command (Item Building)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| `indexCountForIds` — Copilot sessions via workspaceId | ❌ None | Count returns 0 | `manageWorkspacesSessionCount.test.ts` Suite A |
| `indexCountForIds` — Copilot from Code-Insiders (same hash, different storageDir) | ❌ None | Code-Insiders sessions not counted | `manageWorkspacesSessionCount.test.ts` Suite A |
| `indexCountForIds` — Claude sessions via filePath prefix | ❌ None | All Claude sessions show 0 | `manageWorkspacesSessionCount.test.ts` Suite B |
| `indexCountForIds` — mixed Copilot + Claude in same folder group | ❌ None | Partial count only | `manageWorkspacesSessionCount.test.ts` Suite C |
| Byte map — additive accumulation for duplicate IDs | ❌ None | Bytes from second root silently lost | `manageWorkspacesSessionCount.test.ts` Suite D |
| `allIds` — deduplication of duplicate IDs | ❌ None | Bytes / disk sessions counted twice | `manageWorkspacesSessionCount.test.ts` Suite E |
| QuickPick item construction — correct label/description format | ❌ None | UI shows wrong info | E2E / integration test needed |
| Scope manager persist/restore cycle | ⚠️ Partial | Selected IDs lost across restarts | `workspaceScope.test.ts` |

### Layer 4 — Chat Participant (`answerFromHistory`)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| No sessions found → button offered, LLM never called | ✅ Added (test 4b) | — | — |
| LLM returns sentinel → button offered, no sources | ✅ Added (test 4c) | — | — |
| Sources table appears **before** LLM answer in stream | ✅ Added (test 7b) | — | — |
| `--general` flag path: LLM called with general guidance prompt | ❌ None | User clicks button but gets error / empty response | `chatParticipant.test.ts` |
| `chatwizard.answer.general` command registration | ❌ None | Command not found at runtime | Integration test |
| `/troubleshootFromHistory` — equivalent sentinel / button flow | ❌ None | Same class of bug could recur | `chatParticipant.test.ts` |
| `/continueFromHistory` — no sessions → sensible message | ❌ None | Unhandled undefined crash | `chatParticipant.test.ts` |
| Long LLM response — accumulation does not lose chunks | ❌ None | Streaming cut short | `chatParticipant.test.ts` |
| `parseSessionRefs()` — malformed prompt (no `ID:` line) | ❌ None | Returns undefined IDs; `filter` crashes | `chatParticipant.test.ts` or unit test |
| `buildSourcesMarkdown()` — sessions with no title | ❌ None | Renders `undefined` in link text | `chatParticipant.test.ts` or unit test |
| `filterPromptToAllowedSessions()` — scope filtering | ❌ None | All sessions returned regardless of scope | Unit test |

### Layer 5 — MCP Prompts (`contextPrompts.ts`)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| Sentinel phrase unchanged between prompt and handler | ❌ None | Sentinel mismatch → LLM answer never shown | Snapshot / contract test |
| `--general <q>` flag recognised and routed to general branch | ❌ None | Flag ignored; general prompt not rendered | `contextPrompts.test.ts` |
| Session passage truncation at token limit | ❌ None | Prompt exceeds model context window | `contextPrompts.test.ts` |
| Prompt renders all fields (title, date, passage, ID) | ⚠️ Partial | Fields missing; LLM loses context | `contextPrompts.test.ts` |

### Layer 6 — Path Resolution / Config (`configPaths.ts` / `workspaceScope.ts`)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| `chatwizard.copilotStoragePath` — used by `getWorkspaceStorageRoots()` | ❌ None | Setting silently ignored | `copilotWorkspaceRoots.test.ts` (VS Code host only) |
| `resolveCopilotStoragePath()` — interaction with `getWorkspaceStorageRoots()` | ⚠️ Exists but stale | Function defined but not called | `configPaths.test.ts` — add deprecation note test |
| `calcWorkspaceSizeBytes()` — Copilot source | ❌ None | Returns 0 for valid workspace | `workspaceScope.test.ts` |
| `calcWorkspaceSizeBytes()` — Claude source | ❌ None | Returns 0 for valid workspace | `workspaceScope.test.ts` |
| `countWorkspaceSessions()` — Copilot source | ❌ None | Returns 0 when chatSessions/ has files | `workspaceScope.test.ts` |
| `countWorkspaceSessions()` — Claude source | ❌ None | Returns 0 when .jsonl files exist | `workspaceScope.test.ts` |

### Layer 7 — Parsers (edge cases)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| Copilot parser — messages with `type: "tool"` skipped | ⚠️ Basic | Tool messages leak into sessions; inflated counts | `copilot.test.ts` |
| Claude parser — empty conversation file | ❌ None | Throws JSON parse error | `claude.test.ts` |
| Claude parser — `summary` field as title fallback | ❌ None | Title undefined; index corrupted | `claude.test.ts` |
| Cursor parser — workspace path extracted correctly | ⚠️ Minimal | Wrong workspacePath; scope filter fails | `cursor.test.ts` |
| Cline parser — `roocode` variant recognised | ❌ None | `roocode` sessions ignored | `cline.test.ts` |
| Windsurf parser — state.vscdb schema differences | ❌ None | Parser throws on Windsurf-specific schema | `windsurf.test.ts` |

### Layer 8 — Search / Similarity (`similarityEngine.ts`, `sessionIndex.ts`)

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| TF-IDF similarity — returns top-N by score | ⚠️ Smoke only | Returns irrelevant sessions | `similarityEngine.test.ts` |
| Similarity with empty index | ❌ None | Throws / NaN | `similarityEngine.test.ts` |
| `getContext` tool — relevance threshold filtering | ❌ None | Low-relevance sessions included | `mcpTools.test.ts` |
| `search` tool — keyword match across sources | ⚠️ Partial | Source filter ignored | `mcpTools.test.ts` |
| `find_similar` tool — returns [] for unknown session ID | ❌ None | Throws or returns all sessions | `mcpTools.test.ts` |

### Layer 9 — Watcher / File System Events

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| New `.jsonl` file triggers re-index | ❌ None | New sessions invisible until restart | `fileWatcher.test.ts` |
| Deleted `.jsonl` file removes sessions from index | ❌ None | Stale sessions linger; false search hits | `fileWatcher.test.ts` |
| Watcher starts for Insiders storage root | ❌ None | Code-Insiders sessions never update live | `fileWatcher.test.ts` |
| Watcher recovers from root dir deletion | ❌ None | Extension crashes silently | `fileWatcher.test.ts` |

### Layer 10 — Analytics / Timeline / UI

| Area | Current Coverage | Gap | Proposed Test |
|------|-----------------|-----|---------------|
| Token counter — `countTokens()` with CJK characters | ❌ None | Token count wildly wrong for non-ASCII | `tokenCounter.test.ts` |
| Model usage engine — aggregates by model name | ❌ None | Model aliasing wrong; chart misleading | `modelUsageEngine.test.ts` |
| Timeline view — sessions sorted by date | ❌ None | New sessions show at bottom | `timeline.test.ts` |
| Export to Markdown — code blocks preserved | ❌ None | Fenced blocks stripped | `markdownSerializer.test.ts` |
| Prompt library — de-duplicate identical prompts | ❌ None | Duplicate prompts shown | `promptLibrary.test.ts` |

---

## Prioritised Delivery Plan

### Phase 1 — Critical Path Regression Tests (Now)
These were written as part of the current fix session:

- [x] `test/suite/copilotWorkspaceRoots.test.ts` — path discovery, multi-root scans
- [x] `test/suite/manageWorkspacesSessionCount.test.ts` — `indexCountForIds`, byte accumulation, dedup
- [x] `test/suite/mcp/chatParticipant.test.ts` — sentinel flow, button consent, sources ordering

### Phase 2 — High Value (Next sprint)

Covers the next most likely class of regression:

- [ ] `test/suite/workspaceScope.test.ts` — `calcWorkspaceSizeBytes`, `countWorkspaceSessions` for Copilot and Claude sources, using `os.tmpdir()` fake filesystem fixtures
- [ ] `test/suite/contextPrompts.test.ts` — sentinel phrase contract, `--general` branch, field rendering
- [ ] `test/suite/chatParticipant.test.ts` additions — `--general` flow, `/troubleshootFromHistory` sentinel, `/continueFromHistory` no-session path
- [ ] `test/suite/asyncFileDiscovery.test.ts` — add multi-root test (both Code + Insiders dirs)

### Phase 3 — Parser Edge Cases

- [ ] `test/suite/parsers/claude.test.ts` — empty file, summary fallback, multi-conversation format
- [ ] `test/suite/parsers/cursor.test.ts` — workspace path extraction, schema variants
- [ ] `test/suite/parsers/cline.test.ts` — `roocode` variant, missing `api_conversation_history.json`
- [ ] `test/suite/parsers/copilot.test.ts` — `tool` message type filtering

### Phase 4 — Search Quality + MCP Tools

- [ ] `test/suite/similarityEngine.test.ts` — top-N relevance, empty index, threshold behaviour
- [ ] `test/suite/mcp/mcpTools.test.ts` — `getContext` relevance threshold, `search` source filter, `find_similar` unknown ID

### Phase 5 — Watcher + Analytics

- [ ] `test/suite/fileWatcher.test.ts` — new file triggers re-index, delete removes sessions, Insiders root watched
- [ ] `test/suite/tokenCounter.test.ts` — CJK characters, empty string, exact known values
- [ ] `test/suite/markdownSerializer.test.ts` — code block preservation, frontmatter, multi-turn conversations

---

## Conventions for New Tests

All new test files should follow the existing patterns in this repository:

```typescript
// 1. Use os.tmpdir() with timestamp for isolation
let tmpDir: string;
setup(() => { tmpDir = path.join(os.tmpdir(), `cw_test_${Date.now()}`); fs.mkdirSync(tmpDir, { recursive: true }); });
teardown(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// 2. Never import vscode at module scope in pure-logic tests — it's unavailable outside the extension host
// 3. Use SessionIndex directly — it does not require vscode
// 4. FakeGlobalState for WorkspaceScopeManager tests:
class FakeGlobalState {
    private map = new Map<string, unknown>();
    get<T>(key: string): T | undefined { return this.map.get(key) as T; }
    async update(key: string, value: unknown): Promise<void> { this.map.set(key, value); }
}
// 5. Tag bug-regression tests with "BUG regression:" in name so they are easy to filter
```

---

## Metrics Target

| Layer | Tests Before This Session | Tests After Phase 1 | Target After Phase 5 |
|-------|--------------------------|--------------------|-----------------------|
| Readers / Discovery | 2 | 12 | 20 |
| Session Index | 4 | 4 | 10 |
| Manage Workspaces | 3 | 11 | 15 |
| Chat Participant | 7 | 11 | 18 |
| MCP Prompts | 1 | 1 | 6 |
| Parsers | 6 | 6 | 24 |
| Search / Similarity | 2 | 2 | 10 |
| Watcher | 0 | 0 | 8 |
| Analytics / Timeline | 0 | 0 | 10 |
| **Total** | **25** | **47** | **121** |
