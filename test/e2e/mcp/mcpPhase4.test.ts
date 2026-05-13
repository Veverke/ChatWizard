// test/suite/mcp/mcpPhase4.test.ts
//
// Unit tests for Phase 4 deliverables:
//   1. McpConfigHelper.getSetupInstructions() — all 5 targets
//   2. NullSemanticIndexer — implements ISemanticIndexer contract with safe no-ops
//   3. Integration: all 8 tools can be constructed with a live SessionIndex + NullSemanticIndexer

import * as assert from 'assert';
import { McpConfigHelper, McpConfigTarget } from '../../../src/mcp/mcpConfigHelper';
import { NullSemanticIndexer } from '../../../src/search/semanticContracts';
import { SessionIndex } from '../../../src/index/sessionIndex';
import { FullTextSearchEngine } from '../../../src/search/fullTextEngine';
import { SearchTool } from '../../../src/mcp/tools/searchTool';
import { FindSimilarTool } from '../../../src/mcp/tools/findSimilarTool';
import { GetSessionTool } from '../../../src/mcp/tools/getSessionTool';
import { GetSessionFullTool } from '../../../src/mcp/tools/getSessionFullTool';
import { ListRecentTool } from '../../../src/mcp/tools/listRecentTool';
import { GetContextTool } from '../../../src/mcp/tools/getContextTool';
import { ListSourcesTool } from '../../../src/mcp/tools/listSourcesTool';
import { ServerInfoTool } from '../../../src/mcp/tools/serverInfoTool';

// ── McpConfigHelper.getSetupInstructions() ───────────────────────────────────

suite('McpConfigHelper.getSetupInstructions()', () => {
    const helper = new McpConfigHelper();
    const PORT = 6789;
    const allTargets: McpConfigTarget[] = ['copilot', 'claude', 'cursor', 'continue', 'generic'];

    for (const target of allTargets) {
        test(`${target}: returns a non-empty string`, () => {
            const instructions = helper.getSetupInstructions(target, PORT);
            assert.ok(typeof instructions === 'string' && instructions.length > 0,
                `getSetupInstructions("${target}") should return a non-empty string`);
        });

        test(`${target}: contains the port number`, () => {
            const instructions = helper.getSetupInstructions(target, PORT);
            assert.ok(instructions.includes(String(PORT)),
                `instructions for "${target}" should mention port ${PORT}`);
        });

        test(`${target}: starts with a markdown heading`, () => {
            const instructions = helper.getSetupInstructions(target, PORT);
            assert.ok(instructions.startsWith('# '),
                `instructions for "${target}" should start with a markdown h1 heading`);
        });

        test(`${target}: reflects a different port`, () => {
            const instructions = helper.getSetupInstructions(target, 9999);
            assert.ok(instructions.includes('9999'),
                `instructions for "${target}" should mention port 9999`);
        });
    }

    test('copilot: mentions settings.json', () => {
        const instructions = helper.getSetupInstructions('copilot', PORT);
        assert.ok(instructions.includes('settings.json'),
            'copilot instructions should mention settings.json');
    });

    test('claude: mentions claude_desktop_config.json', () => {
        const instructions = helper.getSetupInstructions('claude', PORT);
        assert.ok(instructions.includes('claude_desktop_config.json'),
            'claude instructions should mention claude_desktop_config.json');
    });

    test('cursor: mentions .cursor/mcp.json', () => {
        const instructions = helper.getSetupInstructions('cursor', PORT);
        assert.ok(instructions.includes('.cursor/mcp.json'),
            'cursor instructions should mention .cursor/mcp.json');
    });

    test('continue: mentions .continue/config.json', () => {
        const instructions = helper.getSetupInstructions('continue', PORT);
        assert.ok(instructions.includes('.continue/config.json'),
            'continue instructions should mention .continue/config.json');
    });

    test('generic: includes SSE endpoint reference', () => {
        const instructions = helper.getSetupInstructions('generic', PORT);
        assert.ok(instructions.includes('/sse'),
            'generic instructions should include SSE endpoint reference');
    });

    test('throws on unsupported target', () => {
        assert.throws(
            () => helper.getSetupInstructions('unsupported' as McpConfigTarget, PORT),
            /Unsupported MCP config target/,
        );
    });
});

// ── NullSemanticIndexer ───────────────────────────────────────────────────────

