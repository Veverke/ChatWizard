# Issues List — June 2026

> Snapshot of all open issues on [ChatWizard GitHub](https://github.com/Veverke/ChatWizard/issues) as of June 30, 2026.
> **25 Open** | **4 Closed** (since repo inception)

---

## Legend

| Icon | Meaning |
|------|---------|
| 🐛 | Bug |
| ✨ | Enhancement / Feature Request |
| 📋 | Tracker / Meta-issue |
| ❓ | Question / Investigation |
| 🔜 | Up-next / In-progress |

---

## 🏷️ In Progress

### #61 — Organize chat sessions in Folders
- **Labels:** `enhancement`, `in-progress`
- **Opened:** Jun 24, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/61
- **Description:** Allow users to organize chat sessions into folders/groups for better navigation and management.

### #60 — Whats next p3 v2
- **Labels:** *(none)*
- **Opened:** Jun 21, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/60
- **Description:** Tracker / planning issue for the "What's Next — P3" milestone (v2 iteration).

---

## 🐛 Bugs

### #57 — Views such as Analytics Model Usage should consider current workflow only
- **Labels:** `bug`
- **Opened:** Jun 21, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/57
- **Description:** Analytics views (e.g., Model Usage) currently aggregate across all workflows; they should scope to the active/current workflow.

---

## ✨ Enhancements — Core & Infrastructure

### #59 — Auto convert all existing chats into SQL store
- **Labels:** `enhancement`
- **Opened:** Jun 21, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/59
- **Description:** After SQL store feature is implemented, allow auto-converting all existing chats (from all tools) into SQL store — in the background, async, and resumable at each new startup/window reload until completion.

### #37 — Semantic Search indexing at startup should need less time to complete
- **Labels:** `enhancement`
- **Opened:** May 30, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/37
- **Description:** Optimize semantic search indexing to complete faster on startup.

---

## ✨ Enhancements — UX & UI

### #58 — Show consumed credits on the go as Cline
- **Labels:** `enhancement`
- **Opened:** Jun 21, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/58
- **Description:** Display real-time consumed credits / token usage inline during chat, similar to how Cline shows it.

### #56 — Enhance Cline saved chat sessions
- **Labels:** `enhancement`
- **Opened:** Jun 9, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/56
- **Description:** Improve the rendering, metadata, and usability of imported Cline chat sessions.

### #55 — Switch focus from Premium Requests to Token Consumption
- **Labels:** `enhancement`
- **Opened:** Jun 8, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/55
- **Description:** Shift analytics and display emphasis from premium-request counts to actual token consumption.

### #53 — Parse links in chat and make them clickable
- **Labels:** `enhancement`
- **Opened:** Jun 7, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/53
- **Description:** Detect URLs in chat messages and render them as clickable hyperlinks.

### #52 — Can search point/lead to original chat session/window ?
- **Labels:** `enhancement`
- **Opened:** Jun 7, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/52
- **Description:** When a search result is selected, navigate the user to the original chat session/window where the match was found.

### #50 — Cycle through "Did you know" notifications to be notified by squirrel mascot
- **Labels:** `enhancement`
- **Opened:** Jun 2, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/50
- **Description:** Implement a rotating "Did you know" tip notification system featuring the squirrel mascot.

### #42 — All sort options should merge into a single sort button
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/42
- **Description:** Currently sort options are separate buttons; consolidate into a single sort button offering all options, including "Configure Sort Options."

### #41 — NEED collapsing different tab views
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/41
- **Description:** Add the ability to collapse/expand different tab views for a cleaner workspace.

### #40 — Workspace metadata display should be conditional
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/40
- **Description:** Showing workspace as part of the metadata string for each session adds nothing when all sessions share the same workspace. Only show workspace info when multiple workspaces are selected.

### #14 — Add progress bar to estimate when current AI exchange will complete
- **Labels:** *(none)*
- **Opened:** Mar 23, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/14
- **Description:** Show a progress/estimate indicator during AI response generation.

### #15 — Add setting per model that tells monthly limit rate
- **Labels:** *(none)*
- **Opened:** Mar 23, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/15
- **Description:** Allow users to configure a monthly request/usage limit per model.

---

## ✨ Enhancements — Session Management

### #46 — Erase a chat turn
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/46
- **Description:** User right-clicks a chat turn (prompt or response) and deletes it from the session. Note: should this work in live chat windows or only saved sessions?

### #45 — Split sessions by drawing a line
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/45
- **Description:** User clicks and drags to draw a boundary line splitting a session into two parts — content above the line becomes Session 1, content below becomes Session 2.

### #44 — Join/merge sessions
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/44
- **Description:** Merge multiple sessions (N sessions, not just 2) — LLM blends contents accordingly.

### #38 — Seeing archived messages from other workspaces
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/38
- **Description:** Investigate and fix issue where archived messages from other workspaces are visible in the current workspace view.

---

## ✨ Enhancements — Intelligence & Analysis

### #49 — Prompt Library: identify interactive actions/questions
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/49
- **Description:** Can the extension identify and catalog questions / interactive actions that the chat prompted the user for?

### #48 — UI layer for preferences / instructions / skills / agents
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/48
- **Description:** Provide a graphical UI layer for managing VS Code customization files: preferences, instructions, skills, and agents.

### #47 — Identify recurring preferences & instructions from sessions
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/47
- **Description:** (4.1) Scan all sessions to identify recurring "preferences" not already in `preferences.md` and add them. (4.2) Scan all sessions to identify recurring "instructions" not already in `global-instructions.md` and add them.

### #4 — Analytics term usage distribution is not useful for common words
- **Labels:** *(none)*
- **Opened:** Mar 11, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/4
- **Description:** Analytics showing single-term usage distribution is not useful for terms like "why", "problem", "issue". Algorithm should identify what are valid/relevant prompt terms/tokens.

---

## ❓ Questions & Investigations

### #43 — Group by branch — Product Hunt campaign dates
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/43
- **Description:** Chat dates from AFTER the feature was implemented appear under "[no branch recorded]" — why? Investigate branch grouping logic.

### #39 — Auto-archive — why sessions from 3 days ago archived?
- **Labels:** *(none)*
- **Opened:** May 31, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/39
- **Description:** How come sessions from only 3 days ago (May 28) were auto-archived in a repo created just a week ago? Investigate VS Code analytics auto-archive logic.

---

## 📋 Trackers & Meta-issues

### #54 — New whats next 3
- **Labels:** *(none)*
- **Opened:** Jun 8, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/54
- **Description:** Planning / tracker issue for the next milestone iteration.

### #51 — scalability II completed
- **Labels:** *(none)*
- **Opened:** Jun 2, 2026
- **Assignee:** Veverke
- **URL:** https://github.com/Veverke/ChatWizard/issues/51
- **Description:** Tracker for Scalability Phase II completion.

---

## 📊 Summary

| Category | Count | Issues |
|----------|-------|--------|
| 🐛 Bugs | 1 | #57 |
| ✨ Enhancements — Core & Infra | 2 | #59, #37 |
| ✨ Enhancements — UX & UI | 11 | #58, #56, #55, #53, #52, #50, #42, #41, #40, #14, #15 |
| ✨ Enhancements — Session Mgmt | 4 | #46, #45, #44, #38 |
| ✨ Enhancements — Intelligence | 4 | #49, #48, #47, #4 |
| ❓ Questions / Investigations | 2 | #43, #39 |
| 📋 Trackers & Meta | 3 | #60, #54, #51 |
| **In Progress** | **2** | **#61, #60** |

---

## 📁 Closed Issues (for reference)

| Issue | Title | Closed |
|-------|-------|--------|
| #36 | download popup issues + minor fixes/additions | May 26 |
| #35 | fix(release): add VS Code download + native rebuild to test-insiders job | May 25 |
| #34 | Pre 1.5.0 release fixes | May 25 |
| #33 | Whats next p2 with cr changes | May 25 |
| #32 | fix sqlite module resolution for failing Insiders UTs | May 25 |
| #31 | what's-next-P2 | May 25 |
| #30 | What's Next - P1 | May 19 |
| #29 | whats next consolidated | May 16 |
| #28 | Whats next mcp server | May 16 |
| #27 | leftovers | May 5 |
| #26 | Phase 5 | May 5 |
| #25 | phase 4 | May 4 |
| #24 | phase 3 | May 4 |
| #23 | phase 2 | May 4 |
| #22 | phase 0 | May 4 |
| #21 | add semantic search | May 3 |
| #20 | Add google antigravity support (with review fixes) | Apr 23 |
| #19 | Add google antigravity support | Apr 23 |
| #18 | + run UTs | Apr 21 |
| #17 | new groupings | Apr 19 |
| #16 | Support additional ai coding extensions | Apr 19 |
| #13 | Timeline revamp | Mar 22 |
| #12 | Requests per model | Mar 22 |
| #11 | Default to current ws and allow adding more on demand | Mar 21 |
| #10 | Add Chat messages submitted/sent per LLM model, for a given date period | Mar 22 |
| #9 | Default to current Workspace, while allowing including others, manually | Mar 22 |
| #8 | Cancelled responses | Mar 18 |
| #7 | uix-enhancement-round | Mar 18 |
| #6 | Security improvements | Mar 15 |
| #5 | Scalability s7 fix | Mar 15 |
| #3 | Vs extesion styling | Mar 11 |
| #2 | Make sure newly added chats are tracked while extension is loaded | Mar 18 |
| #1 | Export Excerpt button not working | Mar 18 |