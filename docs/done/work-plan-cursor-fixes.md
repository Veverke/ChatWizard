# ChatWizard — Cursor (and Other Non-Copilot/Claude Sources) Fixes

Date: 2026-04-22  
Scope: Four UI/logic gaps that affect Cursor sessions (and, where noted, all other non-Copilot/Claude sources: Cline, Roo Code, Windsurf, Aider) that were discovered while auditing the Antigravity integration.

---

## Background

When adding Antigravity support, four classes of gaps were fixed for Antigravity that reveal the same underlying problem for **Cursor** (and the other IDEs). The original code was written with a Copilot-vs-Claude mental model and never fully generalised across all sources. The fixes below apply the same treatment.

---

## Fix 1 — Analytics per-source sessions counter (correctness bug)

**Files**: `src/analytics/analyticsEngine.ts`, `src/analytics/analyticsPanel.ts`

**Problem**  
The counting loop that tracks `copilotSessions` / `claudeSessions` used a catch-all `else`:

```typescript
if (s.source === 'copilot') { copilotSessions++; } else { claudeSessions++; }
```

This silently bucketed all Cursor, Cline, Roo Code, Windsurf, and Aider sessions into `claudeSessions`. The Antigravity fix replaced this with an explicit `else if (s.source === 'claude')`, which means Cursor sessions are now **uncounted entirely** — a mild regression.

**Fix**  
- Add `cursorSessions`, `clineSessions`, `roocodeSessions`, `windsurfSessions`, `aiderSessions` counters (or replace the per-source counters with a generic `Record<SessionSource, number>` breakdown).
- Add the corresponding summary cards in the analytics panel.
- Remove the catch-all to make uncovered sources a visible compile-time gap.

**Impact**: High — data shown in the Analytics tab is incorrect for these sources.

---

## Fix 2 — Timeline source filter dropdown

**File**: `src/timeline/timelineViewProvider.ts`

**Problem**  
The `<select id="srcFilter">` only lists `All / Copilot / Claude / Antigravity`. Users cannot filter the timeline to Cursor-only (or Cline, Roo Code, Windsurf, Aider) sessions from that control.

**Fix**  
Add the remaining sources to the dropdown:

```html
<option value="cursor">Cursor</option>
<option value="cline">Cline</option>
<option value="roocode">Roo Code</option>
<option value="windsurf">Windsurf</option>
<option value="aider">Aider</option>
```

Note: `SRC_LABEL` already has entries for all sources, so no JS changes are needed beyond the `<option>` additions.

**Impact**: Medium — functional filter gap in the Timeline tab for affected sources.

---

## Fix 3 — Search panel quick-filter cycle

**File**: `src/search/searchPanel.ts`

**Problem**  
The toolbar source-filter button cycles `All → Copilot → Claude → Antigravity → All`. There is no way to quick-filter the search panel to Cursor (or Cline, Roo Code, Windsurf, Aider) sessions via that control.

**Options (choose one)**

**Option A — Expand the cycle** to include all sources, e.g.:  
`All → Copilot → Claude → Antigravity → Cursor → Cline → Roo Code → Windsurf → Aider → All`  
Simple, but the cycle becomes long.

**Option B — Replace the cycle button with a QuickPick dropdown**, matching the pattern already used in the session tree filter command in `extension.ts`. Cleaner UX; scales to any number of sources without code changes.

**Impact**: Low-Medium — usability gap; power users who rely on the cycle button cannot reach those sources.

---

## Fix 4 — Source badge styling (CSS theme)

**Files**: `src/webview/cwTheme.ts`, `src/timeline/timelineViewProvider.ts`

**Problem**  
Only `--cw-copilot`, `--cw-claude`, and `--cw-antigravity` CSS variables exist. The `renderEntryHtml` badge class selector in the timeline is:

```javascript
const badgeClass = entry.source === 'copilot' ? 'cw-badge-copilot'
                 : entry.source === 'antigravity' ? 'cw-badge-antigravity'
                 : 'cw-badge-claude';
```

Cursor, Cline, Roo Code, Windsurf, and Aider sessions all render with the `cw-badge-claude` purple badge.

**Fix**  
- Add CSS variables and badge classes for each remaining source. Suggested brand colours:
  | Source   | Dark mode        | Light mode       | Rationale                  |
  |----------|------------------|------------------|----------------------------|
  | `cursor` | `#6DB33F`        | `#3d8b00`        | Cursor's green accent       |
  | `cline`  | `#e5a82e`        | `#b07800`        | Cline's amber branding      |
  | `roocode`| `#2eaae5`        | `#0078b0`        | Roo Code's blue accent      |
  | `windsurf`| `#5ecec8`       | `#007b75`        | Windsurf's teal accent      |
  | `aider`  | `#c0c0c0`        | `#606060`        | Aider CLI neutral           |
- Expand the `badgeClass` selector in `timelineViewProvider.ts` to cover each source.

**Impact**: Low — cosmetic only, but important for visual differentiation in the timeline.

---

## Priority Order

| # | Fix | Impact | Effort | Recommended order |
|---|-----|--------|--------|-------------------|
| 1 | Analytics counter correctness | High | Low–Medium | First (correctness bug) |
| 2 | Timeline source filter | Medium | Low | Second |
| 4 | Badge styling | Low | Low | Third (can batch with Fix 2) |
| 3 | Search panel cycle | Low–Medium | Low (Option A) / Medium (Option B) | Last |
