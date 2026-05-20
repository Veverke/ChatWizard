# ChatWizard — P1 Work Plan (Do Now)

_Created: May 2026_
_Source: P1 section of [whats-next.md](whats-next.md)_

---

## Overview

This plan breaks down all nine P1 features into atomic, independently-implementable tasks.
Each feature closes with mandatory UT coverage, e2e tests, manual verification steps, and a
completion gate. Features have no inter-dependencies unless explicitly stated.

**Effort key:** XS < 1 day · S = 1–3 days · M = 1–2 weeks  
**File path conventions:** all paths are workspace-relative from `c:\_\ChatWizard`.

---

## Feature 1 — Multi-source UI fixes (Cursor / Cline / Roo Code / Windsurf / Aider)

_Effort: S · Priority: P1 · No blockers_

### Context

Five session sources (`cursor`, `cline`, `roocode`, `windsurf`, `aider`) are fully indexed but
three UI surfaces still treat them as second-class citizens:

| Surface | Bug |
|---------|-----|
| Analytics panel (`analyticsPanel.ts` lines 619–621) | Source badge falls back to `cw-badge-claude` (purple) for any source that is not `copilot`. |
| Timeline source dropdown (`timelineViewProvider.ts` lines 546–548) | Dropdown has only three options: Copilot, Claude, Antigravity. The five new sources are missing. |
| Search / Semantic search source cycle (`searchPanel.ts` line 15, `semanticSearchPanel.ts` line 19) | `SourceFilterState` type and its `next*` / `icon*` / `tooltip*` helpers cycle through only four states; five sources are not reachable. |

CSS brand variables for the new sources are also absent from `cwTheme.ts`.

---

### Task 1-A — Add CSS brand variables for all sources

**File:** `src/webview/cwTheme.ts`

Add per-source CSS custom properties for the five missing sources. Use neutral-but-distinct
colors that respect both light and dark VS Code themes:

```
--cw-source-cursor:      #00b4d8   (Cursor teal)
--cw-source-cline:       #9b59b6   (Cline purple, distinct from Claude's existing purple)
--cw-source-roocode:     #e67e22   (Roo Code orange)
--cw-source-windsurf:    #1abc9c   (Windsurf green)
--cw-source-aider:       #e74c3c   (Aider red)
```

Also add corresponding `cw-badge-*` CSS classes (`cw-badge-cursor`, `cw-badge-cline`, etc.)
following the same `.cw-badge-copilot` / `.cw-badge-claude` pattern already present.

**Acceptance:** `cwThemeCss()` output contains all five new `--cw-source-*` variables and
`.cw-badge-*` selectors.

---

### Task 1-B — Fix analytics panel badge mapping

**File:** `src/analytics/analyticsPanel.ts`

Replace the two-branch `srcBadge` ternary (lines 619–621) with a lookup that covers every
`SessionSource` value:

```ts
const SOURCE_BADGE_CLASS: Record<string, string> = {
    copilot:     'cw-badge-copilot',
    claude:      'cw-badge-claude',
    antigravity: 'cw-badge-antigravity',
    cursor:      'cw-badge-cursor',
    cline:       'cw-badge-cline',
    roocode:     'cw-badge-roocode',
    windsurf:    'cw-badge-windsurf',
    aider:       'cw-badge-aider',
};
```

Apply the same lookup to the top-sessions table badge column and any other badge render site
in the file.

**Acceptance:** Analytics panel renders the correct brand-color badge for each of the eight
sources.

---

### Task 1-C — Fix timeline source dropdown

**File:** `src/timeline/timelineViewProvider.ts`

Extend the source `<select>` HTML (lines 546–548) to include all eight `SessionSource` values:

```html
<option value="">All sources</option>
<option value="copilot">GitHub Copilot</option>
<option value="claude">Claude Code</option>
<option value="antigravity">Google Antigravity</option>
<option value="cursor">Cursor</option>
<option value="cline">Cline</option>
<option value="roocode">Roo Code</option>
<option value="windsurf">Windsurf</option>
<option value="aider">Aider</option>
```

Fix the badge class ternary (lines 749–751) to use the same `SOURCE_BADGE_CLASS` lookup
introduced in Task 1-B (extract to `src/ui/sourceUi.ts` so both files share it).

**Acceptance:** Timeline dropdown shows all eight sources; selecting each filters the timeline
correctly; each source badge uses its brand color.

---

### Task 1-D — Fix search-panel source filter cycle

**Files:** `src/search/searchPanel.ts`, `src/search/semanticSearchPanel.ts`

Replace the hardcoded `SourceFilterState` union and the `nextSourceState` / `sourceButtonIcon`
/ `sourceButtonTooltip` functions with a data-driven cycle over all eight `SessionSource`
values plus `'all'`. The cycle order: `all → copilot → claude → antigravity → cursor → cline → roocode → windsurf → aider → all`.

Use `sourceCodiconId()` from `src/ui/sourceUi.ts` to retrieve the icon for each state so the
mapping stays in one place.

**Acceptance:** Source cycle button in both search panels steps through all nine states with
correct icons and tooltips.

---

### Task 1-E — Analytics panel per-source session cards

**File:** `src/analytics/analyticsPanel.ts`

The summary cards section currently shows only aggregate counts. Render one card per source
that actually has sessions, using `analyticsData.sessionCountsBySource`. Cards use the brand
badge class from Task 1-B. Sources with zero sessions are omitted.

**Acceptance:** Analytics panel summary row shows a separate card for each source that has at
least one indexed session, labelled with the source's friendly name and its badge color.

---

### UT coverage — Feature 1

Add or extend tests in `test/` covering:

- `cwThemeCss()` output contains all eight `cw-badge-*` selectors (snapshot or contains assertion).
- `analyticsPanel` badge lookup returns the correct class for every `SessionSource` value, including the fallback for unknown strings.
- `nextSourceState` cycle (or equivalent) visits every source exactly once before returning to `'all'`.
- Timeline filter with `source: 'cursor'` returns only cursor sessions from a fixture index containing mixed sources.
- Timeline filter with `source: 'aider'` returns only aider sessions.

---

### e2e tests — Feature 1

In `scripts/` or `test/e2e/`, add a scenario that:

1. Loads a fixture session index with at least one session per source (use existing fixture helpers).
2. Opens the Analytics panel; asserts each source card is present and has a non-purple badge.
3. Opens the Timeline view; exercises the source dropdown for `cursor`, `windsurf`, `aider`, confirms the filtered entry count changes.
4. Opens the Search panel; cycles through all nine source states; confirms the filter is applied.

---

### Manual tests — Feature 1

