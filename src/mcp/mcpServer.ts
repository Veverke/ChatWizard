// src/mcp/mcpServer.ts
import * as http from 'http';
import * as vscode from 'vscode';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { IMcpServer } from './mcpContracts';

const DEFAULT_PORT = 6789;

/**
 * Implements the IMcpServer lifecycle contract.
 * Starts a local HTTP/SSE server that MCP-compatible AI tools can connect to.
 * Phase 4 wiring (tool/resource registration) will call registerTools() on this server.
 */
export class McpServer implements IMcpServer {
    private _httpServer: http.Server | undefined;
    private _sdkServer: SdkMcpServer | undefined;
    private readonly _transports = new Map<string, SSEServerTransport>();
    private _running = false;
    private _port = 0;

    get isRunning(): boolean { return this._running; }
    get port(): number { return this._port; }

    async start(): Promise<void> {
        if (this._running) { return; }

        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const port = cfg.get<number>('mcpServer.port') ?? DEFAULT_PORT;

        const sdkServer = new SdkMcpServer(
            { name: 'chatwizard', version: '1.0.0' },
            { capabilities: {} }
        );

        await new Promise<void>((resolve, reject) => {
            const httpServer = http.createServer(async (req, res) => {
                try {
                    const urlPath = req.url?.split('?')[0] ?? '';

                    if (req.method === 'GET' && urlPath === '/sse') {
                        const transport = new SSEServerTransport('/messages', res);
                        const sessionId = transport.sessionId;
                        this._transports.set(sessionId, transport);
                        transport.onclose = () => { this._transports.delete(sessionId); };
                        await sdkServer.connect(transport);

                    } else if (req.method === 'POST' && urlPath === '/messages') {
                        const rawQs = req.url?.includes('?')
                            ? req.url.slice(req.url.indexOf('?') + 1)
                            : '';
                        const sessionId = new URLSearchParams(rawQs).get('sessionId') ?? '';
                        const transport = this._transports.get(sessionId);
                        if (transport) {
                            await transport.handlePostMessage(req, res);
                        } else {
                            res.writeHead(404).end('Session not found');
                        }

                    } else {
                        res.writeHead(404).end();
                    }
                } catch (err) {
                    if (!res.headersSent) {
                        res.writeHead(500).end(String(err));
                    }
                }
            });

            httpServer.listen(port, '127.0.0.1', () => {
                this._httpServer = httpServer;
                this._sdkServer = sdkServer;
                this._port = port;
                this._running = true;
                resolve();
            });
            httpServer.once('error', reject);
        });
    }

    async stop(): Promise<void> {
        if (!this._running) { return; }

        this._running = false;
        this._port = 0;

        for (const transport of this._transports.values()) {
            try { await transport.close(); } catch { /* ignore */ }
        }
        this._transports.clear();

        await this._sdkServer?.close();
        this._sdkServer = undefined;

        await new Promise<void>((resolve) => {
            if (this._httpServer) {
                this._httpServer.close(() => resolve());
                this._httpServer = undefined;
            } else {
                resolve();
            }
        });
    }

    dispose(): Promise<void> {
        return this.stop();
    }
}
