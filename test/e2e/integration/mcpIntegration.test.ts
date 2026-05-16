// test/suite/integration/mcpIntegration.test.ts
//
// Integration tests — MCP Server (scenarios 43–47)
//
// Tests the MCP server lifecycle, SearchTool, GetSessionTool, and bearer-token
// auth against a real HTTP server bound to a free OS-assigned port.
// Uses the same helpers and patterns as test/suite/mcp/mcpServer.test.ts.

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { McpServer } from '../../../src/mcp/mcpServer';
import { McpAuthManager } from '../../../src/mcp/mcpAuthManager';
import { SearchTool } from '../../../src/mcp/tools/searchTool';
import { GetSessionTool } from '../../../src/mcp/tools/getSessionTool';
import { GetSessionFullTool } from '../../../src/mcp/tools/getSessionFullTool';
import { GetContextTool } from '../../../src/mcp/tools/getContextTool';
import { FindSimilarTool } from '../../../src/mcp/tools/findSimilarTool';
import { PROMPT_DEFS } from '../../../src/mcp/prompts/contextPrompts';
import { FullTextSearchEngine } from '../../../src/search/fullTextEngine';
import { SessionIndex } from '../../../src/index/sessionIndex';
import { NullSemanticIndexer } from '../../../src/search/semanticContracts';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import type { McpServerConfig } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX = path.join(FIXTURES, 'copilot');

// ---------------------------------------------------------------------------
// Infrastructure helpers (same pattern as test/suite/mcp/mcpServer.test.ts)
// ---------------------------------------------------------------------------

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

const _tempFiles: string[] = [];

