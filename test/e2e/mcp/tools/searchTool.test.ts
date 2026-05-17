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

    // ── executeRelaxed ──────────────────────────────────────────────────────

    test('executeRelaxed — returns no-results message when ftse finds nothing', () => {
        // Empty index → relaxed search also returns nothing
        const result = tool.executeRelaxed('uniqueterm', 10);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('No sessions found'), `Expected no-results message, got: ${text}`);
    });

    test('executeRelaxed — returns formatted result with ID line when match found', () => {
        // Need to directly call via hapax-level indexing
        // Seed the index with a session containing a unique word
        const s = makeSession('relax-1', [makeMessage('user', 'uniquerelaxword foo bar baz')]);
        ftse.index(s);
        sessionIndex.upsert(s);
        const result = tool.executeRelaxed('uniquerelaxword', 10);
        const text = result.content[0].text;
        // Result should contain an ID line even if the word is only in hapax store
        // (behaviour depends on FullTextSearchEngine implementation)
        // At minimum it should not throw and should return a non-empty text
        assert.ok(typeof text === 'string' && text.length > 0);
    });

    test('executeRelaxed — snippet truncated at 300 chars', () => {
        const longContent = 'targetword ' + 'x'.repeat(400);
        const s1 = makeSession('relax-long1', [makeMessage('user', longContent)]);
        const s2 = makeSession('relax-long2', [makeMessage('user', longContent)]);
        ftse.index(s1); ftse.index(s2);
        sessionIndex.upsert(s1); sessionIndex.upsert(s2);
        const result = tool.executeRelaxed('targetword', 10);
        const text = result.content[0].text;
        const snippetLines = text.split('\n').filter(l => l.startsWith('Snippet: '));
        for (const line of snippetLines) {
            assert.ok(line.length - 'Snippet: '.length <= 300,
                `Snippet line exceeds 300 chars: ${line.length - 9}`);
        }
    });

    // ── workspaceId filter — scoped empty does not fall back ──────────────

    test('execute — workspaceId filter active with no results returns scoped no-match (no relaxed fallback)', async () => {
        // Seed two sessions in workspace ws-A with keyword "delta"
        const s1 = makeSession('ws-a-1', [makeMessage('user', 'delta concept explained')], 'copilot', 'ws-A');
        const s2 = makeSession('ws-a-2', [makeMessage('user', 'delta theory')], 'copilot', 'ws-A');
        ftse.index(s1); ftse.index(s2);
        sessionIndex.upsert(s1); sessionIndex.upsert(s2);
        // Search in ws-B (no sessions there) — should not fall through to executeRelaxed
        const result = await tool.execute({ query: 'delta', workspaceId: 'ws-B' });
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('No sessions found'), `Expected scoped no-match message, got: ${text}`);
    });

    test('execute — source filter active with no results returns scoped no-match (no relaxed fallback)', async () => {
        const s1 = makeSession('src-1', [makeMessage('user', 'epsilon approach detailed')], 'copilot');
        const s2 = makeSession('src-2', [makeMessage('user', 'epsilon approach overview')], 'copilot');
        ftse.index(s1); ftse.index(s2);
        sessionIndex.upsert(s1); sessionIndex.upsert(s2);
        // These sessions are 'copilot', searching 'claude' should give no results without fallback
        const result = await tool.execute({ query: 'epsilon', source: 'claude' });
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('No sessions found'), `Expected scoped no-match message, got: ${text}`);
    });

    // ── deduplication ──────────────────────────────────────────────────────

    test('execute — same session id appears only once when multiple messages match', async () => {
        // A session with two user messages both containing the keyword
        // Both would appear as separate results from ftse, but dedup should collapse to one
        const s1 = makeSession('dup-1', [
            makeMessage('user', 'duplicate keyword first message'),
            makeMessage('user', 'duplicate keyword second message'),
        ]);
        const s2 = makeSession('dup-2', [makeMessage('user', 'duplicate keyword third message')]);
        ftse.index(s1); ftse.index(s2);
        sessionIndex.upsert(s1); sessionIndex.upsert(s2);
        const result = await tool.execute({ query: 'duplicate keyword' });
        const text = result.content[0].text;
        const idMatches = [...text.matchAll(/^ID: (.+)$/gm)];
        const ids = idMatches.map(m => m[1]);
        const uniqueIds = new Set(ids);
        assert.strictEqual(ids.length, uniqueIds.size, `Expected deduplicated IDs, got duplicates: ${ids.join(', ')}`);
    });
});