Perform in the Extension Development Host with a real session index containing Cursor, Cline,
and Windsurf sessions (use the dev fixture path or real `~/.config` data):

1. Open Chat Analytics — verify each source shows its own card with its brand color, not purple.
2. Open Timeline — open the source dropdown — verify all eight sources appear as options.
3. Select "Cursor" from the Timeline dropdown — verify only Cursor sessions appear.
4. Open full-text search — click the source cycle button — step through all states — verify button icon changes at each step and search results narrow to the selected source.
5. Open semantic search — repeat step 4.
6. In the Analytics panel, scroll to the session table — verify each row badge shows the correct source color.

> **Pre-flight issues found during plan authoring:**
> - Timeline line 751 hard-codes `'cw-badge-claude'` as fallback; without Task 1-C this silently miscolors every non-copilot/non-antigravity session.
> - `analyticsPanel.ts` badges ternary at line 619 covers only copilot; everything else gets the Claude badge regardless of source.

---

### Completion gate — Feature 1

- [ ] All five tasks (1-A through 1-E) implemented and passing lint.
- [ ] All UT assertions pass.
- [ ] All e2e scenarios pass.
- [ ] All manual tests performed and no badge or filter regressions observed.
- [ ] **Feature 1 complete.**

---

---

## Feature 2 — Chat participant: live progress messages

_Effort: XS · Priority: P1 · No blockers_

### Context

All three `@chatwizard` slash commands (`/queryHistory`, `/continueFromHistory`, `/getPrompts`)
are silent for 2–3 seconds while running their pipeline. The VS Code chat API provides
`stream.progress(message)` for exactly this purpose. Currently zero progress messages are
emitted — the chat panel shows a blank spinner until the full response arrives.

**File:** `src/mcp/chatParticipant.ts`

---

### Task 2-A — Add progress messages to `/queryHistory`

The `/queryHistory` pipeline has three measurable stages:

1. **Query preparation** — tokenizing, ranking tokens by rarity against the index.
2. **Search** — running semantic + full-text engines and merging results.
3. **Response assembly** — filtering, rendering the ranked session table, and streaming markdown.

Inject `stream.progress()` calls before each stage. Use the live session count from the index:

```
"Searching 847 sessions…"
"Found 5 candidate sessions — evaluating relevance…"
"Assembling answer from 3 confirmed matches…"
```

Session count comes from `sessionIndex.getAllSummaries().length`. Candidate count is available
after the search merge. Confirmed count is after the `filterPromptToAllowedSessions` pass.

**Acceptance:** Invoking `@chatwizard /queryHistory <query>` shows at least two visible
progress messages before the answer appears.

---

### Task 2-B — Add progress messages to `/continueFromHistory`

Pipeline stages:

1. **Session lookup** — retrieving the most recent session(s).
2. **Summary generation** — extracting or inferring continuation context.
3. **Response assembly**.

```
"Retrieving your most recent session…"
"Building continuation summary…"
"Ready — here is where you left off…"
```

**Acceptance:** Invoking `@chatwizard /continueFromHistory` shows at least two visible
progress messages before the response.

---

### Task 2-C — Add progress messages to `/getPrompts`

Pipeline stages:

1. **Prompt library load** — scanning the prompt library.
2. **Similarity ranking** — scoring prompts against the current context.
3. **Response assembly**.

```
"Loading prompt library…"
"Ranking prompts by relevance…"
"Found <N> matching prompts…"
```

**Acceptance:** Invoking `@chatwizard /getPrompts` shows at least two visible progress messages.

---

### UT coverage — Feature 2

Progress messages are injected into a `vscode.ChatResponseStream`. The stream is already
mockable in unit tests via the existing test helpers. Add assertions that:

- The mock stream's `progress` method is called at least twice during a `/queryHistory`
  execution against a fixture index.
- The first progress call occurs before the first `markdown` call.
- Progress messages are non-empty strings.

---

### e2e tests — Feature 2

Add an e2e scenario that uses the VS Code extension test harness to invoke each slash command
and captures `ChatResponseStream` calls in sequence. Assert:

1. At least one `stream.progress` call precedes the first `stream.markdown` call for each command.
2. Progress text mentions a session count for `/queryHistory`.

---

### Manual tests — Feature 2

1. Type `@chatwizard /queryHistory what is my JWT auth approach` in the Copilot Chat panel —
   verify that a "Searching N sessions…" message appears before the table of results.
2. Type `@chatwizard /continueFromHistory` — verify that "Retrieving your most recent session…"
   appears within ≤ 500 ms.
3. Type `@chatwizard /getPrompts` — verify a progress message appears.
4. Repeat with an empty session index (use a temp workspace) — verify the progress message
   gracefully says "0 sessions" rather than crashing.

> **Pre-flight issue:** If session count is retrieved inside the async render path, it may show
> `0` before indexing completes. Retrieve the count at the top of the handler before any await.

---

### Completion gate — Feature 2

- [ ] Tasks 2-A, 2-B, 2-C implemented.
- [ ] UT passes: progress called before markdown, non-empty strings.
- [ ] e2e passes.
- [ ] Manual: progress messages visible in all three commands.
- [ ] **Feature 2 complete.**

---

---

## Feature 3 — Chat participant: inline action buttons

_Effort: S · Priority: P1 · No blockers_

### Context

After `/queryHistory` and `/continueFromHistory` produce output, users must manually open the
session tree to act on results. VS Code's `stream.button()` API surfaces `vscode.Command`-
backed buttons directly inside the chat response. No other API change is needed.

**File:** `src/mcp/chatParticipant.ts`

---

### Task 3-A — Register required commands (if not already registered)

The buttons reference VS Code commands via `vscode.Command`. Ensure the following commands are
registered in `src/extension.ts` (they may already exist as palette commands):

| Command ID | Action |
|------------|--------|
| `chatwizard.openSession` | Opens the session reader for the given `sessionId`. |
| `chatwizard.focusSessionTree` | Reveals and focuses the ChatWizard session tree panel. |
| `chatwizard.exportSession` | Opens the export flow for the given `sessionId`. |

If a command is already registered, no change is needed — Task 3-A is a verification step.

**Acceptance:** All three command IDs are resolvable via `vscode.commands.getCommands()` in
the dev host.

---

### Task 3-B — Add buttons after `/queryHistory` results

After streaming the ranked session table in `/queryHistory`, append two buttons:

```ts
stream.button({
    command: 'chatwizard.focusSessionTree',
    title: '$(list-tree) Open in ChatWizard',
    tooltip: 'Focus the ChatWizard session tree',
    arguments: [],
});

stream.button({
    command: 'chatwizard.exportSession',
    title: '$(export) Export answer',
    tooltip: 'Export this answer to Markdown',
    arguments: [{ sessionId: refs[0]?.id }],
});
```

