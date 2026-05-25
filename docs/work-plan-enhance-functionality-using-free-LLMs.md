# ChatWizard — Enhance Functionality Using Free LLMs

_Created: May 2026_

---

## Overview

ChatWizard is deliberately privacy-first and 100% local by design. Its search, classification, and analysis features are built entirely on hand-crafted heuristics (regex patterns, TF-IDF, inverted-index scoring) and a locally-run bi-encoder model (`all-MiniLM-L6-v2`). This is correct for the core experience. However, several planned and implemented features rely on heuristics in areas where natural language understanding is genuinely necessary — and heuristics are brittle by nature.

The premise of this work plan: even a free, limited LLM (e.g. a non-premium-request model via the VS Code LM API, or GPT-4o mini class) should outperform hand-crafted heuristics on tasks that fundamentally require natural language comprehension. ChatWizard already uses `vscode.lm.selectChatModels()` in Tier 2 of session title normalization — this work plan identifies where the same approach should be extended, and where it should not.

---

## 1. Scope: What "Free LLM" Means Here

The primary integration point is the **VS Code LM API** (`vscode.lm.selectChatModels()`). This API uses the user's existing GitHub Copilot subscription. Not all models on this API consume "premium requests" — lower-capability, faster models (GPT-4o mini class and below) are available at no additional cost beyond the base Copilot subscription. This means:

- No additional API key required
- Data stays within Copilot infrastructure (which the user already trusts)
- Some models impose minimal per-call cost to the user

External free LLM APIs (OpenAI free tier, Gemini API free tier) are a secondary option but introduce new privacy trade-offs and require users to obtain and manage API keys — incompatible with ChatWizard's zero-setup philosophy. They are noted where relevant but not recommended as the primary path.

---

## 2. Honest Limitations of Free LLMs in This Context

Before the feature analysis, a frank assessment of where free LLMs fall short:

| Limitation | Impact |
|---|---|
| **Rate limits** | Free/non-premium models are throttled. Bulk operations (classifying 3,000 sessions) must be designed with batching, backoff, and graceful degradation to heuristics. Cannot assume all sessions will be processed promptly. |
| **Requires network** | Breaks ChatWizard's "fully offline" guarantee. Any LLM-enhanced feature must still work at reduced quality without connectivity. |
| **Latency (1–5 seconds per call)** | Unacceptable for real-time interactive features. LLM calls must be background/batch operations, never in the hot path of a user interaction. |
| **Context window limits** | Free models typically have smaller context windows. Raw session content can reach 50K+ tokens; summaries or excerpts must be used instead. |
| **Non-determinism** | LLM outputs vary across calls. Cached results in sidecar metadata are essential to avoid index drift on re-runs. |
| **Privacy** | Even via VS Code LM API, session content is sent to an external server. Users with sensitive codebases (financial, healthcare, defence) may need to opt out per-feature. A one-time consent dialog is required before any session content is transmitted. |
| **Quality ceiling of free models** | Smaller/free models underperform on complex reasoning tasks. For nuanced classification or multi-step extraction, the gap vs. premium models is significant. The heuristic baseline must remain available as a fallback. |
| **Availability uncertainty** | Free API tiers have changed pricing/availability before. Code against the VS Code LM API abstraction, not a specific model name. |

**The key design invariant that must be preserved:** Every LLM-enhanced feature must degrade gracefully to the existing heuristic implementation when the LLM is unavailable (no network, rate-limited, model not found, VS Code LM API disabled). The LLM is an enhancement layer, not a hard dependency.

---

## 3. Feature Analysis

Features are organized into three tiers by the strength of the LLM benefit: **High**, **Moderate**, and **Low / Not Recommended**.

---

### Tier A — High Benefit (LLM meaningfully outperforms existing heuristic)

---

