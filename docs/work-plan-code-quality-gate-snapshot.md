# ChatWizard — Code Quality Gate Snapshot

Date: 2026-05-17
Scope: Baseline static analysis of the source tree as of v1.4.0, producing letter-graded scores across three engineering dimensions. This document is the parent reference; the three sibling work-plans (complexity, security, memory/disk) contain the actionable improvement items.

---

## Purpose

Establishes a scored baseline that can be re-evaluated after each improvement sprint to track progress objectively. Scores are 1–10.

---

## 1.1 Modularity — 6 / 10

### Strengths

- Clean directory layout: `parsers/`, `readers/`, `search/`, `views/`, `mcp/`, `analytics/`, `timeline/`, `watcher/`. Each AI source has its own paired reader + parser file.
- MCP tooling follows a clear per-file-per-tool structure under `mcp/tools/`.
- Contracts / interfaces (`ISemanticIndexer`, `IEmbeddingEngine`, `ISemanticIndex`, `IMcpTool`) isolate seams well and enable dependency injection.
- `SessionIndex` is a focused in-memory store with a well-defined event contract (`SessionIndexEvent`).

### Weaknesses

- `src/extension.ts` is **1,859 lines** — a God File that instantiates every component, registers every command (sortBy*, cbSortBy*, filter, export, MCP start/stop, pin, tag…), wires every event listener, and contains inline callback logic. Touching almost any feature requires editing it.
- `src/watcher/fileWatcher.ts` is **1,305 lines**, covering initial discovery, live change detection, and parse-dispatch for all 8 AI sources in one class.
- Three panel files (`analyticsPanel.ts`, `promptLibraryPanel.ts`, `sessionWebviewPanel.ts`) mix webview lifecycle management with large embedded HTML/CSS/JS generation strings, making them hard to test or reuse.
- `SessionWebviewPanel`, `AnalyticsPanel`, and `CodeBlocksPanel` use static singleton fields (`_panel`, `_panels`, `_renderCache`) — implicit global state, not injectable.

### Path to 8/10

- Extract a `CommandRegistrar` / `ListenerRegistrar` from `extension.ts`; shrink `activate()` to a coordinator of ≤ 150 lines.
- Introduce a `SourceWatcher` strategy interface so adding a 9th AI source does not require editing `fileWatcher.ts`.
- Move embedded HTML templates to separate `.html`/`.ts` template files, leaving panels as pure lifecycle managers.

---

## 1.2 SOLID Compliance — 5 / 10

### S — Single Responsibility

`extension.ts` violates SRP severely; it is simultaneously a composition root, a command palette, an event bus, and a state-restoration layer. `fileWatcher.ts` is responsible for discovering, watching, and parse-dispatching for all 8 sources. `sessionTreeProvider.ts` handles rendering, sorting, filtering, grouping, pinning, drag-and-drop, and manual ordering — six distinct concerns.

### O — Open/Closed

Adding a new AI source requires changes in at minimum `fileWatcher.ts`, `extension.ts`, `configPaths.ts`, `sessionTreeProvider.ts`, the `SessionSource` union type, and `package.json`. The `parsers/` and `readers/` folder conventions are structurally open, but the wiring is hard-coded rather than discovered. Registering MCP tools via a list is a positive example of OCP.

### L — Liskov Substitution

No violations observed. `NullSemanticIndexer` implements `ISemanticIndexer` cleanly (Null Object pattern). The semantic proxy in `extension.ts` substitutes transparently for the real `SemanticIndexer`.

### I — Interface Segregation

`IMcpTool`, `IMcpPrompt`, and `ISemanticIndexer` are lean and well-scoped. `SessionIndex` accumulates too many query responsibilities (summaries, prompts, code blocks, fuzzy search, sidecar metadata, chronicle merge) — a read-model / write-model split would align with ISP.

### D — Dependency Inversion

`SemanticIndexer` and `EmbeddingEngine` accept factories for testability — exemplary. `SemanticIndexerVsCodeApi` abstracts VS Code UI interactions for test injection. However, panel classes (`AnalyticsPanel`, `CodeBlocksPanel`) take a concrete `SessionIndex` directly with no interface; most view-layer code couples to concrete types.

### Path to 7/10

- Extract a `SourceWatcher` strategy interface for OCP on new AI sources.
- Define an `ISessionReadModel` interface for the subset of `SessionIndex` queries that views need.
- Split `sessionTreeProvider.ts` into a `SessionSorter`, `SessionFilter`, and `SessionTreeDataProvider`.

---

## 1.3 Test Practices — 7 / 10

### Strengths

- 60+ test files covering parsers, readers, search engines, tree providers, analytics, MCP tools, sidecar store, and telemetry — comprehensive unit coverage across all subsystems.
- Substantive test depth: `sessionIndex.test.ts` (777 lines), `cursorParser.test.ts` (746 lines), `searchEngine.test.ts` (518 lines), `semanticIndexer.test.ts` (497 lines).
- Every AI source has its own parser test and workspace-discovery test.
- Fixture factories and corpus helpers (`fixtureFactory.ts`, `semanticCorpus.ts`) reduce boilerplate and improve readability.
- Dependency injection in `SemanticIndexer`, `EmbeddingEngine`, and `McpServer` enables clean unit tests without a VS Code runtime.
- Coverage data is collected and the `coverage/` directory is present.

### Weaknesses

- `extension.ts` has no direct tests — its 1,859-line `activate()` function is effectively untested at any level.
- Webview HTML rendering has no snapshot or DOM-based tests; a crafted XSS payload in a session title would not be caught by the test suite.
- The `test/e2e/integration/` tests are unit-style tests, not actual end-to-end extension tests running in VS Code's Extension Development Host.
- `fileWatcher.ts` tests exist but the live-watch paths (fsWatcher events) are difficult to exercise without real filesystem events.
- No mutation testing or coverage-threshold enforcement in CI; it is unknown whether 100% line-coverage tests actually validate behaviour.

### Path to 9/10

- Add a dedicated `activateExtension.test.ts` that exercises `activate()` / `deactivate()` with a mock `ExtensionContext`.
- Add webview snapshot tests that render `getShellHtml()` output and assert no unescaped `<script>` tags appear when sessions contain HTML content.
- Establish minimum branch-coverage thresholds (80%) in the CI pipeline.
- Add at least one real VS Code Extension Development Host test using `@vscode/test-electron`.

---

## Sibling Work-Plans

| Document | Focus |
|----------|--------|
| [work-plan-code-complexity.md](work-plan-code-complexity.md) | Top 10 complexity / performance improvements |
| [work-plan-security.md](work-plan-security.md) | Top 10 security issues |
| [work-plan-memory-disk.md](work-plan-memory-disk.md) | Top 10 memory & disk consumption issues |