Only render the export button when at least one session reference was returned.

**Acceptance:** After a `/queryHistory` response, two action buttons are visible in the chat
panel and clicking each executes the correct command.

---

### Task 3-C — Add buttons after `/continueFromHistory` results

After the continuation summary is streamed, append:

```ts
stream.button({
    command: 'chatwizard.openSession',
    title: '$(arrow-right) Pick up where I left off',
    tooltip: 'Open the last session in the reader',
    arguments: [{ id: lastSessionId }],
});

stream.button({
    command: 'chatwizard.focusSessionTree',
    title: '$(history) Open last session in tree',
    tooltip: 'Reveal this session in the ChatWizard tree',
    arguments: [],
});
```

`lastSessionId` is the session ID of the most recently updated session surfaced in the
continuation summary.

**Acceptance:** After `/continueFromHistory`, two action buttons appear; "Pick up where I left
off" opens the session reader for the most recent session.

---

### UT coverage — Feature 3

Mock `vscode.ChatResponseStream` and assert:

- After a `/queryHistory` execution returning ≥ 1 result, `stream.button` is called at least
  twice.
- After a `/queryHistory` execution returning 0 results, the export button is **not** rendered
  (no crash, one fewer button call).
- After `/continueFromHistory` with a known `lastSessionId`, `stream.button` is called with
  `arguments[0].id === lastSessionId`.

---

### e2e tests — Feature 3

1. Invoke `/queryHistory` against a fixture index with ≥ 1 result — assert `stream.button`
   calls include `chatwizard.focusSessionTree` and `chatwizard.exportSession`.
2. Invoke `/queryHistory` against an empty index — assert no export button call.
3. Invoke `/continueFromHistory` — assert `stream.button` is called with the correct
   `lastSessionId` argument.

---

### Manual tests — Feature 3

1. Run `@chatwizard /queryHistory <real query with known results>` — verify two buttons appear
   below the result table.
2. Click "Open in ChatWizard" — verify the session tree panel is focused.
3. Click "Export answer" — verify the export dialog opens.
4. Run `@chatwizard /queryHistory <query with no results>` — verify only the "Open in
   ChatWizard" button appears (no Export button).
5. Run `@chatwizard /continueFromHistory` — verify "Pick up where I left off" opens the
   session reader to the correct session.
6. Verify the button labels are visible in both light and dark VS Code themes.

> **Pre-flight issue:** `stream.button` is only available in VS Code ≥ 1.90. Add a runtime
> version guard: `if (typeof stream.button === 'function')` before each call to avoid
> exceptions on older hosts.

---

### Completion gate — Feature 3

- [ ] Task 3-A verified (commands registered).
- [ ] Tasks 3-B and 3-C implemented with version guard.
- [ ] UT assertions pass.
- [ ] e2e assertions pass.
- [ ] Manual: buttons visible and functional in both commands; zero-result edge case handled.
- [ ] **Feature 3 complete.**

---

---

## Feature 4 — Copilot Chronicle Phase 1: search quality boost

_Effort: S · Priority: P1 · No blockers_

### Context

Copilot's own internal `session-store.db` (the "Chronicle" SQLite store) contains a
`checkpoints` table with rich, AI-summarized session metadata: `overview`, `work_done`,
`technical_details`, `next_steps`. These fields are topically focused and dramatically more
search-friendly than raw conversation turns. No competitor reads this store.

Chronicle location:
- Windows: `%APPDATA%\Code\User\workspaceStorage\<hash>\GitHub.copilot-chat\debug-logs\session-store.db`  
  _(hash = any workspace that has ever had Copilot active)_
- macOS: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/…`
- Linux: `~/.config/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/…`

Graceful degradation: if the DB is not found or is locked, index continues with existing data.

---

### Task 4-A — Create `src/readers/chronicleWorkspace.ts`

Discover all `session-store.db` files under `workspaceStorage`:

```ts
export interface ChronicleDbInfo {
    dbPath: string;      // absolute path to session-store.db
    workspaceHash: string;
}

export async function discoverChronicleDbsAsync(storageRoot?: string): Promise<ChronicleDbInfo[]>
```

- Enumerate subdirectories of `workspaceStorage`.
- For each, check `GitHub.copilot-chat/debug-logs/session-store.db` with a symlink guard.
- Return all readable DB paths.

**Acceptance:** `discoverChronicleDbsAsync()` returns all Chronicle DBs present in the test
fixture directory; returns `[]` gracefully when the directory does not exist.

---

### Task 4-B — Create `src/parsers/chronicle.ts`

Open each Chronicle DB (read-only, WAL mode) using the existing `better-sqlite3` dependency
and extract checkpoint text:

```ts
export interface ChronicleCheckpoint {
    sessionId: string;         // links to Copilot session ID
    overview: string | null;
    workDone: string | null;
    technicalDetails: string | null;
    nextSteps: string | null;
    createdAt: string | null;  // ISO-8601
}

export function readChronicleCheckpoints(dbPath: string): ChronicleCheckpoint[]
```

SQL:
```sql
SELECT session_id, overview, work_done, technical_details, next_steps, created_at
FROM checkpoints
```

- Handle `SQLITE_BUSY` by retrying once with WAL mode, then returning `[]`.
- Handle missing `checkpoints` table (older Chronicle versions) by returning `[]`.
- Cap text fields at 8 KB each to prevent index bloat.

**Acceptance:** Parser returns expected checkpoint rows from a fixture Chronicle DB; returns
`[]` on a locked or missing DB without throwing.

---

### Task 4-C — Merge Chronicle text into the session index

**File:** `src/index/sessionIndex.ts`

After indexing a Copilot session, look up its Chronicle checkpoints by `session_id` and append
the non-null text fields as a virtual "chronicle" message at the end of the session's
`messages` array. This message has `role: 'assistant'` and `content` assembled from available
fields:

```
[Chronicle overview]
<overview>

[Work done]
<work_done>

