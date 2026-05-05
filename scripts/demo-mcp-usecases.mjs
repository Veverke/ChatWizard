/**
 * demo-mcp-usecases.mjs
 *
 * Demonstrates the ChatWizard MCP server against real use cases from the work plan.
 *
 * Prerequisites:
 *   1. ChatWizard extension loaded in VS Code with mcpServer.enabled = true
 *   2. MCP server running (status bar shows $(broadcast) MCP)
 *
 * Usage:
 *   node scripts/demo-mcp-usecases.mjs
 *
 * The TOKEN is read from the extension's global storage automatically.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = 6789;
const BASE = `http://localhost:${PORT}`;

// Read token from the location the extension writes it
const tokenPath = join(
    process.env.APPDATA ?? join(homedir(), '.config'),
    'Code', 'User', 'globalStorage', 'veverke.chatwizard', 'mcp-token.txt'
);

if (!existsSync(tokenPath)) {
    console.error('Token file not found at:', tokenPath);
    console.error('Start the ChatWizard MCP server first (enable chatwizard.mcpServer.enabled).');
    process.exit(1);
}

const TOKEN = readFileSync(tokenPath, 'utf8').trim();

// ── Helpers ────────────────────────────────────────────────────────────────

async function callTool(toolName, args = {}) {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 9999),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    });

    const res = await fetch(`${BASE}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
        },
        body,
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${toolName}`);
    }

    const json = await res.json();
    return json.result?.content?.[0]?.text ?? JSON.stringify(json);
}

function section(title) {
    console.log('\n' + '═'.repeat(60));
    console.log(`  ${title}`);
    console.log('═'.repeat(60));
}

function print(label, text) {
    console.log(`\n▶ ${label}\n`);
    console.log(text ? text.slice(0, 1200) + (text.length > 1200 ? '\n…[truncated]' : '') : '(empty)');
}

// ── Health check ───────────────────────────────────────────────────────────

section('Health check');
try {
    const health = await fetch(`${BASE}/health`);
    const data = await health.json();
    console.log(`Server status: ${data.status} | sessions indexed: ${data.sessions}`);
} catch {
    console.error('Cannot reach MCP server on port', PORT);
    console.error('Make sure the ChatWizard extension is loaded and the server is running.');
    process.exit(1);
}

// ── Use case 8: "What did I try last time?" ────────────────────────────────

section('Use case 8 — What did I try last time?  (chatwizard_list_recent)');
const recent = await callTool('chatwizard_list_recent', { limit: 5 });
print('5 most recent sessions', recent);

// ── Use case 1: Avoiding repeated explanations ─────────────────────────────

section('Use case 1 — Avoiding repeated explanations  (chatwizard_search)');
const searchResult = await callTool('chatwizard_search', {
    query: 'architecture decision',
    limit: 3,
});
print('Sessions mentioning "architecture decision"', searchResult);

// ── Use case 6: Server info / index status ─────────────────────────────────

section('Use case: Server info  (chatwizard_server_info)');
const info = await callTool('chatwizard_server_info');
print('Server metadata', info);

// ── Use case 9: Cross-tool source breakdown ────────────────────────────────

section('Use case 9 — Cross-tool continuity  (chatwizard_list_sources)');
const sources = await callTool('chatwizard_list_sources');
print('Indexed AI tools and session counts', sources);

// ── Use case 5: Smart context retrieval ────────────────────────────────────

section('Use case 5 — Smart context  (chatwizard_get_context)');
const context = await callTool('chatwizard_get_context', {
    topic: 'error handling',
    limit: 3,
});
print('Best passages about "error handling"', context);

// ── If the first search returned a session, fetch its content ──────────────

const idMatch = searchResult.match(/^ID:\s*(\S+)/m);
if (idMatch) {
    section('Use case 2 — Fetch session content  (chatwizard_get_session)');
    const session = await callTool('chatwizard_get_session', {
        sessionId: idMatch[1],
        maxChars: 1500,
    });
    print(`Content of session ${idMatch[1]}`, session);
}

console.log('\n' + '═'.repeat(60));
console.log('  Demo complete.');
console.log('  Next step: paste the Copilot config and ask it to call these');
console.log('  tools automatically based on what you are working on.');
console.log('═'.repeat(60) + '\n');
