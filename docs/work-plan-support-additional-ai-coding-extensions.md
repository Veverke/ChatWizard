# ChatWizard — Support Additional AI Coding Extensions

## Overview

ChatWizard currently indexes conversation history from two AI coding tools: GitHub Copilot Chat and Claude Code. To expand user adoption, this work plan adds first-class support for five additional tools that collectively cover the majority of the non-Copilot/non-Claude AI coding audience.

Each new source follows the existing two-module pattern: a **reader** (workspace/session discovery) and a **parser** (JSONL/JSON/SQLite → `Session`). All new sources integrate with the existing `FileWatcher`, `SessionIndex`, `WorkspaceScopeManager`, and analytics pipeline with zero changes to those components — they register by being called from `ChatWizardWatcher` in the same way the two existing sources are.

**New sources added by this plan:**

| ID | Tool | Storage Format | Estimated Effort |
|----|------|---------------|-----------------|
| EXT-1 | **Cline** (`saoudrizwan.claude-dev`) | JSON files per task | ~1 week |
| EXT-2 | **Roo Code** (`rooveterinaryinc.roo-cline`) | JSON files per task (Cline fork) | ~2 days (reuses EXT-1 parser) |
| EXT-3 | **Cursor** | SQLite `state.vscdb` (VS Code fork) | ~1 week |
| EXT-4 | **Windsurf** (Codeium) | SQLite `state.vscdb` (VS Code fork) | ~2 days (reuses EXT-3 reader) |
| EXT-5 | **Aider** | Markdown `.aider.chat.history.md` per repo | ~1 week |

**Architectural constraints (unchanged from existing design):**
- Read-only access to all source files
- All processing is local; no data leaves the machine
- `FileSystemWatcher` drives live index updates
- Parsers return `ParseResult` (never throw) with best-effort `Session` and error list
- New `SessionSource` string literals are added; `modelNames.ts` handles model name normalisation
- All new config paths follow the override → VS Code setting → OS default resolution pattern

---

## EXT-1 — Cline (`saoudrizwan.claude-dev`) ✦ HIGH IMPACT

Cline stores each agentic task as a directory under VS Code's `globalStorage` for the `saoudrizwan.claude-dev` extension. Each task directory contains two JSON files:
- `api_conversation_history.json` — the raw LLM message array (`role: 'user' | 'assistant'`, `content: string | ContentPart[]`)
- `ui_messages.json` — the richer UI-visible message array with tool results, cost, etc.

This plan reads `api_conversation_history.json` because it provides the cleanest conversation transcript. `ui_messages.json` is ignored for now.

