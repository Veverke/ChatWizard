// src/mcp/mcpContracts.ts

/** Arbitrary key/value input passed to an MCP tool */
export interface McpToolInput {
    [key: string]: unknown;
}

/** The structured response returned by an MCP tool */
export interface McpToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

/** A single MCP tool that can be registered with the server */
export interface IMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: object; // JSON Schema
    execute(input: McpToolInput): Promise<McpToolResult>;
}

/** Lifecycle contract for the MCP HTTP/SSE server */
export interface IMcpServer {
    readonly isRunning: boolean;
    readonly port: number;
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** Argument definition for an MCP prompt */
export interface McpPromptArgument {
    name: string;
    description: string;
    required: boolean;
}

/** A predefined MCP prompt (slash command) exposed to MCP clients */
export interface IMcpPrompt {
    readonly name: string;
    readonly description: string;
    readonly arguments: McpPromptArgument[];
    render(args: Record<string, string>): Promise<McpToolResult>;
}
