/**
 * src/api/restApiServer.ts
 *
 * Feature 44 — REST API / Programmatic Access
 *
 * Provides read-only HTTP REST endpoints for querying the session index
 * from external scripts, dashboards, and integrations without VS Code.
 *
 * Architecture:
 * - Uses Node.js built-in http module (no external dependencies needed)
 * - Runs on a configurable port (separate from MCP server)
 * - Bearer token auth (reuses MCP auth infrastructure)
 * - Returns JSON responses with proper content-type
 * - All responses are CORS-enabled for local development
 *
 * Security:
 * - Bound to 127.0.0.1 only
 * - Bearer token authentication on all endpoints
 * - Read-only (no POST/PUT/DELETE mutations)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { SessionIndex } from '../index/sessionIndex';
import type { Session, SessionSource } from '../types/index';

// ── API Types ───────────────────────────────────────────────────────────────

export interface RestApiConfig {
    enabled: boolean;
    port: number;
    tokenPath: string;
    enableApiDocs: boolean;
}

interface ApiError {
    error: string;
    status: number;
}

interface HealthResponse {
    status: 'ok' | 'error';
    version: string;
    sessionCount: number;
    uptime: string;
}

interface SessionsResponse {
    count: number;
    sessions: RestSessionSummary[];
    next?: string;
}

interface SessionDetailResponse {
    session: RestSessionDetail;
}

interface SearchResponse {
    query: string;
    count: number;
    results: RestSessionSummary[];
}

interface StatsResponse {
    totalSessions: number;
    totalMessages: number;
    totalCodeBlocks: number;
    bySource: Record<string, number>;
    byModel: Record<string, number>;
}

export interface RestSessionSummary {
    id: string;
    title: string;
    source: string;
    messageCount: number;
    updatedAt: string;
    createdAt: string;
    workspacePath?: string;
    model?: string;
}

export interface RestSessionDetail {
    id: string;
    title: string;
    source: string;
    messages: RestMessage[];
    workspacePath?: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
    filePath: string;
}

export interface RestMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

// ── REST API Server ─────────────────────────────────────────────────────────

export class RestApiServer {
    private _httpServer: http.Server | undefined;
    private _running = false;
    private _port = 0;
    private _startTime: Date = new Date();

    constructor(
        private readonly config: RestApiConfig,
        private readonly index: SessionIndex,
        private readonly version: string,
        private readonly logger: (msg: string) => void = () => { /* no-op */ },
    ) {}

    get isRunning(): boolean { return this._running; }
    get port(): number { return this._port; }

    async start(): Promise<void> {
        if (this._running) { return; }

        const token = this._readToken();

        this._httpServer = http.createServer((req, res) => {
            this._handleRequest(req, res, token);
        });

        return new Promise((resolve, reject) => {
            this._httpServer!.listen(this.config.port, '127.0.0.1', () => {
                this._running = true;
                const addr = this._httpServer!.address();
                this._port = typeof addr === 'object' && addr ? addr.port : this.config.port;
                this._startTime = new Date();
                this.logger(`[Chat Wizard] REST API server started on port ${this._port}`);
                resolve();
            });
            this._httpServer!.on('error', (err) => {
                this.logger(`[Chat Wizard] REST API server error: ${err.message}`);
                reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this._running || !this._httpServer) { return; }
        return new Promise((resolve) => {
            this._httpServer!.close(() => {
                this._running = false;
                this.logger('[Chat Wizard] REST API server stopped');
                resolve();
            });
        });
    }

    private _readToken(): string | undefined {
        try {
            const raw = fs.readFileSync(this.config.tokenPath, 'utf8').trim();
            return raw || undefined;
        } catch {
            return undefined;
        }
    }

    private _requireAuth(req: http.IncomingMessage, token?: string): boolean {
        if (!token) { return false; } // No token configured — fail closed
        const auth = req.headers['authorization'];
        if (!auth) { return false; }
        return auth === `Bearer ${token}`;
    }

    private _sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
        const body = JSON.stringify(data, null, 2);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end(body);
    }

    private _sendError(res: http.ServerResponse, status: number, message: string): void {
        this._sendJson(res, { error: message, status } as ApiError, status);
    }

    private _parseQuery(url: string): Record<string, string> {
        const params: Record<string, string> = {};
        const idx = url.indexOf('?');
        if (idx === -1) { return params; }
        const qs = url.slice(idx + 1);
        for (const part of qs.split('&')) {
            const [k, v] = part.split('=');
            if (k) { params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''; }
        }
        return params;
    }

    private _matchPath(url: string): string {
        const idx = url.indexOf('?');
        return idx === -1 ? url : url.slice(0, idx);
    }

    private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse, token?: string): void {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
        }

        // Only GET is allowed
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed. Only GET requests are accepted.');
            return;
        }

        const url = req.url ?? '/';
        const pathname = this._matchPath(url);
        const params = this._parseQuery(url);

        // Public endpoints (no auth required)
        if (pathname === '/health') {
            this._handleHealth(res);
            return;
        }

        // API docs (optional — shows available endpoints)
        if (pathname === '/' || pathname === '/docs') {
            if (!this.config.enableApiDocs) {
                this._sendError(res, 404, 'Not found');
                return;
            }
            this._handleDocs(res);
            return;
        }

        // All other endpoints require auth
        if (!this._requireAuth(req, token)) {
            this._sendError(res, 401, 'Unauthorized. Provide a valid Bearer token in the Authorization header.');
            return;
        }

        switch (pathname) {
            case '/v1/sessions':
                this._handleListSessions(res, params);
                break;
            case '/v1/sessions/search':
                this._handleSearchSessions(res, params);
                break;
            case '/v1/stats':
                this._handleStats(res);
                break;
            default:
                // Match /v1/sessions/:id
                const sessionMatch = pathname.match(/^\/v1\/sessions\/(.+)$/);
                if (sessionMatch) {
                    this._handleGetSession(res, sessionMatch[1]);
                } else {
                    this._sendError(res, 404, `Endpoint not found: ${pathname}`);
                }
                break;
        }
    }

    private _handleHealth(res: http.ServerResponse): void {
        const uptime = Math.floor((Date.now() - this._startTime.getTime()) / 1000);
        const health: HealthResponse = {
            status: 'ok',
            version: this.version,
            sessionCount: this.index.size,
            uptime: `${uptime}s`,
        };
        this._sendJson(res, health);
    }

    private _handleDocs(res: http.ServerResponse): void {
        const docs = {
            api: 'ChatWizard REST API',
            version: this.version,
            endpoints: [
                { path: '/health', method: 'GET', auth: false, description: 'Health check and basic stats' },
                { path: '/v1/sessions', method: 'GET', auth: true, params: { limit: 'Max results (default 50)', offset: 'Pagination offset', source: 'Filter by source' }, description: 'List recent session summaries' },
                { path: '/v1/sessions/:id', method: 'GET', auth: true, description: 'Get full session details by ID' },
                { path: '/v1/sessions/search', method: 'GET', auth: true, params: { q: 'Search query (required)', limit: 'Max results (default 20)' }, description: 'Full-text search across all sessions' },
                { path: '/v1/stats', method: 'GET', auth: true, description: 'Aggregate statistics over all sessions' },
            ],
        };
        this._sendJson(res, docs);
    }

    private _handleListSessions(res: http.ServerResponse, params: Record<string, string>): void {
        const limit = Math.min(parseInt(params['limit'] ?? '50', 10) || 50, 200);
        const offset = parseInt(params['offset'] ?? '0', 10) || 0;
        const sourceFilter = params['source'] as SessionSource | undefined;

        const summaries = this.index.getAllSummaries();
        const filtered = sourceFilter
            ? summaries.filter(s => s.source === sourceFilter)
            : summaries;

        const page = filtered.slice(offset, offset + limit);
        const sessions: RestSessionSummary[] = page.map(s => ({
            id: s.id,
            title: s.title,
            source: s.source,
            messageCount: s.messageCount,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
            workspacePath: s.workspacePath,
            model: s.model,
        }));

        const response: SessionsResponse = {
            count: sessions.length,
            sessions,
        };

        if (offset + limit < filtered.length) {
            response.next = `/v1/sessions?limit=${limit}&offset=${offset + limit}`;
        }

        this._sendJson(res, response);
    }

    private _handleGetSession(res: http.ServerResponse, sessionId: string): void {
        const session = this.index.get(sessionId);
        if (!session) {
            this._sendError(res, 404, `Session not found: ${sessionId}`);
            return;
        }

        const detail: RestSessionDetail = {
            id: session.id,
            title: session.title,
            source: session.source,
            messages: session.messages.map(m => ({
                id: m.id,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
            })),
            workspacePath: session.workspacePath,
            model: session.model,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            filePath: session.filePath,
        };

        this._sendJson(res, { session: detail } as SessionDetailResponse);
    }

    private _handleSearchSessions(res: http.ServerResponse, params: Record<string, string>): void {
        const query = params['q'] ?? '';
        if (!query.trim()) {
            this._sendError(res, 400, 'Missing required parameter: q (search query)');
            return;
        }

        const limit = Math.min(parseInt(params['limit'] ?? '20', 10) || 20, 100);

        const results = this.index.search(query, { searchPrompts: true, searchResponses: true });
        const page = results.slice(0, limit);

        const sessions: RestSessionSummary[] = page.map(s => ({
            id: s.id,
            title: s.title,
            source: s.source,
            messageCount: s.messageCount,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
            workspacePath: s.workspacePath,
            model: s.model,
        }));

        const response: SearchResponse = {
            query,
            count: sessions.length,
            results: sessions,
        };

        this._sendJson(res, response);
    }

    private _handleStats(res: http.ServerResponse): void {
        const summaries = this.index.getAllSummaries();

        const bySource: Record<string, number> = {};
        const byModel: Record<string, number> = {};
        let totalMessages = 0;
        let totalCodeBlocks = 0;

        for (const s of summaries) {
            bySource[s.source] = (bySource[s.source] ?? 0) + 1;
            totalMessages += s.messageCount;

            const full = this.index.get(s.id);
            if (full) {
                for (const msg of full.messages) {
                    totalCodeBlocks += msg.codeBlocks.length;
                }
            }

            if (s.model) {
                byModel[s.model] = (byModel[s.model] ?? 0) + 1;
            }
        }

        const stats: StatsResponse = {
            totalSessions: summaries.length,
            totalMessages,
            totalCodeBlocks,
            bySource,
            byModel,
        };

        this._sendJson(res, stats);
    }
}