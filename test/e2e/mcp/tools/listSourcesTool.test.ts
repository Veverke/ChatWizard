// test/suite/mcp/tools/listSourcesTool.test.ts

import * as assert from 'assert';
import { ListSourcesTool } from '../../../../src/mcp/tools/listSourcesTool';
import { ServerInfoTool } from '../../../../src/mcp/tools/serverInfoTool';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { ISemanticIndexer, SemanticScope } from '../../../../src/search/semanticContracts';
import { Session, Message } from '../../../../src/types/index';
import { SemanticSearchResult } from '../../../../src/search/types';

// ── Stub ─────────────────────────────────────────────────────────────────────

class StubSemanticIndexer implements ISemanticIndexer {
    isReady: boolean;
    isIndexing: boolean;
    indexedCount: number;

    constructor(opts: { isReady?: boolean; isIndexing?: boolean; indexedCount?: number } = {}) {
        this.isReady = opts.isReady ?? true;
        this.isIndexing = opts.isIndexing ?? false;
        this.indexedCount = opts.indexedCount ?? 5;
    }

    async initialize(): Promise<void> {}
    scheduleSession(): void {}
    removeSession(): void {}
    dispose(): void {}
    async search(_q: string, _k: number, _s?: number, _sc?: SemanticScope): Promise<SemanticSearchResult[]> { return []; }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, source: Session['source'], updatedAt = '2026-01-01T00:00:00.000Z'): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId: 'ws-default',
        messages: [makeMessage('user', 'Hello')],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt,
    };
}

// ── ListSourcesTool tests ────────────────────────────────────────────────────

suite('ListSourcesTool', () => {

    let sessionIndex: SessionIndex;
    let tool: ListSourcesTool;

    setup(() => {
        sessionIndex = new SessionIndex();
        tool = new ListSourcesTool(sessionIndex);
    });

    test('returns message when index is empty', async () => {
        const result = await tool.execute({});
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No sessions'));
    });

    test('lists sources with correct counts', async () => {
        sessionIndex.upsert(makeSession('c1', 'copilot'));
        sessionIndex.upsert(makeSession('c2', 'copilot'));
        sessionIndex.upsert(makeSession('c3', 'claude'));

        const result = await tool.execute({});
        const text = result.content[0].text;

        assert.ok(text.includes('copilot'));
        assert.ok(text.includes('2 sessions'));
        assert.ok(text.includes('claude'));
        assert.ok(text.includes('1 session'));
    });

    test('includes total session count in header', async () => {
        sessionIndex.upsert(makeSession('s1', 'cursor'));
        sessionIndex.upsert(makeSession('s2', 'cline'));

        const result = await tool.execute({});
        assert.ok(result.content[0].text.includes('2 total sessions'));
    });

    test('includes most recent date for each source', async () => {
        sessionIndex.upsert(makeSession('s1', 'copilot', '2025-01-01T00:00:00.000Z'));
        sessionIndex.upsert(makeSession('s2', 'copilot', '2026-06-01T00:00:00.000Z'));

        const result = await tool.execute({});
        assert.ok(result.content[0].text.includes('2026-06-01'));
    });

    test('tool has correct name', () => {
        assert.strictEqual(tool.name, 'chatwizard_list_sources');
    });
});

// ── ServerInfoTool tests ─────────────────────────────────────────────────────

suite('ServerInfoTool', () => {

    let sessionIndex: SessionIndex;

    setup(() => {
        sessionIndex = new SessionIndex();
    });

    test('returns version, session count, and uptime', async () => {
        const startTime = new Date(Date.now() - 65_000); // 1 min 5 sec ago
        const tool = new ServerInfoTool(sessionIndex, new StubSemanticIndexer(), '1.2.3', startTime);

        const result = await tool.execute({});
        const text = result.content[0].text;

        assert.ok(text.includes('Version: 1.2.3'));
        assert.ok(text.includes('Total sessions: 0'));
        assert.ok(text.includes('Uptime:'));
    });

    test('lists indexed sources', async () => {
        sessionIndex.upsert(makeSession('s1', 'copilot'));
        sessionIndex.upsert(makeSession('s2', 'claude'));

        const tool = new ServerInfoTool(sessionIndex, new StubSemanticIndexer(), '1.0.0', new Date());
        const result = await tool.execute({});
        const text = result.content[0].text;

        assert.ok(text.includes('claude'));
        assert.ok(text.includes('copilot'));
    });

    test('reports semantic search as enabled when ready', async () => {
        const tool = new ServerInfoTool(
            sessionIndex,
            new StubSemanticIndexer({ isReady: true, indexedCount: 10 }),
            '1.0.0',
            new Date(),
        );
        const result = await tool.execute({});
        assert.ok(result.content[0].text.includes('enabled'));
        assert.ok(result.content[0].text.includes('10'));
    });

    test('reports semantic search as not ready when disabled', async () => {
        const tool = new ServerInfoTool(
            sessionIndex,
            new StubSemanticIndexer({ isReady: false }),
            '1.0.0',
            new Date(),
        );
        const result = await tool.execute({});
        assert.ok(result.content[0].text.includes('not ready'));
    });

    test('tool has correct name', () => {
        const tool = new ServerInfoTool(sessionIndex, new StubSemanticIndexer(), '1.0.0', new Date());
        assert.strictEqual(tool.name, 'chatwizard_server_info');
    });
});
