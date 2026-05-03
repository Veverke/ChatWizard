# ChatWizard — Knowledge Base Generation & Session Tagging Work Plan

_Created: April 2026_

---

## Overview

Two features that are individually useful but compose into something significantly more powerful:

- **Session Tagging / Labels** — lightweight user-defined metadata (`#bugfix`, `#architecture`, `#learning`) stored in a sidecar file alongside the read-only source sessions
- **Knowledge Base / Wiki Generation** — distills a curated set of sessions into a structured Markdown knowledge base, automatically organized by topic clusters or tag chapters

The key relationship: tags are the cheapest possible curation input for the KB. A session tagged `#topic:auth #kind:decision` slots directly into the right chapter with the right entry type — no embedding clustering needed, no ambiguity.

### Core constraints (non-negotiable)

- **Read-only source sessions** — no modifications to files owned by Copilot, Claude, Cursor, etc.
- **User-owned sidecar** — all metadata (tags, bookmarks, annotations) lives in a `chatwizard-metadata.json` file managed by ChatWizard
- **100% local** — no API keys, no network calls, no external AI services
- **Embedding reuse** — the KB clustering pipeline reuses the same embeddings produced by the semantic search feature (`SemanticIndex`); no duplicate model invocations

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Metadata storage | `chatwizard-metadata.json` in `globalStorageUri` | Single source of truth for all user annotations; survives workspace changes |
| Tag format | Freeform strings with optional `type:value` prefix convention | Simple to implement; `topic:auth`, `kind:decision`, `status:resolved` prefix convention is opt-in, not enforced |
| KB chapter source | Tags first, embedding clusters as fallback | Tags encode user intent directly; clustering handles untagged sessions |
| KB output format | Obsidian-compatible Markdown with YAML frontmatter | Most common second-brain tool for developers; wikilinks and frontmatter are the standard |
| Curation opt-in | `#kb` tag or manual checkbox in KB panel | Explicit opt-in; not every session is KB-worthy |
| Incremental export | `kb_manifest.json` tracks exported sessions | Re-runs append new entries; user edits in exported files are preserved via `locked: true` frontmatter flag |
| Entry type detection | Regex/keyword classifier on prompt text | No external AI; extends `promptExtractor.ts` patterns |

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Implementation Order

Phase 0 (sidecar data model) is the strict prerequisite for everything else. Phases 1 and 2 are independent of each other once Phase 0 is in place. Phase 3 depends on both.

```
Phase 0 — Sidecar data model + storage API     ← must complete first
    │
    ├─► Phase 1 — Session Tagging UI            ┐  fully parallel
    └─► Phase 2 — KB Entry Classification       ┘
            │
            └─► Phase 3 — KB Generation + Panel ← converges both tracks
```

---

## Phase 0 — Sidecar Data Model & Storage API ⬜

**Goal:** Define the TypeScript interfaces and the read/write API for `chatwizard-metadata.json`. Everything else in this plan codes against these interfaces.

**Depends on:** Nothing.

### Tasks

- [ ] Define `SessionMetadata` interface in `src/types/index.ts`:
  ```ts
  export interface SessionMetadata {
      sessionId: string;
      tags: string[];           // e.g. ["#kb", "topic:auth", "kind:decision"]
      pinned?: boolean;         // migrated from existing pin mechanism
      status?: 'open' | 'resolved' | 'revisit';
      notes?: string;           // inline annotation
      linkedSessions?: string[];
  }

  export interface ChatWizardMetadata {
      version: number;
      sessions: Record<string, SessionMetadata>;
  }
  ```

- [ ] Create `src/metadata/metadataStore.ts`:
  - `load(): Promise<ChatWizardMetadata>` — reads `globalStorageUri/chatwizard-metadata.json`; returns empty schema if file absent
  - `save(data: ChatWizardMetadata): Promise<void>` — atomic write (write to `.tmp`, rename)
  - `getSession(sessionId: string): SessionMetadata` — returns entry or empty default
  - `updateSession(sessionId: string, patch: Partial<SessionMetadata>): Promise<void>` — merges and saves
  - `addTag(sessionId: string, tag: string): Promise<void>`
  - `removeTag(sessionId: string, tag: string): Promise<void>`
  - `getAllTags(): string[]` — returns sorted deduplicated list of all tags in use

- [ ] Wire `MetadataStore` singleton into `extension.ts` alongside `SessionIndex`

- [ ] Migrate existing pin state into `chatwizard-metadata.json` on first load (one-time migration; old pin storage remains as fallback until confirmed migrated)

---

## Phase 1 — Session Tagging UI ⬜

**Goal:** Allow users to add, remove, and filter by tags from the session tree and session reader. Tags are immediately useful without the KB feature.

**Depends on:** Phase 0.

### Tasks — Session Tree