suite('NullSemanticIndexer', () => {
    let indexer: NullSemanticIndexer;

    setup(() => { indexer = new NullSemanticIndexer(); });

    test('isReady is always false', () => {
        assert.strictEqual(indexer.isReady, false);
    });

    test('isIndexing is always false', () => {
        assert.strictEqual(indexer.isIndexing, false);
    });

    test('indexedCount is always 0', () => {
        assert.strictEqual(indexer.indexedCount, 0);
    });

    test('initialize() resolves without throwing', async () => {
        await assert.doesNotReject(() => indexer.initialize());
    });

    test('scheduleSession() does not throw', () => {
        assert.doesNotThrow(() => indexer.scheduleSession({
            id: 'test', title: 'T', source: 'copilot',
            messages: [], updatedAt: '2025-01-01',
            workspaceId: 'ws1', filePath: '/tmp/test.json', createdAt: '2025-01-01',
        } as unknown as import('../../../src/types/index').Session));
    });

    test('removeSession() does not throw', () => {
        assert.doesNotThrow(() => indexer.removeSession('any-id'));
    });

    test('search() returns empty array', async () => {
        const results = await indexer.search('anything', 10);
        assert.deepStrictEqual(results, []);
    });

    test('dispose() does not throw', () => {
        assert.doesNotThrow(() => indexer.dispose());
    });
});

// ── Tool construction integration ─────────────────────────────────────────────
// Verifies that all 8 tools can be instantiated with the same objects passed in
// extension.ts and that execute() returns a McpToolResult (not a thrown error).

suite('All 8 MCP tools construct and execute safely', () => {
    let index: SessionIndex;
    let engine: FullTextSearchEngine;
    let nullIndexer: NullSemanticIndexer;
    let searchTool: SearchTool;
    let findSimilarTool: FindSimilarTool;

    setup(() => {
        index = new SessionIndex();
        engine = new FullTextSearchEngine();
        nullIndexer = new NullSemanticIndexer();
        searchTool = new SearchTool(engine, index);
        findSimilarTool = new FindSimilarTool(nullIndexer, index);
    });

    test('SearchTool: has correct name and executes without throwing', async () => {
        assert.strictEqual(searchTool.name, 'chatwizard_search');
        const result = await searchTool.execute({ query: 'test' });
        assert.ok(Array.isArray(result.content) && result.content.length > 0);
    });

    test('FindSimilarTool: has correct name and returns not-ready message when indexer not ready', async () => {
        assert.strictEqual(findSimilarTool.name, 'chatwizard_find_similar');
        const result = await findSimilarTool.execute({ query: 'test' });
        // NullSemanticIndexer.isReady is false so tool should return an error message
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.toLowerCase().includes('not') ||
                  result.content[0].text.toLowerCase().includes('disabled') ||
                  result.content[0].text.toLowerCase().includes('ready'),
                  'should mention not ready/disabled status');
    });

    test('GetSessionTool: has correct name and returns isError for unknown ID', async () => {
        const tool = new GetSessionTool(index);
        assert.strictEqual(tool.name, 'chatwizard_get_session');
        const result = await tool.execute({ sessionId: 'no-such-id' });
        assert.strictEqual(result.isError, true);
    });

    test('GetSessionFullTool: has correct name and returns isError for unknown ID', async () => {
        const tool = new GetSessionFullTool(index);
        assert.strictEqual(tool.name, 'chatwizard_get_session_full');
        const result = await tool.execute({ sessionId: 'no-such-id' });
        assert.strictEqual(result.isError, true);
    });

    test('ListRecentTool: has correct name and returns empty-sessions message', async () => {
        const tool = new ListRecentTool(index);
        assert.strictEqual(tool.name, 'chatwizard_list_recent');
        const result = await tool.execute({});
        assert.ok(Array.isArray(result.content) && result.content.length > 0);
    });

    test('GetContextTool: has correct name and executes without throwing', async () => {
        const tool = new GetContextTool(findSimilarTool, searchTool, index);
        assert.strictEqual(tool.name, 'chatwizard_get_context');
        const result = await tool.execute({ topic: 'test topic' });
        assert.ok(Array.isArray(result.content) && result.content.length > 0);
    });

    test('ListSourcesTool: has correct name and returns no-sessions message for empty index', async () => {
        const tool = new ListSourcesTool(index);
        assert.strictEqual(tool.name, 'chatwizard_list_sources');
        const result = await tool.execute({});
        assert.ok(result.content[0].text.includes('No sessions'));
    });

    test('ServerInfoTool: has correct name and returns version and session count', async () => {
        const tool = new ServerInfoTool(index, nullIndexer, '1.3.0', new Date());
        assert.strictEqual(tool.name, 'chatwizard_server_info');
        const result = await tool.execute({});
        const text = result.content[0].text;
        assert.ok(text.includes('1.3.0'), 'should include version');
        assert.ok(text.includes('0'), 'should include zero session count');
    });

    test('ServerInfoTool: semantic search status says not ready when using NullSemanticIndexer', async () => {
        const tool = new ServerInfoTool(index, nullIndexer, '1.0.0', new Date());
        const result = await tool.execute({});
        const text = result.content[0].text;
        assert.ok(text.toLowerCase().includes('not ready') || text.toLowerCase().includes('disabled'),
            'should indicate semantic search is not ready');
    });

    test('All 8 tools have non-empty descriptions', () => {
        const tools = [
            searchTool,
            findSimilarTool,
            new GetSessionTool(index),
            new GetSessionFullTool(index),
            new ListRecentTool(index),
            new GetContextTool(findSimilarTool, searchTool, index),
            new ListSourcesTool(index),
            new ServerInfoTool(index, nullIndexer, '1.0.0', new Date()),
        ];
        for (const tool of tools) {
            assert.ok(tool.description.length > 0, `${tool.name} should have a non-empty description`);
        }
    });

    test('All 8 tools have unique names', () => {
        const tools = [
            searchTool,
            findSimilarTool,
            new GetSessionTool(index),
            new GetSessionFullTool(index),
            new ListRecentTool(index),
            new GetContextTool(findSimilarTool, searchTool, index),
            new ListSourcesTool(index),
            new ServerInfoTool(index, nullIndexer, '1.0.0', new Date()),
        ];
        const names = tools.map(t => t.name);
        const unique = new Set(names);
        assert.strictEqual(unique.size, names.length, 'all tool names must be unique');
    });

    test('All 8 tools have valid JSON Schema inputSchema', () => {
        const tools = [
            searchTool,
            findSimilarTool,
            new GetSessionTool(index),
            new GetSessionFullTool(index),
            new ListRecentTool(index),
            new GetContextTool(findSimilarTool, searchTool, index),
            new ListSourcesTool(index),
            new ServerInfoTool(index, nullIndexer, '1.0.0', new Date()),
        ];
        for (const tool of tools) {
            const schema = tool.inputSchema as { type?: unknown; required?: unknown };
            assert.strictEqual(schema.type, 'object', `${tool.name} inputSchema.type should be "object"`);
            assert.ok(Array.isArray(schema.required), `${tool.name} inputSchema.required should be an array`);
        }
    });
});

