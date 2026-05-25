// test/e2e/mcp/tools/searchToolEntityFilter.test.ts
//
// Real-world tests for the entityType + entityValue filter added to SearchTool
// (Feature 19-D: entity-aware search filtering).
//
// The entity filter relies on FullTextSearchEngine.setMetadataGetter(), which
// allows the engine to look up pre-extracted entities at query time.  These
// tests exercise the full stack: tool.execute() → ftse.search() → filter.

import * as assert from 'assert';
import { SearchTool } from '../../../../src/mcp/tools/searchTool';
import { FullTextSearchEngine } from '../../../../src/search/fullTextEngine';
import { SessionIndex } from '../../../../src/index/sessionIndex';
import { Session, Message } from '../../../../src/types/index';
import type { ExtractedEntities } from '../../../../src/types/index';

// ── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-ent-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(
    id: string,
    messages: Message[],
    source: Session['source'] = 'copilot',
    workspaceId = 'ws-ent',
): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId,
        messages,
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

/**
 * Seed two sessions sharing the same body text so the token reaches
 * MIN_DOC_FREQ = 2 in the FullTextSearchEngine main index.
 */
function seedTwo(
    ftse: FullTextSearchEngine,
    idx: SessionIndex,
    keyword: string,
    suffix = '',
): [Session, Session] {
    const s1 = makeSession(`ent-s1-${keyword}`, [makeMessage('user', `${keyword} approach ${suffix}`)]);
    const s2 = makeSession(`ent-s2-${keyword}`, [makeMessage('user', `${keyword} technique ${suffix}`)]);
    ftse.index(s1);
    ftse.index(s2);
    idx.upsert(s1);
    idx.upsert(s2);
    return [s1, s2];
}

// ── Suite ───────────────────────────────────────────────────────────────────