- [ ] Add tag chips below the session title in `SessionTreeProvider` item rendering (show max 3, `+N more` overflow)

- [ ] Add **"Add Tag…"** to the session item context menu (right-click):
  - Opens `vscode.window.showInputBox` with autocomplete from `MetadataStore.getAllTags()`
  - Tag is normalized to lowercase, `#` prefix optional (normalize on save)
  - Multi-tag input: comma-separated

- [ ] Add **"Remove Tag…"** to context menu: shows `QuickPick` of existing tags on that session

- [ ] Add **"Filter by Tag…"** command (`chatwizard.filterByTag`):
  - `QuickPick` of all tags in use with session counts (`#auth (12)`, `#learning (8)`)
  - Multi-select: show sessions matching ANY selected tag
  - Active tag filter shown in the tree view title bar; clear button to reset

- [ ] Persist active tag filter to `workspaceState` so it survives panel reloads

### Tasks — Session Reader

- [ ] Display tag chips in the session header inside `sessionWebviewPanel.ts` (read-only display; editing from tree only in v1)

### Tasks — Tag Autocomplete & Canonicalization

- [ ] Suggest existing tags on input (prefix match), so users naturally converge on `topic:auth` not both `auth` and `#auth`

- [ ] Add `chatwizard.tagAliases` setting: `{ "auth": "topic:auth", "bug": "kind:gotcha" }` — applied transparently on save

---

## Phase 2 — KB Entry Classification ⬜

**Goal:** Classify sessions (and individual prompt/response pairs) into KB entry types — Decision, Learning, Pattern, Gotcha, Architecture Note — using local heuristics. No external AI.

**Depends on:** Phase 0.

### Entry Types

| Type | Detection Signals |
|---|---|
| **Decision** | Prompts matching: `should I`, `X vs Y`, `which is better`, `I decided`, `we went with`, `tradeoff` |
| **Learning** | Prompts matching: `explain`, `how does`, `why does`, `what is`, `I don't understand`, `walk me through` |
| **Pattern / Reference** | Recurring code blocks (same function signature across ≥2 sessions), `how do I implement`, `snippet for`, `template` |
| **Gotcha / Fix** | Prompts matching: `error:`, `not working`, `why is this failing`, `broken`, `exception`, `TypeError`, `undefined` |
| **Architecture Note** | Prompts matching: `design`, `architecture`, `structure`, `approach`, `system`, `high-level` |

### Tasks

- [ ] Create `src/export/kbEntryClassifier.ts`:
  - `classifySession(session: Session): KBEntryType | null` — returns dominant entry type or `null` if no strong signal
  - `classifyPrompt(prompt: string): KBEntryType | null` — classifies a single message
  - Uses `promptExtractor.ts` output where available; falls back to regex on raw text
  - Confidence score (0–1) returned alongside type; below threshold → `null`

- [ ] Define `KBEntryType` union and `KBEntry` interface in `src/export/kbTypes.ts`:
  ```ts
  export type KBEntryType = 'decision' | 'learning' | 'pattern' | 'gotcha' | 'architecture';

  export interface KBEntry {
      type: KBEntryType;
      chapter: string;           // cluster name or tag-derived chapter
      title: string;             // first user prompt, truncated
      summary: string;           // extracted key paragraph from AI response
      codeSnippet?: string;      // first code block if present
      sessionId: string;
      date: Date;
      tags: string[];
      confidence: number;
  }
  ```

- [ ] Create `src/export/kbClusterer.ts`:
  - `clusterSessions(sessions: Session[], metadata: ChatWizardMetadata): KBCluster[]`
  - **Tag-first**: sessions with `topic:X` tags → chapter `X` directly
  - **Embedding fallback**: untagged sessions → cosine similarity grouping via `SemanticIndex` embeddings (separate distance threshold from search; default 0.65)
  - Chapter name inference for embedding clusters: TF-IDF of noun phrases / code entity names across cluster sessions
  - Returns `KBCluster[]` with `{ name, sessions, inferredName: boolean }`

- [ ] Unit tests in `test/suite/kbEntryClassifier.test.ts` covering each entry type's detection patterns

---

## Phase 3 — KB Generation & Panel ⬜

**Goal:** A command that opens a preview panel, lets the user review and adjust clusters and entries, then writes the Markdown KB to disk.

**Depends on:** Phase 0, Phase 1, Phase 2.

### KB Panel UI

Layout mirrors `promptLibraryPanel.ts`:
- **Left column**: Chapter list (cluster/tag names, session count per chapter, editable names)
- **Center column**: Entry list for selected chapter (type badge, title, date, confidence indicator)
- **Right column**: Live preview of the selected entry + export config

