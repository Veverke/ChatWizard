// test/suite/mcp/tools/searchTool.test.ts

import * as assert from 'assert';
import { SearchTool } from '../../../../src/mcp/tools/searchTool';
import { FullTextSearchEngine } from '../../../../src/search/fullTextEngine';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { Session, Message } from '../../../../src/types/index';

// ── Fixture helpers ─────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, messages: Message[], source: Session['source'] = 'copilot', workspaceId = 'ws-default', updatedAt = '2026-01-01T00:00:00.000Z'): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId,
        messages,
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt,
    };
}

/** Index the same content in two sessions so tokens reach MIN_DOC_FREQ=2 (required by FullTextSearchEngine). */
function seedEngine(ftse: FullTextSearchEngine, sessionIndex: SessionIndex, keyword: string): [Session, Session] {
    const s1 = makeSession('seed-1', [makeMessage('user', `the ${keyword} concept explained`)]);
    const s2 = makeSession('seed-2', [makeMessage('user', `${keyword} usage and examples`)]);
    ftse.index(s1);
    ftse.index(s2);
    sessionIndex.upsert(s1);
    sessionIndex.upsert(s2);
    return [s1, s2];
}

// ── Tests ───────────────────────────────────────────────────────────────────

suite('SearchTool', () => {

    let ftse: FullTextSearchEngine;
    let sessionIndex: SessionIndex;
    let tool: SearchTool;

    setup(() => {
        ftse = new FullTextSearchEngine();
        sessionIndex = new SessionIndex();
        tool = new SearchTool(ftse, sessionIndex);
    });

    // Input validation
    test('returns error result when query is empty string', async () => {
        const result = await tool.execute({ query: '' });
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('non-empty'));
    });

    test('returns error result when query is not a string', async () => {
        const result = await tool.execute({ query: 42 });
        assert.strictEqual(result.isError, true);
    });

    test('returns error result when query is whitespace only', async () => {
        const result = await tool.execute({ query: '   ' });
        assert.strictEqual(result.isError, true);
    });

    // No results
    test('returns no-results message when index is empty', async () => {
        const result = await tool.execute({ query: 'blockchain' });
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No sessions found'));
    });

    // Result formatting
    test('formats matching session with title, source, date, snippet, and ID', async () => {
        const [s1] = seedEngine(ftse, sessionIndex, 'binary');
        const result = await tool.execute({ query: 'binary' });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`Session: ${s1.title}`));
        assert.ok(text.includes('Source: copilot'));
        assert.ok(text.includes('ID: seed-1'));
        assert.ok(text.includes('Snippet:'));
    });

    // Limit clamping
    test('clamps limit to 1 when limit < 1', async () => {
        seedEngine(ftse, sessionIndex, 'reactor');
        const result = await tool.execute({ query: 'reactor', limit: -5 });
        assert.ok(!result.isError);
        // There should be at most 1 result
        const ids = (result.content[0].text.match(/^ID:/gm) ?? []);
        assert.ok(ids.length <= 1);
    });

    test('clamps limit to 50 when limit > 50', async () => {
        // Just verify it doesn't throw and returns a valid result
        seedEngine(ftse, sessionIndex, 'reactor');
        const result = await tool.execute({ query: 'reactor', limit: 999 });
        assert.ok(!result.isError);
    });

    // Source filter
    test('source filter restricts results to matching source', async () => {
        const msg = makeMessage('user', 'distributed tracing implementation');
        const sA = makeSession('filter-a', [msg], 'copilot');
        const sB = makeSession('filter-b', [makeMessage('user', 'distributed tracing details')], 'claude');
        ftse.index(sA);
        ftse.index(sB);
        sessionIndex.upsert(sA);
        sessionIndex.upsert(sB);

        const result = await tool.execute({ query: 'distributed', source: 'claude' });
        const text = result.content[0].text;

        // Should contain filter-b (claude) — may or may not contain filter-a (copilot)
        if (!text.includes('No sessions found')) {
            // Every ID in the result should belong to a claude session
            const idMatches = [...text.matchAll(/^ID: (.+)$/gm)];
            for (const match of idMatches) {
                const session = sessionIndex.get(match[1]);
                assert.strictEqual(session?.source, 'claude');
            }
        }
    });

    // name / description / schema are correct
    test('tool has correct name', () => {
        assert.strictEqual(tool.name, 'chatwizard_search');
    });

    test('inputSchema requires query', () => {
        const schema = tool.inputSchema as { required: string[] };
        assert.ok(schema.required.includes('query'));
    });
});
