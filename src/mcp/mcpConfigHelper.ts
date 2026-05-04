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
     * Return a formatted JSON (or YAML for Continue) config snippet that the user
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
}
