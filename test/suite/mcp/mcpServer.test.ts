// test/suite/mcp/mcpServer.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '../../../src/mcp/mcpServer';
import type { IMcpTool, McpToolInput, McpToolResult } from '../../../src/mcp/mcpContracts';
import type { McpServerConfig } from '../../../src/types/index';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Obtain a free OS-assigned port by binding a temporary server to port 0. */
async function getFreePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/** Track temp token files created during the run so they can be deleted in teardown. */
const _tempFiles: string[] = [];

/** Write a bearer token to a temp file; returns the file path. */
function writeTempToken(token: string): string {
    const p = path.join(os.tmpdir(), `cw-test-token-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(p, token, 'utf8');
    _tempFiles.push(p);
    return p;
}

/** Build a minimal McpServerConfig for testing. */
function makeConfig(port: number, tokenPath = ''): McpServerConfig {
    return { enabled: true, port, tokenPath };
}

/** Simple HTTP GET helper that resolves with { status, body }. */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

/** Fake IMcpTool for injection into the server. */
class FakeTool implements IMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema = { type: 'object', properties: {}, required: [] };
    callCount = 0;
    lastInput: McpToolInput | undefined;
    responseText: string;
    shouldThrow = false;

    constructor(name: string, description = 'A test tool', responseText = 'ok') {
        this.name = name;
        this.description = description;
        this.responseText = responseText;
    }

    async execute(input: McpToolInput): Promise<McpToolResult> {
        this.callCount++;
        this.lastInput = input;
        if (this.shouldThrow) {
            throw new Error('deliberate tool failure');
        }
        return { content: [{ type: 'text', text: this.responseText }] };
    }
}

// ── Lifecycle tests ──────────────────────────────────────────────────────────

suite('McpServer — lifecycle', () => {
    let server: McpServer;
    let port: number;

    suiteSetup(async () => { port = await getFreePort(); });

    setup(() => {
        const tokenPath = writeTempToken('test-token-lifecycle');
        server = new McpServer(makeConfig(port, tokenPath), []);
    });

    teardown(async () => {
        await server.stop();
    });

    test('isRunning is false before start()', () => {
        assert.strictEqual(server.isRunning, false);
    });

    test('port is 0 before start()', () => {
        assert.strictEqual(server.port, 0);
    });

    test('start() sets isRunning = true and port = configured port', async () => {
        await server.start();
        assert.strictEqual(server.isRunning, true);
        assert.strictEqual(server.port, port);
    });

    test('start() is idempotent — second call is a no-op', async () => {
        await server.start();
        await server.start(); // should not throw
        assert.strictEqual(server.isRunning, true);
    });

    test('stop() sets isRunning = false and port = 0', async () => {
        await server.start();
        await server.stop();
        assert.strictEqual(server.isRunning, false);
        assert.strictEqual(server.port, 0);
    });

    test('stop() is safe when server is not running', async () => {
        await server.stop(); // should not throw
        assert.strictEqual(server.isRunning, false);
    });

    test('server can be restarted after stop()', async () => {
        await server.start();
        await server.stop();
        const tokenPath = writeTempToken('test-token-restart');
        server = new McpServer(makeConfig(port, tokenPath), []);
        await server.start();
        assert.strictEqual(server.isRunning, true);
    });

    test('logger callback receives start message', async () => {
        const messages: string[] = [];
        const tokenPath = writeTempToken('test-token-logger');
        const logServer = new McpServer(makeConfig(port + 100), [], [], (msg) => messages.push(msg));
        // Won't be able to bind since we haven't released the port yet, use dedicated port
        const logPort = await getFreePort();
        const logServer2 = new McpServer(makeConfig(logPort, tokenPath), [], [], (msg) => messages.push(msg));
        await logServer2.start();
        await logServer2.stop();
        assert.ok(messages.some(m => m.includes('started')), 'expected start log message');
        assert.ok(messages.some(m => m.includes('stopped')), 'expected stop log message');
    });

    test('EADDRINUSE produces a descriptive error pointing to port setting', async () => {
        await server.start();
        const tokenPath2 = writeTempToken('test-token-eaddrinuse');
        const conflictServer = new McpServer(makeConfig(port, tokenPath2), []);
        try {
            await conflictServer.start();
            assert.fail('Expected EADDRINUSE error');
        } catch (err: unknown) {
            const msg = (err as Error).message;
            assert.ok(msg.includes('already in use'), `error should mention "already in use": ${msg}`);
            assert.ok(msg.includes('chatwizard.mcpServer.port'), `error should mention config key: ${msg}`);
        } finally {
            await conflictServer.stop();
        }
    });
});

// ── /health endpoint ─────────────────────────────────────────────────────────

suite('McpServer — /health endpoint', () => {
    let server: McpServer;
    let port: number;
    let sessionCount = 0;

    suiteSetup(async () => { port = await getFreePort(); });

    setup(async () => {
        const tokenPath = writeTempToken('test-token-health');
        server = new McpServer(makeConfig(port, tokenPath), [], [], () => { /* logger */ }, () => sessionCount);
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('responds 200 with status:ok and sessions count', async () => {
        sessionCount = 42;
        const { status, body } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(status, 200);
        const json = JSON.parse(body);
        assert.strictEqual(json.status, 'ok');
        assert.strictEqual(json.sessions, 42);
    });

    test('/health is accessible without a bearer token', async () => {
        const { status } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(status, 200);
    });

    test('sessions count reflects getSessionCount callback', async () => {
        sessionCount = 7;
        const { body } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(JSON.parse(body).sessions, 7);
    });
});

// ── /mcp-config endpoint ─────────────────────────────────────────────────────

suite('McpServer — /mcp-config endpoint', () => {
    let server: McpServer;
    let port: number;
    const TOKEN = 'config-endpoint-test-token';

    suiteSetup(async () => { port = await getFreePort(); });

    setup(async () => {
        const tokenPath = writeTempToken(TOKEN);
        server = new McpServer(makeConfig(port, tokenPath), []);
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('responds 200 with JSON content-type', async () => {
        // Directly fetch via http.get to capture headers
        const result = await new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
            http.get(`http://localhost:${port}/mcp-config`, (res) => {
                let body = '';
                res.on('data', (c: Buffer) => { body += c; });
                res.on('end', () => resolve({
                    status: res.statusCode ?? 0,
                    contentType: res.headers['content-type'] ?? '',
                    body,
                }));
                res.on('error', reject);
            }).on('error', reject);
        });
        assert.strictEqual(result.status, 200);
        assert.ok(result.contentType.includes('application/json'));
    });

    test('response body includes the correct URL and port', async () => {
        const { body } = await httpGet(`http://localhost:${port}/mcp-config`);
        const json = JSON.parse(body);
        assert.ok(json.url.includes(`localhost:${port}`), `url should include port ${port}`);
    });

    test('response body includes the bearer token', async () => {
        const { body } = await httpGet(`http://localhost:${port}/mcp-config`);
        const json = JSON.parse(body);
        assert.ok(json.authorization.includes(TOKEN), `authorization should include the token`);
    });

    test('response body includes SSE and messages endpoint paths', async () => {
        const { body } = await httpGet(`http://localhost:${port}/mcp-config`);
        const json = JSON.parse(body);
        assert.ok(json.endpoints?.sse, 'should include sse endpoint');
        assert.ok(json.endpoints?.messages, 'should include messages endpoint');
    });

    test('/mcp-config is accessible without a bearer token', async () => {
        const { status } = await httpGet(`http://localhost:${port}/mcp-config`);
        assert.strictEqual(status, 200);
    });
});

