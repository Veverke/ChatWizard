// test/suite/mcp/tools/findSimilarTool.test.ts

import * as assert from 'assert';
import { FindSimilarTool } from '../../../../src/mcp/tools/findSimilarTool';
import { ISemanticIndexer, SemanticScope } from '../../../../src/search/semanticContracts';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { Session, Message } from '../../../../src/types/index';
import { SemanticSearchResult } from '../../../../src/search/types';

// ── Stub ISemanticIndexer ────────────────────────────────────────────────────

class StubSemanticIndexer implements ISemanticIndexer {
    isReady: boolean;
    isIndexing = false;
    indexedCount = 0;

    private _results: SemanticSearchResult[];
    private _shouldThrow: boolean;

    constructor(isReady: boolean, results: SemanticSearchResult[] = [], shouldThrow = false) {
        this.isReady = isReady;
        this._results = results;
        this._shouldThrow = shouldThrow;
    }

    async initialize(): Promise<void> {}
    scheduleSession(): void {}
    removeSession(): void {}
    dispose(): void {}

    async search(_query: string, _topK: number, _minScore?: number, _scope?: SemanticScope): Promise<SemanticSearchResult[]> {
        if (this._shouldThrow) {
            throw new Error('search engine failure');
        }
        return this._results;
    }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'copilot',
        workspaceId: 'ws-default',
        messages: [makeMessage('user', `Content for session ${id}`)],
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

suite('FindSimilarTool', () => {

    let sessionIndex: SessionIndex;

    setup(() => {
        sessionIndex = new SessionIndex();
    });

    test('returns error when query is empty', async () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(true), sessionIndex);
        const result = await tool.execute({ query: '' });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('non-empty'));
    });

    test('returns error when semantic indexer is not ready', async () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(false), sessionIndex);
        const result = await tool.execute({ query: 'event sourcing' });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.toLowerCase().includes('not available'));
    });

    test('returns no-results message when search returns empty array', async () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(true, []), sessionIndex);
        const result = await tool.execute({ query: 'some topic' });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No semantically similar sessions found'));
    });

    test('formats results with similarity score, source, date, and ID', async () => {
        const session = makeSession('sem-1');
        sessionIndex.upsert(session);

        const tool = new FindSimilarTool(
            new StubSemanticIndexer(true, [{ sessionId: 'sem-1', score: 0.87 }]),
            sessionIndex,
        );
        const result = await tool.execute({ query: 'architecture decisions' });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('ID: sem-1'));
        assert.ok(text.includes('Similarity: 0.870'));
        assert.ok(text.includes('Source: copilot'));
    });

    test('returns isError when search throws', async () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(true, [], true), sessionIndex);
        const result = await tool.execute({ query: 'crash test' });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('error'));
    });

    test('tool has correct name', () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(true), sessionIndex);
        assert.strictEqual(tool.name, 'chatwizard_find_similar');
    });

    test('inputSchema requires query', () => {
        const tool = new FindSimilarTool(new StubSemanticIndexer(true), sessionIndex);
        const schema = tool.inputSchema as { required: string[] };
        assert.ok(schema.required.includes('query'));
    });
});
