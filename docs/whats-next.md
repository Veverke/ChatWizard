# ChatWizard — What's Next

_Last updated: April 2026_

---

## 1. Additional IDE / Source Support

The current parser roster covers: GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, Google Antigravity.

The natural next wave of sources to add:

| Source | Notes |
|---|---|
| **Continue.dev** | Open-source, VS Code + JetBrains + Neovim; stores sessions in `~/.continue/` — large user base, well-defined JSONL format |
| **Amazon Q Developer** | AWS's VS Code extension (formerly CodeWhisperer); increasingly adopted in enterprise |
| **Gemini Code Assist** | Google's VS Code extension; direct Copilot competitor, growing quickly |
| **Tabnine Chat** | Still relevant in enterprise environments |
| **Zed AI** | Stores AI conversations on disk; small reach today but growing |
| **Avante.nvim / CodeCompanion.nvim** | Neovim AI plugins with on-disk session files — would be the first non-VS Code IDE source |
| **JetBrains AI Assistant** | Huge user base (IntelliJ, PyCharm, WebStorm); would require a separate JetBrains plugin |
| **Pieces for Developers** | Saves snippets in its own on-disk format; VS Code extension — overlapping audience |

---

## 2. Broader Expansion Possibilities

### Semantic / Vector Search
The current engine is an inverted index + trigrams. Adding local embedding-based similarity search (e.g., via `@xenova/transformers` running fully client-side, zero network) would allow natural language queries like _"find sessions where I discussed authentication patterns"_ without exact keyword matches. This is the single highest-leverage upgrade.

### MCP Server Mode
Expose the chat history index as a **Model Context Protocol (MCP) server** so that AI tools (Copilot, Claude, Cursor, Continue) can query past conversations as context when answering new questions — "before answering, here's how I solved this before."

### Git / Branch Linkage
At session-open time, record the active git branch and HEAD commit. Show sessions tagged by branch in the TreeView, and in the session reader show what the repo looked like at that point. Answers _"what was I doing on feature/auth?"_

### Knowledge Base / Wiki Generation
Export a curated set of sessions as a structured Markdown knowledge base — decisions log, architectural notes, a "things I learned" document — automatically outlined by topic clusters derived from the prompt library.

### Workspace Digest / Standup Reports
A command that generates _"what I worked on [today / this week / this sprint]"_ from the timeline, suitable for pasting into a standup update or a PR description.

### Diff / Comparison View
Side-by-side rendering of two sessions or two responses to the same prompt across different models. Useful for prompt engineering and model evaluation.

### Cloud Sync (opt-in)
The extension is 100% local by design — a core selling point. An optional encrypted sync (e.g., user's own S3 / Azure Blob / GitHub Gist) would make history available across machines without compromising the privacy-first brand.

---

## 3. Chat Management Features Currently Missing

Gaps in the domain of managing conversations themselves:

- **Tagging / Labels** — Manually tag sessions with user-defined labels (`#bugfix`, `#architecture`, `#learning`). Currently pinning is the only organisation tool.
- **Bookmarks within a session** — Mark a specific exchange inside a long session. The reader has no anchoring mechanism beyond "jump to code block."
- **Inline annotations** — Attach a personal note to a message: _"I ended up not using this approach because…"_
- **Session status** — A lifecycle state (`open`, `resolved`, `revisit`) so you know which sessions contain unresolved threads.
- **Session linking** — Explicitly link two sessions (_"this continued in session X"_), creating a conversation graph.
- **Outcome / follow-up tracking** — A lightweight checklist of action items extracted from or appended to a session.
- **Duplicate / related session detection** — When the same conversation was split across two sessions (e.g., Claude vs. Cursor for the same task), surface them as related.
- **Response rating** — A per-response thumbs-up/down for personal recall ("this answer was wrong / excellent").
- **Smart session titles** — Auto-generated or user-editable titles. Copilot titles are often cryptic UUIDs or first-prompt truncations.
- **Keyboard-only navigation** — Vim-style `j/k` in the session tree and reader, which power users expect.

---

## 4. Competitive Gaps vs. Top Tools

**Pieces for Developers** is the most direct competitor. It:
- Uses **on-device ML models** for natural language search — _"find where I used debounce"_ works without typing the exact word
- Maintains **full context per snippet**: git repo, file, branch, language server info, related people/tools
- Has **integrations beyond VS Code**: JetBrains, Neovim, Chrome, Slack, Teams, Raycast
- Offers a **web/desktop app** so history is accessible outside the editor
- Provides **AI-generated descriptions** for every saved item automatically

Broader gaps relative to competitors:

| Gap | Detail |
|---|---|
| No semantic search | Exact-keyword + regex only; no "find sessions about this concept" |
| No AI-assisted summarization | No per-session summary, no topic auto-labeling, no cluster naming |
| Editor-only access | No web UI, no mobile, no CLI — history is locked inside VS Code |
| No collaboration | Can't share a session, export to Notion/Obsidian natively, or link to a GitHub issue |
| No entity extraction | Doesn't extract file names, function names, error messages, or decisions from conversations |
| Unranked search results | No relevance score, recency weighting, or popularity signal |
| No API / extension points | No programmatic way for other extensions or scripts to query the index |
| Analytics depth | Token counts are approximations; no cost estimation ($/model), no prompt-to-response ratio trends |

---

## Core Differentiators to Protect

ChatWizard's strongest competitive moat — double down on these with every new feature:

- **Only tool that aggregates across every major AI coding tool simultaneously**
- **100% local, read-only, zero setup** — no API key, no account, no network calls
- **Privacy-first by architecture**, not just by policy

Anything that preserves these properties while closing the semantic search and annotation gaps would make ChatWizard very difficult to displace.