// ── GetContextTool: semantic branch regression ────────────────────────────────
// Verifies that when a ready ISemanticIndexer returns a known session, GetContextTool
// merges those semantic results into its output (catches the {topic} vs {query} bug).

import { ISemanticIndexer, SemanticScope } from '../../../src/search/semanticContracts';
import { SemanticSearchResult } from '../../../src/search/types';
import { Session } from '../../../src/types/index';

class ReadyStubSemanticIndexer implements ISemanticIndexer {
    constructor(private readonly _result: SemanticSearchResult) {}
    readonly isReady = true;
    readonly isIndexing = false;
    readonly indexedCount = 1;
    initialize(): Promise<void> { return Promise.resolve(); }
    scheduleSession(_s: Session): void { /* no-op */ }
    removeSession(_id: string): void { /* no-op */ }
    search(_query: string, _topK: number, _minScore?: number, _scope?: SemanticScope): Promise<SemanticSearchResult[]> {
        return Promise.resolve([this._result]);
    }
    dispose(): void { /* no-op */ }
}

suite('GetContextTool: semantic branch', () => {
    const KNOWN_SESSION_ID = 'stub-session-abc123';

    test('includes session from semantic search results when indexer is ready', async () => {
        const localIndex = new SessionIndex();
        localIndex.upsert({
            id: KNOWN_SESSION_ID,
            title: 'Stub Session',
            source: 'copilot',
            messages: [{ role: 'user', content: 'Hello from stub session', timestamp: '' }],
            updatedAt: '2025-01-01',
            createdAt: '2025-01-01',
            workspaceId: 'ws-stub',
            filePath: '/tmp/stub.json',
        } as unknown as Session);

        const stub = new ReadyStubSemanticIndexer({ sessionId: KNOWN_SESSION_ID, score: 0.9 });
        const stubFindSimilar = new FindSimilarTool(stub, localIndex);
        const stubSearch = new SearchTool(new FullTextSearchEngine(), localIndex);
        const tool = new GetContextTool(stubFindSimilar, stubSearch, localIndex);

        const result = await tool.execute({ topic: 'test topic' });

        assert.notStrictEqual(result.isError, true, 'should not return an error');
        const text = result.content[0]?.text ?? '';
        assert.ok(
            text.includes(`ID: ${KNOWN_SESSION_ID}`),
            `expected output to include "ID: ${KNOWN_SESSION_ID}" but got:\n${text}`,
        );
    });
});
