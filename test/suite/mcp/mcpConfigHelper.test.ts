// test/suite/mcp/mcpConfigHelper.test.ts

import * as assert from 'assert';
import { McpConfigHelper, McpConfigTarget } from '../../../src/mcp/mcpConfigHelper';

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('McpConfigHelper', () => {
    const helper = new McpConfigHelper();
    const PORT = 6789;
    const TOKEN = 'deadbeef'.repeat(8); // 64-char hex

    // ── Shared invariants ────────────────────────────────────────────────────

    const allTargets: McpConfigTarget[] = ['copilot', 'claude', 'cursor', 'continue', 'generic'];

    for (const target of allTargets) {
        test(`${target}: output is valid JSON`, () => {
            const snippet = helper.getConfigSnippet(target, PORT, TOKEN);
            assert.doesNotThrow(() => JSON.parse(snippet), `snippet for "${target}" is not valid JSON`);
        });

        test(`${target}: includes the SSE URL with correct port`, () => {
            const snippet = helper.getConfigSnippet(target, PORT, TOKEN);
            assert.ok(
                snippet.includes(`localhost:${PORT}/sse`),
                `snippet for "${target}" does not include localhost:${PORT}/sse`,
            );
        });

        test(`${target}: includes the bearer token`, () => {
            const snippet = helper.getConfigSnippet(target, PORT, TOKEN);
            assert.ok(
                snippet.includes(TOKEN),
                `snippet for "${target}" does not include the token`,
            );
        });

        test(`${target}: reflects a different port`, () => {
            const snippet = helper.getConfigSnippet(target, 9999, TOKEN);
            assert.ok(snippet.includes('9999'), `port 9999 not reflected in "${target}" snippet`);
            assert.ok(!snippet.includes(`:${PORT}/`), `default port ${PORT} should not appear when 9999 is used`);
        });
    }

    // ── Copilot ──────────────────────────────────────────────────────────────

    suite('copilot', () => {
        test('wraps entry under github.copilot.chat.mcpServers', () => {
            const obj = JSON.parse(helper.getConfigSnippet('copilot', PORT, TOKEN));
            assert.ok(
                'github.copilot.chat.mcpServers' in obj,
                'top-level key is github.copilot.chat.mcpServers',
            );
        });

        test('server entry is named "chatwizard"', () => {
            const obj = JSON.parse(helper.getConfigSnippet('copilot', PORT, TOKEN));
            const servers = obj['github.copilot.chat.mcpServers'];
            assert.ok('chatwizard' in servers, 'server entry is named "chatwizard"');
        });

        test('Authorization header value starts with "Bearer "', () => {
            const obj = JSON.parse(helper.getConfigSnippet('copilot', PORT, TOKEN));
            const entry = obj['github.copilot.chat.mcpServers']['chatwizard'];
            assert.ok(
                entry.headers?.Authorization?.startsWith('Bearer '),
                'Authorization header starts with Bearer',
            );
        });
    });

    // ── Claude Desktop ────────────────────────────────────────────────────────

    suite('claude', () => {
        test('wraps entry under mcpServers', () => {
            const obj = JSON.parse(helper.getConfigSnippet('claude', PORT, TOKEN));
            assert.ok('mcpServers' in obj, 'top-level key is mcpServers');
        });

        test('server entry is named "chatwizard"', () => {
            const obj = JSON.parse(helper.getConfigSnippet('claude', PORT, TOKEN));
            assert.ok('chatwizard' in obj.mcpServers);
        });

        test('Authorization header value starts with "Bearer "', () => {
            const obj = JSON.parse(helper.getConfigSnippet('claude', PORT, TOKEN));
            const entry = obj.mcpServers.chatwizard;
            assert.ok(entry.headers?.Authorization?.startsWith('Bearer '));
        });
    });

    // ── Cursor ────────────────────────────────────────────────────────────────

    suite('cursor', () => {
        test('wraps entry under mcpServers', () => {
            const obj = JSON.parse(helper.getConfigSnippet('cursor', PORT, TOKEN));
            assert.ok('mcpServers' in obj);
        });

        test('server entry is named "chatwizard"', () => {
            const obj = JSON.parse(helper.getConfigSnippet('cursor', PORT, TOKEN));
            assert.ok('chatwizard' in obj.mcpServers);
        });

        test('Authorization header value starts with "Bearer "', () => {
            const obj = JSON.parse(helper.getConfigSnippet('cursor', PORT, TOKEN));
            const entry = obj.mcpServers.chatwizard;
            assert.ok(entry.headers?.Authorization?.startsWith('Bearer '));
        });
    });

    // ── Continue ──────────────────────────────────────────────────────────────

    suite('continue', () => {
        test('mcpServers is an array', () => {
            const obj = JSON.parse(helper.getConfigSnippet('continue', PORT, TOKEN));
            assert.ok(Array.isArray(obj.mcpServers), 'mcpServers is an array');
        });

        test('array entry has name "chatwizard"', () => {
            const obj = JSON.parse(helper.getConfigSnippet('continue', PORT, TOKEN));
            assert.strictEqual(obj.mcpServers[0]?.name, 'chatwizard');
        });

        test('transport type is sse', () => {
            const obj = JSON.parse(helper.getConfigSnippet('continue', PORT, TOKEN));
            assert.strictEqual(obj.mcpServers[0]?.transport?.type, 'sse');
        });

        test('Authorization header is nested under transport.requestOptions.headers', () => {
            const obj = JSON.parse(helper.getConfigSnippet('continue', PORT, TOKEN));
            const headers = obj.mcpServers[0]?.transport?.requestOptions?.headers;
            assert.ok(headers?.Authorization?.startsWith('Bearer '));
        });
    });

    // ── Generic ───────────────────────────────────────────────────────────────

    suite('generic', () => {
        test('has exactly url and authorization at top level', () => {
            const obj = JSON.parse(helper.getConfigSnippet('generic', PORT, TOKEN));
            const keys = Object.keys(obj).sort();
            assert.deepStrictEqual(keys, ['authorization', 'url']);
        });

        test('authorization value starts with "Bearer "', () => {
            const obj = JSON.parse(helper.getConfigSnippet('generic', PORT, TOKEN));
            assert.ok(obj.authorization.startsWith('Bearer '));
        });

        test('url points to the SSE endpoint', () => {
            const obj = JSON.parse(helper.getConfigSnippet('generic', PORT, TOKEN));
            assert.ok(obj.url.endsWith('/sse'));
        });
    });
});
