/**
 * smoke-test-phase4.mjs
 * Smoke-tests Phase 4 deliverables programmatically (no VS Code needed).
 * Tests: McpConfigHelper.getSetupInstructions, NullSemanticIndexer,
 *        all 8 tools construct+execute, server with all 8 tools wired.
 *
 * Run with: node scripts/smoke-test-phase4.mjs
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'out', 'src');

if (!fs.existsSync(outDir)) {
    console.error('ERROR: out/ not found — run `npm run compile` first.');
    process.exit(1);
}

function load(rel) {
    return import(pathToFileURL(path.join(outDir, rel)).href);
}

const { McpServer } = await load('mcp/mcpServer.js');
const { McpConfigHelper } = await load('mcp/mcpConfigHelper.js');
const { NullSemanticIndexer } = await load('search/semanticContracts.js');
const { SessionIndex } = await load('index/sessionIndex.js');
const { FullTextSearchEngine } = await load('search/fullTextEngine.js');
const { SearchTool } = await load('mcp/tools/searchTool.js');
const { FindSimilarTool } = await load('mcp/tools/findSimilarTool.js');
const { GetSessionTool } = await load('mcp/tools/getSessionTool.js');
const { GetSessionFullTool } = await load('mcp/tools/getSessionFullTool.js');
const { ListRecentTool } = await load('mcp/tools/listRecentTool.js');
const { GetContextTool } = await load('mcp/tools/getContextTool.js');
const { ListSourcesTool } = await load('mcp/tools/listSourcesTool.js');
const { ServerInfoTool } = await load('mcp/tools/serverInfoTool.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m✓\x1b[0m';
const RED   = '\x1b[31m✗\x1b[0m';
let failures = 0;
let passed = 0;

function assert(cond, msg) {
    if (cond) { console.log(`  ${GREEN} ${msg}`); passed++; }
    else        { console.error(`  ${RED} FAILED: ${msg}`); failures++; }
}

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        };
        const req = http.request(url, opts, (res) => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => resolve({ status: res.statusCode, body: out }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Section 1: McpConfigHelper.getSetupInstructions ──────────────────────────

console.log('\n[1] McpConfigHelper.getSetupInstructions()');
const helper = new McpConfigHelper();
const PORT = 7654;
const TARGETS = ['copilot', 'claude', 'cursor', 'continue', 'generic'];

for (const target of TARGETS) {
    const instructions = helper.getSetupInstructions(target, PORT);
    assert(typeof instructions === 'string' && instructions.length > 20,
        `${target}: returns non-empty string`);
    assert(instructions.startsWith('# '),
        `${target}: starts with markdown h1`);
    assert(instructions.includes(String(PORT)),
        `${target}: includes port number`);
}

// ── Section 2: NullSemanticIndexer ───────────────────────────────────────────

console.log('\n[2] NullSemanticIndexer');
const nullIndexer = new NullSemanticIndexer();
assert(nullIndexer.isReady === false, 'isReady is false');
assert(nullIndexer.isIndexing === false, 'isIndexing is false');
assert(nullIndexer.indexedCount === 0, 'indexedCount is 0');
await nullIndexer.initialize();
assert(true, 'initialize() resolves');
const results = await nullIndexer.search('test', 5);
assert(Array.isArray(results) && results.length === 0, 'search() returns empty array');

// ── Section 3: All 8 tools construct and execute ──────────────────────────────

console.log('\n[3] All 8 tools — construction and basic execution');
const index = new SessionIndex();
const engine = new FullTextSearchEngine();
const searchTool = new SearchTool(engine, index);
const findSimilarTool = new FindSimilarTool(nullIndexer, index);
const getSessionTool = new GetSessionTool(index);
const getSessionFullTool = new GetSessionFullTool(index);
const listRecentTool = new ListRecentTool(index);
const getContextTool = new GetContextTool(findSimilarTool, searchTool, index);
const listSourcesTool = new ListSourcesTool(index);
const serverInfoTool = new ServerInfoTool(index, nullIndexer, '1.3.0', new Date());

const tools = [searchTool, findSimilarTool, getSessionTool, getSessionFullTool,
               listRecentTool, getContextTool, listSourcesTool, serverInfoTool];

// Verify names
const expectedNames = [
    'chatwizard_search', 'chatwizard_find_similar', 'chatwizard_get_session',
    'chatwizard_get_session_full', 'chatwizard_list_recent', 'chatwizard_get_context',
    'chatwizard_list_sources', 'chatwizard_server_info',
];
for (let i = 0; i < tools.length; i++) {
    assert(tools[i].name === expectedNames[i], `${expectedNames[i]}: correct name`);
}

// execute with empty/invalid inputs — none should throw
const testInputs = [
    { query: '' },
    { query: 'test' },
    { sessionId: 'nonexistent-id' },
    { sessionId: 'nonexistent-id' },
    {},
    { topic: 'test' },
    {},
    {},
];
for (let i = 0; i < tools.length; i++) {
    let threw = false;
    try {
        await tools[i].execute(testInputs[i]);
    } catch {
        threw = true;
    }
    assert(!threw, `${tools[i].name}: execute() does not throw`);
}

// SearchTool specific: error on empty query
const searchEmpty = await searchTool.execute({ query: '' });
assert(searchEmpty.isError === true, 'SearchTool: empty query returns isError');

// FindSimilarTool: returns error when indexer not ready
const findEmpty = await findSimilarTool.execute({ query: 'test' });
assert(findEmpty.isError === true, 'FindSimilarTool: not-ready returns isError');

// GetSessionTool: not-found returns isError
const getSession = await getSessionTool.execute({ sessionId: 'no-such' });
assert(getSession.isError === true, 'GetSessionTool: not-found returns isError');

// ServerInfoTool: output includes version
const serverInfo = await serverInfoTool.execute({});
assert(serverInfo.content[0].text.includes('1.3.0'), 'ServerInfoTool: includes version');
assert(serverInfo.content[0].text.includes('0'), 'ServerInfoTool: includes session count');

// ── Section 4: McpServer wired with all 8 tools ───────────────────────────────

console.log('\n[4] McpServer with all 8 tools');
const TOKEN = 'ph4-smoke-test-' + Date.now();
const tokenPath = path.join(os.tmpdir(), `cw-ph4-${Date.now()}.txt`);
fs.writeFileSync(tokenPath, TOKEN, 'utf8');

const server = new McpServer(
    { enabled: true, port: 7654, tokenPath },
    [...tools],
    (msg) => { /* silent */ },
    () => index.size,
);

