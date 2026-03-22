# Work Plan: User Requests per Model View

## Feature Summary

Add a new **"Model Usage"** sidebar view in the `chatwizard` activity-bar container (placed after Analytics) that displays a breakdown of user requests distributed across LLM models. The user can adjust a date range (defaulting to current month) to scope the analysis. The view renders a bar chart (+ summary table) using Chart.js, consistent with the existing Analytics view pattern.

**Placement decision**: New dedicated webview sidebar view (`chatwizardModelUsage`), positioned after `chatwizardAnalytics` in `package.json`. Keeping it separate from Analytics avoids overloading that panel and lets this feature evolve independently.

**Data anchor**: `session.updatedAt` (consistent with Analytics and Timeline) is used for date-range filtering. Model identity comes from `Session.model` (already populated by both parsers). Sessions without a model field are grouped under `"Unknown"`.

---

## Architecture Overview

```
SessionIndex
    └─ getAllSummaries()
            │
            ▼
computeModelUsage(summaries, from, to)     ← pure function, easily testable
    └─ ModelUsageData { totalUserRequests, models: ModelEntry[] }
            │
            ▼
ModelUsageViewProvider (WebviewViewProvider)
    ├─ resolveWebviewView() → shell HTML (never reassigned)
    ├─ listens to index typed-change events → debounced refresh
    ├─ receives {type:'ready'} from webview → sends {type:'update', data, dateRange}
    ├─ receives {type:'setDateRange', from, to} → recomputes + sends update
    └─ posts {type:'update', data: ModelUsageData, dateRange:{from,to}}
            │
            ▼
Webview HTML/JS (inline in provider's getShellHtml())
    ├─ Date-range picker (two <input type="date"> with preset buttons)
    ├─ Chart.js 4 horizontal bar chart (model on Y-axis, userRequests on X-axis)
    └─ Summary table (model name | sessions | user requests | % share)
```

---

## Phase 1 — Data Layer (pure functions + types)

**Goal**: Everything computable and testable without VS Code APIs.

### Tasks

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 1.1 | Add `ModelEntry` and `ModelUsageData` types | `src/types/index.ts` | See schema below |
| 1.2 | Implement `computeModelUsage()` | `src/analytics/modelUsageEngine.ts` | Pure function; groups by model, filters by date range |
| 1.3 | Write unit tests for `computeModelUsage()` | `test/suite/modelUsageEngine.test.ts` | Cover: empty input, date filtering, unknown model grouping, sorting, percentages |

### Type Schema

```typescript
// in src/types/index.ts
export interface ModelEntry {
  model: string;               // e.g. "gpt-4o", "claude-sonnet-4-6", "Unknown"
  sessionCount: number;
  userRequests: number;        // sum of SessionSummary.userMessageCount
  percentage: number;          // (userRequests / totalUserRequests) * 100, rounded 2dp
}

export interface ModelUsageData {
  from: string;                // ISO date string YYYY-MM-DD
  to: string;                  // ISO date string YYYY-MM-DD
  totalSessions: number;
  totalUserRequests: number;
  models: ModelEntry[];        // sorted by userRequests desc
}
```

### `computeModelUsage` Signature

```typescript
// src/analytics/modelUsageEngine.ts
export function computeModelUsage(
  summaries: SessionSummary[],
  from: Date,
  to: Date
): ModelUsageData
```

- Filter: include session if `new Date(summary.updatedAt) >= from` AND `<= to` (end of day)
- Group by `summary.model?.trim() || 'Unknown'`
- Sort `models[]` by `userRequests` descending
- `percentage` = `(entry.userRequests / totalUserRequests) * 100` rounded to 2 decimal places; if `totalUserRequests === 0` all percentages are 0

### Phase 1 Deliverables
- `src/analytics/modelUsageEngine.ts` (pure, no VS Code imports)
- `src/types/index.ts` updated with `ModelEntry`, `ModelUsageData`
- `test/suite/modelUsageEngine.test.ts` — all tests passing

