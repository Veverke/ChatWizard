/**
 * smoke-test-mcp-server.mjs
 * Verifies Phase 2 manual testing scenarios from docs/work-plan-mcp-server.md.
 * Run with: node scripts/smoke-test-mcp-server.mjs
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load compiled module ─────────────────────────────────────────────────────
// The compiled CJS output is in /out/ after `npm run compile`.
const outDir = path.join(__dirname, '..', 'out', 'src');
if (!fs.existsSync(outDir)) {
    console.error('ERROR: out/ directory not found. Run `npm run compile` first.');
    process.exit(1);
}

const { McpServer } = await import(pathToFileURL(path.join(outDir, 'mcp', 'mcpServer.js')).href);
const { ServerInfoTool } = await import(pathToFileURL(path.join(outDir, 'mcp', 'tools', 'serverInfoTool.js')).href);
const { SessionIndex } = await import(pathToFileURL(path.join(outDir, 'index', 'sessionIndex.js')).href);

// ── Helpers ──────────────────────────────────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
let failures = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ${PASS} ${message}`);
    } else {
        console.error(`  ${FAIL} FAILED: ${message}`);
        failures++;
    }
}

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

// ── Scenario 1: Start server with ServerInfoTool, verify health ──────────────
console.log('\nScenario 1: Start server + /health');
const TOKEN = 'smoke-test-token-abc123';
const tokenPath = path.join(os.tmpdir(), `cw-smoke-${Date.now()}.txt`);
fs.writeFileSync(tokenPath, TOKEN, 'utf8');

const sessionIndex = new SessionIndex();
const serverInfoTool = new ServerInfoTool(
    sessionIndex,
    { isReady: false, indexedCount: 0, isIndexing: false, search: async () => [] },
    '1.0.0-test',
    new Date(),
);

const server = new McpServer(
    { enabled: true, port: 19999, tokenPath },
    [serverInfoTool],
    (msg) => console.log(`  [log] ${msg}`),
    () => sessionIndex.getAllSummaries().length,
);

await server.start();
assert(server.isRunning, 'isRunning is true after start()');
assert(server.port === 19999, `port is 19999 (got ${server.port})`);

const health = await httpGet('http://localhost:19999/health');
assert(health.status === 200, `/health returns 200`);
const healthJson = JSON.parse(health.body);
assert(healthJson.status === 'ok', `/health body has status:"ok"`);
assert(typeof healthJson.sessions === 'number', `/health body has numeric sessions count`);
console.log(`  [info] sessions=${healthJson.sessions}`);

// ── Scenario 2: Request without bearer token → 401 ───────────────────────────
console.log('\nScenario 2: Auth — no token');
const noAuth = await httpGet('http://localhost:19999/sse');
assert(noAuth.status === 401, `no auth header → 401 (got ${noAuth.status})`);
const noAuthBody = JSON.parse(noAuth.body);
assert(typeof noAuthBody.error === 'string', 'response body has error field');

console.log('\nScenario 2b: Auth — wrong token');
const wrongAuth = await httpGet('http://localhost:19999/sse', { Authorization: 'Bearer wrong-token' });
assert(wrongAuth.status === 401, `wrong token → 401 (got ${wrongAuth.status})`);

// ── Scenario 3: /mcp-config endpoint ─────────────────────────────────────────
console.log('\nScenario 3: /mcp-config endpoint');
const mcpConfig = await httpGet('http://localhost:19999/mcp-config');
assert(mcpConfig.status === 200, `/mcp-config returns 200`);
const configJson = JSON.parse(mcpConfig.body);
assert(configJson.url.includes('19999'), `config includes correct port`);
assert(configJson.authorization.includes(TOKEN), `config includes the token`);
assert(configJson.endpoints?.sse, `config includes sse endpoint`);
assert(configJson.endpoints?.messages, `config includes messages endpoint`);

// ── Scenario 4: Stop → port released → re-start works ────────────────────────
console.log('\nScenario 4: stop() → port released → re-start');
await server.stop();
assert(!server.isRunning, 'isRunning is false after stop()');
assert(server.port === 0, 'port is 0 after stop()');

// Verify port is released (a new server can bind to it)
const server2 = new McpServer(
    { enabled: true, port: 19999, tokenPath },
    [],
    () => {},
    () => 0,
);
await server2.start();
assert(server2.isRunning, 'new server starts on released port');
await server2.stop();
assert(!server2.isRunning, 'new server stops cleanly');

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.unlinkSync(tokenPath);

console.log('\n' + '─'.repeat(50));
if (failures === 0) {
    console.log('\x1b[32mAll smoke tests passed.\x1b[0m');
    process.exit(0);
} else {
    console.error(`\x1b[31m${failures} smoke test(s) failed.\x1b[0m`);
    process.exit(1);
}
