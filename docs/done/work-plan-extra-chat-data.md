# Work Plan: Copilot Chronicle SQLite Integration

## Background

During investigation of the `/answerFromHistory` search quality issue, a secondary data
source was discovered: Copilot's own persistent SQLite store (`session-store.db`), part
of what GitHub internally calls the **Chronicle** feature.

This store is separate from the JSONL/JSON/`.vscdb` files ChatWizard already reads. It
is populated by Copilot's `chronicle.localStore` pipeline and persists across VS Code
restarts for the full lifetime of the extension installation.

**Discovery prompt:** "As a side note — I am wondering whether this SQLite store may
have data that ChatWizard does not — but still data that may be of my interest?"

---

## Store Location

```
Windows: %APPDATA%\Code - Insiders\User\globalStorage\GitHub.copilot-chat\session-store.db
macOS:   ~/Library/Application Support/Code - Insiders/User/globalStorage/GitHub.copilot-chat/session-store.db
Linux:   ~/.config/Code - Insiders/User/globalStorage/GitHub.copilot-chat/session-store.db
```

(Same paths without `- Insiders` for stable VS Code.)

---

## Store Schema (relevant tables)

### `checkpoints`
AI-generated structured summaries produced at session compaction:

| Column | Description |
|---|---|
| `session_id` | Links to `sessions.id` |
| `work_done` | What was accomplished in the session |
| `next_steps` | Suggested follow-on actions |
| `technical_details` | Architecture/implementation notes |
| `overview` | High-level session summary |
| `important_files` | Key files mentioned |
| `history` | Compressed conversation history |

### `session_files`
Every file edited or created via `edit`/`create` tool calls:

| Column | Description |
|---|---|
| `session_id` | Links to `sessions.id` |
| `file_path` | Absolute path of the file |
| `tool_name` | `edit` or `create` |
| `turn_index` | Turn within the session |

### `session_refs`
Git commits, PR numbers, issue numbers mentioned during sessions:

| Column | Description |
|---|---|
| `session_id` | Links to `sessions.id` |
| `ref_type` | `commit`, `pr`, `issue`, etc. |
| `ref_value` | The actual ref value (SHA, number, URL) |

### `sessions` (enrichment fields not in JSONL)

| Column | Value to ChatWizard |
|---|---|
| `branch` | Git branch active during the session |
| `repository` | Remote repository URL |
| `agent_name` | Which agent mode was used (edit, ask, explore) |

---

## Gating: `LocalIndexEnabled` Flag

The store is only populated when Copilot's `chat.localIndex.enabled` experiment flag
is active. This is a **server-side A/B rollout** — most users have it off by default.

However, the VS Code setting `chat.localIndex.enabled` can be set to `true` by the
user (or programmatically by ChatWizard with user consent), which overrides the
experiment default.

**ChatWizard can automate enabling the flag at startup:**

```typescript
const val = vscode.workspace.getConfiguration().get('chat.localIndex.enabled');
if (!val) {
    const choice = await vscode.window.showInformationMessage(
        'Enable Copilot session indexing to give ChatWizard access to richer history ' +
        '(structured summaries, next steps, files touched per session).',
        'Enable', 'Not now', "Don't ask again"
    );
    if (choice === 'Enable') {
        await vscode.workspace.getConfiguration().update(
            'chat.localIndex.enabled', true,
            vscode.ConfigurationTarget.Global
        );
    }
}
```

This requires one user click, is fully reversible, and defaults to prompting on first
activation. A ChatWizard setting `chatwizard.promptForChronicleIndexing` (default: `true`)
controls whether the prompt is ever shown.

---

## Architecture

ChatWizard reads the store **passively and non-exclusively**:

- Never writes to the store
- Never depends on it (JSONL remains the base source)
- Degrades gracefully when the DB is empty or absent
- Deduplicates sessions by `session_id` against existing JSONL-sourced sessions

```
session-store.db (if exists & has rows)
        ↓
src/readers/copilotChronicleWorkspace.ts   — find DB path (platform-aware)
        ↓
src/parsers/copilotChronicle.ts            — query tables, map to Session + extras
        ↓
FullTextSearchEngine.index()               — checkpoints text replaces/supplements raw turns
        ↓
new ChronicleStore (in-memory)             — session_files and session_refs indices
```

---

## Planned Capabilities

### Phase 1 — Search quality boost (lowest effort, highest ROI)

Index `checkpoints.work_done`, `checkpoints.technical_details`, and `checkpoints.history`
alongside (or instead of) raw turn text for sessions that have a checkpoint.

**Impact:** `searchRelaxedBySession` and semantic search return more precise results
because checkpoint text is dense and topically focused, unlike raw conversation turns.