### Phase 1 Test Checklist
- [ ] Empty sessions array → `totalUserRequests: 0`, `models: []`
- [ ] Sessions outside date range are excluded
- [ ] Sessions with `model: undefined` group under `"Unknown"`
- [ ] Sessions with whitespace-only model string group under `"Unknown"`
- [ ] Multiple sessions with same model are aggregated
- [ ] `models[]` sorted descending by `userRequests`
- [ ] `percentage` sums to ~100 (floating point tolerance)
- [ ] `totalSessions` and `totalUserRequests` reflect only filtered sessions

---

## Phase 2 — View Provider (backend / VS Code integration)

**Goal**: Wire the engine into the VS Code sidebar webview lifecycle and index change events.

### Tasks

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 2.1 | Implement `ModelUsageViewProvider` | `src/analytics/modelUsageViewProvider.ts` | Follow `AnalyticsViewProvider` pattern exactly |
| 2.2 | Register view in `package.json` | `package.json` | New entry under `contributes.views.chatwizard` after `chatwizardAnalytics` |
| 2.3 | Register provider in `extension.ts` | `src/extension.ts` | `registerWebviewViewProvider` before `await startWatcher(...)` |

### Provider Behavior

```
constructor(context, sessionIndex)
  - defaultDateRange(): { from: first day of current month, to: today }
  - _dateRange: { from: Date, to: Date }  (mutable, updated by webview messages)
  - subscribeToIndexChanges → debounced _refresh() (500ms, same as AnalyticsViewProvider)

resolveWebviewView(view)
  - set webview.html = getShellHtml(webview)  (once)
  - webview.onDidReceiveMessage:
      'ready'        → _sendUpdate(view)
      'setDateRange' → validate dates, update _dateRange, _sendUpdate(view)

_sendUpdate(view)
  - summaries = sessionIndex.getAllSummaries()
  - data = computeModelUsage(summaries, _dateRange.from, _dateRange.to)
  - view.webview.postMessage({ type: 'update', data, dateRange: { from: ISO, to: ISO } })
```

**Date validation**: if `from > to`, swap them silently. If date strings are invalid, ignore the message.

### Phase 2 Deliverables
- `src/analytics/modelUsageViewProvider.ts`
- `package.json` with new view declaration
- `src/extension.ts` updated with provider registration

### Phase 2 Test Checklist
- [ ] View ID `chatwizardModelUsage` appears in the chatwizard sidebar container
- [ ] Provider responds to index `upsert`/`remove`/`batch` events and re-sends data
- [ ] `setDateRange` message with valid ISO strings triggers recompute
- [ ] `setDateRange` with `from > to` swaps dates without error
- [ ] `setDateRange` with garbage strings is ignored (no crash)
- [ ] No update is posted when the view is not visible (`view.visible === false`)

---

## Phase 3 — Webview UI

**Goal**: Render the date-range controls, Chart.js bar chart, and summary table inside the sidebar panel.

### Tasks

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 3.1 | Build shell HTML with date-range controls | `src/analytics/modelUsageViewProvider.ts` (`getShellHtml`) | Two `<input type="date">` + preset buttons; fires `setDateRange` |
| 3.2 | Implement Chart.js horizontal bar chart | inline `<script>` in shell HTML | Chart updates on each `update` message; destroys previous chart instance |
| 3.3 | Add summary table below chart | inline HTML | model name, sessions, user requests, % share |
| 3.4 | Apply VS Code theme CSS variables | inline `<style>` | Use `--vscode-*` variables for colors; chart colors via a deterministic palette seeded by model name |

### UI Spec

**Date-range row** (top of panel):
- `<input type="date" id="from">` + `<input type="date" id="to">`
- Preset buttons: `This Month` | `Last 30 Days` | `Last 3 Months` | `All Time`
- Inputs fire `setDateRange` on `change` event via `vscode.postMessage`

**Chart**:
- Chart.js 4 `'bar'` with `indexAxis: 'y'` (horizontal)
- Y-axis: model names; X-axis: user request count
- Tooltip: `{model}: {count} requests ({percentage}%)`
- No legend (model name already on axis label)
- If `models.length === 0`: show "No data for selected range" text, hide chart