**Storage path (per OS):**
- Windows: `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/`
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/`

**`api_conversation_history.json` shape:**
```json
[
  { "role": "user", "content": "Help me refactor this function" },
  { "role": "assistant", "content": [{ "type": "text", "text": "Sure, here is..." }] }
]
```
Content can be a `string` or an array of `ContentPart` objects (`type: 'text' | 'tool_use' | 'tool_result' | 'image'`). Only `type === 'text'` parts are extracted; tool calls are skipped.

**Task metadata** is read from `ui_messages.json` for `ts` (timestamp of first message) and the task description (first user message).

### EXT-1-A — Reader: `src/readers/clineWorkspace.ts` ☑

**Implements:** workspace/task discovery for Cline.

**Exports:**
- `getClineStorageRoot(): string` — resolves `globalStorage/saoudrizwan.claude-dev/tasks/` cross-platform using `process.platform` + environment variables (mirrors `getWorkspaceStorageRoot()` in `copilotWorkspace.ts`).
- `discoverClineTasksAsync(override?: string): Promise<ClineTaskInfo[]>` — enumerates task directories, validates that `api_conversation_history.json` exists, returns `ClineTaskInfo[]`.

**`ClineTaskInfo` interface** (added to `src/types/index.ts`):
```ts
interface ClineTaskInfo {
  taskId: string;          // directory name (UUID-like)
  storageDir: string;      // absolute path to task directory
  conversationFile: string;// absolute path to api_conversation_history.json
}
```

**Security guards:**
- Symlink check (`fs.promises.lstat` — reuse `_isSafeFilePathAsync` pattern from `fileWatcher.ts`)
- Max task directories scanned: 10,000 (emit warning beyond this)

### EXT-1-B — Parser: `src/parsers/cline.ts` ☑

**Implements:** `ParseResult` from a Cline task directory.

**Exports:**
- `parseClineTask(taskDir: string, maxLineChars?: number): Promise<ParseResult>`
- `extractClineCodeBlocks(content: string, sessionId: string, messageIndex: number): CodeBlock[]` (delegates to existing `extractCodeBlocks` logic — can share the implementation from `claude.ts`)

**Algorithm:**
1. Read and parse `api_conversation_history.json`; on JSON parse error populate `errors` and return empty session.
2. For each entry: extract text-only content, skip empty turns, map `role: 'user'` → `MessageRole.User`, `role: 'assistant'` → `MessageRole.Assistant`.
3. Read `ui_messages.json` (optional — graceful fallback if missing) for `ts` on first entry → `createdAt`; walk all entries for last timestamp → `updatedAt`.
4. Derive title from first user message text (≤120 chars + `…`) → `'Untitled Task'` fallback.
5. Derive `workspacePath` from `cwd` field in `ui_messages.json` first entry (if present).
6. Derive `model` from first assistant entry's `model` field in `ui_messages.json` (if present).
7. Return `ParseResult` with `session.source = 'cline'`, `session.id = taskId`, `session.workspaceId = taskId`.

**Security:**
- File size limit: skip files > 50 MB (emit `parseErrors` item)
- Max array length guard: if parsed array > 50,000 entries, truncate with warning

### EXT-1-C — Watcher integration ☑

**File:** `src/watcher/fileWatcher.ts`

**Changes:**
- Add `collectClineTasksAsync(): Promise<Session[]>` private method (mirrors `collectClaudeSessionsAsync`).
- Call it from `buildInitialIndex()` when `chatwizard.indexCline` setting is `true` (default `true`).
- Register a `vscode.workspace.createFileSystemWatcher` for `**/saoudrizwan.claude-dev/tasks/**/*.json` in `start()`.
- `parseFile()`: add `source === 'cline'` branch that calls `parseClineTask(path.dirname(filePath))`.

### EXT-1-D — Config path ☑

**File:** `src/watcher/configPaths.ts`

**Changes:**
- Add `resolveClineStoragePath(override?: string): string` following the same three-priority pattern (override → `chatwizard.clineStoragePath` VS Code setting → `getClineStorageRoot()`).

### EXT-1-E — Model name normalisation ☑

**File:** `src/analytics/modelNames.ts`

**Changes:**
- Cline displays model IDs in the same format as Claude Code (e.g. `claude-sonnet-4-5`, `gpt-4o`). No new regex entries needed — existing Claude and GPT matchers cover all known Cline model IDs.
- Verify by adding test cases for any Cline-specific model ID variants not yet covered.

### EXT-1-F — Settings registration ☑

**File:** `package.json`

**Changes:**
- `chatwizard.indexCline` (`boolean`, default `true`, description: `"Index Cline (saoudrizwan.claude-dev) task history."`).
- `chatwizard.clineStoragePath` (`string`, default `""`, description: `"Override the Cline globalStorage path. Leave empty to use the default OS location."`).

### EXT-1-G — Unit tests ☑

**New test files:**
- `test/suite/clineParser.test.ts`
  - Happy path: `parseClineTask` against `test/fixtures/cline/sample-task/` → correct `source`, `messages`, roles, `title`, `createdAt`/`updatedAt`, code block extraction, `workspacePath`.
  - Missing `api_conversation_history.json` → `errors.length > 0`, `messages.length === 0`.
  - Malformed JSON → `errors.length > 0`, `messages.length === 0`.
  - Mixed content parts → only `type === 'text'` parts are included; tool-use content is excluded.
  - Empty turns (tool-only) → excluded from `messages`.
  - `extractClineCodeBlocks`: inline content strings, language detection, `sessionId` / `messageIndex` propagation.
- `test/suite/clineWorkspaceDiscovery.test.ts`
  - `getClineStorageRoot()` returns a string on current OS.
  - `discoverClineTasksAsync(tmpDir)`: empty dir, valid task dir with both JSON files, dir missing `api_conversation_history.json` is excluded, file-not-directory entries are excluded, multiple valid tasks are all returned.

**New fixtures:**
- `test/fixtures/cline/sample-task/api_conversation_history.json` — 3 turns (user/assistant/user), assistant has mixed text+tool_use content parts.
- `test/fixtures/cline/sample-task/ui_messages.json` — matching UI message array with `ts`, `cwd`, `model`.
- `test/fixtures/cline/missing-conversation/ui_messages.json` — task dir without `api_conversation_history.json`.
- `test/fixtures/cline/malformed/api_conversation_history.json` — invalid JSON.

**Effort:** ~1 week
**Complexity:** Medium

---

## EXT-2 — Roo Code (`rooveterinaryinc.roo-cline`) ✦ MEDIUM IMPACT

Roo Code is a community fork of Cline. Its storage layout is **identical** to Cline's, with only the `globalStorage` extension ID changing from `saoudrizwan.claude-dev` to `rooveterinaryinc.roo-cline`.

This section reuses every module from EXT-1; the only new code is parameterization of the storage root and a new VS Code setting.

### EXT-2-A — Reader parameterization ☑

**File:** `src/readers/clineWorkspace.ts`

**Changes:**
- Generalise `getClineStorageRoot()` to `getClineCompatStorageRoot(extensionId: string): string`.
- Add convenience wrappers: `getClineStorageRoot() = getClineCompatStorageRoot('saoudrizwan.claude-dev')` and `getRooCodeStorageRoot() = getClineCompatStorageRoot('rooveterinaryinc.roo-cline')`.
- Add `discoverRooCodeTasksAsync(override?: string): Promise<ClineTaskInfo[]>` (delegates to `discoverClineTasksAsync` with the Roo Code root).

### EXT-2-B — Watcher integration ☑

**File:** `src/watcher/fileWatcher.ts`

**Changes:**
- Add `collectRooCodeTasksAsync()` — identical to `collectClineTasksAsync()` but uses `resolveRooCodeStoragePath()`.
- Include in `buildInitialIndex()` when `chatwizard.indexRooCode` is `true`.
- Register file system watcher for `**/rooveterinaryinc.roo-cline/tasks/**/*.json`.
- `parseFile()`: add `source === 'roocode'` branch (same `parseClineTask` call — format is identical).

### EXT-2-C — Config path ☑

**File:** `src/watcher/configPaths.ts`

**Changes:**
- Add `resolveRooCodeStoragePath(override?: string): string` (same pattern as `resolveClineStoragePath`).

### EXT-2-D — Settings registration ☑

**File:** `package.json`

**Changes:**
- `chatwizard.indexRooCode` (`boolean`, default `true`).
- `chatwizard.rooCodeStoragePath` (`string`, default `""`).

### EXT-2-E — Unit tests ☑

**New test file:** `test/suite/rooCodeWorkspaceDiscovery.test.ts`
- `discoverRooCodeTasksAsync(tmpDir)`: mirrors Cline discovery tests — valid task dirs, missing JSON, file-not-directory.
- Parser reuse: assert that `parseClineTask` on a Roo Code fixture produces `source === 'roocode'` when called with the correct `source` argument.

**New fixture:** `test/fixtures/roocode/sample-task/api_conversation_history.json` — same structure as Cline fixture.

**Effort:** ~2 days
**Complexity:** Low (reuse EXT-1)

---

## EXT-3 — Cursor ✦ HIGH IMPACT

> **SQLite introduced here.** Cursor is the first source in this project that stores chat history in a SQLite database rather than JSONL/JSON files. This is why `better-sqlite3` (a native Node.js module) was added as a production dependency. Because native modules contain platform-compiled binaries, each VSIX must be built on the matching OS — the CI pipeline was updated accordingly (see `package-targeted-vsix.yml`). The `scripts/rebuild-native.js` helper handles rebuilding `better-sqlite3` against the correct VS Code Electron ABI before each packaging step.

Cursor is a VS Code fork. Its `workspaceStorage` directory mirrors VS Code's layout exactly:
- Windows: `%APPDATA%/Cursor/User/workspaceStorage/<hash>/`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/`
- Linux: `~/.config/Cursor/User/workspaceStorage/<hash>/`

