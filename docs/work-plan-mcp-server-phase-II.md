# ChatWizard — MCP Server Phase II Work Plan

_Created: May 2026_

---

## Overview

This document captures the deferred open questions from the Phase I MCP Server work plan that are candidates for a follow-up iteration. Questions 3 (Continue.dev/Cursor config format verification) and 5 (token rotation UX) were resolved and implemented as part of the initial Phase I wrap-up.

The three items below represent deliberate trade-off decisions made at launch: each was deferred not because it is unimportant but because the cost/benefit ratio favoured shipping the core feature first and collecting real usage data before committing to heavier engineering.

---

## Item 1 — Reranker Pass for `chatwizard_get_context`

**Original question:** Should `chatwizard_get_context` use a reranker pass after the semantic + keyword merge?

### Background

`GetContextTool` merges results from `FindSimilarTool` (bi-encoder semantic search) and `SearchTool` (full-text keyword search), deduplicates by session ID, and returns the top N passages. The current ranking is determined by the order in which results come back from each engine rather than by a unified relevance score.

A **reranker** (cross-encoder) scores each candidate against the original query a second time. Cross-encoders process both query and candidate together, making them significantly more precise than bi-encoders — but also ~10–100× slower per candidate.

### Pros

- Meaningfully better top-result quality — the single most important result is more likely to be genuinely the most relevant, which directly improves agent behaviour when it relies on the first-returned passage
- Eliminates the ambiguity of bi-encoder + keyword rank disagreement: currently, if semantic search ranks a session #2 and keyword search ranks it #1, the merged order is arbitrary; a reranker resolves this with a principled score
- The benefit compounds as the index grows — with hundreds of sessions, the bi-encoder retrieval net is cast wide but imprecise; a reranker tightens it

### Cons

- Requires a cross-encoder model (e.g. `ms-marco-MiniLM-L-6-v2`) — another native dependency: additional VSIX weight (~30–80 MB depending on quantisation), per-platform build, maintenance surface
- Adds 50–200 ms of latency per `get_context` call; in an agentic chain this cost is paid on every invocation
- Architecturally complex relative to current inference: the existing pipeline is pure vector similarity; a cross-encoder requires a separate ONNX/transformers inference path
- The benefit is most visible at scale; users with tens of sessions likely won't notice a difference

### Trade-off

The latency cost is constant and paid by every user on every agent call. The quality benefit scales with index size and query ambiguity — it is currently unproven for this workload. The right trigger for building this is a concrete signal from users that `get_context` result ordering is causing bad agent outputs, not a preemptive bet.

**Recommended trigger:** If post-launch feedback or telemetry shows that agents consistently pick up irrelevant sessions via `get_context` while more relevant ones exist in the index, revisit.

### Work Required

| Work item | Estimate |
|---|---|
| Evaluate and select cross-encoder model (size, latency, accuracy) | 0.5 day |
| Add ONNX inference path for cross-encoder (separate from existing bi-encoder) | 2 days |
| Per-platform build + CI integration | 1 day |
| Wire into `GetContextTool` behind a config flag | 0.5 day |
| Tests + latency benchmarks | 1 day |
| **Total** | **~5 days** |

---

## Item 2 — Auth-protect the `/mcp-config` Endpoint

**Original question:** Should the `/mcp-config` HTTP endpoint be protected by auth?

### Background

`/mcp-config` is currently accessible without a bearer token. It returns a JSON snippet containing the server `url`, the `Authorization` header name, and the available endpoints — but **not the token value itself**. The rationale for leaving it unprotected was to allow `curl http://localhost:6789/mcp-config` to work before the user has a token, avoiding a chicken-and-egg situation during initial setup.

### Pros of protecting it

- Defence-in-depth: a malicious local process scanning ports discovers nothing about the server's capabilities or endpoint structure without the token
- Consistency: all server-information endpoints follow the same access model, making it easier to reason about the auth boundary
- Small but non-zero information leak is eliminated (endpoint paths are technically enumerable without auth)

