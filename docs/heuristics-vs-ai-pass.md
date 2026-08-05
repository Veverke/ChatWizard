# Heuristics vs AI Pass — Audit & Roadmap

**Feature 19/34 work plan** · Updated 2026-08-05

This document catalogs every ChatWizard feature that either uses an AI (LLM)
path, a pure heuristic fallback, or both. It records the "try AI first → fall
back to heuristic" pattern used across the extension, and identifies which
heuristic-only features are candidates for an AI upgrade.

---

## The canonical pattern

Most "smart" features follow the same two-tier design:

```text
try LLM (Copilot LM API, free) first
  └─ success?  → use the LLM result
  └─ fail/unavailable? → fall back to heuristic
```

The free model chain is `o4-mini` → `gpt-4o-mini`, resolved via
`vscode.lm.selectChatModels({ vendor: 'copilot', ... })`. When the LM API is
unavailable (no Copilot authentication, offline, etc.) the feature degrades
gracefully to the heuristic.

---

## Feature audit

| Feature                    | File(s)                                                       | AI path            | Heuristic fallback            | Category |
|----------------------------|---------------------------------------------------------------|--------------------|-------------------------------|----------|
| **Action Items**           | `actionItemExtractor.ts`, `actionItemLlmExtractor.ts`, `actionItemVerifier.ts` | ✅ LM API + verify | ✅ Phrase matching            | ✅ Good |
| **KB Classification**      | `kbClassifier.ts`, `kbLlmClassifier.ts`                       | ✅ LM API          | ✅ Keyword matching           | ✅ Good |
| **Prompt Consolidation**   | `promptConsolidator.ts`                                       | ✅ LM API          | ✅ Heuristic merge            | ✅ Good |
| **Summary Generation**     | `summaryGenerator.ts`                                         | ✅ Chronicle + LM  | ✅ TF-IDF                     | ✅ Good (3-tier) |
| **Prompt Analysis**        | `promptAnalyzer.ts`                                           | ✅ LM API          | ✅ Verbosity heuristics       | ✅ Good |
| **Prompt Cost Advisor**    | `promptCostAdvisor.ts`                                        | ✅ LM API          | ✅ Heuristic consolidate      | ✅ Good |
| **Entity Extraction**      | `entityExtractor.ts`                                          | 🆕 LM API (added)  | ✅ Regex                      | 🆕 Improved |
| **Work Item Extraction**   | `workItemExtractor.ts`                                        | ❌ None            | ✅ Regex                      | ⚠️ Candidate |
| **Title Normalizer**       | `titleNormalizer.ts`                                          | ❌ None            | ✅ TF-IDF                     | ⚠️ Candidate |
| **Token Estimation**       | `tokenEstimator.ts`                                           | ❌ None            | ✅ Calibrated heuristic       | ⚠️ Candidate |
| **Live Session Tracker**   | `liveSessionTracker.ts`                                       | ❌ None            | ✅ Timestamp heuristics       | ⚠️ Candidate |
| **Path Normalizer**        | `pathNormalizer.ts`                                           | ❌ None            | ✅ Heuristic fallback         | ⚠️ Candidate |

---

## Heuristic-only candidates (no AI path)

These features currently rely purely on heuristics and are ranked by
**expected ROI** of adding an AI pass.

### 1. Entity Extraction — ✅ IMPROVED (highest ROI)
*File: `entityExtractor.ts`*

Regex-based extraction captures file paths, function/class names, error
messages, and decision phrases — but misses **semantic entities**: framework
names, API endpoints, architectural concepts, libraries, and technical jargon
that don't follow a regular pattern.

**Improvement**: Added an LLM pass (`entityLlmExtractor.ts`) that runs first
and extracts richer semantic entities (frameworks, libraries, API endpoints,
protocols, architectural concepts). Falls back to the original regex when the
LM API is unavailable. Bumped `ENTITIES_VERSION` to 2 to invalidate caches.

### 2. Title Normalizer — candidate
*File: `titleNormalizer.ts`* · TF-IDF only

Could benefit from an LLM to generate more human-readable, descriptive titles
from session content. Medium ROI — TF-IDF already produces acceptable titles,
but they can be generic ("Fix bug in login").

### 3. Work Item Extraction — candidate
*File: `workItemExtractor.ts`* · Regex only

JIRA/GitHub/Azure work-item IDs are already well-structured (`ABC-123`,
`#123`, `AB#123`). Low ROI for AI — the regex is reliable and precise.

### 4. Token Estimation — candidate
*File: `tokenEstimator.ts`* · Calibrated heuristic

Already accurate to ±10% (word-count / 4). Low ROI — an LLM pass would be
slower and less consistent than the calibrated formula.

### 5. Live Session Tracker — candidate
*File: `liveSessionTracker.ts`* · Timestamp heuristics

Low ROI — timestamps are deterministic and don't benefit from semantic
analysis.

### 6. Path Normalizer — candidate
*File: `pathNormalizer.ts`* · Heuristic fallback

Low ROI — path handling is a mechanical transformation, not a semantic task.

---

## Recommended next steps

Priorities in order:

1. ✅ **Entity Extraction** — AI pass added (frameworks, APIs, concepts).
2. ⚠️ **Title Normalizer** — evaluate an LLM pass for more descriptive titles.
3. ⚠️ **Work Item / Token / Live Session / Path** — low ROI; leave as-is unless
   a specific user pain point emerges.

---

## Maintenance notes

- Each AI-capable feature degrades to its heuristic when the LM API is
  unavailable — never blocks the user.
- Bump the feature's `*_VERSION` constant whenever extraction logic changes so
  cached sidecar metadata is invalidated and re-extracted.
- The free model chain (`o4-mini` → `gpt-4o-mini`) is shared across all
  features; keep it consistent to avoid duplicated model-selection code.