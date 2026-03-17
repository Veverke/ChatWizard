# ChatWizard — UIX Work Plan (Pre-Launch)

Date: 2026-03-16
Scope: UX/UI refinements proposed before going live, derived from the current product review.

## Prioritization Method

- Impact scale: Very High, High, Medium
- Complexity scale: Low, Medium
- Classification:
  - Must-Ship: should land before public launch
  - Should-Ship: high-value, can land in first post-launch patch if needed
  - Nice-to-Have: valuable polish for later iterations

## Recommendation Matrix (Sorted by Impact, then Complexity)

| # | Initiative | Impact | Complexity | Classification | Why it matters |
|---|---|---|---|---|---|
| 1 | Remove/remap global `Ctrl+Shift+H` shortcut conflict | Very High | Low | Must-Ship | Avoids conflict with native VS Code Replace in Files and immediate user confusion. |
| 2 | First-run empty states + quick-start CTAs in panels | Very High | Low | Must-Ship | Prevents “blank means broken” on first use and improves activation-to-value. |
| 3 | Keyboard and accessibility semantics in webviews | High | Medium | Must-Ship | Improves usability for keyboard-only users and reduces accessibility risk at launch. |
| 4 | Click-through analytics (rows/charts open sessions/filters) | High | Medium | Should-Ship | Converts passive dashboard into actionable workflow and improves retention. |
| 5 | Persist panel-local search/filter/sort state | High | Medium | Should-Ship | Supports long research workflows and reduces repeated setup friction. |
| 6 | Index freshness/status indicators | High | Medium | Should-Ship | Builds trust that results are current and reduces uncertainty during live updates. |
| 7 | Session Reader toolbar hierarchy cleanup | Medium | Low | Nice-to-Have | Reduces visual competition and improves scanability in dense reader header. |
| 8 | Timeline month-oriented jump control UX | Medium | Low | Nice-to-Have | Aligns control with mental model (month navigation) and reduces interaction friction. |
| 9 | In-panel token estimate microcopy in Analytics | Medium | Low | Nice-to-Have | Prevents misinterpretation of estimated token counts as billing-accurate numbers. |
| 10 | Unified cross-panel Copilot/Claude source identity | Medium | Low | Nice-to-Have | Improves wayfinding and visual consistency across all major surfaces. |

## Release Buckets

## Must-Ship (Before Launch)

### 1) Keybinding Conflict Removal
- Target: update contributed keybindings to avoid overriding Replace in Files by default.
- Suggested action:
  - Remove default keybinding for `chatwizard.search`, or
  - Move to a safer default and document it in README.
- Primary file:
  - `package.json`
- Acceptance criteria:
  - Triggering native Replace in Files works as expected with defaults.
  - ChatWizard search remains discoverable via command palette and view actions.

### 2) Empty-State Guided Onboarding
- Target: add explicit empty/loading/next-step states in webviews and list panels.
- Suggested action:
  - Add clear empty-state copy with two actions:
    - Configure data paths
    - Trigger rescan/reload workflow
- Primary files:
  - `src/analytics/analyticsPanel.ts`
  - `src/prompts/promptLibraryPanel.ts`
  - `src/codeblocks/codeBlocksPanel.ts`
  - `src/timeline/timelineViewProvider.ts`
- Acceptance criteria:
  - New users with zero indexed sessions see actionable guidance in every panel.
  - No panel appears blank without explanation.

### 3) Accessibility and Keyboard Navigation
- Target: ensure interactive UI elements in webviews are reachable and operable without mouse.
- Suggested action:
  - Add semantic roles/labels for click targets.
  - Add Enter/Space activation parity.
  - Add visible focus styles.
- Primary files:
  - `src/timeline/timelineViewProvider.ts`
  - `src/codeblocks/codeBlocksPanel.ts`
  - `src/prompts/promptLibraryPanel.ts`
  - `src/views/sessionWebviewPanel.ts`
- Acceptance criteria:
  - All core actions are keyboard-operable.
  - Focus indicators are visible and consistent.
  - Basic screen-reader labels exist for non-text controls.

## Should-Ship (Launch Patch Window)

### 4) Click-Through Analytics
- Target: let users open sessions/filtered views directly from analytics tables/charts.
- Primary file:
  - `src/analytics/analyticsPanel.ts`
- Acceptance criteria:
  - Clicking a longest-session row opens that session.
  - Clicking project metrics navigates to corresponding filtered session context.

### 5) Persist UI State by Panel
- Target: preserve user context (search/filter/sort) between panel reopen/reload.
- Primary files:
  - `src/analytics/analyticsPanel.ts`
  - `src/timeline/timelineViewProvider.ts`
  - `src/prompts/promptLibraryPanel.ts`
  - `src/codeblocks/codeBlocksPanel.ts`
- Acceptance criteria:
  - Last query/filter values restore after panel reopen.
  - User does not need to repeatedly reconfigure the same view.

### 6) Index Freshness and Progress Feedback
- Target: expose indexing recency and in-progress status to users.
- Suggested action:
  - Add “Last updated” and “Indexed N sessions” indicators.
  - Show temporary reindexing message during refresh bursts.
- Candidate files:
  - `src/views/sessionTreeProvider.ts`
  - `src/analytics/analyticsPanel.ts`
  - `src/timeline/timelineViewProvider.ts`
- Acceptance criteria:
  - Users can tell if data is current.
  - Refresh/reindex periods are visible and understandable.

## Nice-to-Have (Post-Launch Polish)

### 7) Session Reader Toolbar Hierarchy
- Target: emphasize search flow and de-emphasize secondary actions.
- Primary file:
  - `src/views/sessionWebviewPanel.ts`

### 8) Timeline Jump Control Alignment
- Target: month-oriented jump UX (YYYY-MM) instead of day-first interaction.
- Primary file:
  - `src/timeline/timelineViewProvider.ts`

### 9) Token Estimate Microcopy
- Target: add brief explanatory text in analytics where token numbers are shown.
- Primary file:
  - `src/analytics/analyticsPanel.ts`

### 10) Source Identity Consistency
- Target: normalize Copilot/Claude badges and visual source cues across all panels.
- Primary files:
  - `src/webview/cwTheme.ts`
  - `src/analytics/analyticsPanel.ts`
  - `src/timeline/timelineViewProvider.ts`
  - `src/codeblocks/codeBlocksPanel.ts`
  - `src/prompts/promptLibraryPanel.ts`

## Suggested Delivery Order

1. Must-Ship items (1 to 3)
2. Should-Ship items (4 to 6)
3. Nice-to-Have items (7 to 10)

## Estimation Snapshot

- Must-Ship bundle: ~3 to 6 dev days
- Should-Ship bundle: ~4 to 7 dev days
- Nice-to-Have bundle: ~2 to 4 dev days

(Assumes one contributor familiar with current webview architecture and existing command wiring.)

## Notes

- Keep launch scope focused on trust, discoverability, and accessibility.
- Favor low-risk incremental UI updates over deep architectural changes in this phase.