[Technical context]
<technical_details>
```

This message participates in both full-text and semantic search without modifying source files
or the original `Session` shape. Tag it `isChronicle: true` in an optional field so the reader
view can display it distinctly or hide it.

**Acceptance:** After indexing a Copilot workspace that has a Chronicle DB, searching for a
term that appears only in `checkpoints.technical_details` returns the correct session.

---

### Task 4-D — Add `FileSystemWatcher` for Chronicle DB changes

**File:** `src/watcher/` (existing watcher infrastructure)

Register a watcher on the Chronicle DB path. On change, re-read checkpoints for affected
sessions and update the index. Use the same debounce pattern as existing watchers (300 ms).

**Acceptance:** Modifying a fixture Chronicle DB triggers a re-index of the affected session
within 1 second in a test harness.

---

### UT coverage — Feature 4

- `discoverChronicleDbsAsync` with a temp directory containing mock DB files at the expected
  path returns correct `ChronicleDbInfo` entries.
- `discoverChronicleDbsAsync` with a missing root returns `[]`.
- `readChronicleCheckpoints` with a fixture DB returns correctly mapped `ChronicleCheckpoint[]`.
- `readChronicleCheckpoints` with a DB that has no `checkpoints` table returns `[]`.
- `readChronicleCheckpoints` with a DB that is locked (simulate with a write lock) returns `[]`
  without throwing.
- Session index search finds a term present only in a Chronicle checkpoint field.

---

### e2e tests — Feature 4

1. Load a fixture Copilot session alongside a fixture Chronicle DB whose `checkpoints.technical_details`
   contains the string `"event-sourcing-cqrs-pattern"`.
2. Perform a full-text search for `"event-sourcing-cqrs-pattern"` — assert the session is returned.
3. Perform a semantic search — assert the session is in the top-3 results.
4. Remove the Chronicle DB from the fixture path — assert indexing still succeeds (graceful
   degradation).

---

### Manual tests — Feature 4

1. Activate the extension with a real Copilot workspace that has a Chronicle DB.
2. Open the Output panel → ChatWizard; verify a log line mentioning Chronicle checkpoints
   loaded (add a log call in Task 4-C).
3. Search for a topic you discussed with Copilot last week — verify the search rank improves
   compared to a no-Chronicle run (disable the Chronicle merge and compare).
4. Simulate Chronicle DB unavailability by renaming the DB — verify extension activates
   normally with no error toasts.
5. Rename the DB back — verify re-indexing picks it up within a few seconds.

> **Pre-flight issue:** `better-sqlite3` may fail to open a WAL DB that Copilot has open with
> an exclusive lock. Always open with `{ readonly: true, fileMustExist: true }` and wrap in a
> try-catch. Test on Windows specifically — WAL lock behavior differs from macOS/Linux.

---

### Completion gate — Feature 4

- [ ] Tasks 4-A through 4-D implemented.
- [ ] All UT cases pass including the locked-DB and missing-table scenarios.
- [ ] e2e passes including graceful-degradation scenario.
- [ ] Manual: search quality improvement observable; no error toasts on missing/locked DB.
- [ ] **Feature 4 complete.**

---

---

## Feature 5 — Copilot Chronicle Phase 2: enhanced `/continueFromHistory`

_Effort: S · Priority: P1 · Depends on: Feature 4 (Chronicle reader must be available)_

### Context

`/continueFromHistory` currently reconstructs session context by feeding raw messages to the
LLM. For Copilot sessions with Chronicle data, `checkpoints.next_steps` and
`checkpoints.work_done` already contain an AI-generated continuation summary at near-zero cost.
Using them directly eliminates the LLM inference step, speeds the response, and produces more
accurate output.

**File:** `src/mcp/chatParticipant.ts` and `src/mcp/prompts/contextPrompts.ts`

---

### Task 5-A — Expose Chronicle checkpoint data on `Session` objects

**File:** `src/types/index.ts`

Add an optional field to the `Session` interface:

```ts
interface ChronicleData {
    nextSteps: string | null;
    workDone: string | null;
    overview: string | null;
}

interface Session {
    // ... existing fields ...
    chronicleData?: ChronicleData;
}
```

Populate `chronicleData` in `sessionIndex.ts` when Chronicle checkpoints are available for
that session (reuse the data fetched in Feature 4 Task 4-C).

**Acceptance:** `session.chronicleData` is populated for Copilot sessions that have a
matching Chronicle DB entry; is `undefined` for other sources.

---

### Task 5-B — Use `chronicleData` in the `/continueFromHistory` prompt renderer

**File:** `src/mcp/prompts/contextPrompts.ts` (the `continueFromHistory` prompt)

In the prompt's `render()` method, check `session.chronicleData`:

```ts
if (session.chronicleData?.nextSteps) {
    // Use Chronicle data directly — no LLM inference needed
    continuationText = buildChronicleContination(session.chronicleData);
} else {
    // Fall back to existing LLM-based summarization
    continuationText = await inferContinuation(session);
}
```

`buildChronicleContination` formats the Chronicle fields into the same output shape the LLM
path produces, so downstream rendering is unchanged:

```
**What was done:**
<work_done>

**Next steps:**
<next_steps>
```

**Acceptance:** For a Copilot session with Chronicle data, the `/continueFromHistory` response
populates "What was done" and "Next steps" from Chronicle fields without making an LLM call.

---

### Task 5-C — Log the data source in the continuation response

In the streamed response, add a small footer indicating the data source so the user
understands the provenance:

```
_Context sourced from Copilot Chronicle (no LLM inference required)._
```

For sessions without Chronicle data, the footer reads:

```
_Context inferred from session messages._
```

**Acceptance:** Footer is visible and correct for both the Chronicle and non-Chronicle paths.

---

### UT coverage — Feature 5

- `buildChronicleContination` formats `ChronicleData` into the expected Markdown string.
- When `session.chronicleData` is populated, the prompt renderer does not call the LLM
  inference path (mock the LLM call and assert it is not invoked).
- When `session.chronicleData` is `undefined`, the LLM inference path is called as before.
- `session.chronicleData` is `undefined` for a Claude session (not Copilot).

---

### e2e tests — Feature 5

1. Load a fixture Copilot session with Chronicle data whose `next_steps` = `"Implement the
   retry logic for the webhook handler"`.
2. Invoke `/continueFromHistory` — assert the response contains `"retry logic"` and the
   Chronicle source footer.
3. Load a fixture session without Chronicle data — invoke `/continueFromHistory` — assert the
   response contains the inference footer and no Chronicle footer.

---

### Manual tests — Feature 5

1. Open `@chatwizard /continueFromHistory` in a workspace where the last session has Chronicle
   data — verify the response appears faster than before (no LLM round-trip) and mentions
   "Copilot Chronicle".
2. Open `/continueFromHistory` in a workspace where the last session has no Chronicle data
   (e.g. a Claude session) — verify it falls back gracefully with the inference footer.
3. Verify the "What was done" and "Next steps" sections match what Copilot actually summarized
   (cross-check against the session itself).

> **Pre-flight issue:** `checkpoints.next_steps` may be NULL for very short sessions. Guard
> with `?? ''` and omit the section header if the value is empty.

---

### Completion gate — Feature 5

