# ChatWizard — Corporate Edition: Vision & Feature Roadmap

_Created: May 2026_

---

## Context

This document captures the corporate use-case discussion initiated by an enterprise inquiry about adopting ChatWizard for company-wide deployment. It extends [whats-next.md](whats-next.md) with a corporate lens, covering new features, a deployment model, a revenue path, and the impact of the VS Code Insiders Agent apps platform on the picture.

---

## The Core Corporate Proposition

ChatWizard already aggregates AI conversations from all tools into a searchable, analysable corpus. In an individual developer's hands that is a productivity tool. In a company's hands that corpus becomes **institutional memory** — every architectural decision, every debugging session, every prompt refinement that any developer had with any AI tool across the organisation.

Two facts drive the value:

1. Every company paying for AI coding seats (Copilot, Claude, Cursor, etc.) is generating thousands of sessions per year. Today those sessions silently disappear when tools prune their history. That is an asset being discarded.
2. Regulated industries have obligations around what data leaves the perimeter. AI coding tools are a current blindspot for compliance and legal teams.

The two features with the clearest immediate "sell" — and the lowest build cost on top of the existing architecture — are:
- **Team Knowledge Base** (institutional memory, team onboarding, cross-team search)
- **AI Usage Compliance & Audit Trail** (data governance, regulated industries, CISO-level concerns)

Both were the focus of the initial enterprise discussion and are elaborated in detail below.

---

## Feature 1 — Team Knowledge Base & Institutional Memory

### What It Is

A shared, curated layer on top of the per-developer local index. Developers "promote" sessions into a team-visible store. The team store is searchable and readable by all team members and is served via the existing MCP server interface so that AI agents can query it as context.

### Corporate Value

- When a senior engineer leaves, the AI conversations that contained architecture decisions, debugging approaches, and domain knowledge do not leave with them.
- New hires onboarding onto a legacy module can search for past AI sessions related to that codebase and immediately get historical context.
- Teams working on the same feature from different angles can discover each other's relevant prior sessions.

### Key Capabilities

| Capability | Description |
|---|---|
| **Promote to team store** | A command or right-click action on any session to push it to the central hub |
| **Team search** | Full-text + semantic search across the promoted corpus, scoped to team or project |
| **MCP exposure** | The team hub acts as an MCP server; AI agents query team history as context just as they currently query personal history |
| **Redaction before promotion** | Optional automatic redaction pass (strip API keys, PII patterns, internal paths) before a session enters the shared store |
| **Expiry & ownership** | Sessions in the team store carry the promoting developer's identity and an optional expiry date |

### Build Path

Reuses the existing MCP server and session index infrastructure. The new component is a lightweight central hub (self-hosted, see Deployment Model below) that accepts promoted sessions and serves team-level MCP queries. The developer-side VS Code extension gains one new command and a fetch-from-hub source alongside the existing local sources.

---

## Feature 2 — AI Usage Compliance & Audit Trail

### What It Is

A read-only, tamper-evident log of what was sent to AI tools: which model, from which workstation, at what time, within which project. Configurable retention, pattern-based sensitive data detection, and exportable reports.

### Corporate Value

- Regulated industries (finance, healthcare, defence contracting) have data handling obligations that AI tools currently bypass entirely. This feature makes AI tool usage auditable.
- Legal and security teams get a concrete answer to: *"Was sensitive data sent to an external LLM?"*
- The CISO immediately understands the value — this maps directly to existing data loss prevention (DLP) workflows.

### Key Capabilities

| Capability | Description |
|---|---|
| **Sensitive token detection** | Regex/pattern rules run against every session on ingestion: API keys, PII patterns (email, IBAN, SSN formats), internal hostnames, classified project codenames |
| **Per-developer per-model usage reports** | Exportable to CSV/PDF; shows which models each developer used, volume, and dates |
| **Model policy enforcement** | Flag or alert when a developer uses a model not on the company-approved list (e.g. policy: only Copilot and internal Claude, not OpenAI direct) |
| **Immutable audit export** | Signed JSON bundles per sprint or month; tamper-evident for audit submission |
| **Quarantine** | Sessions matching a DLP policy are excluded from the team knowledge base and flagged for review |
| **Alerts** | Configurable notifications to a security inbox or Slack/Teams channel when a high-severity pattern is detected |

### Build Path