### Phase 2 — Enhanced `/continueFromHistory`

Return `checkpoints.next_steps` directly when a relevant checkpoint exists, without
requiring an LLM inference step — the AI already summarized the continuation at
compaction time.

Return `checkpoints.work_done` as the "what you did last time" summary.

### Phase 3 — File-centric history

New MCP tool: `chatwizard_sessions_for_file`
```
Input: file path (absolute or relative to workspace)
Output: list of sessions that touched the file, with dates and summaries
```

New VS Code integration — trigger is **file entering context**, not a specific click:
- File opened in editor (tab activated, `vscode.window.onDidChangeActiveTextEditor`)
- File opened via Ctrl+T / Quick Open
- File explicitly right-clicked in the Explorer

When any of the above fires, ChatWizard checks `session_files` for sessions that
touched that file and surfaces a status bar item or inline CodeLens: "3 chat sessions
touched this file". Clicking it opens a webview listing those sessions with dates,
summaries, and links to the full session detail.

The Explorer right-click context menu entry ("Show ChatWizard History") is an
additional entry point but not the primary trigger.

### Phase 4 — Work item & branch grouping (Sessions tab, implemented)

The Sessions tab gains two new group modes, accessible via the **Group Sessions…** QuickPick button (toolbar icon):

- **Group by Branch** — reads `sessions.branch` from Chronicle DB; sessions without branch data go to `[no branch recorded]`. Requires `chatwizard.chronicle.enableLocalIndex = true` to populate.
- **Group by Work Item** — applies `chatwizard.workItemPattern` regex against session titles and messages; sessions with no match go to `(no work item)`.

Both modes replaced the previously planned separate "By Context" sidebar tab. The QuickPick also offers "No grouping" and "Group by Date" for parity with existing behaviour.

**VS Code setting:**
```jsonc
// settings.json
"chatwizard.workItemPattern": "PREFIX-\\d+"
```

**MCP tools to match:**
```
chatwizard_sessions_for_work_item  — input: "PROJ-123" → all sessions for that item
chatwizard_sessions_for_branch     — input: "feature/auth" → all sessions on branch
```

### Phase 5 — Commit archaeology

New MCP tool: `chatwizard_get_context_for_commit`
```
Input: commit SHA or PR number
Output: session(s) that produced or discussed that commit, with full context
```

Works by joining `session_refs` (ref_type = 'commit', ref_value = SHA prefix match)
with the session's checkpoint and turn data.

For teams using work item prefixes in commit messages (e.g. `PROJ-123: fix auth`),
this extends to: given a work item ID, find all commits mentioning it, then find all
sessions that produced those commits — complete audit trail from Jira ticket to chat
session to code change.

Timeline view enhancement: annotate session cards with linked commit/PR/issue badges.

### Phase 6 — Branch-aware context recall

On `git checkout <branch>` (detected via the VS Code Git extension API), surface the
last session on that branch via a notification or status bar tooltip:
"Last ChatWizard session on this branch: 3 days ago — JWT expiry fix"

Filter in existing search tools: `filter.branch` parameter to scope results to a
specific branch.

---

## Implementation Notes

- `better-sqlite3` is already a ChatWizard dependency (used by the Cursor reader) —
  no new native module required.
- Read in **read-only WAL mode** to avoid locking the DB while Copilot writes to it:
  ```typescript
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  ```
- Check row counts before indexing to skip empty DBs silently.
- Session deduplication: if a `session_id` already exists from the JSONL reader,
  merge checkpoint data into the existing session rather than creating a duplicate.

---

## Priority Order

| Priority | Feature | Effort | Value |
|---|---|---|---|
| 1 | Auto-enable flag prompt on activation | Low | Unlocks everything below |
| 2 | Index checkpoint text for search quality | Low | High — immediate search improvement |
| 3 | `/continueFromHistory` checkpoint integration | Medium | High |
| 4 | File-in-context trigger → session history surfacing | Medium | New capability |
| 5 | Work item & branch grouping tab view | High | High — unique product differentiator |
| 6 | Commit archaeology MCP tool | Medium | New capability |
| 7 | Branch-aware context recall on checkout | Medium | Niche but powerful |
| 2 | Index checkpoint text for search quality | Low | High — immediate search improvement |
| 3 | `/continueFromHistory` checkpoint integration | Medium | High |
| 4 | `session_files` reader + MCP tool | Medium | New capability |
| 5 | File explorer right-click integration | Medium | New surface |
| 6 | Git ref linkage MCP tool | Medium | New capability |
| 7 | Branch-aware context recall | High | Niche but powerful |
