/**
 * smoke-test-phase3.mjs
 * Verifies Phase 3 (McpAuthManager + McpConfigHelper) end-to-end.
 * Run with: node scripts/smoke-test-phase3.mjs
 */

import { fileURLToPath, pathToFileURL } from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'out', 'src');

if (!fs.existsSync(outDir)) {
    console.error('ERROR: out/ directory not found. Run `npm run compile` first.');
    process.exit(1);
}

const { McpAuthManager } = await import(pathToFileURL(path.join(outDir, 'mcp', 'mcpAuthManager.js')).href);
const { McpConfigHelper } = await import(pathToFileURL(path.join(outDir, 'mcp', 'mcpConfigHelper.js')).href);

// ── Helpers ──────────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
let failures = 0;

function assert(cond, msg) {
    if (cond) { console.log(`  ${PASS} ${msg}`); }
    else { console.error(`  ${FAIL} FAILED: ${msg}`); failures++; }
}

// ── McpAuthManager ────────────────────────────────────────────────────────────
console.log('\nScenario 1: McpAuthManager — getOrCreateToken');
const mgr = new McpAuthManager();
const tokenPath = path.join(os.tmpdir(), `cw-smoke3-${Date.now()}.txt`);

const t1 = await mgr.getOrCreateToken(tokenPath);
assert(t1.length === 64, `generated token is 64 hex chars (got ${t1.length})`);
assert(/^[0-9a-f]{64}$/.test(t1), 'token is lowercase hex');
assert(fs.existsSync(tokenPath), 'token file was created');

const t2 = await mgr.getOrCreateToken(tokenPath);
assert(t1 === t2, 'second call returns the same token (idempotent)');

console.log('\nScenario 2: McpAuthManager — rotateToken');
const t3 = await mgr.rotateToken(tokenPath);
assert(t3 !== t1, 'rotated token differs from original');
assert(t3.length === 64, 'rotated token is 64 chars');
const onDisk = fs.readFileSync(tokenPath, 'utf8').trim();
assert(onDisk === t3, 'token on disk matches returned rotated token');

console.log('\nScenario 3: McpAuthManager — relative path rejection');
let threw = false;
try { await mgr.getOrCreateToken('relative/path.txt'); } catch { threw = true; }
assert(threw, 'getOrCreateToken throws for relative tokenPath');
threw = false;
try { await mgr.rotateToken('relative/path.txt'); } catch { threw = true; }
assert(threw, 'rotateToken throws for relative tokenPath');

fs.unlinkSync(tokenPath);

// ── McpConfigHelper ───────────────────────────────────────────────────────────
console.log('\nScenario 4: McpConfigHelper — all targets produce valid JSON with correct URL + token');
const helper = new McpConfigHelper();
const TOKEN = 'a1b2c3d4'.repeat(8);
const PORT = 6789;

for (const target of ['copilot', 'claude', 'cursor', 'continue', 'generic']) {
    const snippet = helper.getConfigSnippet(target, PORT, TOKEN);
    let obj;
    try { obj = JSON.parse(snippet); } catch (e) { assert(false, `${target}: valid JSON (parse error: ${e.message})`); continue; }
    assert(snippet.includes(`localhost:${PORT}/sse`), `${target}: includes SSE URL localhost:${PORT}/sse`);
    assert(snippet.includes(TOKEN), `${target}: includes bearer token`);
}

console.log('\nScenario 5: McpConfigHelper — structure spot-checks');
const copilot = JSON.parse(helper.getConfigSnippet('copilot', PORT, TOKEN));
assert('github.copilot.chat.mcpServers' in copilot, 'copilot: top-level key is github.copilot.chat.mcpServers');
assert('chatwizard' in copilot['github.copilot.chat.mcpServers'], 'copilot: server entry named "chatwizard"');

const claude = JSON.parse(helper.getConfigSnippet('claude', PORT, TOKEN));
assert('mcpServers' in claude, 'claude: top-level key is mcpServers');
assert('chatwizard' in claude.mcpServers, 'claude: server entry named "chatwizard"');

const cursor = JSON.parse(helper.getConfigSnippet('cursor', PORT, TOKEN));
assert('mcpServers' in cursor, 'cursor: top-level key is mcpServers');
assert('chatwizard' in cursor.mcpServers, 'cursor: server entry named "chatwizard"');

const cont = JSON.parse(helper.getConfigSnippet('continue', PORT, TOKEN));
assert(Array.isArray(cont.mcpServers), 'continue: mcpServers is an array');
assert(cont.mcpServers[0]?.name === 'chatwizard', 'continue: first entry named "chatwizard"');
assert(cont.mcpServers[0]?.transport?.type === 'sse', 'continue: transport type is "sse"');
assert(cont.mcpServers[0]?.transport?.requestOptions?.headers?.Authorization?.startsWith('Bearer '), 'continue: Authorization header under requestOptions');

const generic = JSON.parse(helper.getConfigSnippet('generic', PORT, TOKEN));
assert(Object.keys(generic).sort().join(',') === 'authorization,url', 'generic: only url and authorization keys');
assert(generic.authorization.startsWith('Bearer '), 'generic: authorization starts with "Bearer "');
assert(generic.url.endsWith('/sse'), 'generic: url ends with /sse');

console.log('\nScenario 6: McpConfigHelper — port reflects correctly');
const s9999 = helper.getConfigSnippet('copilot', 9999, TOKEN);
assert(s9999.includes('9999'), 'different port (9999) appears in snippet');
assert(!s9999.includes(`:${PORT}/`), `default port ${PORT} does not appear when 9999 is used`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (failures === 0) {
    console.log('\x1b[32mAll Phase 3 smoke tests passed.\x1b[0m');
    process.exit(0);
} else {
    console.error(`\x1b[31m${failures} smoke test(s) FAILED.\x1b[0m`);
    process.exit(1);
}