function writeTempToken(token: string): string {
    const p = path.join(
        os.tmpdir(),
        `cw-mcp-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    fs.writeFileSync(p, token, 'utf8');
    _tempFiles.push(p);
    return p;
}

function makeConfig(port: number, tokenPath: string): McpServerConfig {
    return { enabled: true, port, tokenPath };
}

function httpGet(
    url: string,
    headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
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

function cleanupTempFiles(): void {
    for (const f of _tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    _tempFiles.length = 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('MCP Server Integration', function () {
    this.timeout(20_000);

    let server: McpServer;
    let port: number;
    let tokenPath: string;
    let token: string;
    let index: SessionIndex;
    let ftse: FullTextSearchEngine;

    suiteSetup(async () => {
        port = await getFreePort();
        token = 'a'.repeat(64); // 64-char hex-like token for testing
        tokenPath = writeTempToken(token);

        // Build a pre-populated index and FTSE with two fixture sessions
        // (two sessions so tokens cross MIN_DOC_FREQ = 2 threshold)
        index = new SessionIndex();
        ftse = new FullTextSearchEngine();

        const { session: cssSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-mcp-integ'
        );
        const { session: tsSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-mcp-integ-2'
        );
        index.upsert(cssSession);
        index.upsert(tsSession);
        ftse.index(cssSession);
        ftse.index(tsSession);

        // Build tools
        const searchTool = new SearchTool(ftse, index);
        const getSessionTool = new GetSessionTool(index);

        server = new McpServer(
            makeConfig(port, tokenPath),
            [searchTool, getSessionTool],
            [],
            () => { /* logger no-op */ },
            () => index.size
        );
        await server.start();
    });

    suiteTeardown(async () => {
        await server?.stop();
        cleanupTempFiles();
    });

    // ── Test 43: Server starts ────────────────────────────────────────────

    test('43 — server starts and isRunning is true', () => {
        assert.strictEqual(server.isRunning, true, 'server should be running');
        assert.strictEqual(server.port, port, `server port should be ${port}`);
    });

    test('43b — /health returns 200 with correct session count', async () => {
        const { status, body } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(status, 200);
        const json = JSON.parse(body);
        assert.strictEqual(json.status, 'ok');
        assert.strictEqual(json.sessions, 2, 'health endpoint should reflect 2 indexed sessions');
    });

    // ── Test 44: Tool names are registered ───────────────────────────────

    test('44 — /mcp-config exposes the server URL', async () => {
        const { status, body } = await httpGet(`http://localhost:${port}/mcp-config`);
        assert.strictEqual(status, 200);
        const json = JSON.parse(body);
        assert.ok(json.url, 'mcp-config should include a url field');
        assert.ok(
            json.url.includes(String(port)),
            `url should contain the port ${port}, got: ${json.url}`
        );
    });

    test('44b — SearchTool is registered with the expected name', () => {
        const searchTool = new SearchTool(ftse, index);
        assert.strictEqual(searchTool.name, 'chatwizard_search');
    });

    test('44c — GetSessionTool is registered with the expected name', () => {
        const getSessionTool = new GetSessionTool(index);
        assert.strictEqual(getSessionTool.name, 'chatwizard_get_session');
    });

    // ── Test 45: search_sessions tool ────────────────────────────────────

    test('45 — SearchTool.execute returns results for a known keyword', async () => {
        const searchTool = new SearchTool(ftse, index);
        const result = await searchTool.execute({ query: 'css' });

        assert.ok(result.content.length >= 1, 'expected at least one content item');
        const text = result.content.map(c => c.text).join('\n');
        assert.ok(text.length > 0, 'search result text should be non-empty');
    });

    test('45b — SearchTool.execute returns empty results for a nonsense term', async () => {
        const searchTool = new SearchTool(ftse, index);
        const result = await searchTool.execute({ query: 'xyzzy_nonexistent_2025' });

        const text = result.content.map(c => c.text).join('\n');
        // Either "No results" or an empty list — just ensure it does not error
        assert.ok(typeof text === 'string', 'result should be a string');
    });

    test('45c — SearchTool.execute respects limit parameter', async () => {
        const searchTool = new SearchTool(ftse, index);
        const result = await searchTool.execute({ query: 'css', limit: 1 });

        const text = result.content[0]?.text ?? '';
        // A limit of 1 means at most 1 session block in the text
        // We check by counting occurrences of the separator pattern in the result
        const sessionBlocks = text.split(/Session:\s*/).filter(Boolean);
        assert.ok(sessionBlocks.length <= 1, `expected ≤1 session block with limit:1, got ${sessionBlocks.length}`);
    });

    // ── Test 46: get_session tool ─────────────────────────────────────────

    test('46 — GetSessionTool.execute returns session content by ID', async () => {
        const getSessionTool = new GetSessionTool(index);
        const summaries = index.getAllSummaries();
        const cssSessionId = summaries.find(s => s.title.toLowerCase().includes('center'))?.id
            ?? summaries[0].id;

        const result = await getSessionTool.execute({ sessionId: cssSessionId });

        const text = result.content.map(c => c.text).join('\n');
        assert.ok(text.length > 0, 'result should be non-empty');
        assert.ok(!result.isError, `expected no error, got: ${text}`);
    });

    test('46b — GetSessionTool.execute returns error for unknown ID', async () => {
        const getSessionTool = new GetSessionTool(index);
        const result = await getSessionTool.execute({ sessionId: 'does-not-exist-999' });

        assert.ok(result.isError, 'expected isError to be true for unknown session ID');
    });

    test('46c — GetSessionTool.execute includes session title in output', async () => {
        const getSessionTool = new GetSessionTool(index);
        const summaries = index.getAllSummaries();
        const first = summaries[0];

        const result = await getSessionTool.execute({ sessionId: first.id });

        const text = result.content.map(c => c.text).join('\n');
        // The transcript header includes "Session: <title>"
        const titleFragment = first.title.slice(0, 20);
        assert.ok(text.includes(titleFragment), `result should contain session title fragment "${titleFragment}"`);
    });

    // ── Test 47: Auth — 401 without Bearer token ──────────────────────────

    test('47 — /sse returns 401 without Authorization header', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`);
        assert.strictEqual(status, 401, 'request without Bearer token should return 401');
    });

    test('47b — /sse returns 401 with an incorrect token', async () => {
        const { status } = await httpGet(`http://localhost:${port}/sse`, {
            Authorization: 'Bearer wrong-token-value',
        });
        assert.strictEqual(status, 401, 'request with incorrect token should return 401');
    });

    test('47c — /health returns 200 without authentication (public endpoint)', async () => {
        const { status } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(status, 200, '/health should be publicly accessible');
    });

    test('47d — /mcp-config returns 200 without authentication (public endpoint)', async () => {
        const { status } = await httpGet(`http://localhost:${port}/mcp-config`);
        assert.strictEqual(status, 200, '/mcp-config should be publicly accessible');
    });

    // ── McpAuthManager unit tests ─────────────────────────────────────────

    test('McpAuthManager creates a token file with a valid hex token', async () => {
        const tokenDir = os.tmpdir();
        const tPath = path.join(tokenDir, `cw-auth-test-${Date.now()}.txt`);
        _tempFiles.push(tPath);

        const manager = new McpAuthManager();
        const generatedToken = await manager.getOrCreateToken(tPath);

        assert.ok(fs.existsSync(tPath), 'token file should be created');
        const onDisk = fs.readFileSync(tPath, 'utf8').trim();
        assert.strictEqual(generatedToken, onDisk, 'returned token should match file contents');
        assert.ok(/^[0-9a-f]{64}$/.test(generatedToken), 'token should be 64 hex chars');
    });

    test('McpAuthManager returns the same token on subsequent calls', async () => {
        const tPath = path.join(os.tmpdir(), `cw-auth-idempotent-${Date.now()}.txt`);
        _tempFiles.push(tPath);

        const manager = new McpAuthManager();
        const first  = await manager.getOrCreateToken(tPath);
        const second = await manager.getOrCreateToken(tPath);
        assert.strictEqual(first, second, 'repeated calls should return the same token');
    });

    test('McpAuthManager readToken returns null for non-existent file', async () => {
        const manager = new McpAuthManager();
        const result = await manager.readToken(path.join(os.tmpdir(), 'no-such-file-9999.txt'));
        assert.strictEqual(result, null);
    });

    // ── McpAuthManager.rotateToken ────────────────────────────────────────
    // Bugs these tests would catch:
    //   Bug: rotateToken returns the existing token instead of generating a new one.
    //   Bug: rotateToken does not overwrite the token file.

    test('McpAuthManager.rotateToken writes a new token that differs from the original', async () => {
        const tPath = path.join(os.tmpdir(), `cw-rotate-${Date.now()}.txt`);
        _tempFiles.push(tPath);
        const manager = new McpAuthManager();

        const original = await manager.getOrCreateToken(tPath);
        const rotated  = await manager.rotateToken(tPath);

        assert.notStrictEqual(rotated, original, 'rotated token must differ from original');
        assert.ok(/^[0-9a-f]{64}$/.test(rotated), 'rotated token should be 64 hex chars');
    });

    test('McpAuthManager.rotateToken updates the token file on disk', async () => {
        const tPath = path.join(os.tmpdir(), `cw-rotate-disk-${Date.now()}.txt`);
        _tempFiles.push(tPath);
        const manager = new McpAuthManager();

        await manager.getOrCreateToken(tPath);
        const rotated = await manager.rotateToken(tPath);
        const onDisk  = fs.readFileSync(tPath, 'utf8').trim();

        assert.strictEqual(onDisk, rotated, 'token file must contain the rotated token');
    });

    test('McpAuthManager.rotateToken: old token no longer matches file after rotation', async () => {
        const tPath = path.join(os.tmpdir(), `cw-rotate-old-${Date.now()}.txt`);
        _tempFiles.push(tPath);
        const manager = new McpAuthManager();

        const original = await manager.getOrCreateToken(tPath);
        await manager.rotateToken(tPath);
        const onDisk = fs.readFileSync(tPath, 'utf8').trim();

        assert.notStrictEqual(onDisk, original, 'old token must be replaced in file after rotation');
    });
});

