# ChatWizard — Fill Antigravity Chat Gaps Work Plan

_Created: May 2026_

---

## Background & Motivation

ChatWizard added Antigravity support reading from:

```
~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/overview.txt
```

These files are **agent execution traces** — JSONL steps recording tool calls, planner
responses, and USER_INPUT envelopes.  They give useful signal but they are not the
primary chat store; they are agentic side-channel logs.

Analysis of the open-source [ChatSync extension](https://marketplace.visualstudio.com/items?itemName=hurryingauto3.chatsync)
([source](https://github.com/hurryingauto3/chatsync)) revealed that Antigravity writes
a **second, sibling directory** that was missed during original research:

```
~/.gemini/antigravity/conversations/
```

This directory contains the actual chat conversations as either structured **JSON** files
or binary **Protocol Buffer (`.pb`)** files, written locally by Antigravity with no
running instance required to read them.  This is a pure offline file read — exactly
the model ChatWizard uses for every other source.

---

## What the `conversations/` Directory Contains

### JSON files (`*.json`)

Structured objects with the following shape (field names are optional / nullable):

```ts
interface AntigravityConversation {
  id?:         string;
  title?:      string;
  messages?:   AntigravityMessage[];   // primary field
  turns?:      AntigravityMessage[];   // fallback alias
  created_at?: string | number;
  updated_at?: string | number;
}

interface AntigravityMessage {
  role?:      string;
  author?:    string;   // fallback for role
  content?:   string;   // primary text
  text?:      string;   // fallback for content
  model?:     string;
  timestamp?: string | number;
}
```

These map cleanly onto ChatWizard's `Session` / `Message` types and should parse with
high fidelity.

### Protocol Buffer files (`*.pb`)

Binary protobuf encoding without a publicly documented schema.  ChatSync's approach
(best-effort heuristic):

1. Scan the buffer byte-by-byte looking for **wire-type 2** (length-delimited) fields.
2. For each candidate field, attempt UTF-8 decode of the payload.
3. Keep segments where >80 % of characters are printable ASCII and length > 20 chars.
4. Assign alternating `user` / `assistant` roles to recovered strings (structural
   information is lost).

This is inherently lossy.  It recovers message text but discards timestamps, titles,
and structural role metadata.  Extracted sessions should be flagged in metadata so
users know they may be incomplete.

---

## Gap Analysis vs. Current Implementation

| Aspect | Current (`brain/`) | Missing (`conversations/`) |
|---|---|---|
| Data | Agent execution traces, tool calls | Actual chat messages |
| Format | JSONL (`overview.txt`) | JSON or protobuf per file |
| Fidelity | Partial (prompts only, agentic noise) | Full conversation (user + model turns) |
| Schema | Custom XML-envelope `USER_REQUEST` blocks | Standard role/content pairs |
| Requires running instance? | No | No |
| Covered by ChatWizard today | Yes | **No** |

---

## Proposed Changes

### 1. New reader: `src/readers/antigravityConversations.ts`

Mirror the structure of `antigravityWorkspace.ts`:

- `getAntigravityConversationsRoot(): string` → `~/.gemini/antigravity/conversations`
- `discoverAntigravityConversationFilesAsync(override?)` → returns list of
  `{ filePath, format: 'json' | 'pb' }` entries found in the directory.

### 2. New parser: extend `src/parsers/antigravity.ts`

Add two new exported functions alongside the existing `parseAntigravityConversation`:

- `parseAntigravityConversationJson(filePath): ParseResult`
  - Reads and parses the JSON file.
  - Maps `messages ?? turns` → `Message[]`.
  - Normalises `role ?? author`, `content ?? text`, `timestamp`.
  - Falls back gracefully when optional fields are absent.

- `parseAntigravityConversationPb(filePath): ParseResult`
  - Reads binary buffer.
  - Extracts UTF-8 string segments via protobuf wire-type 2 scan.
  - Alternates `user` / `assistant` roles.
  - Sets `metadata.extractedFromProtobuf = true` on each message.
  - Sets `metadata.lowFidelity = true` on the session.

### 3. Wire into `FileWatcher` (`src/watcher/fileWatcher.ts`)

In `buildInitialIndex` and the watch loop, after the existing `brain/` Antigravity scan,
add a second scan of `conversations/`:

```
if (indexAntigravity) {
    // Existing: brain/ overview.txt scan
    ...

    // New: conversations/ JSON + .pb scan
    const convFiles = await discoverAntigravityConversationFilesAsync();
    for (const { filePath, format } of convFiles) {
        const result = format === 'json'
            ? parseAntigravityConversationJson(filePath)
            : parseAntigravityConversationPb(filePath);
        // index result.session, collect result.errors
    }
}
```

Add a `fs.watch` on `conversations/` for live updates (same pattern as the brain watcher).

### 4. Deduplication

A `brain/` overview.txt and a `conversations/` JSON file may represent the same
conversation (same `conversationId` / UUID appears in both paths).  The session `id`
for `conversations/` files should be derived from the conversation UUID found in
the file (field `id`) or filename, **not** from the file path, so that if both sources
are indexed the session index deduplicates naturally.

Compare with the `brain/` reader which derives the id from the directory UUID — ensure
they produce the same id for the same conversation so one replaces the other cleanly.

### 5. Config path helper (`src/watcher/configPaths.ts`)

Add `resolveAntigravityConversationsPath(override?)` alongside the existing
`resolveAntigravityBrainPath`, respecting the same user-override setting pattern.

### 6. Test coverage

- Unit tests for `parseAntigravityConversationJson` with fixture files covering:
  - `messages` field present
  - `turns` fallback
  - `author` fallback for role
  - `text` fallback for content
  - Numeric timestamps
  - Missing optional fields (no title, no id)
- Unit test for `parseAntigravityConversationPb` with a hand-crafted binary fixture
  containing at least two wire-type 2 UTF-8 string fields.
- Integration test: `discoverAntigravityConversationFilesAsync` with a temp directory
  containing one `.json` and one `.pb` file.

---

## Out of Scope

- Reverse-engineering the full protobuf schema.  Best-effort text extraction is
  sufficient; full structural recovery requires Antigravity's private `.proto` files.
- Writing back to `conversations/`.  ChatWizard is read-only for all sources.
- Removing or replacing the existing `brain/` reader.  Both paths carry complementary
  data and should coexist.

---

## Acceptance Criteria

- [ ] `conversations/` JSON files are indexed and searchable in ChatWizard.
- [ ] `conversations/` `.pb` files are indexed with a best-effort extraction; sessions
      are flagged `lowFidelity` in metadata.
- [ ] Duplicate sessions (same UUID in both `brain/` and `conversations/`) are
      deduplicated in the index — the `conversations/` version takes precedence as it
      has higher fidelity.
- [ ] File watcher picks up new/modified files in `conversations/` without restart.
- [ ] All new code has unit tests with fixture files.
- [ ] No native dependencies added (pure Node.js file I/O only).

---

## Appendix — Cross-IDE Sharing Design Discussion

_May 2026_

**Question raised:** ChatSync's other headline feature is sharing chat sessions across
IDEs.  Could ChatWizard close that gap easily by writing parsed sessions to a
centralized location at startup, then reading from that same location — so all IDEs
running ChatWizard share a single normalized session store?

**Short answer:** Correct design, not missing anything critical, and the implementation
path already exists in the roadmap.

### What ChatWizard already covers

ChatWizard reads *all* IDE sources directly (Cursor SQLite, Claude JSONL, Windsurf,
Cline, etc.) even when running inside VS Code.  Cross-IDE visibility on the same
machine is already ~90 % solved without any shared store.  A write-back store adds
value for:

- **Performance** — avoid re-parsing already-seen sessions on every startup.  This is
  exactly what `work-plan-move-to-sqlite.md` describes.
- **Sessions from sources with no direct parser** — a future IDE ChatWizard hasn't
  implemented yet; sessions discovered by another ChatWizard instance.
- **Cross-machine sharing** — out of scope for a local-file design (requires a sync
  service like ChatSync's Supabase layer).

### Caveats

| Concern | Severity | Notes |
|---|---|---|
| Deduplication | Medium | Same session arrives via native source read AND shared store. Session IDs must be stable and deterministic (content-derived, not path-derived) |
| Concurrent writes | Low | Two IDE instances writing simultaneously → SQLite in WAL mode handles this safely; raw JSON files do not |
| Cross-machine | Out of scope | Local-file design shares sessions across IDEs on one machine only |
| Stale data | Low | Sessions from uninstalled IDEs persist indefinitely — likely desirable |

### Convergence with the SQLite work plan

The proposed design and `work-plan-move-to-sqlite.md` are the same thing scoped
differently.  If the SQLite persistent cache is placed at a **user-global path**
(`~/.chatwizard/index.db`) instead of per-workspace, it *is* the centralized shared
store.  The two work plans collapse into one: implement the SQLite cache at global
scope, and same-machine cross-IDE sharing comes for free with no additional work.