A single-pass pattern engine on ingestion — the lowest-friction entry point. The pattern rules are centrally configured and distributed to all developer VS Code instances via the company's settings sync or a policy file pulled from the hub. No server component is required for the detection itself; the hub is only needed for centralised reporting and policy management.

---

## Feature 3 — Shared & Governed Prompt Library

### What It Is

A company-managed prompt template library, distributed to all developers via a central config endpoint. Senior developers or AI champions curate and version-control approved prompts for common tasks.

### Corporate Value

Consistency in how teams interact with AI tools. A junior developer writing a security-sensitive prompt from scratch versus using a company-vetted template is a meaningful quality and risk difference. Vetted prompts also encode company-specific conventions (testing frameworks, commit message standards, code review checklists) that individual developers would otherwise have to rediscover.

### Examples

- "Generate a unit test for this function" — with company-specific testing conventions baked in
- "Review this code for OWASP Top 10 issues" — scoped to the company's stack
- "Write a commit message following our conventional commits standard"
- "Generate an ADR from this conversation" — structured Architecture Decision Record output

### Key Capabilities

- Template versioning and a publish/review workflow (who can publish, who approves)
- Templates distributed as a fetch-from-URL source alongside local templates — no developer action required after initial setup
- Usage analytics: which templates are used most, by which teams
- Template variables (e.g. `{{jira_ticket}}`, `{{service_name}}`) resolved at invocation time

---

## Feature 4 — Team & Project-Level Analytics

### What It Is

Roll the existing per-developer token/model analytics up to team and project dimensions. A management-facing dashboard showing AI tool adoption, usage patterns, and ROI signals.

### Corporate Value

Heads of engineering and CTOs are being asked by their CFOs whether the AI tooling spend is justified. Currently there is no data. ChatWizard can provide it because it sits across all tools and all developers.

### Metrics

| Metric | Audience |
|---|---|
| Sessions per developer per sprint | Engineering manager |
| Models used per team (approved vs. unapproved) | CISO, engineering lead |
| Token burn rate vs. code commit rate | CTO (ROI signal) |
| Top topics per project (what teams ask AI about most) | Product / architecture |
| Time-of-day and sprint-phase patterns | Engineering manager |
| Onboarding acceleration (new hire session volume growth curve) | HR, engineering lead |

---

## Feature 5 — Standup, Sprint Digest & Work Item Integration

The personal "Workspace Digest" in the roadmap becomes a team workflow feature:

- Per-developer standup summary auto-generated from previous day's AI sessions
- Sprint retrospective: what categories of problems dominated across the team?
- Auto-draft PR descriptions correlated to the AI sessions that produced the code
- Post digests to Slack/Teams on a schedule
- **Git & JIRA/ADO correlation**: at session-open time, record active branch and HEAD commit; link sessions to work items via branch name conventions (`feature/ABC-1234`)
  - "Show me all AI sessions related to ticket ABC-1234" → full AI-assisted decision history for a feature
  - ADR generation: extract the pivotal exchange from a session and format it as a structured Architecture Decision Record

---

## Feature 6 — Security & Data Governance Policy Engine

A rule engine, configured centrally and deployed to all VS Code instances via settings or a policy file, that runs against every new session on ingestion:

- Flag sessions referencing internal IP ranges, domain names, project codenames
- Warn when sessions reference file paths under sensitive directories
- Block-list specific models for specific project workspaces
- Enforce minimum redaction before team promotion
- Per-workspace policy overrides (stricter rules for regulated projects)

---

## Feature 7 — Prompt Cost Control (Zero-LLM Analysis)

### Context

GitHub Copilot is transitioning from a premium-request monthly allowance model to **pay-per-token consumption**. For a company with 50+ developers, uncontrolled prompt habits — pasting entire files, asking multi-part questions in one shot, choosing GPT-4o for a one-liner refactor — translate directly into a larger monthly bill. ChatWizard is uniquely positioned to address this because it already holds historical token data for every session across every developer.

### The Paradox and Its Resolution

The obvious approach — use an LLM to evaluate prompt quality before sending — is self-defeating: you spend tokens to save tokens. Every analysis signal described below is achievable with **zero LLM calls**, using only local computation on existing data.

### Analysis Signals (All Local, No Network)