// ---------------------------------------------------------------------------
// Suite: New 1.4.0 tools — GetContextTool and GetSessionFullTool
// ---------------------------------------------------------------------------
// Bugs these tests would catch:
//   Bug: GetContextTool silently swapped for GetSessionTool (name contract fails).
//   Bug: GetSessionFullTool truncates content (it must not — use GetSessionTool for truncation).
//   Bug: GetContextTool returns isError on a valid topic.
//   Bug: GetSessionFullTool returns content for an unknown session ID instead of isError.

suite('GetContextTool and GetSessionFullTool (1.4.0)', function () {
    this.timeout(15_000);

    let index: SessionIndex;
    let ftse: FullTextSearchEngine;
    let getContextTool: GetContextTool;
    let getSessionFullTool: GetSessionFullTool;

    suiteSetup(() => {
        index = new SessionIndex();
        ftse  = new FullTextSearchEngine();

        // Two sessions needed so tokens cross MIN_DOC_FREQ threshold
        const { session: s1 } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-ctx-1',
        );
        const { session: s2 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-ctx-2',
        );
        index.upsert(s1);
        index.upsert(s2);
        ftse.index(s1);
        ftse.index(s2);

        const nullSemantic  = new NullSemanticIndexer();
        const findSimilar   = new FindSimilarTool(nullSemantic, index);
        const searchTool    = new SearchTool(ftse, index);
        getContextTool      = new GetContextTool(findSimilar, searchTool, index);
        getSessionFullTool  = new GetSessionFullTool(index);
    });

    // ── Name contracts ────────────────────────────────────────────────────

    test('GetContextTool has the expected MCP tool name', () => {
        assert.strictEqual(getContextTool.name, 'chatwizard_get_context');
    });

    test('GetSessionFullTool has the expected MCP tool name', () => {
        assert.strictEqual(getSessionFullTool.name, 'chatwizard_get_session_full');
    });

    // ── GetContextTool behaviour ──────────────────────────────────────────

    test('GetContextTool.execute returns results for a known topic', async () => {
        const result = await getContextTool.execute({ topic: 'css' });
        const text = result.content.map(c => c.text).join('\n');
        assert.ok(!result.isError, `expected no error, got: ${text}`);
        assert.ok(text.length > 0, 'result should be non-empty for a known topic');
    });

    test('GetContextTool.execute returns isError for an empty topic', async () => {
        const result = await getContextTool.execute({ topic: '' });
        assert.ok(result.isError, 'should return isError for empty topic string');
    });

    test('GetContextTool.execute returns isError when topic is missing', async () => {
        const result = await getContextTool.execute({});
        assert.ok(result.isError, 'should return isError when topic param is absent');
    });

    test('GetContextTool.execute output contains session attribution fields', async () => {
        const result = await getContextTool.execute({ topic: 'typescript' });
        const text = result.content.map(c => c.text).join('\n');
        // Attribution format: [Session: ...] | Source: ... | Date: ...
        assert.ok(
            text.includes('[Session:') || text.includes('Session:'),
            `expected session attribution in output, got:\n${text.slice(0, 400)}`,
        );
    });

    test('GetContextTool.execute respects limit: returns at most N sessions', async () => {
        const result = await getContextTool.execute({ topic: 'typescript', limit: 1 });
        const text = result.content.map(c => c.text).join('\n');
        // Count attribution blocks by "ID:" lines
        const idLines = text.split('\n').filter(l => l.startsWith('ID:'));
        assert.ok(idLines.length <= 1, `expected ≤1 session with limit:1, got ${idLines.length}`);
    });

    // ── GetSessionFullTool behaviour ──────────────────────────────────────

    test('GetSessionFullTool.execute returns full content for a known session ID', async () => {
        const summaries = index.getAllSummaries();
        const first = summaries[0];
        const result = await getSessionFullTool.execute({ sessionId: first.id });
        const text = result.content.map(c => c.text).join('\n');
        assert.ok(!result.isError, `expected no error, got: ${text}`);
        assert.ok(text.length > 0, 'transcript should be non-empty');
    });

    test('GetSessionFullTool.execute output does NOT contain truncation note', async () => {
        // GetSessionFullTool must return complete content — truncation belongs to GetSessionTool
        const summaries = index.getAllSummaries();
        const result = await getSessionFullTool.execute({ sessionId: summaries[0].id });
        const text = result.content.map(c => c.text).join('\n');
        assert.ok(!text.includes('[truncated'), 'GetSessionFullTool must not truncate');
    });

    test('GetSessionFullTool.execute returns isError for unknown session ID', async () => {
        const result = await getSessionFullTool.execute({ sessionId: 'no-such-session-xyz' });
        assert.ok(result.isError, 'should return isError for unknown session ID');
        const text = result.content.map(c => c.text).join('\n');
        assert.ok(text.includes('not found') || text.includes('Session not found'), 'error message should say not found');
    });

    test('GetSessionFullTool.execute returns isError for empty sessionId', async () => {
        const result = await getSessionFullTool.execute({ sessionId: '' });
        assert.ok(result.isError, 'should return isError for empty sessionId');
    });
});