- [ ] Tasks 5-A, 5-B, 5-C implemented.
- [ ] UT: Chronicle path skips LLM; non-Chronicle path falls back correctly.
- [ ] e2e: Chronicle data populates continuation; non-Chronicle falls back.
- [ ] Manual: faster response with Chronicle; graceful fallback without.
- [ ] **Feature 5 complete.**

---

---

## Feature 6 — Antigravity `conversations/` JSON support

_Effort: S · Priority: P1 · No blockers_

### Context

Antigravity writes full chat conversations to `~/.gemini/antigravity/conversations/*.json`.
This directory was missed during original Antigravity research. Each file contains structured
`role`/`content` pairs (similar to Claude's format). Sessions here are deduplicated against
existing `brain/` data by conversation UUID. This upgrades Antigravity coverage from partial
agent-trace logs to full conversation history.

---

### Task 6-A — Extend `src/readers/antigravityWorkspace.ts`

Add a new discovery function alongside the existing `discoverAntigravityConversationsAsync`:

```ts
export interface AntigravityJsonConversationInfo {
    conversationId: string;   // filename stem (UUID)
    jsonFile: string;          // absolute path to the .json file
}

export function getAntigravityConversationsRoot(override?: string): string
// Returns ~/.gemini/antigravity/conversations

export async function discoverAntigravityJsonConversationsAsync(
    override?: string
): Promise<AntigravityJsonConversationInfo[]>
```

Apply the same symlink guard pattern as `discoverAntigravityConversationsAsync`. Cap at
10,000 files with a warning log.

**Acceptance:** Function returns all `.json` files in the conversations directory; returns `[]`
gracefully when the directory does not exist.

---

### Task 6-B — Create JSON conversation parser in `src/parsers/antigravity.ts`

Add a new export alongside the existing `parseAntigravityConversation`:

```ts
export interface AntigravityJsonMessage {
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
    createTime?: string;  // ISO-8601
}

export interface AntigravityJsonConversation {
    conversationId?: string;
    messages: AntigravityJsonMessage[];
    createTime?: string;
    updateTime?: string;
}

export async function parseAntigravityJsonConversation(
    jsonFile: string,
    maxLineChars?: number
): Promise<ParseResult>
```

- Parse the JSON file; map `role: 'model'` → `role: 'assistant'`.
- Extract `parts[].text` as the message content.
- Derive title from the first user message (truncated to 120 chars).
- Derive `updatedAt` from `updateTime` or the last message's `createTime`.
- Return `ParseResult` (never throw); populate `errors[]` for malformed JSON.

**Acceptance:** Parser correctly maps a fixture conversation file to a `Session`; handles
malformed JSON without throwing.

---

### Task 6-C — Wire into the watcher and index

**File:** `src/watcher/` (or wherever `antigravityWorkspace.ts` is called)

Register a `FileSystemWatcher` on `~/.gemini/antigravity/conversations/*.json`.
On discovery, index each JSON conversation using `parseAntigravityJsonConversation`.

**Deduplication:** If a conversation UUID already exists in the index from the `brain/`
reader (`source: 'antigravity'`), skip the JSON file to avoid double-counting. Compare by
`conversationId`.

**Acceptance:** JSON conversations appear in the session tree; conversations already indexed
from `brain/` are not duplicated.

---

### Task 6-D — Extend analytics and UI for JSON-sourced Antigravity sessions

The `source` field remains `'antigravity'` for JSON-parsed sessions. No badge change is needed.
However, add an optional `subSource: 'brain' | 'conversations'` field to `Session` so the
reader view can show a tooltip distinguishing which Antigravity data path the session came from.

**Acceptance:** Session reader tooltip displays `"Source: Google Antigravity (conversations)"`
vs `"Source: Google Antigravity (brain)"`.

---

### UT coverage — Feature 6

- `discoverAntigravityJsonConversationsAsync` with a fixture conversations directory returns
  correct `AntigravityJsonConversationInfo[]`.
- `discoverAntigravityJsonConversationsAsync` with no directory returns `[]`.
- `parseAntigravityJsonConversation` with a valid fixture file returns a `Session` with correct
  message count, title, `updatedAt`, and `source: 'antigravity'`.
- `parseAntigravityJsonConversation` with a malformed JSON file returns `ParseResult` with
  populated `errors[]` and no throw.
- Deduplication: when both brain and conversations paths provide a session with the same UUID,
  the index contains exactly one entry.

---

### e2e tests — Feature 6

1. Provide a fixture directory `test/fixtures/antigravity/conversations/` with two `.json`
   conversation files.
2. Activate a test index — assert both sessions appear in the session tree.
3. Provide a brain fixture with the same conversation UUID — assert only one session is indexed
   after deduplication.
4. Provide a malformed `.json` file alongside a valid one — assert the valid session is indexed
   and an error is logged for the malformed one without crashing.

---

### Manual tests — Feature 6

1. If Antigravity is installed and has a `~/.gemini/antigravity/conversations/` directory, activate
   the extension and verify that sessions from that directory appear in the tree (they were not
   visible before this feature).
2. Open one of the newly-indexed sessions; verify message rendering looks correct (user /
   assistant turns, no raw JSON artefacts).
3. Verify that sessions also indexed via `brain/` are not duplicated in the tree.
4. Temporarily rename the conversations directory; verify the extension activates with no errors
   and the brain sessions still appear.

> **Pre-flight issue:** Antigravity JSON `role` field uses `'model'` not `'assistant'`. The
> mapper in Task 6-B must normalise this before constructing the `Session.messages` array.
> Not doing so will cause all messages to be invisible in the reader.

---

### Completion gate — Feature 6

- [ ] Tasks 6-A through 6-D implemented.
- [ ] UT: discovery, parse, deduplication, and malformed-file scenarios pass.
- [ ] e2e: sessions appear; deduplication works; malformed file does not crash.
- [ ] Manual: Antigravity `conversations/` sessions visible in tree; no duplicates.
- [ ] **Feature 6 complete.**

---

---

## Feature 7 — Mermaid diagram generation in architecture queries

_Effort: S · Priority: P1 · No blockers_

### Context

VS Code renders ```` ```mermaid ```` blocks natively in chat responses. When a user's
`/queryHistory` query appears to be an architecture or design question, injecting a prompt
hint that asks the LLM to include a Mermaid diagram turns a text answer into a visual one —
with zero stream API changes.

**Files:** `src/mcp/chatParticipant.ts`, `src/mcp/prompts/contextPrompts.ts`

---

### Task 7-A — Implement architecture query detector

**File:** `src/mcp/chatParticipant.ts` (or a new `src/utils/queryClassifier.ts`)

```ts
export function isArchitectureQuery(query: string): boolean
```

Return `true` when the lowercased query contains two or more of:

```
architecture, design, diagram, flow, structure, system, component,
service, module, layer, pipeline, schema, data model, relationship,
dependency, topology, sequence, interaction
```

**Acceptance:** `isArchitectureQuery` returns `true` for `"explain the service architecture"`,
`false` for `"how do I fix the JWT bug"`.

---

### Task 7-B — Inject Mermaid hint into the `/queryHistory` prompt

**File:** `src/mcp/prompts/contextPrompts.ts`

In the `/queryHistory` prompt `render()` method, after the base instruction block, conditionally
append:

```
If the question concerns architecture, system design, component relationships, or data flow,
include a Mermaid diagram (```mermaid ... ```) in your response to illustrate the structure
described in the sessions above. Use flowchart LR or sequenceDiagram as appropriate.
```

This hint is appended only when `isArchitectureQuery(query)` returns `true`.

**Acceptance:** The rendered prompt string contains the Mermaid hint when the query is
architectural; does not contain it for non-architectural queries.

---

### Task 7-C — Verify Mermaid rendering in the chat panel

This is a smoke-test task. No code change is required. Confirm via manual testing (Task 7
manual tests) that VS Code renders a ```` ```mermaid ```` block returned by the LLM inline
in the chat response.

If VS Code does NOT render the block (e.g. the chat participant does not support markdown
fence rendering), add a fallback: convert the Mermaid source to a VS Code `MarkdownString`
and wrap it with `stream.markdown(mermaidMd)` directly. Detect LLM output containing
```` ```mermaid ```` in the streamed text and pass it through unchanged.

**Acceptance:** A ```` ```mermaid ```` block in the LLM's response is visible as a rendered
diagram in the chat panel OR as a readable Mermaid source block.

---

### UT coverage — Feature 7

- `isArchitectureQuery` returns `true` for a set of known architecture queries.
- `isArchitectureQuery` returns `false` for a set of known non-architecture queries.
- `isArchitectureQuery` is case-insensitive.
- The prompt renderer includes the Mermaid hint exactly once for an architecture query.
- The prompt renderer does not include the Mermaid hint for a non-architecture query.

---

### e2e tests — Feature 7

1. Invoke `/queryHistory "describe the authentication service architecture"` against a fixture
   index containing sessions about auth services — assert the rendered prompt contains the
   Mermaid hint string.
2. Invoke `/queryHistory "how do I fix the null pointer error"` — assert the prompt does NOT
   contain the Mermaid hint.

---

### Manual tests — Feature 7

1. Run `@chatwizard /queryHistory describe the overall system architecture` in a workspace with
   relevant sessions — verify the LLM response includes a ```` ```mermaid ```` block AND that
   the block renders as a diagram in the chat panel.
2. Run `@chatwizard /queryHistory what was the last bug I fixed` — verify no diagram appears.
3. Vary the architecture vocabulary (`component relationships`, `data flow diagram`, `sequence
   of API calls`) — verify the detector triggers for each.
4. Run with a session index containing no architectural content — verify the LLM either
   produces a minimal diagram or omits the Mermaid block without erroring.

> **Pre-flight issue:** If the LLM returns an invalid Mermaid definition (e.g. mixing flowchart
> and sequence syntax), VS Code may show a red error inside the diagram block. This is an LLM
> output quality issue — the hint should specify a single diagram type per invocation
> (`flowchart LR` OR `sequenceDiagram`, chosen by the detector based on the query verb).

---

### Completion gate — Feature 7

- [ ] Tasks 7-A and 7-B implemented.
- [ ] Task 7-C smoke-tested; fallback implemented if needed.
- [ ] UT: detector accuracy; prompt hint conditional injection.
- [ ] e2e: hint present/absent based on query type.
- [ ] Manual: diagram renders for architecture queries; no diagram for non-architecture queries.
- [ ] **Feature 7 complete.**

---

---

## Feature 8 — Session title normalization

_Effort: M · Priority: P1 · Depends on: Feature 9 (sidecar metadata) for persistence_

### Context

Copilot sessions have cryptic UUID-based or first-prompt-truncated titles. The feature gives
users a command to regenerate titles using a three-tier strategy:

1. **Copilot Chronicle `checkpoints.overview`** — free, no LLM call.
2. **VS Code LM API** (`vscode.lm.selectChatModels`) — uses the user's Copilot subscription.
3. **Offline TF-IDF heuristic** — no LLM, no network, always available.

Titles are stored in sidecar metadata (Feature 9) and never written to source files.
Multi-topic format: `"3 topics: Docker setup → React hooks → TS generics"`.

---

### Task 8-A — Implement the TF-IDF title heuristic

**File:** `src/utils/titleNormalizer.ts` (new file)

```ts
export function deriveTitleFromMessages(messages: Message[]): string
```

Algorithm:
1. Concatenate all user messages into a single string.
2. Tokenize, remove stop words (reuse the stop-words set from `analyticsEngine.ts`).
3. Score each token by TF-IDF across the session's own message corpus (session-local IDF).
4. Take the top 5 tokens; group into up to 3 conceptual clusters using simple co-occurrence
   (tokens that appear in the same message are in the same cluster).
5. Format: if 1 cluster → `"<token1> <token2>"` · if 2–3 clusters →
   `"N topics: <cluster1> → <cluster2>"`.

**Acceptance:** `deriveTitleFromMessages` returns a human-readable title (not a UUID) for a
set of fixture messages about Docker, React, and TypeScript. Test case must produce a title
that mentions at least two of those topics.

---

### Task 8-B — Implement the Chronicle-based title extractor

**File:** `src/utils/titleNormalizer.ts`

```ts
export function deriveTitleFromChronicle(chronicleData: ChronicleData): string | null
```

- Return the first 120 chars of `chronicleData.overview` if non-null/non-empty.
- Strip Markdown formatting (headers, bold) before returning.
- Return `null` if overview is absent.

**Acceptance:** Returns a clean plain-text title from a fixture `ChronicleData` with a
Markdown-formatted overview.

---

### Task 8-C — Implement the LM API title generator

**File:** `src/utils/titleNormalizer.ts`

```ts
export async function deriveTitleViaLmApi(
    messages: Message[],
    model?: vscode.LanguageModelChat
): Promise<string | null>
```

- Select a chat model with `vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' })`.
- If no model is available, return `null`.
- Send a concise prompt (≤ 200 tokens of session content) asking for a 10-word title.
- Parse the response; strip surrounding quotes.
- Return `null` on any error (timeout, API error) — caller falls back to TF-IDF.

**Acceptance:** With a mocked `vscode.lm.selectChatModels`, the function sends a correctly
structured request and returns the model's first response line as the title.

---

### Task 8-D — Implement the three-tier title resolver

**File:** `src/utils/titleNormalizer.ts`

```ts
export async function resolveSessionTitle(
    session: Session,
    options?: { useLmApi?: boolean }
): Promise<string>
```

Priority order:
1. If `session.chronicleData?.overview` is non-null → `deriveTitleFromChronicle(...)`.
2. If `options.useLmApi` is true and LM API is available → `deriveTitleViaLmApi(...)`.
3. Fallback → `deriveTitleFromMessages(session.messages)`.

**Acceptance:** Resolver returns Chronicle title when available; falls back correctly at each
tier; never throws.

---

### Task 8-E — Add "Regenerate Title" command

**Files:** `src/commands/paletteCommands.ts`, `src/extension.ts`, `package.json`

Register a new command `chatwizard.regenerateTitle` that:

1. Gets the currently selected session from the tree view (or accepts a `sessionId` argument).
2. Calls `resolveSessionTitle(session, { useLmApi: true })`.
3. Stores the result in sidecar metadata via the sidecar API (Feature 9, `setTitle(sessionId, title)`).
4. Shows a `vscode.window.showInformationMessage` with the new title.
5. Refreshes the tree view to display the new title.

Also add a right-click tree item menu entry: `"Regenerate Title"`.

**Acceptance:** Right-clicking a session and choosing "Regenerate Title" updates the displayed
title in the tree within 3 seconds; the new title is persisted across a VS Code restart.

---

### Task 8-F — Add "Regenerate All Titles" command

Register `chatwizard.regenerateAllTitles`:

1. Shows a progress notification: `"Regenerating titles for N sessions…"`.
2. Iterates all sessions in the index.
3. For each, calls `resolveSessionTitle(session, { useLmApi: false })` (TF-IDF / Chronicle
   only — LM API is disabled for bulk runs to avoid quota exhaustion).
4. Writes results to sidecar metadata.
5. Refreshes the tree.

Show final count: `"Updated N session titles"`.

**Acceptance:** Running the command updates all titles with no VS Code freeze (use
`vscode.window.withProgress` with incremental steps).

---

### UT coverage — Feature 8

- `deriveTitleFromMessages` returns a multi-topic title for a session with messages spanning
  three distinct subjects.
- `deriveTitleFromMessages` returns a single-topic title for a focused session.
- `deriveTitleFromChronicle` strips Markdown formatting from the overview.
- `deriveTitleFromChronicle` returns `null` for an empty overview.
- `deriveTitleViaLmApi` returns `null` when no model is available (mock returns `[]`).
- `resolveSessionTitle` selects Chronicle when available.
- `resolveSessionTitle` falls back to TF-IDF when no Chronicle data and LM API unavailable.
- Title is never a UUID (assert the result does not match `/^[0-9a-f-]{36}$/i`).

---

### e2e tests — Feature 8

1. Run `resolveSessionTitle` against a fixture Copilot session with Chronicle `overview` —
   assert result matches the first 120 chars of the overview (stripped of Markdown).
2. Run against a Copilot session without Chronicle data, with a mocked LM API — assert the
   mocked model's response is returned.
3. Run against a Claude session (no Chronicle, no LM API mock available) — assert TF-IDF title
   contains at least one meaningful keyword from the session content.
4. Run `chatwizard.regenerateAllTitles` against a fixture index of 20 sessions — assert all 20
   sessions get non-UUID titles; assert no session's title equals another (no mass-assignment
   of the same title).

