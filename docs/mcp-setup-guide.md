# ChatWizard — MCP Server Setup Guide

_Last updated: May 2026_

---

## What is the ChatWizard MCP Server?

The ChatWizard MCP Server exposes your entire local chat history — indexed from GitHub Copilot, Claude Code, Cline, Roo Code, Cursor, Windsurf, Aider, and Google Antigravity — as a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server. AI tools that support MCP can call ChatWizard's tools to retrieve relevant past conversations as context before they answer your questions.

**Key properties:**
- **100% local** — the server binds to `127.0.0.1` only; no traffic leaves your machine
- **Read-only** — no MCP tool can modify your session files or any source data
- **Opt-in** — disabled by default; you must explicitly enable it
- **Auth-gated** — every request requires a bearer token generated on first start; only tools you configure with the token can query your history

---

## Quick Start (all tools)

1. Open **VS Code Settings** (`Ctrl+,` / `Cmd+,`).
2. Search for `chatwizard.mcpServer.enabled` and set it to `true`.
3. Run **Chat Wizard: Copy MCP Config** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
4. Select your AI tool from the quick-pick menu.
5. The config snippet is copied to your clipboard and setup instructions open automatically.
6. Paste the snippet into your tool's config file (see per-tool sections below).
7. Restart or reload the tool. It will connect to ChatWizard immediately.

**Status bar indicator:** Once the server is running, a `$(broadcast) MCP` item appears in the VS Code status bar. Click it to start or stop the server.

---

## Available MCP Tools

| Tool name | Purpose |
|-----------|---------|
| `chatwizard_search` | Full-text keyword search across all sessions |
| `chatwizard_find_similar` | Topic / semantic similarity search (requires semantic search to be enabled) |
| `chatwizard_get_session` | Retrieve session content (truncated to 4 000 chars by default) |
| `chatwizard_get_session_full` | Retrieve complete session content with no truncation |
| `chatwizard_list_recent` | List recently updated sessions, optionally filtered by source or date |
| `chatwizard_get_context` | Smart context: best snippets for a topic in a single call |
| `chatwizard_list_sources` | Show which AI tools are indexed and their session counts |
| `chatwizard_server_info` | Server metadata, session count, index status, and uptime |

---

## GitHub Copilot (VS Code)

### Config file
**VS Code `settings.json`** — open it via the gear icon → `Open Settings (JSON)`, or via the Command Palette: `Preferences: Open User Settings (JSON)`.

**Location:**
- **Windows:** `%APPDATA%\Code\User\settings.json`
- **macOS:** `~/Library/Application Support/Code/User/settings.json`
- **Linux:** `~/.config/Code/User/settings.json`

### What to paste

```json
{
  "github.copilot.chat.mcpServers": {
    "chatwizard": {
      "type": "sse",
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

> The `"Chat Wizard: Copy MCP Config"` command puts your actual token into the snippet — just paste it directly.

### Steps

1. Open `settings.json` as described above.
2. If `"github.copilot.chat.mcpServers"` does not exist, paste the full block at the top level.
3. If it already exists, add the `"chatwizard"` entry to the existing object.
4. Save the file. VS Code picks up MCP servers automatically — no restart needed.
5. Open a Copilot Chat session and verify the connection:
   - Ask Copilot: _"Call chatwizard_server_info and show me the result."_
   - Or use the `#chatwizard` context variable in newer Copilot Chat versions.

### Notes

- The MCP server must be running in VS Code (status bar shows `$(broadcast) MCP`).
- If you rotate the bearer token, run **Copy MCP Config** again and update `settings.json`.
- Port can be changed via `chatwizard.mcpServer.port` (default `6789`); update the URL accordingly.

---

## Claude Desktop

### Config file
**`claude_desktop_config.json`**

**Location:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Create the file if it does not exist.

### What to paste

