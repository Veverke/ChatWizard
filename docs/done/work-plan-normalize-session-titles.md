# Work Plan: Normalize Session Titles

## Background

Chat sessions are typically named after the first user prompt — the LLM generates a
title by semantically analyzing it. In practice users often stay on the same chat
session as topics shift, leaving the original title inaccurate or misleading.

**Goal:** Give users a way to regenerate session titles so each one reflects what was
*actually* discussed. When a session covers multiple unrelated topics, the title
should say so explicitly (e.g. `"3 topics: Docker setup → React hooks → TS generics"`).

---

## Core Constraint: ChatWizard is Read-Only

Normalized titles **cannot be written back** to the source AI tool's file. They must
live in ChatWizard's own metadata layer — `chatwizard-metadata.json`, which is already
planned in `docs/work-plan-kb-and-tagging.md`. The `SessionMetadata` interface there
gains a `customTitle?: string` field. `SessionTreeItem` will prefer `customTitle` when
set, with a small `✏` indicator to show the title has been overridden.

**Revert is free:** since only ChatWizard's metadata is touched (never the source
file), *"Reset to Original Title"* is trivial — just clear `customTitle`.

---

## Title Generation — Tiered Source Strategy

Three tiers, evaluated in order per session:

### Tier 1 — Copilot Chronicle SQLite (`checkpoints` table)

The Chronicle store (`session-store.db`) is populated by Copilot at session compaction
and contains AI-generated structured summaries. For Copilot sessions with Chronicle
data, **no additional LLM call is needed** — the AI already did the work.

Relevant columns:

| Column | Use |
|---|---|
| `overview` | Primary candidate for a single-topic title |
| `work_done` | More precise; focuses on what was accomplished |
| `technical_details` | Useful for disambiguation |

**Multi-topic detection via multiple checkpoints:** If a session was compacted more
than once, it has multiple checkpoint rows for the same `session_id`. This is a
structural signal that the conversation drifted. Each checkpoint `overview` becomes
one segment in the `"N topics: A → B → C"` format — no embedding math required.

**Gating:** Chronicle data only exists when `chat.localIndex.enabled` is on (server-side
A/B flag, overridable by the user). The engine must fall through to Tier 2 silently
when no checkpoint rows exist.

### Tier 2 — VS Code LM API (Copilot subscription, no extra key)

`vscode.lm.selectChatModels()` calls Copilot's model through the user's existing
subscription. No external API key, no network calls outside what Copilot already makes.
ChatWizard already has a `chatParticipant.ts` on the same surface area.

The prompt fed to the model is built from the session's user turns (first N chars of
each, to stay within context limits). It asks for:
- A concise title (≤ 60 chars)
- A topic count and comma-separated list if more than one distinct topic is detected

Used for: Copilot sessions with no Chronicle data, and all non-Copilot sessions.

### Tier 3 — Offline heuristic (no dependencies)

Fallback when neither Chronicle nor an LM is available.

Options:
- **TF-IDF over user prompts** — extract top N noun phrases
- **Embedding cosine similarity** — reuse the existing `EmbeddingEngine`; large drops
  between consecutive user-turn embeddings signal topic boundaries; cluster and pick
  representative text per cluster

Lower accuracy but zero external dependencies. Useful for fully offline scenarios or
when the user has not yet built the semantic index.

---

## Multi-Topic Title Format

Proposed format when N > 1 topics are detected:

```
"3 topics: Docker setup → React hooks → TS generics"
```

The `→` conveys chronological drift rather than treating all topics as equal.
Alternative formats to consider:

- `"Docker setup, React hooks, TS generics"` — flat, shorter
- `"Docker setup (+ 2 more topics)"` — emphasizes the primary topic
- `"3 topics: A, B and C"` — natural language feel

Character limit: **60 chars** recommended to avoid truncation in narrow tree views.
Topic segment phrases should be trimmed to fit.

---

## User Flows

### Bulk — "Normalize Session Titles" (primary use case)