| Signal | Method | Example Warning |
|---|---|---|
| **Token estimate** | Local tokenizer (tiktoken-style, ~50KB, no network) counts tokens in the draft prompt; known model price gives exact cost | *"~2,400 tokens · est. $0.07 at current GPT-4o rate"* |
| **Cache hit suggestion** | Local bi-encoder (already in ChatWizard) checks similarity against your session history | *"You asked something very similar on 3 Apr and got a useful answer. Review before sending?"* |
| **Verbosity patterns** | Regex heuristics on the draft prompt | *"Prompt contains an entire file — consider pasting only the relevant function"* |
| **Multi-question bundling** | Detect multiple `?` separated by conjunctions | *"This looks like 3 separate questions — splitting them usually produces shorter, more focused responses"* |
| **Open-ended scope** | Match phrases like "list all possible", "explain everything", "write a complete implementation of" | *"Open-ended scope tends to generate very long responses — consider narrowing the ask"* |
| **Model selection** | Heuristics on prompt length + code presence | *"This looks like a one-liner refactor — Haiku or 4o-mini would handle it at ~10% of the cost"* |
| **Historical cost correlation** | From existing session index: prompts with a code block > N lines historically generated 4× more response tokens for this user | *"Prompts with large code blocks in your history average 3,800 response tokens"* |

### Interception Architecture

ChatWizard currently reads session files *after* they are written — it has no native pre-send hook. Three practical interception points, in order of corporate fit:

| Approach | How It Works | Friction |
|---|---|---|
| **`@chatwizard analyze` chat participant** | User types prompt, invokes `@chatwizard analyze` (or a keybinding) before sending. ChatWizard scores it and responds inline in the chat panel. | One extra step; fits natively into VS Code chat |
| **"Analyze Prompt" command on selection** | User writes prompt in editor, runs command on selection, gets a notification with cost estimate and suggestions | Low friction, no chat panel dependency |
| **Corporate agent pre-send hook** | The company deploys `@acme-assistant` via Agent apps. Every prompt goes through it. The agent calls ChatWizard's MCP tools (similarity check, historical cost lookup — all local, no LLM) and either warns or proceeds. | Zero extra developer friction once deployed — the strongest corporate fit |

The third option is the most powerful: when the company agent *is* the interception point, cost governance is enforced transparently and centrally without asking developers to change their habits.

### Corporate Value

- Finance and procurement teams get a predictable AI spend signal before the bill arrives
- Engineering leads can see which teams or individuals have the highest-cost prompt patterns and address them with training or template nudges
- The company prompt library (Feature 3) becomes a cost-optimisation tool as well as a quality tool — vetted templates are already right-sized

---

## The VS Code Insiders Agent Apps Layer

### What Changed

VS Code Insiders introduced **Agent apps** — custom chat participants defined via `.agent.md` files, publishable to the VS Code Marketplace or a private registry, with full access to MCP tool servers. This materially strengthens the corporate ChatWizard architecture.

### ChatWizard's MCP Server as an Agent Backend

ChatWizard v1.4 already exposes chat history as an MCP server (`chatwizard_search`, `chatwizard_get_context`, `chatwizard_get_session`, etc.). An Agent app is the natural first-class consumer of that interface.

**Before Agent apps:** Developers had to configure their AI tool to use the MCP server manually, and the connection was tool-specific.

**With Agent apps:** A `@chatwizard` agent (or `@acme-assistant` for the corporate fork) is invoked inline in the VS Code chat panel. It is pre-wired to the company hub, prompt library, and policy engine — invisible to the developer. The developer just types `@acme-assistant how did we solve the rate-limiting problem on the payments service?` and gets an answer drawn from the team knowledge base.

### Corporate-Specific Agents

The `.agent.md` format allows defining **role-specific agents**, each with a different tool scope and system instruction set, distributed via the company's internal VS Code extension registry:

| Agent | Purpose | Tools Used |
|---|---|---|
| `@security-reviewer` | Review code for policy violations and OWASP issues before commit | ChatWizard policy engine, approved prompt templates |
| `@arch-assistant` | Surface relevant ADRs and past architectural decisions | Team knowledge base MCP, git/JIRA correlation |
| `@standup-bot` | Generate standup entry from today's sessions | Session digest tool, JIRA integration |
| `@onboarding-guide` | Answer "how does X work here?" using team session history | Team knowledge base MCP |

### Enforcement Point

Every agent invocation that queries the ChatWizard hub passes through the policy engine before context is surfaced. This means data governance rules are enforced at the point where AI context is assembled — without requiring developers to change their workflow or be aware of the enforcement.

