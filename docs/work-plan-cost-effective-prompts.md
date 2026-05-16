# Work Plan — Prompt Cost Control & Cost-Effective Prompt Guidance

_Created: May 2026_

---

## Context

GitHub Copilot is transitioning from a premium-request monthly allowance model to **pay-per-token consumption**. For individual developers and companies with multiple AI coding seats, uncontrolled prompt habits translate directly into a larger monthly bill.

ChatWizard is uniquely positioned to address this: it already holds historical token data for every session across every developer, and its local bi-encoder enables similarity lookups with zero network cost. This work plan covers two complementary deliverables:

1. **In-product guidance**: surfacing the rules of thumb that actually reduce cost (short prompts, file references, output constraints)
2. **Pre-send analysis**: a local, zero-LLM mechanism that scores a draft prompt and nudges the user before they send it

---

## What Makes a Prompt Cost-Effective

The following principles are grounded in how token-based billing works for models like Sonnet 4.6 (output tokens ≈ 5× the cost of input tokens; cached tokens ≈ 10× cheaper than normal input tokens).

### Rule 1 — Short, Precise Prompts

Vague prompts produce longer answers. Longer answers mean expensive output tokens and higher variance in cost.

| Pattern | Example |
|---|---|
| ✅ Better | "Review this function for bugs. Only list concrete issues." |
| ❌ Worse | "Analyze this code thoroughly and explain everything in detail." |

### Rule 2 — Reference Files Instead of Pasting

When you paste file content into a prompt, those tokens are charged every turn with no reuse. When you reference a repo file by path, the model loads it once as a **cached context token** that is reused cheaply across turns.

| Method | Token behaviour | Cost |
|---|---|---|
| Paste file contents into prompt | Input tokens charged every turn | ❌ Expensive |
| `"Read src/auth.ts and update login.ts"` | Cached context tokens | ✅ Cheap |
| Re-referencing same file across turns | Cache hits | ✅ Very cheap |

> **Important nuance:** the file tokens are not free — they are just much cheaper. First reference has a small cost; subsequent turns have minimal incremental cost.

### Rule 3 — Explicitly Restrict Output to Only What's Relevant

Output tokens are the most expensive part. Without an explicit constraint, the model optimises for completeness, not brevity — it will restate code, explain context you already know, and add unsolicited commentary.

**Effective output-limiting phrases:**

```
For code changes:
  "Output only the diff."
  "Return only the modified functions."
  "Do not repeat unchanged code."

For reviews:
  "List only concrete issues, no explanations."
  "Bullet points only, max 5 items."
  "Ignore style and formatting issues."

For explanations:
  "Answer in one paragraph."
  "Explain only the root cause, not background."
  "Assume I already know the codebase."

For agent workflows:
  "After completing the task, stop and wait."
  "Do not summarize unless I ask."
```

### Rule 4 — Reuse Context Across Turns

Once a file is loaded as context, keep it in scope rather than re-loading it. End or reset agent sessions when the task is complete — agent mode accumulates history every turn, and unbounded context growth is a hidden cost multiplier.

### Rule 5 — Match Model to Task

Large, capable models are expensive. Many tasks (planning, one-liner refactors, format conversions) can be handled by smaller models at 10–20% of the cost.

**Best-practice prompt template:**

```
Context:
- Files: src/auth.ts, src/login.ts

Task:
- Fix null validation bug in login

Constraints:
- Minimal changes
- Output ONLY the diff
- No explanations
```

### What Does NOT Save Tokens

- Asking Copilot to "re-explain" a file already in context
- Repeatedly requesting summaries of prior output
- Long conversational back-and-forth before the actual task
- Letting agent mode accumulate history indefinitely
- Using "explain everything", "list all possibilities", "write a complete implementation of" without scope constraints

---

## The Core Design Constraint: Zero-LLM Analysis

Using an LLM to evaluate a draft prompt before sending is self-defeating — you spend tokens to save tokens. Every analysis signal described below is achievable with **zero LLM calls**, using only local computation on data ChatWizard already holds.

---

## Analysis Signals (All Local, No Network)

| Signal | Method | Example nudge |
|---|---|---|
| **Token estimate** | Local tokenizer (tiktoken-style, ~50 KB, no network) counts tokens in the draft prompt; model price schedule gives an exact cost estimate | *"~2,400 tokens · est. $0.07 at current Sonnet rate"* |
| **Cache hit suggestion** | Local bi-encoder (already in ChatWizard) checks similarity against session history | *"You asked something very similar on 3 Apr and got a useful answer. Review before sending?"* |
| **Verbosity pattern** | Regex heuristics on the draft | *"Prompt contains an entire file — consider pasting only the relevant function"* |
| **Multi-question bundling** | Detect multiple `?` separated by conjunctions | *"This looks like 3 separate questions — splitting them usually produces shorter, more focused responses"* |
| **Open-ended scope** | Match phrases like "list all possible", "explain everything", "write a complete implementation of" | *"Open-ended scope tends to generate very long responses — consider narrowing the ask"* |
| **Model selection** | Heuristics on prompt length + code presence | *"This looks like a one-liner refactor — a smaller model would handle it at ~10% of the cost"* |
| **Historical cost correlation** | From existing session index: prompts with a code block > N lines historically generated 4× more response tokens for this user | *"Prompts with large code blocks in your history average 3,800 response tokens"* |