---

### Manual tests — Feature 8

1. Right-click a Copilot session with a UUID title → "Regenerate Title" → verify the new title
   is descriptive and no longer a UUID; reload VS Code and verify the title is still there
   (sidecar persistence).
2. Run "Regenerate All Titles" on an index of 10+ sessions — verify the progress bar appears
   and titles update visibly in the tree.
3. Right-click a Claude session → "Regenerate Title" — verify TF-IDF title appears (no LM call
   expected since `useLmApi` is only true for single-session regeneration).
4. Rename the sidecar metadata file and reload — verify titles revert to originals (sidecar is
   the only mutation point, source files are intact).
5. Run on a session with a very short single-message conversation (< 5 words) — verify a
   graceful short title rather than an empty string.

> **Pre-flight issue:** TF-IDF over a single short message produces degenerate results (all
> tokens have equal IDF). Guard with a minimum token count (≥ 3 meaningful tokens); otherwise
> fall back to the raw first user message truncated to 80 chars.

---

### Completion gate — Feature 8

- [ ] Tasks 8-A through 8-F implemented.
- [ ] UT: all tier scenarios pass; UUID guard passes.
- [ ] e2e: Chronicle, LM API, and TF-IDF paths exercised; bulk command works.
- [ ] Manual: persistent title change via right-click; bulk regeneration with progress bar.
- [ ] **Feature 8 complete.**