#### A1. KB Entry Classification
**Status:** Planned (P3, #23 in `whats-next.md`)  
**Current heuristic approach:**  
`kbEntryClassifier.ts` (planned) uses regex/keyword pattern matching to classify sessions into five types: Decision, Learning, Pattern/Reference, Gotcha/Fix, Architecture Note. Detection signals are literal keyword lists: `"should I"`, `"X vs Y"`, `"explain"`, `"not working"`, `"design"`.

**Where the heuristic fails:**  
- Users rarely phrase questions so cleanly. A question like "I've been going back and forth on whether to keep the auth logic in the middleware or extract it" is a Decision — no keyword matches.  
- Overlap is common: debugging sessions often contain architectural decisions buried in the conversation.  
- Non-English prompts are ignored entirely.  
- Confidence scores derived from regex hit counts are statistically meaningless.

**LLM benefit:**  
Classification of natural-language text into a small fixed set of categories is a core LLM strength. A well-prompted free model handles paraphrasing, mixed-type sessions, and borderline cases far better than any regex-based approach. Expected accuracy improvement: from ~50–60% (regex on realistic prompts) to ~85–90%.

**Risks and mitigations:**  
- Rate limits: Process in background batches of 10–20 sessions; respect backoff signals; cache classification results in sidecar metadata so re-runs skip already-classified sessions.  
- Privacy: Use the session's first N user turns (not the full conversation), capped at ~1,000 tokens.  
- Quality ceiling: Free/small models occasionally miscategorize ambiguous sessions. The confidence score from the LLM response (e.g. via logit bias or a structured JSON response) should gate whether the classification is stored or left as null for manual review.

**Recommendation:** Build `kbEntryClassifier.ts` with LLM as the primary backend and regex as the fallback. The regex patterns already designed in the work plan become the offline/rate-limited fallback, not the primary path.

**Effort delta vs. regex-only plan:** +1–2 days for LLM integration, batching, and consent/fallback logic.

---

#### A2. Entity Extraction from Sessions
**Status:** Planned (P2, #19 in `whats-next.md`)  
**Current heuristic approach:**  
No implementation specified. The work plan describes extracting: file paths, function/class names, error messages/codes, and decisions ("I decided to…"). The implied approach would be regex-based.

**Where the heuristic fails:**  
Regex can reliably extract explicit file paths (`src/auth.ts`) and formatted error codes (`TypeError: Cannot read property…`), but it cannot extract:
- Function/class names mentioned in passing ("the `handleLogin` function has an issue") without file context
- Decisions phrased conversationally ("In the end we went with event sourcing because it fit the audit trail requirement better")
- Implicit file references ("the middleware file we were editing")
- Partial or paraphrased error messages

**LLM benefit:**  
Named-entity recognition and information extraction are foundational LLM tasks. A free model prompted to extract structured entities (files, functions, errors, decisions) from a conversation excerpt will outperform any regex-based approach by a large margin. This is the single largest gap between ChatWizard's planned heuristic and what is achievable.

**Risks and mitigations:**  
- Bulk extraction: Background batch job; cache all extracted entities in sidecar metadata; incremental (only new/changed sessions).  
- Context limit: Use first/last N user turns + assistant responses; avoid pasting entire long sessions.  
- Privacy: Entity extraction reads session content — requires opt-in consent.  
- Hallucination: LLMs can invent plausible-sounding file paths that don't exist. The "file path" entity type should be cross-referenced against the workspace file tree where possible; unverifiable entities should be marked as `inferred`.

**Recommendation:** Design the entity extractor (`src/entities/entityExtractor.ts`) with LLM as the primary backend from the start, rather than adding it later. The regex-only fallback would be limited to explicit path patterns and formatted error codes only.

**Effort delta:** Building with LLM is comparable in effort to a comprehensive regex approach but produces dramatically better results.

---

#### A3. Workspace Digest / Standup Report Generation
**Status:** Planned (P3, #26 in `whats-next.md`)  
**Current heuristic approach:**  
Not yet implemented. A template-based approach would concatenate session titles or Chronicle `work_done` summaries into a list — readable but machine-textured.

**Where the heuristic falls short:**  
Template assembly cannot produce natural standup language. "Worked on: Docker setup, React hooks, auth middleware refactor" is not a standup update. A good standup update connects items, explains progression, and uses natural past tense: "Finished the Docker configuration for the dev environment, worked through some React hooks issues with the form validation, and started refactoring the auth middleware to support refresh tokens."

**LLM benefit:**  
Summarizing a short list of session titles/summaries into natural-language narrative is exactly what LLMs do well — and it requires only a small amount of input text (session titles, Chronicle `work_done` summaries), staying well within free-model context windows. The privacy exposure is low: session titles and Chronicle summaries are already high-level.

**Risks and mitigations:**  
- This is a user-triggered command, not an automatic background operation. Latency (2–5 seconds for a standup) is acceptable.  
- Rate limits are not a concern at one-call-per-day usage frequency.  
- Privacy: Use session titles and Chronicle `work_done` excerpts as input, not raw session content. This is the minimal-exposure path.  
- Offline: Fall back to the structured list format when LLM is unavailable.

**Recommendation:** Design this feature with LLM generation from the start. There is no reasonable heuristic alternative that produces comparable output quality. The template-based fallback is adequate for offline use but should not be the primary path.

**Effort delta:** LLM integration replaces the template-assembly logic entirely; net effort is similar.

---

#### A4. Action Item / Outcome Extraction
**Status:** Planned (P3, #34 in `whats-next.md`)  
**Current heuristic approach:**  
Not yet implemented. A regex approach would match patterns like `"TODO"`, `"need to"`, `"should"`, `"will implement"`.

**Where the heuristic fails:**  
The distinction between an actual commitment ("I'll refactor this tomorrow") and an exploratory suggestion the model made ("you could also try X") requires understanding conversational role and agency — not just keyword presence. Regex approaches produce high false-positive rates on exploratory model suggestions mistaken for user commitments.

**LLM benefit:**  
Good at distinguishing genuine user commitments from model suggestions, at extracting action items phrased in non-standard ways, and at capturing the semantic content of an action item rather than just flagging its presence. Also handles "implicit" action items: "The tests are still red for the auth module" implies an action item even with no explicit commitment language.

**Risks and mitigations:**  
- On-demand only (triggered when user opens a session or explicitly requests extraction), not bulk automatic processing.  
- Cache in sidecar metadata.  
- Privacy: Reads session content; opt-in consent required.  
- Offline: Degrade gracefully to regex-based extraction (acknowledging higher false-positive rate).

**Recommendation:** Build with LLM as primary. Regex fallback for offline use, but label results from fallback as lower-confidence.

---

#### A5. Session Linking / Continuity Detection
**Status:** Planned (P3, #31, #33 in `whats-next.md`)  
**Current heuristic approach:**  
Embedding cosine similarity (the existing bi-encoder) is the planned approach for detecting related sessions. Explicit session linking is manual (user-driven right-click action).

**Where the heuristic falls short (for automated suggestions only):**  
The bi-encoder flags sessions as related when they share lexical/semantic content, but cannot distinguish between:
- Two sessions about "React state management" as unrelated independent questions  
- Two sessions about "React state management" as one continuous task interrupted by a session close (the meaningful "continuation" relationship)

Temporal proximity (same day, same workspace) combined with semantic similarity is a better signal, but it still produces false positives that a free LLM — given both session titles and a few turns of context — can rule out.

**LLM benefit:**  
Moderate and targeted: use LLM only as a validation step on high-similarity pairs identified by the bi-encoder (cosine > 0.80). Ask the LLM: "Do these two sessions appear to be working on the same task or problem?" The binary yes/no answer improves precision without needing to run LLM on all session pairs.

**Risks and mitigations:**  
- O(n²) problem: only apply to pairs already flagged by bi-encoder, not all pairs.  
- Run as a background job over the session corpus; cache results.  
- Privacy: Send only session titles and first/last turn excerpts, not full sessions.

**Recommendation:** Implement as a post-filter on bi-encoder results. The bi-encoder remains the primary detection mechanism; the LLM validation step reduces false positives for the automatic "related sessions" suggestion UI.

**Effort delta:** +1 day for the validation layer and caching logic.

---

### Tier B — Moderate Benefit (LLM helps, but existing approach is reasonable)

---

#### B1. Session Title Normalization — Extending Tier 2 Coverage
**Status:** Implemented/Planned (P1, #8 in `whats-next.md`; `titleEngine.ts` planned)  
**Current approach:**  
Three tiers: (1) Chronicle `checkpoints.overview` — free, no LLM; (2) VS Code LM API — already uses LLM; (3) TF-IDF / embedding clustering — offline heuristic fallback.

**Assessment:**  
Tier 2 already covers the LLM use case for Copilot sessions and non-Copilot sessions when online. The gap is Tier 3: users in offline or air-gapped environments get poor-quality TF-IDF titles. A free external LLM API could serve as an intermediate "Tier 2.5" for the small percentage of users who use non-Copilot sources and are occasionally offline.

**Recommendation:** The existing three-tier design is well-considered. The LLM opportunity here is already captured in Tier 2. A hypothetical Tier 2.5 using a free external API introduces API key management and privacy trade-offs that outweigh the marginal improvement in an already-covered scenario. **No change recommended.** The only actionable improvement is extending Tier 2 to non-Copilot sessions more aggressively (it is already available for all sessions via `vscode.lm.selectChatModels()`).

---

#### B2. `chatwizard_get_context` Result Reranking
**Status:** Planned (P2, #21 in `whats-next.md`)  
**Current heuristic approach:**  
Position-based merge of full-text and semantic search results. Rank disagreements between engines are resolved arbitrarily.

**Assessment:**  
A free LLM API call for reranking (asking the model "which of these sessions is most relevant to the query?") would work but adds 1–3 seconds of latency to every `get_context` call. This is unacceptable in agentic chains where `chatwizard_get_context` may be called multiple times per agent session.

The right solution for reranking is a **local cross-encoder ONNX model** (`ms-marco-MiniLM-L-6-v2`, ~30 MB, 50–200 ms per rerank pass). This is already described in `work-plan-mcp-server-phase-II.md`. A local cross-encoder outperforms a free API call on latency, privacy, and availability — the only cost is VSIX weight and a native build artifact.

**Recommendation:** Use a local cross-encoder ONNX model for reranking, not a free LLM API call. The latency and availability trade-offs of a remote API are inappropriate for this hot path. **Free LLM not recommended here.**

---

#### B3. Post-Session Cost Tips Pattern Detection
**Status:** Planned (P3, #37 in `whats-next.md`)  
**Current approach:**  
Heuristic pattern matching on session content (detected pasted file content, open-ended phrases, unbounded agent runs).

**Assessment:**  
The heuristics described in `work-plan-cost-effective-prompts.md` are competent at flagging explicit patterns ("this prompt contains > N tokens" or "prompt contains 'explain everything'"). A free LLM would add marginal value — it could better identify "this session had poor cost efficiency because the user was having the model re-derive context it already had" — but this is a nuanced post-hoc analysis that even the LLM would struggle with on local session data alone.

More importantly, the value proposition of this feature is specifically that it requires zero LLM calls. Using an LLM to deliver cost-saving tips undermines the message.

**Recommendation:** Keep this feature LLM-free as designed. **Not a LLM candidate.**

---

#### B4. Prompt Verbosity / Scope Analysis
**Status:** Planned (P2, #20 in `whats-next.md`)  
**Current approach:**  
Regex patterns on draft prompt text: detect `"list all possible"`, `"explain everything"`, multi-question detection via `?` count + conjunctions.

**Assessment:**  
The core design constraint of this feature is explicit: "Using an LLM to evaluate a draft prompt before sending is self-defeating — you spend tokens to save tokens." This constraint should be respected. The heuristics handle the most impactful cases (explicitly open-ended phrasing, pasted file content, multi-question bundling).

A free LLM could detect more subtle scope issues ("fix this" without context is vague), but the delta between the heuristic and LLM accuracy on this task does not justify breaking the zero-LLM constraint that is the feature's headline value.

**Recommendation:** Keep this feature LLM-free as designed. **Not a LLM candidate.**

---

### Tier C — Low Benefit / Not Recommended

These are features where the existing heuristic approach is adequate, where a local model is already in use, or where the LLM trade-offs clearly outweigh the benefits:

| Feature | Reason LLM is not recommended |
|---|---|
| **Full-text search ranking** | Already augmented by local bi-encoder semantic search. The combination already covers most gaps. |
| **Mermaid diagram intent detection** (#7) | Keyword heuristic achieves ~80%+ accuracy on this binary classification. An LLM call for a simple if/else gate adds latency, rate-limit exposure, and complexity with minimal precision gain. |
| **Session archive deduplication** | Determined by session ID and file path — a data integrity check, not a language understanding problem. |
| **Workspace scope detection** | Path-matching logic; no natural language involved. |
| **Token counting for analytics** | A local tokenizer (tiktoken-compatible) is the correct tool; LLMs would add overhead. |

---

## 4. Implementation Strategy

### 4.1 LLM Service Layer

Create a shared `src/llm/llmService.ts` module that:

- Wraps `vscode.lm.selectChatModels()` with model preference: non-premium models first, falling back to the best available
- Implements a **rate-limit-aware request queue**: when the VS Code LM API returns a rate-limit signal, the queue backs off exponentially and processes remaining items at reduced pace
- Returns a `LlmUnavailableError` when no model is available (no network, quota exhausted, Copilot not authenticated), allowing all callers to fall through to the heuristic backend
- Enforces a **per-call token budget** (input content capped at ~800 tokens by default; configurable) to prevent long sessions from consuming disproportionate quota
- Logs call counts and backoff events to the local telemetry recorder (existing telemetry system)

```typescript
interface LlmServiceOptions {
    maxInputTokens?: number;   // default 800
    preferNonPremium?: boolean; // default true
    timeout?: number;           // default 8000 ms
}

interface LlmResult<T> {
    value: T;
    source: 'llm' | 'heuristic';   // always set so callers know which backend answered
}
```

The `source` field on every result is important: UI surfaces that display LLM-generated content (classifications, extracted entities, standup text) should indicate when the heuristic fallback was used instead, so users understand the quality level.

### 4.2 One-Time Consent Dialog

The first time any feature would transmit session content to the VS Code LM API, show a modal confirmation:

> "This feature sends excerpts from your AI chat history to GitHub Copilot's model API to improve accuracy. Content is processed via your existing Copilot subscription and subject to [GitHub's privacy policy]. This is the same service used when you ask @chatwizard in the chat panel. Proceed?"
>
> [Allow for this session] [Always allow] [Never — use local analysis only]

The "Never" choice globally disables LLM-enhanced features, falling back to all heuristics. This setting persists to `globalState`. Features that operate on session titles/Chronicle summaries (not raw turns) should not require this consent — they are low-exposure.

### 4.3 Sidecar Metadata Caching

All LLM-generated outputs must be cached in `chatwizard-metadata.json` (sidecar metadata store, Phase 0 prerequisite):

```typescript
// Fields to add to SessionMetadata
entityCache?: {
    extractedAt: string;       // ISO timestamp
    files: string[];
    functions: string[];
    errors: string[];
    decisions: string[];
    source: 'llm' | 'regex';   // which backend produced this
};

kbClassification?: {
    classifiedAt: string;
    type: KBEntryType | null;
    confidence: number;
    source: 'llm' | 'regex';
};

actionItems?: {
    extractedAt: string;
    items: Array<{ text: string; source: 'llm' | 'regex' }>;
};
```

Cached results are used on subsequent loads; the LLM is only called again when session content changes (new messages parsed) or the user explicitly requests re-analysis.

### 4.4 Background Batch Processing

All bulk LLM operations (entity extraction on index startup, KB classification sweep) run in a low-priority background queue:

- Process N sessions per batch (default 5), pause between batches
- Lowest-priority scheduling (after initial index build, after search engines initialize)
- Progress surfaced via `vscode.window.withProgress` only when user-triggered
- Auto-paused when VS Code window is not focused (to avoid consuming quota while the user is away)

### 4.5 Feature Flags

All LLM-enhanced features should be individually controllable via VS Code settings:

```json
"chatwizard.llm.enableEntityExtraction": { "default": true }
"chatwizard.llm.enableKbClassification": { "default": true }
"chatwizard.llm.enableStandupGeneration": { "default": true }
"chatwizard.llm.enableActionItemExtraction": { "default": true }
"chatwizard.llm.enableSessionLinkingValidation": { "default": false }
```

`enableSessionLinkingValidation` defaults to `false` because it is the most aggressive (pairwise comparison of many sessions) and most likely to trigger rate limits.

---

## 5. Priority Order

| # | Feature | Tier | Effort | Dependency |
|---|---|---|---|---|
| 1 | **LLM Service Layer** (shared infrastructure) | — | S | None — prerequisite for all below |
| 2 | **KB Entry Classification** (A1) | High | S | LLM service + sidecar metadata Phase 0 |
| 3 | **Entity Extraction** (A2) | High | M | LLM service + sidecar metadata Phase 0 |
| 4 | **Standup Report Generation** (A3) | High | S | LLM service; Chronicle Phase 1 data preferred |
| 5 | **Action Item Extraction** (A4) | High | S | LLM service + sidecar metadata Phase 0 |
| 6 | **Session Linking Validation** (A5) | Moderate | M | LLM service; bi-encoder results as input |

---

## 6. What This Does Not Change

The following architectural commitments remain untouched:

- **ChatWizard never makes any network calls on its own.** All network activity is via `vscode.lm.selectChatModels()` through the user's Copilot subscription. No direct calls to OpenAI, Anthropic, or Google APIs are added.
- **The extension works fully without LLM availability.** Every enhanced feature falls back to the existing heuristic or a degraded-but-functional equivalent.
- **No new API keys.** The VS Code LM API requires only the user's existing Copilot authentication.
- **No raw session content sent to external systems without consent.** The one-time consent dialog is required before any content transmission.
- **The local bi-encoder (`all-MiniLM-L6-v2`) remains the primary semantic search engine.** It is not replaced by an API call — it runs entirely offline and is the correct tool for latency-sensitive similarity search.