---

## Interception Architecture

ChatWizard currently reads session files after they are written — it has no native pre-send hook. Three practical interception points, in order of implementation effort:

### Option A — `@chatwizard analyze` Chat Participant (Lowest friction for individual)

User types their draft prompt, invokes `@chatwizard /analyzePrompt` (or a keyboard shortcut) before sending. ChatWizard scores the draft and responds inline in the chat panel with cost estimate and improvement suggestions. One extra step; fits natively into VS Code chat.

### Option B — "Analyze Prompt" Command on Selection

User writes prompt in the editor, runs a command on the selection, receives a notification with cost estimate and suggestions. No chat panel dependency; works anywhere the user writes prompts.

### Option C — Corporate Agent Pre-Send Hook (Strongest for company deployment)

The company deploys `@acme-assistant` via Agent apps. Every prompt passes through it. The agent calls ChatWizard's MCP tools (similarity check, historical cost lookup — all local, no LLM) and either warns or proceeds transparently. Zero extra developer friction once deployed.

This is the most powerful option: when the company agent _is_ the interception point, cost governance is enforced centrally without asking developers to change their habits.

---

## In-Product Guidance Surface

Beyond pre-send analysis, ChatWizard can passively surface cost-effective prompt guidance:

- **Post-session tip**: after a session closes, if the estimated token cost exceeded a threshold, show a one-line tip relevant to the detected pattern (e.g. "This session used a large pasted file — referencing it by path would reduce future cost")
- **Prompt library annotations**: tag prompt templates with an estimated cost tier (low / medium / high output) so users can choose accordingly
- **Analytics view**: extend the existing token analytics with a "cost efficiency" dimension — average output tokens per input token per prompt type

---

## Implementation Phases

### Phase 1 — Token Estimator + Basic Heuristics (3–5 days)

- Integrate a local tokenizer (tiktoken-compatible, no network dependency)
- Implement verbosity, open-ended scope, and multi-question heuristics
- Expose as `@chatwizard /analyzePrompt` chat participant command
- Show token count + estimated cost + flagged patterns inline

**Acceptance criteria:**
- Token count is accurate to ±5% for GPT-4o and Sonnet-class prompts
- At least verbosity, open-ended scope, and multi-question signals fire correctly on test inputs
- No LLM calls made during analysis

### Phase 2 — Cache Hit & Historical Cost Signals (3–4 days)

- Wire the existing bi-encoder into the analyzer for similarity check against session history
- Query the session index for the user's historical output-token-per-prompt-type ratios
- Add model selection heuristic based on prompt length and code presence
- Surface results alongside Phase 1 output

**Acceptance criteria:**
- Similarity check returns a match (with session title and date) when a near-duplicate prompt exists in history
- Historical correlation signal shows correct average for the detected prompt type
- All signals still zero LLM calls

### Phase 3 — "Analyze Prompt" Editor Command (2–3 days)

- Add VS Code command "ChatWizard: Analyze Selected Prompt"
- Reuses Phase 1–2 analysis engine
- Displays results as a VS Code notification or inline decoration (configurable)
- Optional: keybinding support

### Phase 4 — Post-Session Tips & Analytics Integration (2–3 days)

- Detect high-cost session patterns on session close
- Surface one actionable tip as a VS Code notification (dismissible, with "don't show again")
- Add "cost efficiency" column to the existing Analytics view

### Phase 5 — Corporate Agent Pre-Send Hook (future / corporate tier)

- Document the `.agent.md` pattern for a corporate pre-send agent
- Expose analysis signals as MCP tools so any agent can call them
- Ensure all signals remain local and produce no LLM calls

---

## Out of Scope

- Modifying how Copilot sends prompts (no API access to intercept)
- Cloud-side caching optimisation (outside ChatWizard's control)
- Automatic prompt rewriting (would require an LLM call, defeating the purpose)

---

## Related Documents

- [whats-next-corporate.md](whats-next-corporate.md) — Feature 7: Prompt Cost Control (corporate context)
- [work-plan-kb-and-tagging.md](work-plan-kb-and-tagging.md) — Session tagging (feeds the prompt type classification)
- [work-plan-mcp-server-phase-II.md](work-plan-mcp-server-phase-II.md) — MCP server Phase II (exposes analysis signals as tools)
