// src/mcp/mcpConfigHelper.ts

/** Supported AI tools for MCP config snippet generation */
export type McpConfigTarget = 'copilot' | 'claude' | 'cursor' | 'continue' | 'generic';

/**
 * Generates ready-to-paste MCP config snippets for each supported AI tool.
 *
 * The server uses HTTP + SSE transport bound to localhost, so the SSE endpoint
 * is `http://localhost:<port>/sse` and every request requires a Bearer token.
 */
export class McpConfigHelper {
    /**
     * Return a formatted JSON config snippet that the user
     * can paste directly into the target tool's configuration file.
     *
     * @param tool    Which AI tool to generate the snippet for.
     * @param port    Port the MCP server is listening on.
     * @param token   Bearer token the tool must supply in the Authorization header.
     */
    getConfigSnippet(tool: McpConfigTarget, port: number, token: string): string {
        const sseUrl = `http://localhost:${port}/sse`;

        switch (tool) {
            case 'copilot':
                return this._copilotSnippet(sseUrl, token);
            case 'claude':
                return this._claudeSnippet(sseUrl, token);
            case 'cursor':
                return this._cursorSnippet(sseUrl, token);
            case 'continue':
                return this._continueSnippet(sseUrl, token);
            case 'generic':
                return this._genericSnippet(sseUrl, token);
            default:
                throw new Error(`Unsupported MCP config target: "${tool as string}"`);
        }
    }

    // ── Per-tool formatters ────────────────────────────────────────────────────

