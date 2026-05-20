# Automatrics — VS Code Extension Analytics Platform — Work Plan

_Created: May 2026_

---

## Overview

Build a 3-layer analytics platform for VS Code extension developers — filling a real gap in the ecosystem where no turnkey, opinionated, VS Code-native analytics solution exists.

**ChatWizard is the pilot.** The platform is developed as a side project; CW is the first consumer. Each CW release exercises the SDK in production.

### Product gap
The ecosystem has:
- `@vscode/extension-telemetry` — low-level, requires infrastructure, no built-in metrics
- Generic SDKs (PostHog JS, Mixpanel) — not VS Code-aware, no auto-capture, no derived metrics
- No CLI or tooling to auto-instrument extension source code

There is no turnkey, opinionated solution that combines auto-capture, code transformation, and a developer-friendly UX.

---

## Product Architecture (3 Layers)

| Layer | Artifact | Audience | Job |
|---|---|---|---|
| 1 | `vsce-analytics` npm package | Extension developer | Core engine — tracking, storage, env auto-capture |
| 2 | `vsce-analytics` CLI | Extension developer | Code transformation — injects SDK, wraps `registerCommand` calls, writes config |
| 3 | **Automatrics** VS Code extension | Extension developer | UX shell — command palette interface for CLI operations; keeps developer inside VS Code |

**Key constraint**: VS Code's extension sandbox makes runtime injection into other extensions impossible. All instrumentation happens at **dev-time** (source code transformation), not at runtime.

**Automatrics is not a dashboard.** It is a developer tooling UX. Real analytics data lives in two places only:
- **SDK `debug` mode**: emits a line per event to an Output channel — proof the SDK is wired correctly
- **PostHog** (Phase 3): the actual analytics product, where cross-user DAU/retention/funnels live

---

## Design Principles

1. **Zero-config auto-capture** — the richest possible metric set from a single `init()` call; the CLI handles injection so developers write zero boilerplate
2. **Local-first** — fully functional with no backend; privacy-safe by default
3. **Respects telemetry settings** — honours `vscode.env.isTelemetryEnabled` by default; SDK users can override
4. **Typed and minimal API surface** — small, stable, easy to upgrade
5. **No vendor lock-in** — PostHog is the recommended backend but the transport layer is pluggable
6. **Dev-time transformation, not runtime injection** — the CLI modifies source code; no sandbox violations, no fragile monkey-patching

---

## Privacy Requirements

These are non-negotiable constraints that apply across all three layers.

### What the SDK MUST NEVER capture or transmit

| Category | Examples |
|---|---|
| User content | code, prompts, chat messages, file contents, clipboard data |
| Credentials | API keys, tokens, passwords |
| Identifiable paths | absolute file paths, workspace names, repo names |
| Command arguments | parameters passed to any VS Code command |
| Error messages/stacks | may contain file paths or user data — only capture error *type* (constructor name) |

The SDK only captures: event names, high-level environment properties (OS, IDE name, version, remote type), anonymous machine ID, and timestamps.

### Per-extension opt-out setting

The CLI (`vsce-analytics init`) must auto-generate a per-extension telemetry setting in the host extension's `package.json`:

```json
"contributes": {
  "configuration": {
    "properties": {
      "myExtension.enableTelemetry": {
        "type": "boolean",
        "default": true,
        "description": "Allow anonymous usage data to be collected to improve this extension. No personal data or code is ever collected."
      }
    }
  }
}
```

The SDK `enabled` flag resolves as: `options.enabled ?? perExtensionSetting ?? vscode.env.isTelemetryEnabled`. All three are checked; any `false` wins.

### Mandatory disclosure

Any extension using the SDK must include the following in its README (the SDK provides this as a copy-paste template):

> **Telemetry**: This extension collects anonymous usage data (command invocation counts, activation frequency, VS Code version, OS type) to help improve functionality. No personal data, code, prompts, or file contents are ever collected. You can disable this at any time via the `myExtension.enableTelemetry` setting or VS Code's global `telemetry.telemetryLevel` setting.

### CLI privacy constraint

The CLI transformer reads source files at dev-time to perform AST transformation. It must never transmit source code to any remote endpoint. The CLI is a fully local operation.

---