### Private Agent Registry

For the corporate fork, agents are published to an internal VS Code extension registry (or distributed via `.vsix` through MDM/SCCM). This gives the company control over which agents are available to developers, what tools those agents can access, and how they are versioned.

---

## Deployment Model

| Layer | Requirement |
|---|---|
| **Central hub** | Lightweight self-hosted server (Docker image) receiving promoted sessions, serving team MCP queries, and hosting the policy engine and prompt library |
| **Admin console** | Web UI for managing users, policies, prompt templates, and viewing analytics |
| **SSO / SAML** | Authentication via company IdP (Azure AD, Okta) for hub and console |
| **Settings distribution** | Centrally push ChatWizard configuration and policy files to all developer instances via VS Code settings sync or MDM/SCCM |
| **Private agent registry** | Internal extension host serving company-specific `.agent.md` agents |
| **Licensing server** | Per-seat or per-team license validation |
| **On-premise guarantee** | All data stays inside the corporate network — critical for regulated industries and a key differentiator vs. cloud-native AI tool vendors |

---

## Revenue Path

| Tier | Who Buys | Price Model | Key Features |
|---|---|---|---|
| **Individual** (existing) | Developer | Free / open source | Local index, personal analytics, MCP server |
| **Team** | Engineering lead, 5–50 devs | Per-seat SaaS or self-hosted licence | Team knowledge base, team analytics, shared prompt library, `@chatwizard` agent |
| **Enterprise** | CTO, CISO, 50–500+ devs | Site licence, self-hosted | Compliance audit trail, policy engine, SSO, JIRA/ADO integration, management dashboard, private agent registry, on-premise guarantee |

The Commons Clause already in the license protects the commercial angle — no one can resell the core without a commercial agreement.

---

## Recommended First Steps for a Corporate Pilot

In priority order, based on the meeting discussion:

### Step 1 — Sensitive Data Detection (2–3 days)
A single regex/pattern pass on ingestion, with a report view in the extension. No server component. A CISO can immediately see the value in a demo. Pattern rules are configurable via VS Code settings. This is the fastest proof-of-concept for the compliance angle.

### Step 2 — Team Prompt Library via URL source (3–5 days)
Extend the existing prompt library engine with a `fetch-from-URL` source. The company hosts a JSON file (on an internal server or SharePoint) that defines approved prompt templates. All developers with the extension automatically see them. Zero server infrastructure required for the pilot.

### Step 3 — `@chatwizard` Agent app (2–3 days)
A minimal `.agent.md` agent that wraps the existing MCP server tools and is distributed as a `.vsix`. Developers invoke it from the VS Code chat panel. Demonstrates the Agent apps integration and gives a compelling demo of the team knowledge base concept even before the hub is built.

### Step 4 — Central Hub (2–3 weeks)
A minimal Node.js / Docker hub that receives promoted sessions, stores them, and serves team-level MCP queries. This is the foundation for the team knowledge base, analytics dashboard, and policy engine.

---

## Why Agent Apps Change the Adoption Story

**Without Agent apps**, ChatWizard's MCP server is a configuration detail developers set up manually per tool. It's powerful but invisible and requires friction to adopt.

**With Agent apps**, you publish a `@acme-assistant` agent to the company's internal registry once, and every developer gets it automatically via MDM/settings sync. They just type `@acme-assistant how did we handle auth in the payments service?` and the agent queries the team knowledge base, runs it through the policy engine, and returns an answer — all transparent to the developer, all enforced by the company.

That's a fundamentally different adoption story: instead of selling developers on a tool, you're selling the CTO on a capability that deploys silently to 50 seats overnight. The pilot steps above are ordered to reach that demo as quickly as possible.

---

## Related Documents

- [whats-next.md](whats-next.md) — Individual developer roadmap
- [work-plan-mcp-server.md](work-plan-mcp-server.md) — MCP server Phase I
- [work-plan-mcp-server-phase-II.md](work-plan-mcp-server-phase-II.md) — MCP server Phase II (reranker, auth)
- [work-plan-session-archive.md](work-plan-session-archive.md) — Session archiving (feeds the team knowledge base)
- [work-plan-kb-and-tagging.md](work-plan-kb-and-tagging.md) — Knowledge base and tagging (individual precursor to team KB)