```json
{
  "mcpServers": {
    "chatwizard": {
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Steps

1. Open the config file in a text editor.
2. If `"mcpServers"` does not exist, paste the full block.
3. If it already exists, add the `"chatwizard"` key under `"mcpServers"`.
4. Save the file.
5. **Fully restart Claude Desktop** (quit and relaunch — a window reload is not sufficient).
6. In Claude, verify: _"Please call chatwizard_server_info and show me the result."_

### Notes

- Claude Desktop must be fully restarted whenever the MCP config file changes.
- The bearer token is embedded in the copied snippet — paste it as-is.
- If you rotate the token, update the `Authorization` header value and restart Claude Desktop.

---

## Cursor

### Config file
**`.cursor/mcp.json`** — a global user-level file (not project-specific).

**Location:**
- **macOS/Linux:** `~/.cursor/mcp.json`
- **Windows:** `%USERPROFILE%\.cursor\mcp.json`

Create the file and any missing parent directories if they do not exist.

### What to paste

```json
{
  "mcpServers": {
    "chatwizard": {
      "url": "http://localhost:6789/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

### Steps

1. Open or create `~/.cursor/mcp.json`.
2. If `"mcpServers"` does not exist, paste the full block.
3. If it already exists, add the `"chatwizard"` key under `"mcpServers"`.
4. Save the file.
5. **Restart Cursor** (or use `Cmd+Shift+P` → `Developer: Reload Window`).
6. In Cursor Chat, verify: `@chatwizard chatwizard_server_info`

### Notes

- Cursor supports HTTP SSE transport via the `url` field — no subprocess or `command` key required.
- The bearer token is required; it is already embedded in the copied snippet.
- Cursor's MCP client schema may evolve between releases; check the Cursor docs if the `"type"` field is required by a newer version.

---

## Continue

### Config file
Continue supports **project-scoped** and **global** MCP server files.

- **Project-scoped (recommended):** `.continue/mcpServers/chatwizard.json` in your workspace root
- **Global:** `~/.continue/mcpServers/chatwizard.json`

Create the `mcpServers/` directory if it does not exist.

### What to paste

Save the following as `chatwizard.json` inside the `mcpServers/` directory:

```json
{
  "mcpServers": [
    {
      "name": "chatwizard",
      "transport": {
        "type": "sse",
        "url": "http://localhost:6789/sse",
        "requestOptions": {
          "headers": {
            "Authorization": "Bearer <your-token>"
          }
        }
      }
    }
  ]
}
```

### Steps

1. Create `.continue/mcpServers/` in your project root (or `~/.continue/mcpServers/` for global scope).
2. Save the snippet above as `chatwizard.json` inside that directory.
3. Continue picks up new files in `mcpServers/` automatically — no restart needed.
4. Switch Continue to **Agent mode** (MCP tools are only available in agent mode, not chat mode).
5. Verify: `@chatwizard chatwizard_server_info`

### Notes

- MCP tools are **only available in agent mode** in Continue. They are not visible in standard chat mode.
- Continue supports SSE transport via the `url` field — no subprocess is needed.
- The `headers.Authorization` field contains your bearer token.
- If you rotate the token, update the JSON file. Continue reloads MCP config files automatically.

---

## Generic / Any MCP-Compatible Client

Use these connection details for any MCP client not listed above:

| Property | Value |
|----------|-------|
| **SSE endpoint** | `http://localhost:6789/sse` |
| **Messages endpoint** | `http://localhost:6789/messages` |
| **Health endpoint** | `http://localhost:6789/health` _(no auth required)_ |
| **Auth header** | `Authorization: Bearer <your-token>` |
| **Transport** | HTTP + SSE |

1. Copy your bearer token from the config snippet (run **Chat Wizard: Copy MCP Config** → **Generic**).
2. Configure your client to connect to the SSE endpoint and set the `Authorization` header.
3. Verify connectivity by calling `chatwizard_server_info` with no arguments.

---

## Troubleshooting

### "Connection refused" or client can't connect

- Confirm the MCP server is running: the status bar should show `$(broadcast) MCP`.
- If not running, use **Chat Wizard: Start MCP Server** from the Command Palette.
- Verify the port matches (`chatwizard.mcpServer.port`, default `6789`).
- Check that VS Code is not blocked by a local firewall rule on `127.0.0.1:6789`.

### "401 Unauthorized"

- The bearer token in your tool's config does not match the one generated by ChatWizard.
- Run **Chat Wizard: Copy MCP Config** again to get a fresh snippet with the current token.
- Paste the new token into your tool's config and restart the tool.

### "Port already in use"

- Another process (or a previous VS Code window) is already using port `6789`.
- Change `chatwizard.mcpServer.port` to an unused port (e.g., `6790`) and update the URL in your tool's config.

### Semantic search tools return "not available"

- `chatwizard_find_similar` and `chatwizard_get_context` (semantic path) require semantic search to be enabled.
- Set `chatwizard.enableSemanticSearch` to `true` in VS Code Settings and wait for the index to build.
- `chatwizard_search` (keyword search) is always available regardless of semantic search status.

### Token rotation

- To invalidate the current token and generate a new one, delete `mcp-token.txt` from VS Code's extension global storage and restart the MCP server.
- After rotation, run **Chat Wizard: Copy MCP Config** again and update all configured AI tools.