1. Command palette → *Normalize Session Titles…*
2. Optional scope picker: all sessions / last N days / specific source / specific workspace
3. Progress notification while titles are generated (async, batched)
4. Preview diff list: old title → proposed title, one row per session
5. User can: Accept All, Reject All, or toggle individual sessions
6. Accepted titles written to `chatwizard-metadata.json`

### Single session — context menu

Right-click session in tree → *"Suggest Better Title"*
→ Input box pre-filled with the generated suggestion
→ User edits or accepts
→ Saves to metadata

### MCP tool (bonus)

`chatwizard_suggest_title(sessionId)` — returns a proposed title string. LLM clients
can call it, present the result to the user, and the user confirms via the extension
or directly edits.

---

## Indicator for Overridden Titles

`SessionTreeItem` should signal that a title has been manually normalized. Options:

- Small `✏` suffix in the tree label
- Dedicated icon overlay (like the existing parse-error `⚠` badge)
- Tooltip line: `Title normalized by ChatWizard (original: "…")`

The *"Reset to Original Title"* context menu entry clears `customTitle` and removes
the indicator.

---

## Architecture / Where It Fits

```
SessionMetadata.customTitle          ← write destination (KB/tagging Phase 0)
        ↑
src/titles/titleEngine.ts            ← new service; tiered strategy
    ├── ChronicleBackend             ← reads checkpoints table (Chronicle Phase 1)
    ├── LmApiBackend                 ← calls vscode.lm API
    └── HeuristicBackend             ← TF-IDF / embedding clustering, offline
        ↑
chatwizard.normalizeTitles command   ← bulk flow (extension.ts)
chatwizard.suggestSessionTitle       ← single-session flow (context menu)
chatwizard_suggest_title MCP tool    ← optional MCP exposure
```

`SessionTreeItem` reads `customTitle ?? summary.title` and adds the `✏` indicator.

### Natural build order (dependencies first)

1. **Chronicle integration** (`work-plan-extra-chat-data.md` Phase 1) — makes
   checkpoint data available in the index
2. **`SessionMetadata.customTitle`** (`work-plan-kb-and-tagging.md` Phase 0) — the
   write destination
3. **`TitleEngine`** with tiered backends
4. **Bulk normalize command** + single-session context menu entry
5. *Optional:* MCP `chatwizard_suggest_title` tool

---

## Open Questions

1. **Confidence threshold** — if the session is single-topic and the original title is
   already a good match, should the engine skip it silently? A confidence score (from
   the LM response or cosine similarity) could avoid proposing worse titles than what
   already exists.

2. **Re-run policy** — once a title is normalized, is it locked until the user
   explicitly re-runs? Or does it regenerate when the session gains new messages? The
   latter risks clobbering a title the user manually edited.

3. **Source bias** — Claude and Cursor often generate reasonable titles natively;
   Copilot titles tend to be the best normalization targets. Worth defaulting the bulk
   scope filter to Copilot-only on first run?

4. **Distinguishing Chronicle-backed vs LM-inferred titles** — should the `✏`
   indicator (or tooltip) say where the title came from? E.g. `"Title generated from
   Copilot session summary"` vs `"Title inferred by ChatWizard"`.

5. **Batch size and rate limiting** — the LM API tier will be slow for large
   backlogs. What's an acceptable batch size? Should there be a progress bar with a
   cancel button?

6. **Character limit enforcement** — 60 chars is a suggestion; should it be
   user-configurable via `chatwizard.normalizedTitleMaxLength`?

7. **What counts as "multi-topic"?** — with the heuristic/embedding backend there's
   no clean threshold. Two questions need answering: how different must embeddings be
   to count as a new topic, and what's the minimum segment length (in turns) to
   qualify as a distinct topic vs a brief tangent?

8. **Scope of the bulk command** — should it only target sessions that still have
   their *original* (never-overridden) title, or also re-normalize previously
   normalized ones?