**Summary table** (below chart):
| Model | Sessions | User Requests | % Share |
- Rows sorted by user requests desc (same order as `ModelUsageData.models[]`)
- Footer row: **Total** | sum | sum | 100%

**Loading state**: "Loading…" shown between `ready` sent and first `update` received.

### Phase 3 Deliverables
- `getShellHtml()` fully implemented inside `ModelUsageViewProvider`
- Chart renders correctly on first load and updates on date-range change
- Empty-state message shown when no data matches date range

### Phase 3 Test Checklist
- [ ] Shell HTML contains both `<input type="date">` elements pre-populated with default range
- [ ] Preset "This Month" button sets from = 1st of current month, to = today
- [ ] Preset "All Time" button sends min/max possible dates
- [ ] Chart.js script is loaded from CDN (same URL as AnalyticsViewProvider)
- [ ] Old chart instance is destroyed before creating new one (no canvas leak)
- [ ] Empty-state text is shown when `models.length === 0`
- [ ] Table footer shows correct totals
- [ ] `--vscode-foreground`, `--vscode-editor-background` CSS vars are used (no hardcoded colors)

---

## Phase 4 — Integration & End-to-End Validation

**Goal**: Verify the full pipe works together—watcher populates index, provider picks it up, webview renders correctly—and that no regressions were introduced.

### Tasks

| # | Task | File(s) | Notes |
|---|------|---------|-------|
| 4.1 | Write integration test for `ModelUsageViewProvider` message handling | `test/suite/modelUsageViewProvider.test.ts` | Mock `SessionIndex`, verify correct `postMessage` output |
| 4.2 | Verify `package.json` view declaration doesn't break existing sidebar order | manual | Check that existing views still appear |
| 4.3 | Run full test suite; fix any regressions | — | `npm test` must pass |
| 4.4 | Mark Phase 4 complete in this document | `docs/work-plan-user-requests-per-model.md` | |

### Phase 4 Test Checklist
- [ ] `npm test` passes with no failing tests
- [ ] View provider test: `ready` → correct `update` message posted
- [ ] View provider test: index change → debounced refresh fires
- [ ] View provider test: `setDateRange` → `update` message reflects new range
- [ ] Existing `analyticsEngine.test.ts` and `timelineBuilder.test.ts` still pass
- [ ] No TypeScript compile errors (`npm run watch` clean)

---

## Parallel Execution Notes

Phases 1–3 have clear sequential data dependencies, but within each phase the tasks are largely parallelizable:

- **Phase 1**: Tasks 1.1 (types) must precede 1.2 (engine) and 1.3 (tests), but 1.2 and 1.3 can be drafted in parallel once types are agreed.
- **Phase 2**: Tasks 2.1–2.3 can be drafted in parallel; 2.1 depends on types from Phase 1.
- **Phase 3**: All UI tasks (3.1–3.4) are within a single file and best done sequentially; however, the CSS/theming (3.4) can be done independently of chart logic (3.2).
- **Phase 4**: 4.1 (test file) can be drafted during Phase 3; 4.2–4.3 are final validation gates.

---

## Implementation Reference: Key Existing Patterns

| Pattern | Found in |
|---------|----------|
| Shell HTML + ready-handshake | `AnalyticsViewProvider.ts` |
| Debounced index refresh (500ms) | `AnalyticsViewProvider.ts` |
| `view.visible` guard | `AnalyticsViewProvider.ts` |
| Chart.js CDN URL | `analyticsPanel.ts` (copy exact URL) |
| `registerWebviewViewProvider` call site | `extension.ts` (before `startWatcher`) |
| `package.json` view declaration shape | existing `chatwizardAnalytics` entry |
| Date anchor = `updatedAt` | `analyticsEngine.ts`, `timelineBuilder.ts` |

---

## Progress Tracker

| Phase | Status |
|-------|--------|
| Phase 1 — Data Layer | ✅ Complete |
| Phase 2 — View Provider | ✅ Complete |
| Phase 3 — Webview UI | ✅ Complete |
| Phase 4 — Integration & E2E | ✅ Complete |