// ── Auth middleware ───────────────────────────────────────────────────────────

suite('McpServer — auth middleware', () => {
    const TOKEN = 'auth-test-secret-token';
    let port: number;
    let server: McpServer;

    suiteSetup(async () => { port = await getFreePort(); });

    setup(async () => {
        const tokenPath = writeTempToken(TOKEN);
        server = new McpServer(makeConfig(port, tokenPath), []);
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('returns 401 when Authorization header is missing', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`);
        assert.strictEqual(status, 401);
    });

    test('returns 401 when bearer token is wrong', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`, {
            Authorization: 'Bearer wrong-token',
        });
        assert.strictEqual(status, 401);
    });

    test('returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`, {
            Authorization: TOKEN,
        });
        assert.strictEqual(status, 401);
    });

    test('401 response body contains error message', async () => {
        const { body } = await httpGet(`http://localhost:${port}/sse`);
        const json = JSON.parse(body);
        assert.ok(json.error, 'should include an error field');
    });
});

// ── Auth middleware — no token file ──────────────────────────────────────────

suite('McpServer — auth middleware (no token file)', () => {
    let port: number;
    let server: McpServer;

    suiteSetup(async () => { port = await getFreePort(); });

    setup(async () => {
        // Point to a path that doesn't exist
        const nonExistentPath = path.join(os.tmpdir(), `cw-no-token-${Date.now()}.txt`);
        server = new McpServer(makeConfig(port, nonExistentPath), []);
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('returns 503 when token file does not exist', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`, {
            Authorization: 'Bearer any-token',
        });
        assert.strictEqual(status, 503);
    });

    test('503 body contains an informative error', async () => {
        const { body } = await httpGet(`http://localhost:${port}/sse`);
        const json = JSON.parse(body);
        assert.ok(typeof json.error === 'string' && json.error.length > 0);
    });
});

// ── Tool registry ─────────────────────────────────────────────────────────────

suite('McpServer — tool registry', () => {
    let port: number;
    let server: McpServer;

    suiteSetup(async () => { port = await getFreePort(); });

    teardown(async () => {
        await server.stop();
    });

    test('tools passed to constructor are registered', async () => {
        const tool = new FakeTool('chatwizard_test_a');
        const tokenPath = writeTempToken('registry-token');
        server = new McpServer(makeConfig(port, tokenPath), [tool]);
        // Access internal state via a cast — acceptable in unit tests
        const internal = server as unknown as { _tools: Map<string, IMcpTool> };
        assert.ok(internal._tools.has('chatwizard_test_a'));
    });

    test('register() adds a tool to the registry', async () => {
        const tokenPath = writeTempToken('registry-token-2');
        server = new McpServer(makeConfig(port, tokenPath), []);
        const tool = new FakeTool('chatwizard_test_b');
        server.register(tool);
        const internal = server as unknown as { _tools: Map<string, IMcpTool> };
        assert.ok(internal._tools.has('chatwizard_test_b'));
    });

    test('register() overwrites a tool with the same name', () => {
        const tokenPath = writeTempToken('registry-token-3');
        server = new McpServer(makeConfig(port, tokenPath), []);
        const t1 = new FakeTool('dupe', 'first');
        const t2 = new FakeTool('dupe', 'second');
        server.register(t1);
        server.register(t2);
        const internal = server as unknown as { _tools: Map<string, IMcpTool> };
        assert.strictEqual((internal._tools.get('dupe') as FakeTool).description, 'second');
    });

    test('multiple tools can be registered', () => {
        const tokenPath = writeTempToken('registry-token-4');
        server = new McpServer(makeConfig(port, tokenPath), [
            new FakeTool('tool_1'),
            new FakeTool('tool_2'),
            new FakeTool('tool_3'),
        ]);
        const internal = server as unknown as { _tools: Map<string, IMcpTool> };
        assert.strictEqual(internal._tools.size, 3);
    });
});

// ── Unknown path ──────────────────────────────────────────────────────────────

suite('McpServer — unknown paths', () => {
    let port: number;
    let server: McpServer;

    suiteSetup(async () => { port = await getFreePort(); });

    setup(async () => {
        const tokenPath = writeTempToken('unknown-path-token');
        server = new McpServer(makeConfig(port, tokenPath), []);
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('returns 401 for unknown authenticated paths when token missing from header', async () => {
        const { status } = await httpGet(`http://localhost:${port}/unknown-endpoint`);
        // Auth is checked first — missing token → 401
        assert.strictEqual(status, 401);
    });

    test('returns 404 for unknown paths when correctly authenticated', async () => {
        const { status } = await httpGet(`http://localhost:${port}/unknown-endpoint`, {
            Authorization: 'Bearer unknown-path-token',
        });
        assert.strictEqual(status, 404);
    });
});

suiteTeardown(() => {
    for (const p of _tempFiles) {
        fs.rmSync(p, { force: true });
    }
});
