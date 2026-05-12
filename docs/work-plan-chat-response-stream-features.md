# Work Plan: Chat Response Stream API Enhancements

## Background

The VS Code chat `stream` object exposes a richer API than plain markdown text.
ChatWizard currently uses only `stream.markdown()` for all output. This work plan
documents opportunities to use the full stream API to improve existing workflows and
enable new ones.

---

## VS Code Chat Stream API — What Is Available

| Method | What It Renders |
|---|---|
| `stream.markdown(string \| MarkdownString)` | Markdown, GFM tables, fenced code blocks, `command:` URIs |
| `stream.anchor(uri, title?)` | Clickable file/line link (blue file reference pill) |
| `stream.button({ title, command, arguments })` | Clickable inline action button |
| `stream.filetree(items, baseUri)` | VS Code-native collapsible file tree |
| `stream.reference(uri \| Location)` | Source reference chip (like Copilot's "Used N references") |
| `stream.progress(message)` | Transient status message while still processing |
| Fenced ` ```mermaid ` block | VS Code renders Mermaid diagrams natively in chat |

**Not supported:** Raw HTML — VS Code strips it for security.

---

## Feature 1 — Live Progress Messages (`stream.progress`)

**Current state:** All three commands (`answerFromHistory`, `troubleshootFromHistory`,
`continueFromHistory`) are silent while searching. The user sees nothing for 2–3 seconds.

**Proposed change:** Emit progress messages at each pipeline stage:

```
Searching 847 sessions...
Running semantic similarity search...
Found 3 relevant sessions — generating answer...
```

**Implementation:** Add `stream.progress()` calls inside `createParticipantHandler`
at the key pipeline points:
1. Before `prompt.render()` — "Searching N sessions…"
2. After render (session refs parsed) — "Found N relevant sessions — generating answer…"
3. Before `sendRequest` — "Generating answer…"

**Effort:** ~30 min  
**Impact:** Every command benefits immediately. No data dependencies.

---

## Feature 2 — Inline Action Buttons (`stream.button`)

### 2a — `answerFromHistory`

After the synthesized answer, append:
- **[Open in ChatWizard]** → opens the ChatWizard timeline/session view filtered to
  the returned sessions
- **[Export answer]** → saves the synthesized answer + sources to a `.md` file in the
  workspace

### 2b — `continueFromHistory`

After the continuation summary, append:
- **[Pick up where I left off →]** → opens a new chat with the checkpoint's `next_steps`
  pre-filled as context
- **[Open last session]** → opens the most recent matching session in the ChatWizard
  webview

### 2c — `troubleshootFromHistory`

After the diagnosis:
- **[Search for more similar errors]** → re-runs the search with a broader query
- **[Open matching session]** → opens the top-ranked matching session

**Effort:** ~1 hour per command  
**Data dependencies:** None for basic open/export buttons. `next_steps` requires
Chronicle Phase 2 (checkpoint data).

---

## Feature 3 — Clickable File Links (`stream.anchor`)

When retrieved session data includes file paths — either from checkpoint
`important_files` (Chronicle Phase 2) or from `session_files` (Chronicle Phase 3) —
emit actual VS Code file anchors instead of plain text paths:

```typescript
stream.anchor(vscode.Uri.file('/src/auth/jwtHandler.ts'), 'jwtHandler.ts')
```

**Primary use case — `continueFromHistory`:** Instead of:
> "Last time you were editing `src/auth/jwtHandler.ts`"

Render:
> "Last time you were editing [jwtHandler.ts](anchor) and [authMiddleware.ts](anchor)"

**Effort:** ~2 hours  
**Data dependencies:** Chronicle Phase 2 (checkpoint `important_files`) or Phase 3
(`session_files` table).

---

## Feature 4 — File Tree for Work Item / Branch Views (`stream.filetree`)

For the planned `chatwizard_sessions_for_work_item` and
`chatwizard_sessions_for_branch` commands (Chronicle Phase 4), instead of listing
files touched across sessions as bullet points, render a collapsible VS Code file tree:

```
📁 src/auth
   ├ jwtHandler.ts       (3 sessions)
   └ middleware.ts       (1 session)
📁 test/auth
   └ jwtHandler.test.ts  (2 sessions)
```

**Effort:** ~3 hours  
**Data dependencies:** Chronicle Phase 4 (work item / branch grouping + `session_files`).

---

## Feature 5 — Native Reference Chips (`stream.reference`)

Replace (or supplement) the current Sources `MarkdownString` link list with proper
VS Code reference chips — the same style Copilot uses for "Used 3 references".

Each chip would open the session in the ChatWizard webview. Looks more native, less
like appended footnotes.

**Effort:** ~2 hours  
**Impact:** Cosmetic improvement over the current working solution. Lower priority.

---

## Feature 6 — Mermaid Diagrams for Architecture Queries

When `answerFromHistory` or `troubleshootFromHistory` detects an architecture or
design question (heuristic: question contains "architecture", "flow", "diagram",
"how does X work"), include a hint in the LLM prompt instructing it to embed a
Mermaid diagram in its response. VS Code renders these natively in chat:

````markdown
```mermaid
graph LR
  JSONL --> SessionIndex --> FullTextEngine --> GetContextTool --> ChatParticipant
```
````

No stream API change required — this is a prompt engineering addition. The LLM
generates the Mermaid block; VS Code renders it automatically.

**Effort:** ~2 hours  
**Impact:** Niche but high-impression for architecture-oriented queries.

---

## Priority Order

| # | Feature | Effort | Impact | Dependencies |
|---|---|---|---|---|
| 1 | `stream.progress()` — live status | 30 min | High — all commands | None |
| 2 | `stream.button()` on `continueFromHistory` | 1 hour | High — actionable flow | None / Chronicle P2 |
| 3 | `stream.button()` on `answerFromHistory` | 1 hour | Medium | None |
| 4 | `stream.anchor()` for file links | 2 hours | High | Chronicle P2 or P3 |
| 5 | Mermaid diagram generation | 2 hours | Niche | None |
| 6 | `stream.filetree()` for work item/branch | 3 hours | Medium | Chronicle P4 |
| 7 | `stream.reference()` chips for sources | 2 hours | Low — cosmetic | None |