    /**
     * VS Code `settings.json` entry for GitHub Copilot.
     * Add the `"github.copilot.chat.mcpServers"` block (or merge into an existing one).
     */
    private _copilotSnippet(sseUrl: string, token: string): string {
        const config = {
            'github.copilot.chat.mcpServers': {
                chatwizard: {
                    type: 'sse',
                    url: sseUrl,
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            },
        };
        return JSON.stringify(config, null, 2);
    }

    /**
     * Claude Desktop `claude_desktop_config.json` entry.
     * Merge the `"mcpServers"` block into your existing config file.
     */
    private _claudeSnippet(sseUrl: string, token: string): string {
        const config = {
            mcpServers: {
                chatwizard: {
                    url: sseUrl,
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            },
        };
        return JSON.stringify(config, null, 2);
    }

    /**
     * Cursor `.cursor/mcp.json` entry.
     * If the file already exists, merge the inner `"chatwizard"` key under `"mcpServers"`.
     */
    private _cursorSnippet(sseUrl: string, token: string): string {
        const config = {
            mcpServers: {
                chatwizard: {
                    url: sseUrl,
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            },
        };
        return JSON.stringify(config, null, 2);
    }

    /**
     * Continue `.continue/config.json` `mcpServers` array entry.
     * Add the object inside the existing `"mcpServers": [...]` array.
     */
    private _continueSnippet(sseUrl: string, token: string): string {
        const entry = {
            name: 'chatwizard',
            transport: {
                type: 'sse',
                url: sseUrl,
                requestOptions: {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            },
        };
        // Wrap in a container so the user can see where it belongs
        const config = {
            mcpServers: [entry],
        };
        return JSON.stringify(config, null, 2);
    }

    /**
     * Generic snippet — a minimal `{ url, authorization }` block usable by any
     * MCP-aware client that accepts a raw HTTP endpoint + auth header.
     */
    private _genericSnippet(sseUrl: string, token: string): string {
        const config = {
            url: sseUrl,
            authorization: `Bearer ${token}`,
        };
        return JSON.stringify(config, null, 2);
    }

    // ── Setup instructions ─────────────────────────────────────────────────────

    /**
     * Return step-by-step plain-text setup instructions for the given tool.
     * Shown in the "Show instructions" virtual document after copying config.
     */
    getSetupInstructions(tool: McpConfigTarget, port: number): string {
        switch (tool) {
            case 'copilot':
                return this._copilotInstructions(port);
            case 'claude':
                return this._claudeInstructions(port);
            case 'cursor':
                return this._cursorInstructions(port);
            case 'continue':
                return this._continueInstructions(port);
            case 'generic':
                return this._genericInstructions(port);
            default:
                throw new Error(`Unsupported MCP config target: "${tool as string}"`);
        }
    }

    private _copilotInstructions(port: number): string {
        return [
            '# ChatWizard MCP Setup — GitHub Copilot',
            '',
            '## Steps',
            '',
            '1. Open **VS Code Settings** (`Ctrl+,` / `Cmd+,`).',
            '2. Click the **Open Settings (JSON)** icon in the top-right corner.',
            '3. Paste the copied JSON block at the top level of your `settings.json`.',
            '   - If you already have a `"github.copilot.chat.mcpServers"` key, merge',
            '     the `"chatwizard"` entry into the existing object.',
            '4. Save the file. VS Code will pick up the new MCP server automatically.',
            '5. Open a Copilot Chat session and verify with:',
            '   `@chatwizard chatwizard_server_info`',
            '',
            '## Notes',
            '',
            `- The MCP server runs on **port ${port}** (localhost only).`,
            '- Keep the ChatWizard extension loaded and the MCP server running while using Copilot.',
            '- To stop the server: run **Chat Wizard: Stop MCP Server** from the Command Palette.',
        ].join('\n');
    }

    private _claudeInstructions(port: number): string {
        return [
            '# ChatWizard MCP Setup — Claude Desktop',
            '',
            '## Steps',
            '',
            '1. Locate your Claude Desktop config file:',
            '   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`',
            '   - **Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`',
            '2. Open the file in a text editor (create it if it does not exist).',
            '3. Paste the copied JSON block, merging the `"mcpServers"` entry.',
            '   - If `"mcpServers"` already exists, add `"chatwizard"` to that object.',
            '4. Save the file.',
            '5. **Restart Claude Desktop** to pick up the new MCP server.',
            '6. In Claude, try: `/chatwizard_server_info` or ask Claude to call it.',
            '',
            '## Notes',
            '',
            `- The MCP server runs on **port ${port}** (localhost only).`,
            '- The bearer token is required — it is already embedded in the copied config.',
            '- If you rotate the token, copy the config again and update Claude Desktop.',
        ].join('\n');
    }

    private _cursorInstructions(port: number): string {
        return [
            '# ChatWizard MCP Setup — Cursor',
            '',
            '## Steps',
            '',
            '1. Locate (or create) `.cursor/mcp.json` in your home directory:',
            '   - **macOS/Linux**: `~/.cursor/mcp.json`',
            '   - **Windows**: `%USERPROFILE%\\.cursor\\mcp.json`',
            '2. Paste the copied JSON block into that file.',
            '   - If the file already exists, merge the `"chatwizard"` entry under `"mcpServers"`.',
            '3. Save the file.',
            '4. **Restart Cursor** (or reload the window) to activate the MCP server.',
            '5. In Cursor Chat, verify with: `@chatwizard chatwizard_server_info`',
            '',
            '## Notes',
            '',
            `- The MCP server runs on **port ${port}** (localhost only).`,
            '- The bearer token in the config snippet is required for authentication.',
        ].join('\n');
    }

    private _continueInstructions(port: number): string {
        return [
            '# ChatWizard MCP Setup — Continue',
            '',
            '## Steps',
            '',
            '1. Open your Continue config file:',
            '   - **All platforms**: `~/.continue/config.json`',
            '   - Or open Continue in VS Code and click **Settings → Edit config.json**.',
            '2. Find the `"mcpServers"` array (or add it if absent).',
            '3. Paste the copied object into that array.',
            '4. Save the file. Continue reloads its config automatically.',
            '5. In a Continue session, call: `@chatwizard chatwizard_server_info`',
            '',
            '## Notes',
            '',
            `- The MCP server runs on **port ${port}** (localhost only).`,
            '- The `requestOptions.headers.Authorization` field contains your bearer token.',
            '- Continue supports SSE transport, so no proxy or subprocess is needed.',
        ].join('\n');
    }

    private _genericInstructions(port: number): string {
        return [
            '# ChatWizard MCP Setup — Generic Client',
            '',
            '## Connection details',
            '',
            `- **SSE endpoint**: \`http://localhost:${port}/sse\``,
            `- **Messages endpoint**: \`http://localhost:${port}/messages\``,
            `- **Health endpoint**: \`http://localhost:${port}/health\` (no auth required)`,
            '',
            '## Authentication',
            '',
            '- Add the header `Authorization: Bearer <token>` to every request.',
            '- The token is embedded in the copied config snippet.',
            '',
            '## Steps',
            '',
            '1. Copy the token from the pasted config snippet.',
            '2. Configure your MCP client to connect to the SSE endpoint above.',
            '3. Set the Authorization header with your token.',
            '4. Test connectivity by calling `chatwizard_server_info` with no arguments.',
            '',
            '## Notes',
            '',
            '- The server is bound to localhost only — no external access.',
            '- Keep the ChatWizard extension running in VS Code while using the MCP client.',
        ].join('\n');
    }
}