Each workspace hash directory contains a `state.vscdb` SQLite database. Cursor Chat history is stored in the `ItemTable` within `state.vscdb` under the key `composer.composerData` (a JSON blob containing an array of composer sessions, each with messages).

**Key schema:**
```
ItemTable (key TEXT PRIMARY KEY, value TEXT)
  'composer.composerData' → JSON: { allComposers: [ComposerEntry, ...] }
```

```ts
interface ComposerEntry {
  composerId: string;
  name?: string;                          // user-set title
  createdAt: number;                      // unix ms
  type: number;                           // 1 = chat, 2 = agent
  conversation: ConversationItem[];
}

interface ConversationItem {
  type: 1 | 2;                            // 1 = user, 2 = assistant
  text?: string;
  richText?: string;                      // fallback
  unixMs: number;
}
```

### EXT-3-A — Reader: `src/readers/cursorWorkspace.ts` ☑

**Implements:** workspace discovery for Cursor.

**Exports:**
- `getCursorStorageRoot(): string` — resolves `Cursor/User/workspaceStorage/` cross-platform.
- `discoverCursorWorkspacesAsync(override?: string): Promise<ScopedWorkspace[]>` — enumerates hash directories, reads `workspace.json` (same format as Copilot's `file://` URI → path decoding), checks for `state.vscdb` presence, skips deleted workspace paths.

**Returns `ScopedWorkspace[]`** with `source: 'cursor'`.

**Security guards:**
- Symlink check per directory and per `state.vscdb` file
- Skip directories where `state.vscdb` exceeds 500 MB (oversized database guard)

### EXT-3-B — Parser: `src/parsers/cursor.ts` ☑

**Implements:** extraction of `Session[]` from a single Cursor `state.vscdb`.

**Exports:**
- `parseCursorWorkspace(vscdbPath: string, workspaceId: string, workspacePath?: string): Promise<ParseResult[]>` — returns an array (one `ParseResult` per `ComposerEntry`) rather than a single result, because one SQLite file contains multiple sessions.

**Algorithm:**
1. Open database with `better-sqlite3` (already a dependency for Copilot's `state.vscdb` reads — confirm and add if missing).
2. Run `SELECT value FROM ItemTable WHERE key = 'composer.composerData'`.
3. JSON-parse the value; iterate `allComposers`.
4. For each composer: map `conversation` items to `Message[]` (skip empty text, skip non-1/2 types), extract code blocks, build `Session`.
5. `session.id = composerId`, `session.title = name || first user message || 'Untitled'`, `session.source = 'cursor'`.
6. Return array of `ParseResult`.

**Dependencies:**
- `better-sqlite3` — confirm it is already listed in `package.json` `dependencies` (used by Copilot reader for `state.vscdb`). If not, add it.

**Security:**
- Wrap entire SQLite read in try/catch; populate `errors` on exception.
- Sanitize JSON parse result with depth/size guards before iterating composers.

### EXT-3-C — Watcher integration ☑

**File:** `src/watcher/fileWatcher.ts`

**Changes:**
- Add `collectCursorSessionsAsync()` — iterates `discoverCursorWorkspacesAsync()`, calls `parseCursorWorkspace()` per workspace, flattens `ParseResult[]` arrays.
- Include in `buildInitialIndex()` when `chatwizard.indexCursor` is `true`.
- Register file watcher on `**/Cursor/User/workspaceStorage/**/state.vscdb`.
- `parseFile()`: add `source === 'cursor'` branch.

### EXT-3-D — Config path ☑

**File:** `src/watcher/configPaths.ts`

**Changes:**
- Add `resolveCursorStoragePath(override?: string): string`.

### EXT-3-E — Model name normalisation ☑

**File:** `src/analytics/modelNames.ts`

**Changes:**
- Cursor exposes model IDs like `cursor-fast`, `cursor-small`, `claude-3-5-sonnet-20241022`, `gpt-4o`, `gemini-2.0-flash`. Existing matchers cover all non-Cursor-native IDs.
- Add matchers for Cursor-native IDs:
  - `cursor-fast` → `'Cursor Fast'`
  - `cursor-small` → `'Cursor Small'`
- Add unit tests in `modelNames.test.ts` for these two plus any Cursor-surfaced model IDs not yet covered.

### EXT-3-F — Settings registration ☑

**File:** `package.json`

- `chatwizard.indexCursor` (`boolean`, default `true`).
- `chatwizard.cursorStoragePath` (`string`, default `""`).

### EXT-3-G — Unit tests ☑

**New test files:**
- `test/suite/cursorParser.test.ts`
  - Happy path: `parseCursorWorkspace` against `test/fixtures/cursor/sample.vscdb` → correct session count, `source === 'cursor'`, titles, message roles, code block extraction, `workspacePath` forwarding.
  - Empty `allComposers` array → returns `[]`.
  - Missing `composer.composerData` key → returns one `ParseResult` with `errors.length > 0`.
  - Malformed JSON value → returns one `ParseResult` with `errors.length > 0`.
  - Composer with only empty messages → session has `messages.length === 0` (filtered by `parseFile`).
  - `better-sqlite3` open failure (non-SQLite file) → returns one `ParseResult` with `errors.length > 0`.
- `test/suite/cursorWorkspaceDiscovery.test.ts`
  - `getCursorStorageRoot()` returns a string on current OS.
  - `discoverCursorWorkspacesAsync(tmpDir)`: empty dir, valid workspace dirs with `workspace.json` + `state.vscdb`, dir missing `state.vscdb` is excluded, deleted workspace paths (non-existent root) are excluded.

**New fixture:**
- `test/fixtures/cursor/sample.vscdb` — minimal SQLite with `ItemTable` containing two `ComposerEntry` records (one chat, one agent), one with mixed text/empty messages.
- `test/fixtures/cursor/empty-composers.vscdb` — SQLite with `allComposers: []`.
- `test/fixtures/cursor/no-key.vscdb` — SQLite `ItemTable` with no `composer.composerData` key.

**Effort:** ~1 week
**Complexity:** Medium-High (SQLite, multi-session-per-file pattern)

---

## EXT-4 — Windsurf (Codeium) ✦ MEDIUM IMPACT

Windsurf is another VS Code fork. Its storage layout mirrors Cursor's:
- Windows: `%APPDATA%/Windsurf/User/workspaceStorage/<hash>/`
- macOS: `~/Library/Application Support/Windsurf/User/workspaceStorage/<hash>/`
- Linux: `~/.config/Windsurf/User/workspaceStorage/<hash>/`

The `state.vscdb` SQLite schema is the same VS Code storage table, but Windsurf's chat feature is called **Cascade** and stores data under a different `ItemTable` key: `cascade.sessionData`.

**Key schema:**
```
'cascade.sessionData' → JSON: { sessions: [CascadeSession, ...] }
```

```ts
interface CascadeSession {
  sessionId: string;
  title?: string;
  createdAt: number;  // unix ms
  messages: CascadeMessage[];
}

interface CascadeMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
```

> **Note:** The exact Windsurf schema should be verified by inspecting a live `state.vscdb`. The shape above reflects community-reported structure and may require adjustment during implementation.

### EXT-4-A — Reader: `src/readers/windsurfWorkspace.ts` ☐

**Exports:**
- `getWindsurfStorageRoot(): string` — same pattern as `getCursorStorageRoot()` with `Windsurf` in path.
- `discoverWindsurfWorkspacesAsync(override?: string): Promise<ScopedWorkspace[]>` — same algorithm as `discoverCursorWorkspacesAsync`, with `source: 'windsurf'`.

### EXT-4-B — Parser: `src/parsers/windsurf.ts` ☐

**Exports:**
- `parseWindsurfWorkspace(vscdbPath: string, workspaceId: string, workspacePath?: string): Promise<ParseResult[]>`

**Algorithm:** same as `parseCursorWorkspace` but reads `cascade.sessionData` key and maps the `CascadeSession` / `CascadeMessage` shapes.

### EXT-4-C — Watcher integration ☐

**File:** `src/watcher/fileWatcher.ts`

Same integration pattern as EXT-3-C, pointing to Windsurf paths and `parseWindsurfWorkspace`.

### EXT-4-D — Config path ☐

**File:** `src/watcher/configPaths.ts`

- Add `resolveWindsurfStoragePath(override?: string): string`.

### EXT-4-E — Settings registration ☐

**File:** `package.json`

- `chatwizard.indexWindsurf` (`boolean`, default `true`).
- `chatwizard.windsurfStoragePath` (`string`, default `""`).

### EXT-4-F — Unit tests ☐

**New test files:**
- `test/suite/windsurfParser.test.ts` — mirrors `cursorParser.test.ts` using `cascade.sessionData` key and `CascadeSession` fixture structure.
- `test/suite/windsurfWorkspaceDiscovery.test.ts` — mirrors `cursorWorkspaceDiscovery.test.ts`.

**New fixtures:**
- `test/fixtures/windsurf/sample.vscdb`
- `test/fixtures/windsurf/empty-sessions.vscdb`
- `test/fixtures/windsurf/no-key.vscdb`

**Effort:** ~2 days
**Complexity:** Low (reuses EXT-3 reader/parser structure)

---

## EXT-5 — Aider ✦ MEDIUM IMPACT

Aider writes a Markdown chat log directly into each project root:

**Path:** `<projectRoot>/.aider.chat.history.md`

**Format:**
```markdown
# aider chat started at 2024-11-15 09:23:45

> /add src/utils.ts

#### User message text here

assistant message text here

#### Another user message

assistant response here
```

**Rules:**
- Lines starting with `#### ` are **user messages**.
- Non-blank lines between user messages that are not `>` commands (interactive Aider commands) are **assistant messages**.
- Lines starting with `>` are Aider command inputs — skip them.
- The `# aider chat started at <datetime>` heading gives the session start timestamp.
- Model information is **not** in the history file; it is in `.aider.conf.yml` (`model:` key) in the same directory. Read it if present.
- One `.aider.chat.history.md` file = one `Session`.

### EXT-5-A — Reader: `src/readers/aiderWorkspace.ts` ☐

**Implements:** discovery of Aider history files across VS Code open workspaces and configured locations.

**Strategy:** Unlike other sources (which have a central storage directory), Aider files live inside project repos. Discovery scans:
1. All currently open VS Code workspace folders (via `vscode.workspace.workspaceFolders`).
2. A user-configurable list of root directories (`chatwizard.aiderSearchRoots`, default: `[]`).
3. For each root, recursively enumerates up to 3 directory levels deep looking for `.aider.chat.history.md`.

**Exports:**
- `discoverAiderHistoryFilesAsync(roots: string[]): Promise<AiderHistoryInfo[]>`

**`AiderHistoryInfo` interface** (added to `src/types/index.ts`):
```ts
interface AiderHistoryInfo {
  historyFile: string;      // absolute path to .aider.chat.history.md
  workspacePath: string;    // parent directory
  configFile?: string;      // absolute path to .aider.conf.yml if present
}
```

**Security:**
- Symlink check per file
- Depth limit: max 3 levels (configurable via `chatwizard.aiderSearchDepth`, default `3`, max `5`)
- File size limit: skip files > 20 MB

### EXT-5-B — Parser: `src/parsers/aider.ts` ☐

**Exports:**
- `parseAiderHistory(info: AiderHistoryInfo, maxLineChars?: number): ParseResult`
- `extractAiderCodeBlocks(content: string, sessionId: string, messageIndex: number): CodeBlock[]` (delegates to shared code block extractor)

**Algorithm:**
1. Read file line by line (split on `\n`).
2. Extract session start timestamp from `# aider chat started at <YYYY-MM-DD HH:mm:ss>` → `createdAt`.
3. Read `.aider.conf.yml` (if `info.configFile` present) and extract `model:` value → `session.model`.
4. State machine over lines:
   - `#### ` prefix → new user message; flush current assistant buffer.
   - `> ` prefix (Aider commands) → skip.
   - non-empty, non-command lines while in "after-user" state → accumulate assistant message buffer.
   - Blank lines → continue (don't flush until next `#### ` or EOF).
5. Extract code blocks from each message.
6. `session.id = sha1(historyFile)` (stable ID from path, not content — avoids churn on appends).
7. `session.source = 'aider'`, `session.workspacePath = info.workspacePath`.
8. `updatedAt` = last message timestamp parsed from context, or file mtime.

**Security:**
- Lines > `maxLineChars` → skip with `skipped: true` placeholder (mirrors Claude parser behaviour).
- Cap assembled message at 1 MB; truncate with warning if exceeded.

### EXT-5-C — Watcher integration ☐

**File:** `src/watcher/fileWatcher.ts`

**Changes:**
- Add `collectAiderSessionsAsync()` — calls `discoverAiderHistoryFilesAsync(roots)` then `parseAiderHistory`.
- `roots` = VS Code workspace folder paths + `chatwizard.aiderSearchRoots` setting.
- Include in `buildInitialIndex()` when `chatwizard.indexAider` is `true`.
- Register file watcher on `**/.aider.chat.history.md`.
- `parseFile()`: add `source === 'aider'` branch.

### EXT-5-D — Config paths ☐

**File:** `src/watcher/configPaths.ts`

No root path to resolve (Aider files are in-repo). No new function needed — roots come directly from workspace folders and the `chatwizard.aiderSearchRoots` setting.

### EXT-5-E — Settings registration ☐

**File:** `package.json`

- `chatwizard.indexAider` (`boolean`, default `true`).
- `chatwizard.aiderSearchRoots` (`array` of `string`, default `[]`, description: `"Additional root directories to search for .aider.chat.history.md files."`).
- `chatwizard.aiderSearchDepth` (`integer`, default `3`, minimum `1`, maximum `5`).

### EXT-5-F — Unit tests ☐

**New test files:**
- `test/suite/aiderParser.test.ts`
  - Happy path: `parseAiderHistory` on `test/fixtures/aider/sample/` → correct `source`, `messages`, roles, `title`, `createdAt`, `workspacePath`, code blocks.
  - Aider command lines (`> `) → excluded from messages.
  - Mixed content with code fences → code blocks extracted correctly.
  - File missing → `errors.length > 0`, `messages.length === 0`.
  - Empty file → `session.messages.length === 0`, no errors.
  - `.aider.conf.yml` with `model:` key → populated on `session.model`.
  - `.aider.conf.yml` absent → `session.model` is `undefined`.
  - `extractAiderCodeBlocks`: language detection, `sessionId`/`messageIndex` propagation.
- `test/suite/aiderWorkspaceDiscovery.test.ts`
  - `discoverAiderHistoryFilesAsync([tmpDir])`: empty dir, `.aider.chat.history.md` at root, `.aider.chat.history.md` nested 2 levels, nested at 4 levels (excluded by default depth), file with symlink (excluded).

**New fixtures:**
- `test/fixtures/aider/sample/.aider.chat.history.md` — 4 turns (user/assistant/user/assistant), one code block, one Aider command line.
- `test/fixtures/aider/sample/.aider.conf.yml` — `model: claude-3-5-sonnet-20241022`.
- `test/fixtures/aider/empty/.aider.chat.history.md` — empty file.

**Effort:** ~1 week
**Complexity:** Medium (line-oriented state-machine parser)

---

## Cross-Cutting Tasks

### CC-1 — `SessionSource` type extension ☐

**File:** `src/types/index.ts`

Add `'cline' | 'roocode' | 'cursor' | 'windsurf' | 'aider'` to the `SessionSource` union type.

Update any exhaustive switches over `SessionSource` in the codebase (run `grep -r "SessionSource\|session\.source" src/` to find them):
- `src/analytics/analyticsEngine.ts`
- `src/analytics/modelUsageEngine.ts`
- `src/views/sessionTreeProvider.ts`
- `src/views/sessionRenderer.ts`
- `src/watcher/workspaceScope.ts`

### CC-2 — Source identity display ☐

**Files:** `src/views/sessionTreeProvider.ts`, `src/views/sessionRenderer.ts`, `src/webview/cwTheme.ts`

- Add display labels and icon associations for the five new sources (mirror existing Copilot/Claude label pattern).
- `friendlySourceName(source: SessionSource): string` helper — add to `src/views/webviewUtils.ts` or inline where needed.

### CC-3 — `WorkspaceScopeManager` multi-source extension ☐

**File:** `src/watcher/workspaceScope.ts`

- `calcWorkspaceSizeBytes` / `countWorkspaceSessions` — add branches for `'cline'`, `'roocode'`, `'cursor'`, `'windsurf'`, `'aider'` sources (scan correct directories for each).

### CC-4 — `modelNames.ts` completeness ☐

**File:** `src/analytics/modelNames.ts`

Audit all model IDs that appear in the new fixture files and verify each maps to the correct friendly name. Add missing matchers and unit tests in `test/suite/modelNames.test.ts`.

### CC-5 — README update ☐

**File:** `README.md`

Update the "Supported AI Tools" section to list all five new sources with their storage path and any prerequisites (e.g. `better-sqlite3` native module, Aider search roots config).

---

## Implementation Order & Parallelism

The following groups can be implemented in parallel (no inter-group dependencies):

| Group | Items | Can start |
|-------|-------|-----------|
| **A** | CC-1 (type extension) | Immediately — blocks nothing but should be done first |
| **B** | EXT-1-A, EXT-1-B, EXT-1-D, EXT-1-E, EXT-1-F | After CC-1 |
| **B** | EXT-3-A, EXT-3-B, EXT-3-D, EXT-3-E, EXT-3-F | After CC-1 (in parallel with EXT-1) |
| **B** | EXT-5-A, EXT-5-B, EXT-5-D, EXT-5-E (no EXT-5-C yet) | After CC-1 (in parallel with EXT-1 & EXT-3) |
| **C** | EXT-2-A, EXT-2-B, EXT-2-C, EXT-2-D, EXT-2-E | After EXT-1 is complete |
| **C** | EXT-4-A, EXT-4-B, EXT-4-C, EXT-4-D, EXT-4-F | After EXT-3 is complete |
| **D** | EXT-1-C, EXT-1-G | After EXT-1-A, EXT-1-B, EXT-1-D |
| **D** | EXT-3-C, EXT-3-G | After EXT-3-A, EXT-3-B, EXT-3-D |
| **D** | EXT-5-C, EXT-5-F | After EXT-5-A, EXT-5-B |
| **E** | CC-2, CC-3, CC-4, CC-5 | After all EXT tasks complete |

---

## Completion Summary

| Item | Status |
|------|--------|
| CC-1 — `SessionSource` type extension | ☑ (partial: 'cline' + 'roocode' added) |
| CC-2 — Source identity display | ☐ |
| CC-3 — `WorkspaceScopeManager` multi-source | ☐ |
| CC-4 — `modelNames.ts` completeness | ☐ |
| CC-5 — README update | ☐ |
| EXT-1-A — Cline reader | ☑ |
| EXT-1-B — Cline parser | ☑ |
| EXT-1-C — Cline watcher integration | ☑ |
| EXT-1-D — Cline config path | ☑ |
| EXT-1-E — Cline model name normalisation | ☑ |
| EXT-1-F — Cline settings | ☑ |
| EXT-1-G — Cline unit tests | ☑ |
| EXT-2-A — Roo Code reader parameterization | ☑ |
| EXT-2-B — Roo Code watcher integration | ☑ |
| EXT-2-C — Roo Code config path | ☑ |
| EXT-2-D — Roo Code settings | ☑ |
| EXT-2-E — Roo Code unit tests | ☑ |
| EXT-3-A — Cursor reader | ☑ |
| EXT-3-B — Cursor parser | ☑ |
| EXT-3-C — Cursor watcher integration | ☑ |
| EXT-3-D — Cursor config path | ☑ |
| EXT-3-E — Cursor model name normalisation | ☑ |
| EXT-3-F — Cursor settings | ☑ |
| EXT-3-G — Cursor unit tests | ☑ |
| EXT-4-A — Windsurf reader | ☐ |
| EXT-4-B — Windsurf parser | ☐ |
| EXT-4-C — Windsurf watcher integration | ☐ |
| EXT-4-D — Windsurf config path | ☐ |
| EXT-4-E — Windsurf settings | ☐ |
| EXT-4-F — Windsurf unit tests | ☐ |
| EXT-5-A — Aider reader | ☐ |
| EXT-5-B — Aider parser | ☐ |
| EXT-5-C — Aider watcher integration | ☐ |
| EXT-5-D — Aider config paths | ☐ |
| EXT-5-E — Aider settings | ☐ |
| EXT-5-F — Aider unit tests | ☐ |