User actions in the panel:
- Rename a chapter
- Merge two chapters (drag or "Merge with…" button)
- Exclude a session from a chapter
- Toggle entry type override (e.g., reclassify a Learning as a Decision)
- Set output format, date range filter, output path
- **Preview full output** before writing

### Tasks — Panel

- [ ] Create `src/export/kbPanel.ts`:
  - Webview panel, reuses `webviewUtils.ts` helpers
  - Message protocol: `{ type: 'renameChapter' | 'mergeChapters' | 'excludeSession' | 'overrideEntryType' | 'export' | ... }`
  - Live preview re-renders on every user action

- [ ] Register `chatwizard.generateKnowledgeBase` command in `extension.ts`:
  - Reads `MetadataStore` for tags
  - Calls `kbClusterer.clusterSessions()`
  - Calls `kbEntryClassifier.classifySession()` for each session in each cluster
  - Opens `KBPanel` with the result

### Tasks — Markdown Exporter

- [ ] Create `src/export/knowledgeBaseExporter.ts`:
  - `export(clusters: KBCluster[], entries: KBEntry[], config: KBExportConfig): Promise<void>`
  - Writes one `.md` file per chapter into `config.outputDir`
  - Writes `_index.md` with chapter TOC and `[[wikilink]]` cross-references
  - YAML frontmatter per entry: `date`, `source`, `session_id`, `tags`, `kind`, `locked`
  - Entry deduplication: if same session appears in two clusters, primary chapter gets the full entry; secondary chapter gets a cross-reference stub

- [ ] `KBExportConfig` interface:
  ```ts
  export interface KBExportConfig {
      outputDir: string;
      format: 'obsidian' | 'single-file' | 'docusaurus';
      dateRange?: { from: Date; to: Date };
      includeTypes: KBEntryType[];
      minConfidence: number;   // default 0.5
  }
  ```

- [ ] Incremental export support:
  - Write `kb_manifest.json` to `outputDir` listing exported session IDs and their last-exported date
  - On re-run, skip sessions already in manifest unless session metadata changed
  - Entries with `locked: true` in frontmatter are never overwritten

- [ ] Single-file output mode: concatenate all chapters into one `KNOWLEDGE_BASE.md` with `## Chapter` headings

### Tasks — Settings

- [ ] Add to `package.json` contributes/configuration:
  - `chatwizard.kb.defaultOutputDir` — default KB output folder (default: workspace root)
  - `chatwizard.kb.defaultFormat` — `"obsidian" | "single-file" | "docusaurus"` (default: `"obsidian"`)
  - `chatwizard.kb.minConfidence` — entry classifier confidence threshold (default: `0.5`)
  - `chatwizard.tagAliases` — tag canonicalization map (default: `{}`)

---

## Open Design Questions

These decisions are deferred until implementation begins; the choices made here have non-trivial UX consequences.

| Question | Options | Recommendation |
|---|---|---|
| **Incremental vs. snapshot** | Always regenerate vs. append new entries | Incremental (manifest approach) — user edits in exported files must survive re-runs |
| **User edits survivability** | `locked: true` frontmatter vs. merge mode | `locked: true` for v1; merge mode is a v2 enhancement |
| **Cluster granularity** | Single distance threshold vs. configurable | Separate `chatwizard.kb.clusterThreshold` setting; default 0.65 (vs. 0.75 for search) |
| **Entry deduplication** | One canonical entry + cross-ref stubs vs. duplicates in each chapter | Canonical + stubs; `also discussed in: [session list]` footer on cross-refs |
| **Tag UI placement** | Inline in tree vs. separate Tags sidebar vs. both | Inline chips in tree (v1); dedicated Tag filter panel can come later |
| **`#kb` opt-in vs. all-sessions** | Require `#kb` tag vs. include all sessions by default | Opt-in via `#kb` tag by default; configurable to include all in settings |

---

## File Map

New files this plan introduces:

```
src/
  metadata/
    metadataStore.ts          ← Phase 0
  export/
    kbTypes.ts                ← Phase 2
    kbEntryClassifier.ts      ← Phase 2
    kbClusterer.ts            ← Phase 2
    kbPanel.ts                ← Phase 3
    knowledgeBaseExporter.ts  ← Phase 3
test/
  suite/
    kbEntryClassifier.test.ts ← Phase 2
```

Modified files:

```
src/types/index.ts              ← SessionMetadata, ChatWizardMetadata, KBEntry, KBEntryType
src/extension.ts                ← MetadataStore singleton, chatwizard.generateKnowledgeBase command,
                                   chatwizard.filterByTag command
src/views/sessionTreeProvider.ts  ← tag chips, context menu items, tag filter
src/views/sessionWebviewPanel.ts  ← tag chips in session header
src/export/markdownSerializer.ts  ← reused by knowledgeBaseExporter
package.json                    ← new commands, settings, context menu contributions
```