assert(!server.isRunning, 'server not running before start()');
await server.start();
assert(server.isRunning, 'server running after start()');
assert(server.port === 7654, 'server on correct port');

// /health — unauthenticated
const health = await httpGet('http://localhost:7654/health');
assert(health.status === 200, '/health returns 200');
const healthBody = JSON.parse(health.body);
assert(healthBody.status === 'ok', '/health body.status is ok');
assert(typeof healthBody.sessions === 'number', '/health body.sessions is a number');

// /mcp-config — unauthenticated
const mcpConfig = await httpGet('http://localhost:7654/mcp-config');
assert(mcpConfig.status === 200, '/mcp-config returns 200');
const mcpConfigBody = JSON.parse(mcpConfig.body);
assert(typeof mcpConfigBody.url === 'string', '/mcp-config has url field');

// Auth: 401 on wrong token
const badAuth = await httpGet('http://localhost:7654/sse', { Authorization: 'Bearer wrong-token' });
assert(badAuth.status === 401, 'wrong token returns 401');

// Auth: 401 on missing token
const noAuth = await httpGet('http://localhost:7654/sse');
assert(noAuth.status === 401, 'missing token returns 401');

// Stop
await server.stop();
assert(!server.isRunning, 'server stopped after stop()');

// Cleanup
fs.unlinkSync(tokenPath);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n─────────────────────────────────────`);
console.log(`Phase 4 smoke test: ${passed} passed, ${failures} failed`);
if (failures > 0) {
    console.error('SOME TESTS FAILED');
    process.exit(1);
} else {
    console.log('ALL TESTS PASSED');
}