suite('SearchTool — entityType / entityValue filter', () => {

    let ftse: FullTextSearchEngine;
    let idx: SessionIndex;
    let tool: SearchTool;
    /** In-memory metadata store for the getter. */
    const metaStore = new Map<string, { entities?: ExtractedEntities }>();

    setup(() => {
        ftse = new FullTextSearchEngine();
        idx = new SessionIndex();
        metaStore.clear();
        // Wire the getter so entity filters work inside FullTextSearchEngine.
        ftse.setMetadataGetter(id => metaStore.get(id));
        tool = new SearchTool(ftse, idx);
    });

    // ── Schema surface-area ─────────────────────────────────────────────────

    test('inputSchema exposes entityType property', () => {
        const schema = tool.inputSchema as {
            properties: Record<string, { type: string; enum?: string[] }>;
        };
        assert.ok(schema.properties['entityType'], 'entityType must be in inputSchema.properties');
        assert.strictEqual(schema.properties['entityType'].type, 'string');
    });

    test('inputSchema entityType has correct enum values', () => {
        const schema = tool.inputSchema as {
            properties: Record<string, { enum?: string[] }>;
        };
        const enums = schema.properties['entityType'].enum ?? [];
        assert.ok(enums.includes('filePaths'), 'enum must include filePaths');
        assert.ok(enums.includes('functionNames'), 'enum must include functionNames');
        assert.ok(enums.includes('errors'), 'enum must include errors');
        assert.ok(enums.includes('decisions'), 'enum must include decisions');
    });

    test('inputSchema exposes entityValue property', () => {
        const schema = tool.inputSchema as {
            properties: Record<string, { type: string }>;
        };
        assert.ok(schema.properties['entityValue'], 'entityValue must be in inputSchema.properties');
        assert.strictEqual(schema.properties['entityValue'].type, 'string');
    });

    // ── Real-world scenario: dev traces a TypeError to specific sessions ─────

    test('developer traces TypeError: only sessions that recorded that error are returned', async () => {
        // Two sessions discuss "authentication" — but only one had the TypeError logged.
        const sWithError = makeSession('auth-err-1', [
            makeMessage('user', 'authentication flow debugging'),
        ]);
        const sClean = makeSession('auth-err-2', [
            makeMessage('user', 'authentication flow debugging continued'),
        ]);
        ftse.index(sWithError);
        ftse.index(sClean);
        idx.upsert(sWithError);
        idx.upsert(sClean);

        // Only sWithError has the extracted error entity.
        metaStore.set(sWithError.id, { entities: { errors: ['TypeError: Cannot read property auth'], filePaths: [], functionNames: [], decisions: [] } });
        metaStore.set(sClean.id,     { entities: { errors: [], filePaths: [], functionNames: [], decisions: [] } });

        const result = await tool.execute({
            query: 'authentication',
            entityType: 'errors',
            entityValue: 'TypeError',
        });

        assert.ok(!result.isError, `Unexpected error: ${result.content[0].text}`);
        const text = result.content[0].text;

        assert.ok(text.includes(`ID: ${sWithError.id}`), 'session with matching error must appear');
        assert.ok(!text.includes(`ID: ${sClean.id}`), 'session without the error must be excluded');
    });

    // ── Real-world scenario: narrow by affected source file ─────────────────

    test('filePaths filter — only sessions touching auth.ts are returned', async () => {
        const sA = makeSession('fp-a', [makeMessage('user', 'middleware refactor details')]);
        const sB = makeSession('fp-b', [makeMessage('user', 'middleware refactor implementation')]);
        ftse.index(sA);
        ftse.index(sB);
        idx.upsert(sA);
        idx.upsert(sB);

        metaStore.set(sA.id, { entities: { filePaths: ['src/auth.ts', 'src/middleware.ts'], functionNames: [], errors: [], decisions: [] } });
        metaStore.set(sB.id, { entities: { filePaths: ['src/middleware.ts'], functionNames: [], errors: [], decisions: [] } });

        const result = await tool.execute({
            query: 'middleware',
            entityType: 'filePaths',
            entityValue: 'auth.ts',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${sA.id}`), 'session with auth.ts must appear');
        assert.ok(!text.includes(`ID: ${sB.id}`), 'session without auth.ts must be excluded');
    });

    // ── Real-world scenario: find where postgres decision was made ───────────

    test('decisions filter — locates session where postgres was selected', async () => {
        const sPostgres = makeSession('dec-pg', [makeMessage('user', 'database selection process')]);
        const sMysql    = makeSession('dec-my', [makeMessage('user', 'database selection comparison')]);
        ftse.index(sPostgres);
        ftse.index(sMysql);
        idx.upsert(sPostgres);
        idx.upsert(sMysql);

        metaStore.set(sPostgres.id, { entities: { decisions: ['use postgres for persistence', 'add pgvector extension'], filePaths: [], functionNames: [], errors: [] } });
        metaStore.set(sMysql.id,    { entities: { decisions: ['use mysql replication'], filePaths: [], functionNames: [], errors: [] } });

        const result = await tool.execute({
            query: 'database',
            entityType: 'decisions',
            entityValue: 'postgres',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${sPostgres.id}`), 'postgres decision session must appear');
        assert.ok(!text.includes(`ID: ${sMysql.id}`), 'mysql-only session must be excluded');
    });

    // ── entityValue matching is case-insensitive ─────────────────────────────

    test('entityValue match is case-insensitive', async () => {
        const s1 = makeSession('ci-1', [makeMessage('user', 'typescript compilation pipeline')]);
        const s2 = makeSession('ci-2', [makeMessage('user', 'typescript compilation errors')]);
        ftse.index(s1);
        ftse.index(s2);
        idx.upsert(s1);
        idx.upsert(s2);

        // Error stored with mixed case
        metaStore.set(s1.id, { entities: { errors: ['ReferenceError: cannot find module'], filePaths: [], functionNames: [], decisions: [] } });
        metaStore.set(s2.id, { entities: { errors: [], filePaths: [], functionNames: [], decisions: [] } });

        // Search with upper-case "REFERENCEERROR"
        const result = await tool.execute({
            query: 'typescript',
            entityType: 'errors',
            entityValue: 'REFERENCEERROR',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${s1.id}`), 'case-insensitive match must return session with ReferenceError');
    });

    // ── entityType alone (without entityValue) is a no-op ───────────────────

    test('entityType without entityValue does not filter results', async () => {
        const [s1, s2] = seedTwo(ftse, idx, 'reactor');
        // Give s1 some entity metadata and s2 nothing.
        metaStore.set(s1.id, { entities: { filePaths: ['reactor.ts'], functionNames: [], errors: [], decisions: [] } });
        // s2 has no metadata at all.

        // No entityValue → filter should be a no-op and both sessions returned.
        const result = await tool.execute({
            query: 'reactor',
            entityType: 'filePaths',
            // entityValue intentionally omitted
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${s1.id}`), 's1 should appear when no entityValue');
        assert.ok(text.includes(`ID: ${s2.id}`), 's2 should also appear when no entityValue');
    });

    // ── entityValue alone (without entityType) is a no-op ───────────────────

    test('entityValue without entityType does not filter results', async () => {
        const [s1, s2] = seedTwo(ftse, idx, 'neutron');

        metaStore.set(s1.id, { entities: { filePaths: ['neutron.ts'], functionNames: [], errors: [], decisions: [] } });

        // No entityType → filter must be a no-op.
        const result = await tool.execute({
            query: 'neutron',
            // entityType omitted
            entityValue: 'neutron.ts',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${s1.id}`), 's1 should appear when no entityType');
        assert.ok(text.includes(`ID: ${s2.id}`), 's2 should also appear when no entityType');
    });

    // ── Combined: source filter + entity filter both applied ─────────────────

    test('entity filter + source filter are applied conjunctively', async () => {
        // sMatch: correct source AND has matching entity.
        // sWrongSource: has entity but wrong source.
        // sNoEntity: correct source but no entity match.
        const sMatch      = makeSession('combo-match',       [makeMessage('user', 'vector database embeddings')], 'claude');
        const sWrongSrc   = makeSession('combo-wrong-src',   [makeMessage('user', 'vector database embeddings search')], 'copilot');
        const sNoEntity   = makeSession('combo-no-entity',   [makeMessage('user', 'vector database embeddings usage')], 'claude');

        ftse.index(sMatch);
        ftse.index(sWrongSrc);
        ftse.index(sNoEntity);
        idx.upsert(sMatch);
        idx.upsert(sWrongSrc);
        idx.upsert(sNoEntity);

        metaStore.set(sMatch.id,    { entities: { functionNames: ['embedQuery', 'upsertVector'], filePaths: [], errors: [], decisions: [] } });
        metaStore.set(sWrongSrc.id, { entities: { functionNames: ['embedQuery'], filePaths: [], errors: [], decisions: [] } });
        metaStore.set(sNoEntity.id, { entities: { functionNames: ['other'], filePaths: [], errors: [], decisions: [] } });

        const result = await tool.execute({
            query: 'vector',
            source: 'claude',
            entityType: 'functionNames',
            entityValue: 'embedQuery',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${sMatch.id}`), 'sMatch (claude + embedQuery) must appear');
        assert.ok(!text.includes(`ID: ${sWrongSrc.id}`), 'sWrongSrc (copilot) must be excluded by source filter');
        assert.ok(!text.includes(`ID: ${sNoEntity.id}`), 'sNoEntity must be excluded by entity filter');
    });

    // ── Sessions with no metadata entry are excluded by entity filter ────────

    test('session with no metadata entry is excluded when entity filter active', async () => {
        const sWithMeta    = makeSession('meta-present', [makeMessage('user', 'kubernetes deployment manifest')]);
        const sWithoutMeta = makeSession('meta-absent',  [makeMessage('user', 'kubernetes deployment rollout')]);

        ftse.index(sWithMeta);
        ftse.index(sWithoutMeta);
        idx.upsert(sWithMeta);
        idx.upsert(sWithoutMeta);

        // Only sWithMeta has a matching entity; sWithoutMeta has no metadata → empty list → excluded.
        metaStore.set(sWithMeta.id, { entities: { filePaths: ['k8s/deploy.yaml'], functionNames: [], errors: [], decisions: [] } });
        // sWithoutMeta deliberately has NO entry in metaStore.

        const result = await tool.execute({
            query: 'kubernetes',
            entityType: 'filePaths',
            entityValue: 'deploy.yaml',
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${sWithMeta.id}`), 'session with matching filePath must appear');
        assert.ok(!text.includes(`ID: ${sWithoutMeta.id}`), 'session without metadata must be excluded');
    });

    // ── entityValue substring matching (partial path) ────────────────────────

    test('entityValue matches as substring — partial file path works', async () => {
        const s1 = makeSession('sub-1', [makeMessage('user', 'caching strategy implementation')]);
        const s2 = makeSession('sub-2', [makeMessage('user', 'caching strategy review')]);
        ftse.index(s1);
        ftse.index(s2);
        idx.upsert(s1);
        idx.upsert(s2);

        // Store full path; search with just the filename fragment.
        metaStore.set(s1.id, { entities: { filePaths: ['src/cache/redisCache.ts'], functionNames: [], errors: [], decisions: [] } });
        metaStore.set(s2.id, { entities: { filePaths: ['src/cache/memoryCache.ts'], functionNames: [], errors: [], decisions: [] } });

        const result = await tool.execute({
            query: 'caching',
            entityType: 'filePaths',
            entityValue: 'redis',  // partial match
        });

        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes(`ID: ${s1.id}`), 'session with redisCache.ts must match partial "redis"');
        assert.ok(!text.includes(`ID: ${s2.id}`), 'session with memoryCache.ts must not match "redis"');
    });
});