### Pros of leaving it unprotected (status quo)

- Zero friction for the "getting started" path: users can `curl` it to understand the connection parameters before they have set up their tool config
- The actual threat it would protect against is extremely narrow: a process that can scan localhost ports but cannot read files in VS Code's `globalStorageUri`. In practice, any process that can do the former can almost certainly do the latter
- The token is already in a local file; knowing the endpoint structure gives an attacker nothing without the token

### Trade-off

The security gain is marginal given the localhost-only binding and the narrow threat model. The status quo is the correct pragmatic choice for a developer tool. This is a low-priority hardening exercise, not a security necessity.

**Recommended trigger:** If a security audit identifies localhost endpoint enumeration as an explicit risk vector for this use case, add auth in a single-line change.

### Work Required

| Work item | Estimate |
|---|---|
| Add auth check to `/mcp-config` handler in `McpServer` | 15 min |
| Update `McpServer` tests to cover authenticated `/mcp-config` | 30 min |
| Update onboarding copy (the unauthenticated curl example breaks) | 30 min |
| **Total** | **~1 hour** |

---

## Item 3 — Strip Code Blocks from Tool Results (`includeCode` Flag)

**Original question:** Should session content in tool results strip code blocks for brevity? An `includeCode: boolean` input param on `GetContextTool` could make it opt-in.

### Background

Sessions from coding assistants are often dominated by large code blocks. When a session is retrieved as agent context, those code tokens are expensive (token cost is proportional to length) and can crowd out the prose where decisions, rationale, and error messages actually live. Stripping fenced code blocks and long inline code spans before returning content could reduce token usage by 50–80% on code-heavy sessions.

### Pros

- Meaningful token cost reduction for users on pay-per-token plans — potentially 50–80% on code-heavy sessions
- Keeps context focused on the prose content that agents use for reasoning
- Implementation is simple: a regex strip of fenced code blocks plus inline code above a length threshold

### Cons

- Code is sometimes the only useful part of a session — a session about "how did I implement X" where the answer is a code block becomes useless if code is stripped
- Silent omission: an agent calling `get_context` without code will not know code was stripped; it may confabulate an implementation rather than retrieving it
- Adds schema complexity: every tool that surfaces session content needs a new parameter, its own default decision, and new test coverage
- The `maxChars` truncation on `GetSessionTool` (default 4 000 chars) already handles the worst-case runaway sessions; the incremental value of code-stripping on top of that is unclear

### Trade-off

The correct default matters more than the option's existence. If `includeCode` defaults to `false`, agents that genuinely need code (the common case in a coding assistant history) get degraded context. If it defaults to `true`, no one uses the `false` path. This is a premature optimisation until there is evidence that token cost from code blocks is a real pain point for real users.

**Recommended trigger:** User feedback indicating token cost as a specific pain point, ideally with concrete examples of overly code-heavy context crowding out the prose the agent needed.

### Work Required

| Work item | Estimate |
|---|---|
| Implement code-stripping utility (regex, configurable threshold) | 2 hours |
| Add `includeCode` param to `GetContextTool`, `GetSessionTool`, `GetSessionFullTool` | 2 hours |
| Decide and document the right defaults | 1 hour |
| Test coverage for strip/no-strip paths across 3 tools | 3 hours |
| **Total** | **~1 day** |

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |

---

## Summary Table

| Item | Effort | Priority | Recommended trigger |
|---|---|---|---|
| 1 — Reranker for `get_context` | ~5 days | Low | User/telemetry signal that result ordering causes bad agent outputs |
| 2 — Auth on `/mcp-config` | ~1 hour | Very low | Formal security audit identifies this as a risk vector |
| 3 — `includeCode` flag | ~1 day | Low | User feedback citing token cost from code-heavy sessions |