## Phase 1 — SDK Core (`vsce-analytics` npm package)

### 1.1 Project bootstrap

- New repo: `vsce-analytics`
- TypeScript, ESM-compatible, bundled with `tsup` or `esbuild`
- Target: `node18+` (VS Code's embedded Node)
- Peer dependency: `vscode` (not bundled)
- Zero runtime dependencies (or minimal: `uuid` only if `vscode.env.machineId` is insufficient)

---

### 1.2 Auto-captured metrics at init (zero effort for SDK users)

All captured once per `ExtensionAnalytics.init()` call and stored as session context attached to every subsequent event.

#### Identity
| Property | Source | Notes |
|---|---|---|
| `userId` | `vscode.env.machineId` | VS Code provides a stable, anonymous machine-scoped ID — no need to generate one |
| `sessionId` | `vscode.env.sessionId` | VS Code's per-IDE-session ID |

#### Environment (VS Code API)
| Property | Source | Notes |
|---|---|---|
| `ideName` | `vscode.env.appName` | "Visual Studio Code", "VSCodium", "Cursor", etc. |
| `ideVersion` | `vscode.version` | VS Code engine version |
| `uiKind` | `vscode.env.uiKind` | `Desktop` or `Web` |
| `appHost` | `vscode.env.appHost` | "desktop", "codespaces", "github.dev", etc. |
| `remoteName` | `vscode.env.remoteName` | `undefined` = local; `"ssh-remote"`, `"wsl"`, `"dev-container"`, `"codespaces"` |
| `locale` | `vscode.env.language` | User's display language |
| `isNewInstall` | `vscode.env.isNewAppInstall` | True on first VS Code launch after install |
| `telemetryEnabled` | `vscode.env.isTelemetryEnabled` | Respect user preference; gate all sending on this |

#### Platform (Node.js `os`)
| Property | Source | Notes |
|---|---|---|
| `os` | `os.platform()` | `win32`, `darwin`, `linux` |
| `arch` | `os.arch()` | `x64`, `arm64`, `ia32` |
| `osRelease` | `os.release()` | OS version string |

#### Extension metadata (from `ExtensionContext`)
| Property | Source | Notes |
|---|---|---|
| `extensionId` | passed by SDK user or `context.extension.id` | |
| `extensionVersion` | `context.extension.packageJSON.version` | |
| `extensionMode` | `context.extensionMode` | Production / Development / Test — filter dev noise |

#### Extension lifecycle (from `globalState`)
| Property | Source | Notes |
|---|---|---|
| `activationCount` | incremented each `init()` | Cumulative since install |
| `firstActivatedAt` | stored on first `init()`, never overwritten | Install-date proxy |
| `lastActivatedAt` | updated each `init()` | |
| `daysSinceFirstActivation` | computed | |
| `daysSinceLastActivation` | computed | Gap between sessions |
| `isFirstEverActivation` | `activationCount === 1` | Onboarding funnel entry point |

---

### 1.3 Auto-emitted events (SDK fires these, no user code needed)

| Event | When | Key properties |
|---|---|---|
| `extension.activated` | every `init()` | all session context |
| `extension.first_activated` | `activationCount === 1` only | subset of context |
| `extension.deactivated` | `deactivate()` proxy | `sessionDurationMs` |
| `session.started` | every `init()` | `sessionId`, `activationCount` |

SDK users can suppress any auto-event via config.

---

### 1.4 Manual tracking API

In normal usage, developers don't write this code manually — the CLI (Phase 2) injects it. The API is documented here as the SDK's contract.

```typescript
import { ExtensionAnalytics } from 'vsce-analytics';

// Initialise (call once in activate())
const analytics = await ExtensionAnalytics.init(context, {
  // All optional in Phase 1
  enabled?: boolean;          // default: vscode.env.isTelemetryEnabled
  extensionId?: string;       // default: context.extension.id
  debug?: boolean;            // emit one line per event to VS Code Output channel
  localStorageLimit?: number; // max events kept in globalState (default: 500)
});

// Track a custom event (manually added by developer for business-level signals)
analytics.track('feature_used', { feature: 'search', resultCount: 42 });

// Wrap a command — auto-tracks invocation count, duration, success/error
// The CLI injects this wrapper automatically around registerCommand calls
context.subscriptions.push(
  vscode.commands.registerCommand(
    'myext.doSearch',
    analytics.wrapCommand('myext.doSearch', async () => {
      /* handler */
    })
  )
);

// Read local aggregates — useful for the developer's own debug/verification only
const stats = analytics.getLocalStats();
// → { activationCount, daysActive, lastSeen, firstSeen, currentStreak, ... }

// Dispose (called automatically if pushed to context.subscriptions)
analytics.dispose();
```

---

### 1.5 `wrapCommand()` — what it auto-tracks

When a command is wrapped, the SDK automatically emits `command.invoked` with:
- `commandId`
- `durationMs`
- `success: boolean`
- `errorType` (if failed, error constructor name — no message, no stack)

This gives command-level usage frequency and error rate with zero additional instrumentation.

---

### 1.6 Local storage model

All data stored in `context.globalState` under a namespaced key (`__vsce_analytics__`):

```
{
  meta: {
    userId, firstActivatedAt, lastActivatedAt, activationCount
  },
  events: [
    // ring buffer, newest first, capped at `localStorageLimit`
    { ts, event, properties }
  ],
  aggregates: {
    // per-event-name counters
    "feature_used": { count: 42, lastAt: "..." },
    "myext.doSearch": { count: 18, lastAt: "...", errorCount: 2 }
  },
  dailyActivity: {
    // "YYYY-MM-DD": activationCount  (sparse map, bounded to last 90 days)
  }
}
```

Derived metrics computed on read from this structure:
- `daysActive` — count of distinct days in `dailyActivity`
- `currentStreak` — consecutive days with at least one activation
- `weeklyActive` — active in last 7 days

---

### 1.7 Telemetry guard

```typescript
// SDK internally gates all storage AND sending on:
if (!this.enabled) return;

// `enabled` resolves as:
//   options.enabled ?? vscode.env.isTelemetryEnabled
// Re-checked on each track() call (user may change setting mid-session)
```

---

### 1.8 Phase 1 deliverables

- [ ] Repo created, TypeScript project bootstrapped
- [ ] `ExtensionAnalytics.init()` — auto-captures all properties in §1.2
- [ ] Auto-events in §1.3
- [ ] `track()` API
- [ ] `wrapCommand()` helper
- [ ] Local storage model (ring buffer + aggregates + daily activity)
- [ ] `getLocalStats()` API (developer debug use only)
- [ ] Telemetry guard (honours `isTelemetryEnabled`)
- [ ] `debug` mode — emits one line per event to a VS Code Output channel (this is the only "dashboard" in Phase 1)
- [ ] Unit tests (no VS Code runtime needed — mock `vscode` and `os`)
- [ ] **CW manual integration** — wire `vsce-analytics` v0.1 into ChatWizard by hand (teaches the CLI what code to generate)

### 1.9 Phase 1 — Manual tests

Run these by hand against a minimal test extension (separate from CW) before closing Phase 1:

- [ ] Activate the test extension — verify `extension.activated` event appears in the Output channel with all expected auto-captured properties (OS, IDE name, version, machineId, etc.)
- [ ] Activate a second time — verify `activationCount` increments; `extension.first_activated` does NOT fire again
- [ ] Activate for the very first time (fresh globalState) — verify `extension.first_activated` fires and `isFirstEverActivation` is true
- [ ] Call `track('test_event', { key: 'value' })` — verify event appears in Output channel with correct properties
- [ ] Invoke a wrapped command that succeeds — verify `command.invoked` fires with `success: true` and a valid `durationMs`
- [ ] Invoke a wrapped command that throws — verify `command.invoked` fires with `success: false` and `errorType` set; verify the error message and stack are NOT present
- [ ] Set `enabled: false` in init options — verify zero events appear in Output channel regardless of calls
- [ ] Set VS Code `telemetry.telemetryLevel` to `off` — verify zero events fire (telemetry guard honours `isTelemetryEnabled`)
- [ ] Inspect `globalState` contents — verify structure matches the documented schema (meta, events ring buffer, aggregates, dailyActivity)
- [ ] Call `getLocalStats()` — verify `activationCount`, `firstSeen`, `lastSeen`, `daysActive` return correct values
- [ ] Trigger > 500 `track()` calls — verify ring buffer caps and oldest events are dropped without error
- [ ] **Privacy check**: inspect every field in Output channel output — confirm no file paths, no command arguments, no error messages, no workspace names are present

### 1.10 Phase 1 — E2E tests

Automated tests to be written immediately after manual tests pass. All run without a VS Code runtime (mock `vscode` and `os`):

- [ ] `init()` captures all expected auto-properties and attaches them as context to every subsequent event
- [ ] `init()` increments `activationCount` in globalState on each call
- [ ] `firstActivatedAt` is written once and never overwritten on subsequent `init()` calls
- [ ] `extension.first_activated` fires exactly once across multiple simulated activations
- [ ] `track()` writes event to the ring buffer and increments the per-event aggregate counter
- [ ] Ring buffer evicts oldest entries when `localStorageLimit` is exceeded
- [ ] `wrapCommand()` emits `command.invoked` with `commandId`, `durationMs`, `success: true` on a successful handler
- [ ] `wrapCommand()` emits `command.invoked` with `success: false` and `errorType` (constructor name only) when the handler throws
- [ ] `wrapCommand()` never includes command arguments in the emitted event
- [ ] No event is stored or emitted when `enabled` resolves to `false` (all three precedence levels tested individually)
- [ ] `getLocalStats()` correctly derives `daysActive`, `currentStreak`, and `weeklyActive` from a mock `dailyActivity` map
- [ ] `dispose()` cleans up without throwing; subsequent `track()` calls after dispose are silently ignored

---

## Phase 2 — CLI Transformer (`vsce-analytics` CLI)

The CLI is the adoption engine. It eliminates the manual wiring effort entirely for the `registerCommand` layer.

### 2.1 What it does

```bash
npx vsce-analytics init
```

Run once inside a VS Code extension project. The CLI:

1. Detects `package.json` with `contributes.commands` (validates it is a VS Code extension)
2. Installs `vsce-analytics` as a dependency
3. Scans TypeScript/JavaScript source for `vscode.commands.registerCommand(` call sites
4. Injects `analytics.wrapCommand()` around each handler
5. Adds `ExtensionAnalytics.init(context)` call at the top of `activate()`
6. Writes an `automatrics.config.json` to the project root (which metrics to capture, backend config placeholder)
7. Prints a summary: `Instrumented 7 commands. 2 locations need manual track() — see automatrics.todo.md`

### 2.2 The split: automatic vs manual

The CLI handles everything it can infer from structure:
- All `registerCommand` wrappings (command frequency, duration, error rate) → **automatic**

The CLI **cannot** handle semantic business events — it doesn't know which code paths are meaningful. It marks these for the developer:
- Generates `automatrics.todo.md` listing candidate locations (function bodies containing user-facing logic) as suggestions for manual `track()` calls
- Developer adds `analytics.track('my_event')` at those points manually

### 2.3 Code transformation example

Before:
```typescript
vscode.commands.registerCommand('chatwizard.search', searchHandler);
```

After:
```typescript
vscode.commands.registerCommand(
  'chatwizard.search',
  analytics.wrapCommand('chatwizard.search', searchHandler)
);
```

Transformation uses TypeScript AST (via `ts-morph`) — not regex. Safe, preserves formatting, handles async/sync/arrow/reference patterns.

### 2.4 `automatrics.config.json`

```json
{
  "extensionId": "your-publisher.your-extension",
  "captureCommands": true,
  "captureEnvironment": true,
  "capturePlatform": true,
  "backend": {
    "type": "posthog",
    "apiKey": ""
  }
}
```

### 2.5 Phase 2 deliverables

- [ ] CLI entry point (`npx vsce-analytics init`)
- [ ] Extension project detection
- [ ] Dependency installation (`npm install vsce-analytics`)
- [ ] AST-based `registerCommand` scanner and wrapper injector (via `ts-morph`)
- [ ] `activate()` init injection
- [ ] `automatrics.config.json` writer
- [ ] `automatrics.todo.md` generator (candidate locations for manual `track()`)
- [ ] CLI `status` command — reports instrumentation state of a project without modifying it
- [ ] CLI `update` command — re-runs injection after new commands are added
- [ ] Auto-generate per-extension `enableTelemetry` setting in host extension's `package.json` (see Privacy Requirements)
- [ ] **CW re-integration** — run CLI on CW source; replace manual wiring from Phase 1 with CLI-generated wiring

### 2.6 Phase 2 — Manual tests

Run against a purpose-built fixture extension project (3–5 `registerCommand` calls in various patterns):

- [ ] Run `npx vsce-analytics init` on the fixture project — verify all `registerCommand` calls are wrapped with `wrapCommand()`
- [ ] Verify `ExtensionAnalytics.init(context)` is injected exactly once at the top of `activate()`
- [ ] Verify `automatrics.config.json` is created with correct default values
- [ ] Verify `automatrics.todo.md` is generated and lists plausible candidate locations for manual `track()` calls
- [ ] Verify `enableTelemetry` setting is added to `package.json` `contributes.configuration` without corrupting existing contributions
- [ ] Run `init` a second time on the same project — verify no double-wrapping occurs (idempotent)
- [ ] Add a new command to the fixture and run `npx vsce-analytics update` — verify only the new command is wrapped; existing wrappers untouched
- [ ] Run `npx vsce-analytics status` — verify read-only output correctly reports instrumented commands; verify no files are modified
- [ ] Run `init` on a non-extension project (no `contributes.commands`) — verify a clear error is shown and no files are written
- [ ] **Network check**: run `init` with network monitoring (e.g., Wireshark or Fiddler) — verify zero outbound network calls are made
- [ ] **CW validation**: run CLI on CW source, diff result against Phase 1 manual wiring — verify all commands are correctly wrapped and no regressions introduced

### 2.7 Phase 2 — E2E tests

- [ ] CLI correctly identifies a valid VS Code extension project and rejects a plain Node project
- [ ] All `registerCommand` patterns produce correctly wrapped output: inline handler, named reference, `async` arrow, multi-argument form
- [ ] Running `init` twice produces byte-for-byte identical output to running it once (idempotent transformation)
- [ ] `update` adds wrappers to new commands and does not modify already-wrapped call sites
- [ ] `automatrics.config.json` is written with the exact documented schema
- [ ] `enableTelemetry` contribution is inserted into `package.json` without corrupting other `contributes` keys
- [ ] `status` exits 0 on an instrumented project and reports a non-zero/message on an uninstrumented one
- [ ] No files are written outside the target project root
- [ ] CLI summary output correctly counts instrumented commands and candidate manual-track locations
- [ ] Fixture: a project with 10 commands — verify all 10 are wrapped and `activationCount` in generated init call is correct

---

## Phase 3 — Backend Integration (PostHog)

### 3.1 Why PostHog first
- ~1M events/month free tier
- Built-in DAU, retention curves, funnels, cohort analysis
- Self-hostable (no vendor lock-in)
- Well-documented JS/Node SDK

### 3.2 Transport layer design

The SDK adds an optional transport interface:

```typescript
interface AnalyticsTransport {
  send(event: string, properties: Record<string, unknown>): Promise<void>;
}
```

Built-in transport: `PostHogTransport` (wraps `posthog-node`).  
SDK users can implement custom transports (Supabase, Cloudflare Workers, etc.).

### 3.3 PostHog-specific concerns

- Use `vscode.env.machineId` as PostHog `distinctId` — stable, anonymous
- Batch events before sending (fire on deactivate or on a 30s interval)
- Queue events locally if offline; flush on next activation
- Never send if `!vscode.env.isTelemetryEnabled`

### 3.4 Phase 3 config additions

```typescript
const analytics = await ExtensionAnalytics.init(context, {
  backend: {
    type: 'posthog',
    apiKey: 'phc_...',
    host?: 'https://app.posthog.com', // default
    flushInterval?: 30_000,            // ms
    flushAt?: 20,                      // event count trigger
  }
});
```

### 3.5 Phase 3 deliverables

- [ ] `AnalyticsTransport` interface
- [ ] `PostHogTransport` implementation
- [ ] Event batching + offline queue (stored in `globalState`)
- [ ] Flush on deactivation
- [ ] CW integration updated to PostHog backend
- [ ] README section: "Setting up PostHog in 5 minutes"
- [ ] CLI `init` updated to write PostHog `apiKey` into `automatrics.config.json` when provided

### 3.6 Phase 3 — Manual tests

Requires a real PostHog project (test API key, separate from any production project):

- [ ] Configure PostHog API key, activate the instrumented test extension — verify `extension.activated` event appears in the PostHog Live Events view within 30 seconds
- [ ] Fire 5 `track()` calls — verify all 5 appear in PostHog with correct event names and properties
- [ ] Disable network (airplane mode), fire 3 events, re-enable network — verify all 3 events flush on the next activation
- [ ] Call `dispose()` / deactivate while there are queued events — verify the queue flushes before shutdown completes
- [ ] Set `flushAt: 3`, fire 3 events rapidly — verify a batch send is triggered without waiting for `flushInterval`
- [ ] Set `isTelemetryEnabled = false` — verify nothing appears in PostHog Live Events (check for 60 seconds)
- [ ] **Privacy check on payload**: inspect the raw PostHog event payload — confirm no file paths, workspace names, command arguments, error messages, or API keys are present in any field
- [ ] Verify `distinctId` in PostHog matches `vscode.env.machineId` and is stable across multiple sessions

### 3.7 Phase 3 — E2E tests

- [ ] `PostHogTransport.send()` constructs the correct payload shape (event name, `distinctId`, properties, timestamp)
- [ ] Events are batched: below `flushAt` threshold, transport `send()` is not called
- [ ] `flushAt` threshold triggers a send (mock transport to capture calls)
- [ ] Offline queue: when transport throws a network error, events are written to `globalState`; on next `init()` the queue is drained and sent
- [ ] `enabled: false` results in zero calls to the transport `send()` method
- [ ] `flushInterval` timer triggers a flush (mock timer / fake timers)
- [ ] Payload is validated against the "never collect" list: assert no property key or value contains patterns matching file paths, stack traces, or credential-like strings
- [ ] Custom transport implementation (implementing `AnalyticsTransport`) receives events correctly — verifies pluggability

---

## Phase 4 — Automatrics (VS Code Extension, UX Shell)

Automatrics is a **developer tooling extension** — not an end-user product, not a dashboard. Its only job is to surface CLI operations through the VS Code command palette and UI, so the developer never needs to leave the editor.

### 4.1 What Automatrics is NOT
- Not a runtime analytics viewer
- Not a metrics dashboard
- Not aware of end-user data

### 4.2 What Automatrics IS

A UX wrapper around the CLI, providing:

| Feature | What it does |
|---|---|
| Project detection | On workspace open, reads `package.json` — if it's a VS Code extension project, shows status in status bar |
| Instrumentation status | Shows "Automatrics: instrumented ✓ / not instrumented" — read from presence of `automatrics.config.json` and injected init call in source |
| `Automatrics: Instrument this extension` | Command palette entry → runs `npx vsce-analytics init` under the hood, shows output in a terminal panel |
| `Automatrics: Update instrumentation` | Re-runs CLI after new commands were added to source |
| Backend configuration UI | Quick input / settings UI for entering PostHog API key → writes to `automatrics.config.json` |
| `automatrics.todo.md` viewer | Opens the candidate manual `track()` locations generated by the CLI |

### 4.3 What Automatrics does NOT provide

- No WebView dashboard
- No reading of another extension's `globalState`
- No runtime data of any kind

The developer's only runtime feedback is the SDK's own `debug` Output channel (one line per event, built into the SDK itself in Phase 1).

### 4.4 Phase 4 deliverables

- [ ] Extension project scaffold (VS Code extension with `vsce-analytics` as dev dependency)
- [ ] `package.json` detection and status bar item
- [ ] `Automatrics: Instrument this extension` command (shells out to CLI)
- [ ] `Automatrics: Update instrumentation` command
- [ ] Backend config quick-input UI (writes `automatrics.config.json`)
- [ ] `automatrics.todo.md` open command
- [ ] Publish to VS Code Marketplace

### 4.5 Phase 4 — Manual tests

Run in a real VS Code instance with Automatrics installed from source:

- [ ] Open a non-extension workspace — verify no Automatrics status bar item appears
- [ ] Open an uninstrumented extension project — verify status bar shows "Automatrics: not instrumented"
- [ ] Open an already-instrumented extension project — verify status bar shows "Automatrics: instrumented ✓"
- [ ] Run `Automatrics: Instrument this extension` from the command palette — verify a terminal opens, CLI runs, status bar updates to ✓ after completion
- [ ] Run `Automatrics: Update instrumentation` — verify CLI runs, terminal shows output, no regressions in already-wrapped commands
- [ ] Use the backend config UI to enter a PostHog API key — verify the key is written to `automatrics.config.json`; verify the key is NOT echoed in any Output channel or log
- [ ] Run `Automatrics: Instrument this extension` in a workspace with no `contributes.commands` — verify a user-facing error notification is shown (not a raw exception)
- [ ] Run `Automatrics: Open instrumentation todos` — verify `automatrics.todo.md` opens in the editor
- [ ] Reload VS Code window — verify status bar state is correctly restored from the project files (not from memory)

### 4.6 Phase 4 — E2E tests

Use the VS Code Extension Test runner (`@vscode/test-electron`) for integration-level tests:

- [ ] Extension activates without error in a VS Code test environment
- [ ] Status bar item is created on activation and disposed on deactivation
- [ ] Status reflects `automatrics.config.json` presence: absent → "not instrumented", present → "instrumented ✓"
- [ ] `Automatrics: Instrument this extension` command is registered and callable; verify it shells out to the CLI with the correct working directory
- [ ] `Automatrics: Update instrumentation` command shells out to `vsce-analytics update` (not `init`)
- [ ] Backend config write: entering a value via the quick-input results in the correct JSON written to `automatrics.config.json`
- [ ] Error case: command invoked in a non-extension workspace shows an error message and does not attempt to run the CLI

---

## Phase 5 — Published Packages

- [ ] Package name decision: `vsce-analytics` (preferred) or `@vsce/analytics`
- [ ] Full README with quickstart, API reference, migration guide from `@vscode/extension-telemetry`
- [ ] CLI README: usage, transformation examples, config reference
- [ ] **Privacy disclosure template** — copy-paste README block that consuming extensions must include (see Privacy Requirements)
- [ ] CHANGELOG
- [ ] Semantic versioning (`0.x` until API is stable)
- [ ] GitHub Actions: test + publish SDK and CLI on tag
- [ ] License: MIT
- [ ] Publish SDK + CLI to npm
- [ ] **Privacy policy** for Automatrics marketplace listing (required by VS Code Marketplace for extensions that collect telemetry)
- [ ] Publish Automatrics to VS Code Marketplace

---

## CW Pilot Integration Plan

CW currently has a `src/telemetry/` module. Integration path:

1. **Phase 1** — manually wire `vsce-analytics` v0.1 into CW's `activate()` and hand-wrap the top 5–10 commands. This teaches the CLI exactly what code to generate.
2. **Phase 2** — run `npx vsce-analytics init` on the CW source tree. Compare CLI output to the manual wiring from Phase 1 to validate the transformer.
3. **Phase 3** — configure PostHog API key in `automatrics.config.json`; CW becomes the first real cross-user analytics consumer.
4. **Phase 4** — install Automatrics in the CW development environment; use it to manage future instrumentation updates as CW gains new commands.

---

## Open Questions

| # | Question | Decision needed before |
|---|---|---|
| 1 | Package name: `vsce-analytics` vs `@vsce/analytics` vs other? | Phase 5 |
| 2 | Should `wrapCommand()` track arguments? (privacy risk — probably no) | Phase 1 |
| 3 | `globalState` vs file-based storage for local events? (`globalState` has undocumented size limits) | Phase 1 |
| 4 | Should the SDK create its own Output channel, or accept an existing one from the host extension? | Phase 1 |
| 5 | Self-hosted PostHog vs cloud PostHog for CW itself? | Phase 3 |
| 6 | Should the CLI transformer handle JavaScript source, or TypeScript only? | Phase 2 |
| 7 | How should the CLI handle `registerCommand` calls that use variable references for the handler (not inline)? | Phase 2 |

---

## Non-Goals (v1)

- Access to marketplace install counts (impossible from inside the extension)
- Tracking across multiple extensions (each extension has its own SDK instance)
- Runtime injection into installed/running extensions (VS Code sandbox prevents this)
- PII collection of any kind (enforced by the "never collect" list in Privacy Requirements)