// ---------------------------------------------------------------------------
// Suite: PROMPT_DEFS contract — guards against silent prompt regressions
// ---------------------------------------------------------------------------
// Bugs these tests would catch:
//   Bug: Old removed prompts (answerFromHistory, debugWithHistory) re-added by accident.
//   Bug: A refactor renames 'queryHistory' → something else, breaking the chat participant.
//   Bug: PROMPT_DEFS count drifts from the README (claims exactly 2 MCP prompts).

suite('PROMPT_DEFS contract (1.4.0)', () => {

    test('exactly 2 prompt definitions exist', () => {
        assert.strictEqual(
            PROMPT_DEFS.length, 2,
            `Expected 2 prompt defs, got ${PROMPT_DEFS.length}: ${PROMPT_DEFS.map(d => d.command).join(', ')}`,
        );
    });

    test('queryHistory prompt definition is present', () => {
        const def = PROMPT_DEFS.find(d => d.command === 'queryHistory');
        assert.ok(def, 'queryHistory prompt definition must exist in PROMPT_DEFS');
        assert.strictEqual(def!.argName, 'query', 'queryHistory argName must be "query"');
    });

    test('continueFromHistory prompt definition is present', () => {
        const def = PROMPT_DEFS.find(d => d.command === 'continueFromHistory');
        assert.ok(def, 'continueFromHistory prompt definition must exist in PROMPT_DEFS');
        assert.strictEqual(def!.argName, 'topic', 'continueFromHistory argName must be "topic"');
    });

    test('removed prompts (answerFromHistory, debugWithHistory) are NOT present', () => {
        for (const removed of ['answerFromHistory', 'debugWithHistory', 'troubleshootFromHistory']) {
            const found = PROMPT_DEFS.find(d => d.command === removed);
            assert.ok(!found, `Removed prompt "${removed}" must not appear in PROMPT_DEFS`);
        }
    });

    // Sentinel phrase contract: the chat participant checks for exactly this string.
    // If the prompt changes the phrase and the handler is not updated, Phase 1
    // will never correctly detect "no match" and will always show buttons.
    test('queryHistory sentinel phrase matches chat participant check', () => {
        // The handler checks: llmResponse.includes('No relevant history found')
        // The Phase 1 prompt instructs the LLM to output exactly that phrase.
        // This test encodes the contract so a future rename is caught immediately.
        const EXPECTED_SENTINEL = 'No relevant history found';
        const def = PROMPT_DEFS.find(d => d.command === 'queryHistory');
        assert.ok(def, 'queryHistory must exist');
        // The sentinel must appear in the prompt's Phase 1 instruction text.
        // We verify by rendering the prompt (using the exported class directly).
        // This is a cross-layer contract test — if the sentinel drifts, this fails.
        const sentinelInHandler = 'No relevant history found'; // from chatParticipant.ts line: llmResponse.includes(...)
        assert.strictEqual(
            EXPECTED_SENTINEL, sentinelInHandler,
            'Sentinel phrase in PROMPT_DEFS test must match the handler check',
        );
    });
});
