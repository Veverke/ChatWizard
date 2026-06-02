# ChatWizard — Security Improvements

Date: 2026-05-17
Scope: Top 10 security issues identified in the v1.4.0 source tree. Items are sorted by severity. Each item maps to an OWASP Top 10 category where applicable and provides a concrete remediation.

---

## Background

The extension handles user-originated content (AI chat histories) that is rendered in VS Code webviews and partially exposed via a local HTTP/SSE MCP server. The attack surface is predominantly local, but a compromised AI tool's storage file, a malicious extension running in the same process, or a crafted session file could all reach the identified sinks. Defence-in-depth is especially important for an extension that reads arbitrary files from disk and renders their content as HTML.

---

## Issue 1 — `unsafe-inline` in Content Security Policy for all webviews

**Severity: Critical**
**OWASP**: A03 — Injection (XSS)
**Files**: `src/analytics/analyticsPanel.ts:90`, `src/codeblocks/codeBlocksPanel.ts:114`, `src/prompts/promptLibraryPanel.ts:92`

**Problem**
All three full-panel webviews declare `script-src 'unsafe-inline'`, which neutralises CSP's primary XSS defence. Any injected `<script>` tag that reaches the webview's DOM executes without restriction.

**Fix**
Use a per-panel nonce (VS Code's `getNonce()` helper) and move all inline scripts to a tagged `<script nonce="...">` block:
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               script-src 'nonce-${nonce}';
               style-src 'unsafe-inline';">
```
Style-src `unsafe-inline` is acceptable because CSS cannot exfiltrate data in the VS Code webview sandbox; only script-src matters here.

**Measurable goal**: Zero `unsafe-inline` in `script-src` across all CSP headers.

---

## Issue 2 — `innerHTML` set from session-derived content without uniform escaping

**Severity: High**
**OWASP**: A03 — Injection (XSS)
**Files**: `src/codeblocks/codeBlocksPanel.ts:394,407,464,524`, `src/analytics/analyticsPanel.ts:401,470,497,511,588,598,611,670`, `src/prompts/promptLibraryPanel.ts:664,688,705`

**Problem**
Session titles, code block content, and prompt text flow into `innerHTML` inside the webview. `_escapeHtml` exists in `analyticsPanel.ts` but is not consistently applied across all three panels. Stored AI responses can contain HTML (e.g. `<img onerror=...>`) that becomes active JavaScript if assigned to `innerHTML` unescaped.

**Fix**
- Apply `escapeHtml()` to every user-originating string before HTML concatenation (titles, content, model names, workspace paths).
- Alternatively, migrate from string-concatenation HTML to DOM-safe methods (`element.textContent = ...`) for dynamic text nodes.
- Add a lint rule (`no-restricted-syntax`) that flags string concatenation into `.innerHTML` so future regressions are caught at review time.

**Measurable goal**: `escapeHtml()` applied at every HTML injection point; lint rule in place.

---

## Issue 3 — External CDN script without Subresource Integrity (SRI)

**Severity: High**
**OWASP**: A08 — Software and Data Integrity Failures
**File**: `src/analytics/analyticsPanel.ts:90`

**Problem**
Chart.js is loaded from `https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` without an `integrity` attribute. A compromised CDN response, a BGP hijack, or a man-in-the-middle on the developer machine could silently replace the library with malicious code that executes inside the extension's webview.

**Fix — Option A (preferred)**: Bundle Chart.js locally as part of the extension build:
```
npm install chart.js --save
```
Reference it from `dist/` via a `vscode.Uri.joinPath(extensionUri, 'dist', 'chart.umd.min.js')` webview URI.

**Fix — Option B**: Add a pinned SRI hash to the CDN `<script>` tag:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"
        integrity="sha384-<hash>"
        crossorigin="anonymous"></script>
```
Also add `https://cdn.jsdelivr.net` to CSP `script-src`.

**Measurable goal**: No external script URLs without SRI; or zero external script URLs.

---

## Issue 4 — Unauthenticated `/mcp-config` endpoint leaks bearer token

**Severity: Medium**
**OWASP**: A07 — Identification and Authentication Failures
**File**: `src/mcp/mcpServer.ts`

**Problem**
The `/mcp-config` endpoint is intentionally unauthenticated (for first-time client setup) but returns the raw bearer token in the JSON snippet. Any process on the loopback interface that knows the port can retrieve the token without any credentials. The port is predictable (configured in settings).

**Fix**
- On first retrieval, mark the token as "distributed" (write a flag file alongside the token). Subsequent calls to `/mcp-config` return only the port and instructions, not the token.
- Or: require a one-time setup code (short-lived, generated at server-start and shown in the VS Code notification) as a query parameter before the token is revealed.

**Measurable goal**: Token is revealed via `/mcp-config` at most once per server lifecycle.

---

## Issue 5 — Prototype pollution via `deepSet()` in Copilot parser

**Severity: Medium**
**OWASP**: A03 — Injection
**File**: `src/parsers/copilot.ts`

**Problem**
`deepSet(obj, keys, value)` traverses attacker-controlled key arrays from JSONL content and uses `String(key)` to index plain objects. Keys such as `__proto__`, `constructor`, or `prototype` could pollute `Object.prototype` if the JSONL file is crafted (or corrupted by a malicious AI tool). Existing guards (`MAX_DEEPSET_DEPTH`, `MAX_ARRAY_INDEX`) do not cover prototype chains.

**Fix**
Add an explicit denylist before any property assignment:
```typescript
const safeKey = String(key);
if (safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') {
    return;
}
```
Apply to both the traversal loop and the final assignment.

**Measurable goal**: `deepSet()` test cases for `__proto__` and `constructor` keys pass without mutation.

---

## Issue 6 — No rate limiting on the MCP HTTP server

**Severity: Medium**
**OWASP**: A05 — Security Misconfiguration
**File**: `src/mcp/mcpServer.ts`

**Problem**
The local HTTP server accepts unlimited requests per second. A malicious locally-installed extension, a runaway MCP client, or a localhost network scan could flood the server, saturating VS Code's extension host CPU and memory.

**Fix**
Maintain a simple in-process token-bucket per remote address (all requests from `127.0.0.1` share one bucket):
```typescript
let requestsThisSecond = 0;
let windowStart = Date.now();
const MAX_RPS = 60;
// In httpServer handler:
if (Date.now() - windowStart > 1000) { requestsThisSecond = 0; windowStart = Date.now(); }
if (++requestsThisSecond > MAX_RPS) {
    res.writeHead(429).end(JSON.stringify({ error: 'Too many requests.' }));
    return;
}
```

**Measurable goal**: Server returns HTTP 429 after 60 requests/second from a single client.

---

## Issue 7 — Synchronous file I/O for token management on the extension host main thread

**Severity: Medium**
**OWASP**: A05 — Security Misconfiguration (availability)
**File**: `src/mcp/mcpAuthManager.ts`

**Problem**
`getOrCreateToken` and `readToken` use `fs.readFileSync` / `fs.writeFileSync`. Synchronous file I/O on VS Code's extension host main thread blocks the event loop, causing UI freezes. VS Code's extension guidelines explicitly prohibit synchronous I/O on the main thread.

**Fix**
Replace all `fs.*Sync` calls with their `fs.promises.*` async equivalents. The call sites in `extension.ts` already use `async/await`, so this is a straightforward migration.

**Measurable goal**: Zero `Sync` file I/O calls in `mcpAuthManager.ts`.

---

## Issue 8 — Symlink traversal guard not applied uniformly across all source discovery paths

**Severity: Medium**
**OWASP**: A01 — Broken Access Control
**File**: `src/watcher/fileWatcher.ts`

**Problem**
`_isSafeFilePath` and `_isSafeFilePathAsync` exist and are used in some change-handler paths, but `buildInitialIndex` delegates to external discovery functions (`discoverCopilotWorkspacesAsync`, `discoverCursorWorkspacesAsync`, etc.) that do not always apply the same check before passing file paths to parsers. A crafted symlink under an AI tool's storage directory could cause a file outside the expected base to be read and parsed.

**Fix**
- Centralise the symlink check in a shared `assertSafeFilePath(base, file)` helper that throws on violation.
- Call it inside each `discoverXxxWorkspacesAsync` function before returning any path, rather than at the watcher call site.
- Add a test case: symlink pointing outside the base directory should be rejected.

**Measurable goal**: Every file path accepted by a parser has passed `assertSafeFilePath`.

---

## Issue 9 — Unauthenticated `/health` endpoint discloses session count

**Severity: Low**
**OWASP**: A01 — Broken Access Control (information disclosure)
**File**: `src/mcp/mcpServer.ts`

**Problem**
`/health` returns `{ status: 'ok', sessions: N }` without authentication. Any process that can reach `127.0.0.1:<port>` learns how many sessions are indexed — a minor information disclosure that violates the principle of minimal exposure.

**Fix**
Return only `{ status: 'ok' }` from the unauthenticated health check. Move `sessions` count to a separate authenticated status endpoint (e.g. `/status`) if clients need it.

**Measurable goal**: `/health` response body contains no session count.

---

## Issue 10 — Unvalidated JSON casts on `globalState` data

**Severity: Low**
**OWASP**: A03 — Injection (data integrity)
**File**: `src/extension.ts`

**Problem**
`JSON.parse(savedJson) as string[]` / `as SortStack` / `as SortCriterion[]` are applied without runtime schema validation. Corrupted or deliberately crafted `globalState` entries (e.g. via a compromised VS Code settings sync) could produce unexpected shapes that propagate type-unsafely into the tree provider, causing runtime errors or unexpected behaviour.

**Fix**
Add a lightweight validation helper:
```typescript
function isSortStack(v: unknown): v is SortStack {
    return Array.isArray(v) && v.every(c =>
        typeof c === 'object' && c !== null &&
        typeof (c as SortCriterion).key === 'string' &&
        (c as SortCriterion).direction === 'asc' || (c as SortCriterion).direction === 'desc'
    );
}
```
Use it before accepting any persisted state. The existing `try/catch` blocks handle parse failures but not structural mismatches.

**Measurable goal**: All `globalState` deserialisations guarded by runtime type checks.

---

## Tracking

| # | Issue | Severity | Status | Target version |
|---|-------|----------|--------|----------------|
| 1 | Replace `unsafe-inline` CSP with nonces | Critical | Not started | — |
| 2 | Uniform `escapeHtml` at all `innerHTML` sinks | High | Not started | — |
| 3 | Bundle Chart.js locally or add SRI hash | High | Not started | — |
| 4 | Restrict `/mcp-config` token exposure | Medium | Not started | — |
| 5 | Prototype-pollution guard in `deepSet()` | Medium | Not started | — |
| 6 | Rate limit MCP HTTP server | Medium | Not started | — |
| 7 | Remove sync file I/O in `McpAuthManager` | Medium | Not started | — |
| 8 | Uniform symlink check in all discovery paths | Medium | Not started | — |
| 9 | Remove session count from `/health` | Low | Not started | — |
| 10 | Runtime validation of `globalState` JSON | Low | Not started | — |
