# Work Plan: Test Infrastructure Hardening

**Status:** Active  
**Priority:** High — fast-paced feature development requires automated quality gates that
surface bugs at development time, before manual acceptance testing. Current target: AT
starts with ≥95% passing rate.

---

## Background

Two failure modes were identified through analysis of the current test suite and post-mortem
on bugs that only surfaced during manual acceptance testing:

**Failure mode A — Missing protective layers.**  
The test pyramid has unit tests and e2e integration tests, but no coverage gating, no
TypeScript strict mode, no contract tests, no property-based tests, and the existing smoke
scripts are not wired into CI.

**Failure mode B — Semantically shallow e2e tests.**  
Existing integration tests technically exercise code paths but assert structural properties
("result count ≥ 1", "snippet is non-empty") rather than semantic ones ("the correct session
ranks first", "an off-topic session does not appear"). Fixtures are 2-turn toy conversations
designed to make tests green, not to reflect real-world user queries. Bugs in ranking,
relevance, passage quality, and cross-source disambiguation are invisible to these tests.

---

## Part 1 — Missing Protective Layers

### INFRA-1 — TypeScript strict mode

**Why:** Several documented bugs (`filePath undefined`, `undefined IDs` crashing `.filter()`,
`buildSourcesMarkdown` rendering `"undefined"`) are type-level errors that `strictNullChecks`
catches at compile time — before any test runs.

**Tasks:**
- [ ] Enable `"strict": true` in `tsconfig.json`
- [ ] Fix all resulting type errors (treat them as the bugs they are, not noise)
- [ ] Add `tsc --noEmit --strict` as a dedicated CI step that runs before unit tests
- [ ] Confirm no `// @ts-ignore` suppressions are introduced to silence errors

**Effort:** S  
**Complexity:** Medium (type errors surface real latent bugs)

---

### INFRA-2 — Code coverage gating

**Why:** The project has 55+ test files but `work-plan-missing-testing-layers.md` documents
15+ `❌ None` coverage gaps in critical paths. Without a gate, gaps silently accumulate.
Coverage measurement forces gaps to be visible and blocks regression.

**Tasks:**
- [ ] Add `c8` as a dev dependency (`npm install --save-dev c8`)
- [ ] Add `test:coverage` script: `c8 --reporter=lcov --reporter=text vscode-test`
- [ ] Add `c8 --reporter=lcov --reporter=text --branches 70` threshold to CI
- [ ] Add HTML coverage report as a CI artifact for PR review
- [ ] Incrementally raise the branch threshold as gaps from `work-plan-missing-testing-layers.md`
      are filled

**Effort:** XS  
**Complexity:** Low

---

### INFRA-3 — Contract / snapshot tests for MCP prompts

**Why:** The sentinel phrase mismatch bug (`contextPrompts.ts` ↔ `chatParticipant.ts`) is a
string contract. If either side drifts, the LLM receives wrong routing instructions silently.
Snapshot tests lock the rendered prompt shape and sentinel strings in a single assertion.

**Tasks:**
- [ ] Add snapshot assertions for every `build*Prompt` / `render()` method in
      `contextPrompts.ts` — lock the full rendered output, not just presence of a field
- [ ] Add a dedicated sentinel-string contract test: extract the sentinel phrase from the
      prompt renderer and assert it appears verbatim in the handler's detection logic
- [ ] Add snapshot test for the stream order contract: sources block must appear **before**
      the LLM answer section in the rendered output
- [ ] Re-run and update snapshots intentionally on legitimate prompt changes (not silently)

**Effort:** S  
**Complexity:** Low

---

### INFRA-4 — Property-based testing for parsers

**Why:** 10+ parsers (aider, claude, cursor, cline, windsurf, roocode…) each have
hand-picked fixture files. Property-based tests generate hundreds of random inputs per run
and are exceptionally effective at finding edge cases in parsers — malformed JSON, missing
fields, empty arrays, unexpected encodings, truncated files.

**Tasks:**
- [ ] Add `fast-check` as a dev dependency (`npm install --save-dev fast-check`)
- [ ] Add property tests for each parser covering:
  - Random valid inputs (must not throw, must return a session with `source` set)
  - Malformed JSON lines (must return errors array, must not crash)
  - Empty file (must return empty session, not throw)
  - Missing required fields (must degrade gracefully)
- [ ] Add property tests for path resolution utilities (`configPaths.ts`):
  - Percent-encoded paths (`%3A`, `%20`) must decode correctly
  - Windows and POSIX path separators handled uniformly
- [ ] Add property tests for session count logic (byte map accumulation, duplicate ID dedup)

**Effort:** M  
**Complexity:** Medium

---

### INFRA-5 — Smoke scripts wired into CI

**Why:** `scripts/smoke-test-mcp-server.mjs`, `smoke-test-phase3.mjs`, and
`smoke-test-phase4.mjs` already exist and provide MCP-level sanity checks without needing
VS Code Electron. They are not currently run in `ci.yml`.

**Tasks:**
- [ ] Add a `smoke` step to `ci.yml` between unit tests and integration tests:
  ```yaml
  - name: Smoke tests (MCP)
    run: node scripts/smoke-test-mcp-server.mjs && node scripts/smoke-test-phase4.mjs
  ```
- [ ] Ensure all smoke scripts exit non-zero on failure (add explicit `process.exit(1)`)
- [ ] Add `smoke-test-phase3.mjs` to the step once confirmed green
- [ ] Document the expected output format in each smoke script header

**Effort:** XS  
**Complexity:** Low

---

### INFRA-6 — Mutation testing (Stryker)

**Why:** Mutation testing reveals tests that pass even when the code is broken — i.e., tests
that assert the wrong invariant. Particularly valuable on session counting logic (byte map
accumulation, duplicate ID dedup) and stream ordering where the logic is subtle.

**Tasks:**
- [ ] Add Stryker (`@stryker-mutator/core`, `@stryker-mutator/mocha-runner`) as dev deps
- [ ] Configure `stryker.conf.json` targeting the highest-risk modules first:
  `src/commands/manageWorkspaces.ts`, `src/index/sessionIndex.ts`,
  `src/mcp/chatParticipant.ts`, `src/mcp/prompts/contextPrompts.ts`
- [ ] Set minimum mutation score threshold of 60% for targeted modules
- [ ] Run weekly (not on every commit) — add as a scheduled CI job
- [ ] Fix any tests that are revealed to be asserting the wrong invariant

**Effort:** M  
**Complexity:** Medium

---

### INFRA-7 — Runtime schema validation on parser output (Zod)

**Why:** Parsers consume JSON/JSONL from AI tool databases (SQLite `.vscdb`, `.jsonl`).
Schema drift between tool versions is silent and produces wrong session counts, missing
fields, or crashes in downstream consumers. A `z.parse()` at the reader boundary turns
silent failures into loud, traceable errors at development time.

**Tasks:**
- [ ] Add `zod` as a dependency
- [ ] Define Zod schemas for all parser output types: `CopilotSession`, `ClaudeSession`,
      `CursorSession`, `ClineTask`, `WindsurfSession`, `AiderHistory`
- [ ] Apply `z.safeParse()` at the boundary in each reader; log schema violations with
      the field name and actual value
- [ ] Add unit tests asserting that schema violations produce a structured error, not a crash
- [ ] Apply the same pattern to MCP tool input validation in `mcpContracts.ts`

**Effort:** M  
**Complexity:** Medium

---

### INFRA-8 — CI pipeline order enforcement

**Why:** Currently compile, lint, unit tests, and integration tests run in sequence but
without the fast-fail ordering that maximises developer feedback speed.

**Tasks:**
- [ ] Enforce this step order in `ci.yml`:
  1. `compile + lint`
  2. `tsc --noEmit --strict` (strict typecheck)
  3. Unit tests + coverage gate (`c8`)
  4. Smoke scripts (MCP, phase3, phase4)
  5. Integration tests (VS Code Electron via `xvfb-run`)
- [ ] Each step depends on the previous — fail fast, don't run Electron tests on a broken build
- [ ] Add step-level timing annotations so slow steps are visible in CI history

**Effort:** XS  
**Complexity:** Low

---

## Part 2 — Semantic Depth of E2E / Integration Tests

### INFRA-9 — Semantic fixture corpus (foundational)

**Why:** This is the root cause of semantically shallow tests. Every current fixture was
written at the same time as its test to make the test green. Fixtures are 2-turn toy
conversations ("center a div in CSS", "binary search in TypeScript") with single topics,
obvious keywords, and zero vocabulary overlap between sessions.

Real ChatWizard users run queries like `ECONNREFUSED 5432`, `database migration`,
`slow query optimization`, `microservices vs monolith` — queries drawn directly from the
examples in `user-guide.md`. The fixtures must simulate the sessions those queries would find.

The corpus must have three properties:
1. **Realistic length** — 5–10 turns per session (real conversations meander)
2. **Shared vocabulary with different sub-topics** — so disambiguation can be tested
3. **Multi-source** — the same topic discussed in Copilot AND Claude (tests cross-source merge)

**Fixture set to create** (`test/fixtures/semantic/`):

| File | Content | Key vocabulary |
|------|---------|----------------|
| `auth-debugging-copilot.jsonl` | JWT token expiry causes 401, debugging steps, middleware fix | `jwt`, `401`, `token expiry`, `middleware`, `handleAuthError` |
| `auth-debugging-claude.jsonl` | Same project, same day, user asks Claude about the same auth issue | `jwt`, `bearer token`, `unauthorized`, `auth handler` |
| `db-migration-copilot.jsonl` | Prisma migration fails on production, rollback strategy | `migration`, `prisma migrate`, `rollback`, `schema drift` |
| `db-migration-cline.jsonl` | Same migration topic continued in Cline the next day | `migration`, `ALTER TABLE`, `down migration` |
| `postgres-perf-copilot.jsonl` | Slow query, EXPLAIN ANALYZE, missing index on foreign key | `slow query`, `EXPLAIN ANALYZE`, `N+1`, `missing index`, `ECONNREFUSED 5432` |
| `microservices-design-claude.jsonl` | Architecture discussion: monolith vs. microservices tradeoffs | `microservices`, `monolith`, `decided to`, `tradeoffs`, `event sourcing` |
| `css-animation-cursor.jsonl` | CSS transition not working, `overflow:hidden` clipping issue | `transition`, `overflow hidden`, `CSS animation`, `display none` |
| `unrelated-ui-copilot.jsonl` | Completely unrelated: React component state reset | `useState`, `useEffect`, `component unmount` — no auth/DB/CSS terms |

Crucially: sessions share vocabulary intentionally. `auth-debugging-*.jsonl` both mention
"jwt" and "token". `db-migration-*.jsonl` both mention "migration". The tests verify
disambiguation — that the right session ranks first and off-topic ones don't appear.

**Tasks:**
- [ ] Create `test/fixtures/semantic/` directory
- [ ] Write all 8 fixture JSONL files in the correct parser format for their source tool
- [ ] Write a `test/helpers/semanticCorpus.ts` helper that loads and indexes the full corpus
      into both `SessionIndex` and `FullTextSearchEngine` in one call
- [ ] Document each fixture's intended vocabulary and disambiguation purpose in a comment header

**Effort:** M  
**Complexity:** Low (authoring, not engineering)

---

### INFRA-10 — Ranking and exclusion assertions

**Why:** Current assertions verify presence (`sessionIds.includes(id)`) but not rank or
precision. A buggy relevance algorithm that returns every session in arbitrary order passes
all current tests.

**Pattern to adopt:**

```ts
// Ranking — best match must be first
assert.strictEqual(results[0].sessionId, authCopilotId,
    'JWT auth session should rank first for "handleAuthError" query');

// Exclusion — wrong session must be absent
const ids = results.map(r => r.sessionId);
assert.ok(!ids.includes(cssAnimationId),
    'CSS animation session must not appear in an auth query');
assert.ok(!ids.includes(unrelatedUiId),
    'React state session must not appear in a DB migration query');

// Score gap — top result must be meaningfully better than second
assert.ok(results[0].score > results[1].score * 1.3,
    'top result should outscore second result by a meaningful margin');
```

**Tasks:**
- [ ] Audit every `assert.ok(results.length >= 1)` in integration tests — replace with a
      ranked assertion against the semantic corpus
- [ ] Audit every `sessionIds.includes(id)` — add a corresponding exclusion assertion for
      at least one off-topic session
- [ ] Add score-gap assertions to the top 5 most critical search scenarios
- [ ] Add cross-source ranking test: same topic in Copilot + Claude should both appear in
      results when querying that topic

**Effort:** S  
**Complexity:** Low (pattern is mechanical once corpus exists)

---

### INFRA-11 — Snippet quality assertions

**Why:** Current assertion: `hit.snippet && hit.snippet.length > 0`. This passes for a
snippet containing a completely unrelated sentence. The snippet must contain vocabulary
relevant to the query.

**Tasks:**
- [ ] Replace all `snippet.length > 0` assertions with domain term checks:
  ```ts
  assert.ok(
      hit.snippet.toLowerCase().includes('jwt') || hit.snippet.toLowerCase().includes('auth'),
      `snippet "${hit.snippet}" should contain auth-domain vocabulary`
  );
  ```
- [ ] Add a snippet-source check: confirm the snippet comes from the correct role
      (`You:` vs `Copilot:`) based on the query type (prompt search vs response search)
- [ ] Add minimum snippet length assertion (e.g. ≥ 20 chars) to prevent empty-but-truthy edge cases

**Effort:** XS  
**Complexity:** Low

---

### INFRA-12 — Golden query tests for the MCP tools

**Why:** `chatwizard_search` and `chatwizard_get_context` are the primary user-facing
surfaces. Test 45b (`assert.ok(typeof text === 'string')`) is effectively a no-op assertion.
Golden-query tests define fixed (query → expected passage content) pairs derived from the
documented user-guide examples — they are the automated equivalent of manual acceptance tests.

**Golden query set (to be implemented against semantic corpus):**

| Query | Expected top session | Excluded sessions |
|-------|---------------------|-------------------|
| `handleAuthError JWT 401` | `auth-debugging-copilot` | `css-animation-cursor`, `unrelated-ui-copilot` |
| `database migration rollback` | `db-migration-copilot` or `db-migration-cline` | `postgres-perf-copilot`, `auth-debugging-*` |
| `ECONNREFUSED 5432` | `postgres-perf-copilot` | all others |
| `slow query optimization` | `postgres-perf-copilot` | `microservices-design-claude` |
| `microservices vs monolith` | `microservices-design-claude` | all DB/auth/CSS sessions |
| `CSS transition not working` | `css-animation-cursor` | all auth/DB sessions |

**Tasks:**
- [ ] Create `test/e2e/integration/goldenQueries.test.ts`
- [ ] For each row in the table above, write a test that:
  1. Indexes the full semantic corpus
  2. Executes the query against `FullTextSearchEngine` and `GetContextTool`
  3. Asserts the expected session ranks first
  4. Asserts at least two excluded sessions are absent from results
- [ ] Add a passage-content assertion for each `GetContextTool` golden test:
  the returned passage must contain at least one domain term from the expected session
- [ ] Run golden query tests as part of the standard integration test suite in CI

**Effort:** S  
**Complexity:** Low

---

### INFRA-13 — Semantic search vocabulary-gap tests

**Why:** Semantic search is designed for "when you remember the concept but not the exact
wording" (`user-guide.md`). This is impossible to test with current fixtures that only
contain the exact keyword being searched. Semantic fixtures must have deliberate vocabulary
gaps between query and session content.

**Vocabulary-gap pairs to test (query has zero lexical overlap with session content):**

| Query | Session content | Expected match |
|-------|-----------------|----------------|
| `slow query optimization` | Session says `SELECT N+1 problem`, `missing index on foreign key` | `postgres-perf-copilot` |
| `CSS layout not rendering correctly` | Session says `overflow: hidden was clipping the animated element` | `css-animation-cursor` |
| `how do I avoid re-running work I already did with AI` | Session says `chatwizard_get_context`, `query your session history` | (meta fixture) |

**Tasks:**
- [ ] Ensure semantic fixture content uses synonyms and paraphrases, not the query keywords
- [ ] Create `test/e2e/integration/semanticVocabGap.test.ts`
- [ ] For each vocabulary-gap pair, assert the correct session appears in top 3 semantic results
- [ ] Assert that full-text search on the same query returns zero results (confirming the
      gap is real and semantic is doing genuine work)

**Effort:** S  
**Complexity:** Medium (requires semantic index to be meaningful)

---

### INFRA-14 — Chat participant command scenario tests

**Why:** `/queryHistory`, `/continueFromHistory`, and `/troubleshootFromHistory` are the
highest-value user-facing surfaces. Their current tests use stub tools and don't verify
that the right session content reaches the LLM prompt. Scenario tests simulate full
command invocations against the semantic corpus.

**Scenarios to cover:**

| Command | Scenario | Assert |
|---------|----------|--------|
| `/queryHistory` | "What did I decide about error handling in my auth service?" | Passage from `auth-debugging-copilot` appears in constructed prompt; `css-animation-cursor` passage does not |
| `/continueFromHistory` | "Continue from the database migration work" | Most recent `db-migration-*` session content appears; prompt includes `next_steps` or final exchange |
| `/queryHistory` | No matching sessions | Sentinel "no relevant sessions found" triggers; LLM is not called |
| `/queryHistory --general` | General guidance query | `--general` flag routed to general branch; general prompt template used, not session-grounded one |
| `/troubleshootFromHistory` | "ECONNREFUSED 5432" error | `postgres-perf-copilot` session appears in prompt passage |

**Tasks:**
- [ ] Add these five scenarios to `test/e2e/mcp/chatParticipant.test.ts`
- [ ] Use the semantic corpus fixtures for data (not the current toy copilot fixtures)
- [ ] Assert passage content (not just call count) for each scenario
- [ ] Assert excluded sessions are absent from the constructed prompt
- [ ] Add the `--general` flag routing test (currently `❌ None` per `work-plan-missing-testing-layers.md`)

**Effort:** M  
**Complexity:** Medium

---

---

## Part 3 — Shallow Unit Tests and Flaky Tests

### INFRA-15 — Shallow UT assertion audit

**Why:** The same problem identified in integration tests exists in unit tests. Searching
the test suite reveals a class of bare assertions that verify the weakest possible property:

```ts
assert.ok(root.length > 0);                        // passes for any non-empty string
assert.ok(allBlocks.length >= 1, '...');            // verifies count, not content
assert.ok(result.errors.length > 0, '...');         // correct direction, wrong specificity
assert.ok(result.session.messages.length === 1);    // no assertion on what the message says
```

These pass even when the code returns the wrong type, the wrong item, or the wrong field
value — as long as *something* is returned. Mutation testing (INFRA-6) will surface these
mechanically, but a targeted audit is faster and more surgical.

**Shallow assertion patterns to find and fix:**

| Shallow pattern | Replacement |
|-----------------|-------------|
| `assert.ok(arr.length >= 1)` | `assert.strictEqual(arr.length, N)` or assert on `arr[0].specificField` |
| `assert.ok(str.length > 0)` | `assert.ok(str.includes(expectedSubstring))` |
| `assert.ok(errors.length > 0)` | `assert.ok(errors[0].includes('expected error keyword'))` |
| `assert.ok(obj)` | `assert.strictEqual(obj.field, expectedValue)` |
| `assert.ok(session.messages.length === 1)` | `assert.strictEqual(session.messages[0].role, 'user')` + content check |

**Tasks:**
- [ ] Run a grep audit across all `test/e2e/**/*.ts` for `assert.ok(.*\.length` and
      `assert.ok(.*> 0)` — triage each one as "adequate" or "shallow"
- [ ] For each shallow assertion, strengthen it to assert the specific value, field, or
      content expected — not just the presence or non-zero count
- [ ] Pay particular attention to parser tests (`aiderParser`, `antigravityParser`,
      `clineParser`, `copilotParser`) — verify code block `language`, `content` substring,
      and `role`, not just array length
- [ ] For `errors.length > 0` assertions: add a second assertion on the error text to
      confirm the right error is being raised for the right reason
- [ ] INFRA-6 (Stryker) will surface remaining shallow assertions automatically — treat
      surviving mutants as a prompt to strengthen the assertion, not to fix the mutant

**Effort:** S  
**Complexity:** Low (mechanical audit, high signal)

---

### INFRA-16 — Flaky test detection and remediation

**Why:** Flaky tests are actively harmful: they erode trust in the CI signal, cause
developers to re-run jobs instead of investigating failures, and mask real regressions.
The current test suite has concrete flakiness candidates already visible.

**Known flakiness candidates (found by code inspection):**

| File | Issue | Risk |
|------|-------|------|
| `analyticsCache.test.ts` | `setTimeout` calls inside test bodies to simulate async invalidation | High — race condition on loaded CI |
| `analyticsCache.test.ts` | `assert.ok(elapsed < 500, ...)` wall-clock performance assertion | High — fails on slow GitHub Actions runners |
| `messageRenderer.test.ts` | `Date.now()` timing assertions | Medium |
| `asyncFileDiscovery.test.ts` | `Date.now()` elapsed timing check | Medium |
| `embeddingEngine.test.ts` | `this.timeout(120_000)` downloading 22 MB model on first run | Medium — network-dependent |
| `invertedIndexRemoval.test.ts` | `this.timeout(30_000)` with no structural completion guarantee | Low–Medium |

**Detection mechanism:**

Mocha has no built-in flaky detection. The pragmatic approach for this stack:

```jsonc
// package.json — add a repeat script
"test:flaky": "for /L %i in (1,1,5) do npm test 2>&1 >> flaky-run-%i.txt"
```

Or, more usefully, use `mocha --reporter json` to capture structured results and diff
across runs with a small script (`scripts/detect-flaky.mjs`):

```
Run 1: 312 passing, 0 failing
Run 2: 311 passing, 1 failing  ← "analyticsCache — completes in < 500ms" is the flaky one
Run 3: 312 passing, 0 failing
```

Any test that changes pass/fail status across identical runs without a code change is flaky.

**Fix patterns by cause:**

| Cause | Fix |
|-------|-----|
| `setTimeout` in test body | Replace with event-driven pattern or explicit `Promise` resolved by the code under test |
| Wall-clock `< N ms` assertion | Remove from unit tests entirely — move to a separate `test:perf` suite with a very loose threshold (10× the expected time) and run only manually or weekly |
| Network download in test | Gate behind `CHATWIZARD_SLOW_TESTS=1` env var; skip by default in CI |
| Temp path collision | Use `crypto.randomUUID()` instead of `Date.now()` for uniqueness |

**Tasks:**
- [ ] Create `scripts/detect-flaky.mjs` — runs `npm test` N times (default 5), captures
      JSON reporter output, diffs the passing/failing sets, prints a flaky test report
- [ ] Add `test:flaky` script to `package.json`: `node scripts/detect-flaky.mjs`
- [ ] Run `test:flaky` against the current suite and catalogue all flaky tests found
- [ ] Fix `analyticsCache.test.ts` timing tests: remove wall-clock assertions; test the
      logical invalidation behaviour (version bump, recompute flag) without timing
- [ ] Fix `analyticsCache.test.ts` `setTimeout` usages: replace with synchronous
      invalidation triggers or awaited promises
- [ ] Move all `elapsed < N ms` performance assertions into a dedicated
      `test:perf` script that is not part of the default CI run
- [ ] Gate `embeddingEngine.test.ts` (model download) behind `CHATWIZARD_SLOW_TESTS=1`
- [ ] Add `--retries 0` to the `vscode-test` invocation in CI to make flakiness
      immediately visible rather than silently retried

**Effort:** S  
**Complexity:** Medium (diagnosis is easy; some fixes require restructuring async test logic)

---

## Summary Table

| ID | Area | Type | Effort | Priority |
|----|------|------|--------|----------|
| INFRA-1 | TypeScript strict mode | Compiler gate | S | P0 — do first |
| INFRA-2 | Code coverage gating (c8) | CI gate | XS | P0 — do first |
| INFRA-3 | Contract/snapshot tests for MCP prompts | Unit tests | S | P1 |
| INFRA-5 | Smoke scripts wired into CI | CI step | XS | P1 |
| INFRA-9 | Semantic fixture corpus | Test data | M | P1 — blocks INFRA-10..14 |
| INFRA-10 | Ranking and exclusion assertions | Test pattern | S | P1 — after INFRA-9 |
| INFRA-11 | Snippet quality assertions | Test pattern | XS | P1 — after INFRA-9 |
| INFRA-12 | Golden query tests | Integration tests | S | P1 — after INFRA-9 |
| INFRA-15 | Shallow UT assertion audit | Test quality | S | P1 — independent |
| INFRA-16 | Flaky test detection and remediation | Test reliability | S | P1 — independent |
| INFRA-4 | Property-based testing (fast-check) | Unit tests | M | P2 |
| INFRA-6 | Mutation testing (Stryker) | Quality gate | M | P2 |
| INFRA-7 | Zod schema validation | Runtime guard | M | P2 |
| INFRA-8 | CI pipeline order enforcement | CI config | XS | P2 |
| INFRA-13 | Semantic vocabulary-gap tests | Integration tests | S | P2 — after INFRA-9 |
| INFRA-14 | Chat participant scenario tests | Integration tests | M | P2 |

**Critical path:** INFRA-1 → INFRA-2 → INFRA-9 → INFRA-10/11/12 in parallel → INFRA-14  
**Independent parallel tracks:** INFRA-15 and INFRA-16 can start immediately alongside any other work
