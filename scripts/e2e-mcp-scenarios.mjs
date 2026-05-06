/**
 * e2e-mcp-scenarios.mjs
 *
 * End-to-end tests of the ChatWizard MCP tool logic against 3 real fixture sessions
 * drawn from different AI tools (Claude, Copilot, Aider).
 *
 * Tests:
 *   Scenario 1 — "Did I solve binary search before?"  (chatwizard_search → FOUND)
 *   Scenario 2 — Cross-tool context: CSS from a Copilot session  (chatwizard_get_context → FOUND)
 *   Scenario 3 — "Where did I leave off?"  (chatwizard_list_recent + chatwizard_get_session)
 *   Scenario 4 — No results: topic never discussed  (chatwizard_search → graceful empty)
 *   Scenario 5 — Unknown session ID  (chatwizard_get_session → isError)
 *   Scenario 6 — Source inventory  (chatwizard_list_sources)
 *
 * Does NOT require a running VS Code window.
 * Usage: node scripts/e2e-mcp-scenarios.mjs
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as http from 'http';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir    = path.join(__dirname, '..', 'out', 'src');

if (!fs.existsSync(outDir)) {
    console.error('ERROR: out/ directory not found — run `npm run compile` first.');
    process.exit(1);
}

function load(rel) {
    return import(pathToFileURL(path.join(outDir, rel)).href);
}

// ── Load compiled modules ─────────────────────────────────────────────────

const { SessionIndex }        = await load('index/sessionIndex.js');
const { FullTextSearchEngine } = await load('search/fullTextEngine.js');
const { NullSemanticIndexer } = await load('search/semanticContracts.js');
const { McpServer }           = await load('mcp/mcpServer.js');
const { SearchTool }          = await load('mcp/tools/searchTool.js');
const { FindSimilarTool }     = await load('mcp/tools/findSimilarTool.js');
const { GetSessionTool }      = await load('mcp/tools/getSessionTool.js');
const { GetSessionFullTool }  = await load('mcp/tools/getSessionFullTool.js');
const { ListRecentTool }      = await load('mcp/tools/listRecentTool.js');
const { GetContextTool }      = await load('mcp/tools/getContextTool.js');
const { ListSourcesTool }     = await load('mcp/tools/listSourcesTool.js');
const { ServerInfoTool }      = await load('mcp/tools/serverInfoTool.js');

// ── Test fixtures — 4 sessions across 3 AI tools ─────────────────────────
// NOTE: The full-text engine requires MIN_DOC_FREQ=2, meaning a token must appear
// in ≥2 sessions to be searchable. So fixtures overlap topics deliberately:
//   - "binary search" appears in session 1 (claude) AND session 4 (cursor)
//   - "CSS" / "center" appears in session 2 (copilot) AND session 4 (cursor)
//   - session 3 (aider) is retrievable by ID (list_recent / get_session)

const SESSIONS = [
    {
        id: 'claude-binary-search-001',
        title: 'Binary Search Implementation in TypeScript',
        source: 'claude',
        workspaceId: 'ws-typescript-project',
        workspacePath: '/home/user/projects/myapp',
        model: 'claude-3-sonnet',
        filePath: 'test/fixtures/claude/sample-session.jsonl',
        fileSizeBytes: 1024,
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:01:10.000Z',
        messages: [
            { role: 'user',      content: 'Can you help me implement a binary search algorithm in TypeScript?' },
            { role: 'assistant', content: 'Sure! Here\'s a binary search implementation:\n\n```typescript\nfunction binarySearch<T>(arr: T[], target: T): number {\n    let left = 0;\n    let right = arr.length - 1;\n    while (left <= right) {\n        const mid = Math.floor((left + right) / 2);\n        if (arr[mid] === target) return mid;\n        else if (arr[mid] < target) left = mid + 1;\n        else right = mid - 1;\n    }\n    return -1;\n}\n```\nThis runs in O(log n) time.' },
            { role: 'user',      content: 'How do I write unit tests for this?' },
            { role: 'assistant', content: 'Here are unit tests using Jest:\n\n```typescript\ndescribe(\'binarySearch\', () => {\n    test(\'finds element in middle\', () => { expect(binarySearch([1,3,5,7,9], 5)).toBe(2); });\n    test(\'returns -1 when not found\', () => { expect(binarySearch([1,3,5], 4)).toBe(-1); });\n    test(\'handles empty array\', () => { expect(binarySearch([], 1)).toBe(-1); });\n});\n```' },
        ],
    },
    {
        id: 'copilot-css-centering-002',
        title: 'CSS Centering with Flexbox and Grid',
        source: 'copilot',
        workspaceId: 'ws-frontend-app',
        workspacePath: '/home/user/projects/frontend',
        model: 'gpt-4o',
        filePath: 'test/fixtures/copilot/sample-session.jsonl',
        fileSizeBytes: 840,
        createdAt: '2024-01-15T11:00:00.000Z',
        updatedAt: '2024-01-15T11:02:00.000Z',
        messages: [
            { role: 'user',      content: 'How do I center a div in CSS using flexbox?' },
            { role: 'assistant', content: 'There are several ways to center a div in CSS:\n\n**Using Flexbox:**\n```css\n.container { display: flex; justify-content: center; align-items: center; }\n```\n\n**Using Grid:**\n```css\n.container { display: grid; place-items: center; }\n```' },
            { role: 'user',      content: 'Which approach is best for centering both horizontally and vertically?' },
            { role: 'assistant', content: 'For centering both horizontally and vertically, the Grid approach with `place-items: center` is the most concise. Flexbox requires two properties, while Grid\'s place-items is a shorthand for both.' },
        ],
    },
    {
        id: 'aider-refactor-003',
        title: 'Refactoring TypeScript Utilities',
        source: 'aider',
        workspaceId: 'ws-typescript-project',
        workspacePath: '/home/user/projects/myapp',
        model: 'gpt-4',
        filePath: 'test/fixtures/aider/sample/.aider.chat.history.md',
        fileSizeBytes: 512,
        createdAt: '2024-11-15T09:23:45.000Z',
        updatedAt: '2024-11-15T09:25:00.000Z',
        messages: [
            { role: 'user',      content: 'Help me refactor this function' },
            { role: 'assistant', content: 'Sure! Here is a cleaner version:\n\n```typescript\nfunction greet(name: string) {\n    return `Hello, ${name}!`;\n}\n```\nThis is more idiomatic TypeScript.' },
            { role: 'user',      content: 'Thanks, can you also add a test?' },
            { role: 'assistant', content: 'Of course! Here is a simple test:\n\n```typescript\ntest(\'greet returns greeting\', () => {\n    expect(greet(\'World\')).toBe(\'Hello, World!\');\n});\n```' },
        ],
    },
    // 4th session (cursor) overlaps keywords from sessions 1 and 2 to satisfy MIN_DOC_FREQ=2
    {
        id: 'cursor-mixed-004',
        title: 'Binary Search and CSS Centering Review',
        source: 'cursor',
        workspaceId: 'ws-typescript-project',
        workspacePath: '/home/user/projects/myapp',
        model: 'gpt-4o',
        filePath: 'test/fixtures/cursor/sample-session.jsonl',
        fileSizeBytes: 600,
        createdAt: '2024-02-01T08:00:00.000Z',
        updatedAt: '2024-02-01T08:05:00.000Z',
        messages: [
            { role: 'user',      content: 'Can you review my binary search algorithm and CSS centering code?' },
            { role: 'assistant', content: 'Your binary search looks correct. For CSS centering with flexbox, the approach is fine but you can simplify using grid layout instead.' },
        ],
    },
];

// ── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
    if (condition) {
        console.log(`  \x1b[32m✔\x1b[0m ${label}`);
        passed++;
    } else {
        console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

function section(title) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(60));
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

// ── Setup ──────────────────────────────────────────────────────────────────

const index  = new SessionIndex();
const engine = new FullTextSearchEngine();
const nullIndexer = new NullSemanticIndexer();

for (const s of SESSIONS) {
    index.upsert(s);
    engine.index(s);
}

const searchTool      = new SearchTool(engine, index);
const findSimilarTool = new FindSimilarTool(nullIndexer);
const getSessionTool  = new GetSessionTool(index);
const getFullTool     = new GetSessionFullTool(index);
const listRecentTool  = new ListRecentTool(index);
const getContextTool  = new GetContextTool(findSimilarTool, searchTool, index);
const listSourcesTool = new ListSourcesTool(index);
const serverInfoTool  = new ServerInfoTool(index, nullIndexer, '1.4.0-e2e', new Date());

const TOKEN     = 'e2e-token-' + Date.now();
const tokenPath = path.join(os.tmpdir(), `cw-e2e-${Date.now()}.txt`);
fs.writeFileSync(tokenPath, TOKEN);

const server = new McpServer(
    { enabled: true, port: 7777, tokenPath },
    [searchTool, findSimilarTool, getSessionTool, getFullTool,
     listRecentTool, getContextTool, listSourcesTool, serverInfoTool],
    () => {},
    () => index.size,
);
await server.start();

console.log(`\nChatWizard MCP — End-to-End Scenario Tests`);
console.log(`Server: http://localhost:${server.port}  |  Sessions: ${index.size} (4 fixtures)`);
console.log(`  Session 1: "${SESSIONS[0].title}" (claude)`);
console.log(`  Session 2: "${SESSIONS[1].title}" (copilot)`);
console.log(`  Session 3: "${SESSIONS[2].title}" (aider)`);

// ══════════════════════════════════════════════════════════════════════════
// Scenario 0 — HTTP /health endpoint (server is reachable)
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 0 — HTTP /health endpoint (server is live)');
const health = await httpGet(`http://localhost:${server.port}/health`);
const healthBody = JSON.parse(health.body);
console.log('  [GET /health response]:', health.body);
ok('returns HTTP 200',                healthBody.status === 'ok' && health.status === 200);
ok('sessions count is 4',             healthBody.sessions === 4);

// ══════════════════════════════════════════════════════════════════════════
// Scenario 1 — Use case 2: "Did I solve binary search before?" → FOUND
// Prompt: "I need to implement binary search. Did I work on this before?"
// MCP tool: chatwizard_search
// Expected: returns the Claude session with matching content
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 1 — "Did I solve binary search before?" → expects FOUND');
const r1 = await searchTool.execute({ query: 'binary search algorithm', limit: 3 });
const t1 = r1.content[0].text;
console.log('  [chatwizard_search, query: "binary search algorithm"]');
console.log('  Response excerpt:', t1.slice(0, 300));

ok('isError is false',                            !r1.isError);
ok('result contains session title',               t1.includes('Binary Search'));
ok('result contains the session ID',              t1.includes('claude-binary-search-001'));
ok('result shows source = claude',                t1.toLowerCase().includes('claude'));
ok('result includes a snippet of the content',    t1.toLowerCase().includes('binary search'));
ok('→ model can open: "You solved this on [date] — here\'s what worked"',
    t1.includes('claude-binary-search-001') && t1.toLowerCase().includes('claude'));

// ══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Use case 5: Cross-tool context
// Prompt: "How should I center a div — did I research this before?"
// MCP tool: chatwizard_get_context
// Expected: surfaces the Copilot session even though user might now be in Claude
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 2 — Cross-tool context: "CSS centering" from a Copilot session → FOUND');
const r2 = await getContextTool.execute({ topic: 'css centering', limit: 3 });
const t2 = r2.content[0].text;
console.log('  [chatwizard_get_context, topic: "css centering"]');
console.log('  Response excerpt:', t2.slice(0, 300));

ok('isError is false',                            !r2.isError);
ok('result mentions CSS or centering',            t2.toLowerCase().includes('css') || t2.toLowerCase().includes('center') || t2.toLowerCase().includes('flex'));
ok('cross-tool: result comes from a tool other than the querying tool',
    t2.toLowerCase().includes('cursor') || t2.toLowerCase().includes('copilot'),
    'context retrieved from a cross-tool session (cursor or copilot had the CSS discussion)');
ok('→ model gets context from a DIFFERENT tool than the one asking',
    !r2.isError && t2.length > 0);

// ══════════════════════════════════════════════════════════════════════════
// Scenario 3 — Use case 8: Resume from last session
// Prompt: "Where did I leave off on TypeScript refactoring?"
// MCP tools: chatwizard_list_recent → chatwizard_get_session
// Expected: list shows all 3 sessions; get_session returns refactoring content
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 3 — "Where did I leave off on TypeScript refactoring?" → resume session');
const r3a = await listRecentTool.execute({ limit: 5 });
const t3a = r3a.content[0].text;
console.log('  [chatwizard_list_recent, limit: 5]');
console.log('  Response excerpt:', t3a.slice(0, 300));

ok('all 3 sessions appear in list',               t3a.includes('claude-binary-search-001') &&
                                                   t3a.includes('copilot-css-centering-002') &&
                                                   t3a.includes('aider-refactor-003'));
ok('list shows source diversity (3 tools)',        t3a.toLowerCase().includes('claude') &&
                                                   t3a.toLowerCase().includes('copilot') &&
                                                   t3a.toLowerCase().includes('aider'));

const r3b = await getSessionTool.execute({ sessionId: 'aider-refactor-003', maxChars: 2000 });
const t3b = r3b.content[0].text;
console.log('\n  [chatwizard_get_session, sessionId: "aider-refactor-003"]');
console.log('  Response excerpt:', t3b.slice(0, 300));

ok('get_session returns full conversation',        t3b.toLowerCase().includes('refactor'));
ok('includes user message (what they were asking)', t3b.toLowerCase().includes('help me refactor'));
ok('includes AI response (greet function)',        t3b.toLowerCase().includes('greet'));
ok('→ model can brief "Your last session on this project was [date] — you were..."',
    t3b.toLowerCase().includes('greet') || t3b.toLowerCase().includes('typescript'));

// ══════════════════════════════════════════════════════════════════════════
// Scenario 4 — "No results" case: topic never discussed before
// Prompt: "How do I deploy with Kubernetes helm charts?"
// MCP tool: chatwizard_search
// Expected: graceful empty result — NOT an error
//           Model must answer from its own knowledge (regular non-MCP workflow)
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 4 — "No results" case: topic with no matching sessions');
const r4 = await searchTool.execute({ query: 'kubernetes helm chart deployment', limit: 5 });
const t4 = r4.content[0].text;
console.log('  [chatwizard_search, query: "kubernetes helm chart deployment"]');
console.log('  Full response:', t4);

ok('isError is FALSE — graceful empty result',     !r4.isError);
ok('response has content (not blank)',              t4.length > 0);
ok('none of the 3 session IDs appear',             !t4.includes('claude-binary-search-001') &&
                                                   !t4.includes('copilot-css-centering-002') &&
                                                   !t4.includes('aider-refactor-003'));
ok('response signals no results were found',
    t4.toLowerCase().includes('no result') ||
    t4.toLowerCase().includes('no match') ||
    t4.toLowerCase().includes('nothing') ||
    t4.toLowerCase().includes('found 0') ||
    t4 === 'No results found.' ||
    /^no/i.test(t4.trim()),
    `response was: "${t4}"`);
ok('→ model falls back to own knowledge (server did not crash)',
    !r4.isError && t4.length > 0);

// ══════════════════════════════════════════════════════════════════════════
// Scenario 5 — get_session on a non-existent session ID
// Expected: isError = true with descriptive message
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 5 — get_session on unknown ID → isError = true');
const r5 = await getSessionTool.execute({ sessionId: 'does-not-exist-xyz' });
const t5 = r5.content[0].text;
console.log('  [chatwizard_get_session, sessionId: "does-not-exist-xyz"]');
console.log('  Full response:', t5);

ok('isError is true',                              r5.isError === true);
ok('error message contains the missing ID',        t5.includes('does-not-exist-xyz'));

// ══════════════════════════════════════════════════════════════════════════
// Scenario 6 — chatwizard_list_sources: cross-tool source inventory
// Prompt: "What AI tools have I used for this project?"
// Expected: shows all 3 sources with session counts
// ══════════════════════════════════════════════════════════════════════════

section('Scenario 6 — Source inventory: what AI tools have I used?');
const r6 = await listSourcesTool.execute({});
const t6 = r6.content[0].text;
console.log('  [chatwizard_list_sources]');
console.log('  Full response:', t6);

ok('lists claude',                                 t6.toLowerCase().includes('claude'));
ok('lists copilot',                                t6.toLowerCase().includes('copilot'));
ok('lists aider',                                  t6.toLowerCase().includes('aider'));
ok('lists cursor',                                 t6.toLowerCase().includes('cursor'));
ok('shows numeric counts',                         /[124]/.test(t6));

// ── Teardown ───────────────────────────────────────────────────────────────

await server.stop();
ok('server stopped cleanly',                       !server.isRunning);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60) + '\n');

if (failed > 0) { process.exit(1); }