---

---

## Feature 9 — Sidecar metadata model (Phase 0 prerequisite)

_Effort: S · Priority: P1 · No blockers (implement before Feature 8)_

### Context

Tags, custom titles, annotations, linked sessions, and status flags must be persisted without
touching source files. This feature defines the `SessionMetadata` interface and the
`chatwizard-metadata.json` storage layer under `context.globalStorageUri`. Existing pin state
is migrated to the new model on first load.

**This feature is a prerequisite for Feature 8 (title normalization) and is referenced by
P2 features (tagging, annotations, session linking). It must be implemented first.**

---

### Task 9-A — Define `SessionMetadata` interface

**File:** `src/types/index.ts`

```ts
export interface SessionMetadata {
    sessionId: string;
    customTitle?: string;        // user-set or AI-generated title override
    tags?: string[];             // e.g. ['#bugfix', 'topic:auth', 'kind:decision']
    status?: 'open' | 'resolved' | 'revisit';
    isPinned?: boolean;          // migrated from existing globalState pin storage
    annotations?: SessionAnnotation[];
    linkedSessionIds?: string[]; // explicit forward/backward links
    subSource?: string;          // e.g. 'brain' | 'conversations' for Antigravity
    createdAt?: string;          // ISO-8601, when the metadata entry was first written
    updatedAt?: string;          // ISO-8601, when it was last modified
}

export interface SessionAnnotation {
    messageIndex: number;        // 0-based index into session.messages
    noteText: string;
    createdAt: string;           // ISO-8601
}
```

**Acceptance:** Interface compiles without errors; no existing types are broken.

---

### Task 9-B — Implement `SidecarMetadataStore`

**File:** `src/index/sidecarMetadataStore.ts` (new file)

```ts
export class SidecarMetadataStore {
    constructor(private readonly storageDir: string) {}

    async load(): Promise<Map<string, SessionMetadata>>
    async save(map: Map<string, SessionMetadata>): Promise<void>
    async get(sessionId: string): Promise<SessionMetadata | undefined>
    async set(sessionId: string, meta: SessionMetadata): Promise<void>
    async patch(sessionId: string, partial: Partial<SessionMetadata>): Promise<SessionMetadata>
    async delete(sessionId: string): Promise<void>
    async setTitle(sessionId: string, title: string): Promise<void>  // shortcut
    async setPin(sessionId: string, pinned: boolean): Promise<void>  // shortcut
}
```

Storage: single JSON file at `<storageDir>/chatwizard-metadata.json`.

- `load()` reads and parses the file; returns an empty `Map` if the file does not exist.
- `save(map)` atomically writes the full map via a temp-file + rename pattern to prevent
  corruption on crash.
- `patch(sessionId, partial)` merges partial fields into the existing entry, creating it if
  absent, and calls `save()`.

**Acceptance:** Round-trip test: write metadata, reload from disk, assert the values match.
Corruption test: write a truncated JSON file, call `load()`, assert it returns an empty `Map`
without throwing.

---

### Task 9-C — Migrate existing pin state

**File:** `src/extension.ts` or the activation path

On first activation after this feature is deployed, read the existing pinned session IDs from
`globalState.get<string[]>('chatwizard.pinnedSessionIds')`, write each as
`{ sessionId, isPinned: true }` to the `SidecarMetadataStore`, then delete the `globalState`
key to avoid double-migration on subsequent activations.

Use a migration version flag: `globalState.get('chatwizard.sidecarMigrationVersion')`. If
it equals `'1'`, skip the migration. After migrating, set it to `'1'`.

**Acceptance:** A session pinned before this feature is deployed remains pinned after the
migration; the old `globalState` key is cleared.

---

### Task 9-D — Wire `SidecarMetadataStore` into `SessionIndex`

**File:** `src/index/sessionIndex.ts`

Inject `SidecarMetadataStore` into `SessionIndex`. When resolving a session summary for display:

1. Check the store for a `customTitle` — use it instead of `session.title` if present.
2. Include `isPinned` from the store (replacing the old `globalState` pin lookup).

When the tree view requests a session title, it should go through `SessionIndex.getTitleFor(id)`
which applies the metadata override.

**Acceptance:** Sessions with a `customTitle` in the sidecar show the custom title in the tree;
sessions without show the original title.

---

### Task 9-E — Expose `SidecarMetadataStore` to commands

**File:** `src/extension.ts`

Instantiate `SidecarMetadataStore` with `context.globalStorageUri.fsPath` during activation
and pass it to all commands that need to write metadata (pin, title normalization, future
tagging).

**Acceptance:** `chatwizard.openSession` and tree view commands can read/write sidecar
metadata via the shared store instance.

---

### UT coverage — Feature 9

- `SidecarMetadataStore.load()` returns an empty `Map` for a missing file.
- `SidecarMetadataStore.load()` returns an empty `Map` for a corrupt (truncated) JSON file
  without throwing.
- `SidecarMetadataStore` round-trip: `set` → `load` (new instance) → `get` returns same values.
- `SidecarMetadataStore.patch()` merges partial fields without overwriting unset fields.
- `SidecarMetadataStore.setTitle()` sets only `customTitle`, leaving other fields intact.
- `SessionIndex.getTitleFor(id)` returns `customTitle` when set; returns original `title`
  when no sidecar entry exists.
- Migration task: given a `globalState` with pinned IDs, produces correct sidecar entries and
  clears the `globalState` key.

---

### e2e tests — Feature 9

1. Create a sidecar store in a temp directory; write 5 session entries; load in a new instance;
   assert all 5 are present with correct values.
2. Simulate a crash mid-write (write a partial file manually); assert `load()` returns an
   empty `Map`.
3. Run the pin migration: set up a `globalState` mock with 3 pinned IDs; run the migration;
   assert those IDs have `isPinned: true` in the sidecar; assert `globalState` key is deleted.
4. Create a `SessionIndex` with a sidecar store containing a `customTitle`; assert the session
   tree item displays the custom title, not the original.

---

### Manual tests — Feature 9

1. Pin a session via right-click in the tree — verify it moves to the top and remains pinned
   after reloading VS Code.
2. Inspect `<globalStorageUri>/chatwizard-metadata.json` in VS Code's file explorer — verify
   the pinned session appears with `"isPinned": true`.
3. Manually edit the metadata file to add a `customTitle` for a session; reload VS Code;
   verify the new title appears in the tree.
4. Delete the metadata file while VS Code is open; reload; verify the extension activates
   without errors and pin state resets to default.
5. Verify the migration: downgrade to a version without sidecar (delete the metadata file and
   set the old `globalState` key manually via the VS Code Developer Tools → `globalState`
   API), then upgrade — verify pinned sessions survive the migration.

> **Pre-flight issue:** `context.globalStorageUri.fsPath` may not be an existing directory on
> first activation. Call `fs.promises.mkdir(storageDir, { recursive: true })` inside the store
> constructor before any read/write operation.

---

### Completion gate — Feature 9

- [ ] Tasks 9-A through 9-E implemented.
- [ ] UT: all storage, migration, and override scenarios pass.
- [ ] e2e: round-trip, crash-safety, migration, and title-override scenarios pass.
- [ ] Manual: pin persistence, custom title via direct JSON edit, migration from old `globalState`.
- [ ] **Feature 9 complete.**

---

---

## Parallel execution guide

The nine features above can be assigned to independent tracks simultaneously:

| Track | Features | Rationale |
|-------|----------|-----------|
| **Track A** | 9 → 8 | Feature 9 (sidecar) must land before Feature 8 uses `setTitle()`. |
| **Track B** | 4 → 5 | Feature 5 (Chronicle Phase 2) consumes Feature 4's `session.chronicleData`. |
| **Track C** | 1, 2, 3, 6, 7 | All fully independent — can run in parallel with each other and with Tracks A and B. |

All five tasks in Track C are also independent of each other and can be assigned to different
developers on the same day.

---

## Definition of "done" for this work plan

All nine features are complete when:

- [ ] Every task checkbox above is checked.
- [ ] `npm test` passes with zero failures.
- [ ] `npm run bundle:watch` builds without TypeScript errors.
- [ ] All manual test steps above have been performed in the Extension Development Host.
- [ ] `CHANGELOG.md` updated with entries for all nine features.
- [ ] `whats-next.md` P1 section items 1–9 moved to `docs/done/`.
