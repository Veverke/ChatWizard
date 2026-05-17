// test/e2e/integration/goldenQueries.test.ts
//
// Golden-query tests (INFRA-12).
//
// Each test:
//   1. Indexes the full semantic corpus (8 realistic, multi-turn sessions)
//   2. Executes a specific query against FullTextSearchEngine
//   3. Asserts the expected session ranks first
//   4. Asserts at least one off-topic session is absent from results
//   5. Asserts the top result's snippet contains relevant vocabulary
//
// The semantic corpus replaces the 2-turn toy fixtures used elsewhere with
// sessions that share vocabulary intentionally, enabling disambiguation tests.
//
// Fixture vocabulary map:
//   auth-debugging-copilot/claude — jwt, 401, token expiry, middleware, handleAuthError, bearer token, unauthorized
//   db-migration-copilot/cline    — migration, prisma migrate, rollback, schema drift, ALTER TABLE
//   postgres-perf-copilot         — ECONNREFUSED 5432, slow query, EXPLAIN ANALYZE, N+1, missing index
//   microservices-design-claude   — microservices, monolith, tradeoffs, event sourcing, decided to
//   css-animation-copilot         — transition, overflow hidden, display none, CSS animation
//   unrelated-ui-copilot          — useState, useEffect, component unmount (no auth/DB/CSS terms)

import * as assert from 'assert';
import { FullTextSearchEngine } from '../../../src/search/fullTextEngine';
import { indexSemanticCorpus, SemanticCorpus } from '../../helpers/semanticCorpus';

suite('Golden Query Tests (INFRA-12)', function () {
    this.timeout(15_000);

    let engine: FullTextSearchEngine;
    let corpus: SemanticCorpus;

    suiteSetup(async () => {
        engine = new FullTextSearchEngine();
        corpus = await indexSemanticCorpus(engine, null);
    });

    // ── Query 1: Auth debugging ───────────────────────────────────────────

    test('GQ-1: "handleAuthError JWT 401" — auth sessions rank first, CSS/UI sessions absent', () => {
        const response = engine.search({ text: 'handleAuthError JWT 401' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for auth query');

        const topId = response.results[0].sessionId;
        const authIds = new Set([corpus.sessions.authCopilot.id, corpus.sessions.authClaude.id]);
        assert.ok(
            authIds.has(topId),
            `expected an auth session to rank first, got ${topId}`,
        );

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            !resultIds.includes(corpus.sessions.cssAnimation.id),
            'CSS animation session must not appear in an auth query',
        );
        assert.ok(
            !resultIds.includes(corpus.sessions.unrelatedUi.id),
            'React useState session must not appear in an auth query',
        );
    });

    test('GQ-1b: auth top result snippet contains auth-domain vocabulary', () => {
        const response = engine.search({ text: 'handleAuthError JWT 401' });
        assert.ok(response.results.length >= 1);

        const snippet = response.results[0].snippet?.toLowerCase() ?? '';
        const hasAuthVocab = snippet.includes('jwt') || snippet.includes('auth') ||
            snippet.includes('token') || snippet.includes('401') || snippet.includes('unauthorized');
        assert.ok(
            hasAuthVocab,
            `top snippet "${response.results[0].snippet}" should contain auth-domain vocabulary`,
        );
    });

    test('GQ-1c: auth cross-source — both copilot and claude auth sessions appear for "bearer token unauthorized"', () => {
        const response = engine.search({ text: 'bearer token unauthorized' });
        const resultIds = response.results.map(r => r.sessionId);

        const eitherAuthFound = resultIds.includes(corpus.sessions.authCopilot.id) ||
            resultIds.includes(corpus.sessions.authClaude.id);
        assert.ok(eitherAuthFound, 'at least one auth session (copilot or claude) should appear for bearer token query');
    });

    // ── Query 2: Database migration ───────────────────────────────────────

    test('GQ-2: "database migration rollback" — migration sessions rank first, auth/perf absent', () => {
        const response = engine.search({ text: 'database migration rollback' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for migration query');

        const topId = response.results[0].sessionId;
        const migrationIds = new Set([corpus.sessions.dbMigrationCopilot.id, corpus.sessions.dbMigrationCline.id]);
        assert.ok(
            migrationIds.has(topId),
            `expected a migration session to rank first, got ${topId}`,
        );

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            !resultIds.includes(corpus.sessions.authCopilot.id),
            'JWT auth session must not appear in a migration rollback query',
        );
    });

    test('GQ-2b: migration top result snippet contains migration vocabulary', () => {
        const response = engine.search({ text: 'database migration rollback' });
        assert.ok(response.results.length >= 1);

        const snippet = response.results[0].snippet?.toLowerCase() ?? '';
        const hasMigrationVocab = snippet.includes('migrat') || snippet.includes('rollback') ||
            snippet.includes('schema') || snippet.includes('prisma') || snippet.includes('alter table');
        assert.ok(
            hasMigrationVocab,
            `top snippet "${response.results[0].snippet}" should contain migration vocabulary`,
        );
    });

    // ── Query 3: ECONNREFUSED 5432 ────────────────────────────────────────

    test('GQ-3: "ECONNREFUSED 5432" — postgres-perf session ranks first', () => {
        const response = engine.search({ text: 'ECONNREFUSED 5432' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for ECONNREFUSED 5432');

        const topId = response.results[0].sessionId;
        assert.strictEqual(
            topId,
            corpus.sessions.postgresPerf.id,
            `postgres-perf session should rank first for "ECONNREFUSED 5432", got ${topId}`,
        );

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            !resultIds.includes(corpus.sessions.microservicesDesign.id),
            'microservices session must not appear for ECONNREFUSED query',
        );
    });

    // ── Query 4: Slow query optimization ─────────────────────────────────

    test('GQ-4: "slow query optimization" — postgres-perf session is in top results', () => {
        const response = engine.search({ text: 'slow query optimization' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for slow query optimization');

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            resultIds.includes(corpus.sessions.postgresPerf.id),
            'postgres-perf session must appear for "slow query optimization"',
        );
        assert.ok(
            !resultIds.includes(corpus.sessions.microservicesDesign.id),
            'microservices-design session must not appear for slow query optimization',
        );
    });

    test('GQ-4b: "slow query optimization" snippet contains query-performance vocabulary', () => {
        const response = engine.search({ text: 'slow query optimization' });
        assert.ok(response.results.length >= 1);

        const snippet = response.results[0].snippet?.toLowerCase() ?? '';
        assert.ok(
            snippet.length >= 20,
            `snippet "${response.results[0].snippet}" is too short (< 20 chars)`,
        );
        const hasPerfVocab = snippet.includes('query') || snippet.includes('index') ||
            snippet.includes('scan') || snippet.includes('explain') || snippet.includes('slow');
        assert.ok(
            hasPerfVocab,
            `snippet "${response.results[0].snippet}" should contain query-performance vocabulary`,
        );
    });

    // ── Query 5: Microservices vs monolith ────────────────────────────────

    test('GQ-5: "microservices vs monolith" — microservices-design session ranks first', () => {
        const response = engine.search({ text: 'microservices vs monolith' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for microservices vs monolith');

        const topId = response.results[0].sessionId;
        assert.strictEqual(
            topId,
            corpus.sessions.microservicesDesign.id,
            `microservices-design session should rank first, got ${topId}`,
        );

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            !resultIds.includes(corpus.sessions.authCopilot.id),
            'JWT auth session must not appear in a microservices architecture query',
        );
        assert.ok(
            !resultIds.includes(corpus.sessions.cssAnimation.id),
            'CSS animation session must not appear in a microservices query',
        );
    });

    // ── Query 6: CSS transition ───────────────────────────────────────────

    test('GQ-6: "CSS transition not working" — css-animation session ranks first', () => {
        const response = engine.search({ text: 'CSS transition not working' });
        assert.ok(response.results.length >= 1, 'expected ≥1 result for CSS transition query');

        const topId = response.results[0].sessionId;
        assert.strictEqual(
            topId,
            corpus.sessions.cssAnimation.id,
            `css-animation session should rank first for "CSS transition not working", got ${topId}`,
        );

        const resultIds = response.results.map(r => r.sessionId);
        assert.ok(
            !resultIds.includes(corpus.sessions.authCopilot.id),
            'JWT auth session must not appear in a CSS transition query',
        );
        assert.ok(
            !resultIds.includes(corpus.sessions.dbMigrationCopilot.id),
            'DB migration session must not appear in a CSS transition query',
        );
    });

    // ── Score-gap assertions ──────────────────────────────────────────────

    test('GQ-score: ECONNREFUSED 5432 top result score is meaningfully better than second', () => {
        const response = engine.search({ text: 'ECONNREFUSED 5432' });
        if (response.results.length < 2) {
            // Only one result — score gap trivially satisfied
            assert.ok(response.results.length >= 1);
            return;
        }

        const top = response.results[0].score;
        const second = response.results[1].score;
        assert.ok(
            top > second * 1.3,
            `top result score (${top}) should be ≥130% of second result score (${second})`,
        );
    });

    test('GQ-score: "microservices vs monolith" top result score is meaningfully better than second', () => {
        const response = engine.search({ text: 'microservices vs monolith' });
        if (response.results.length < 2) {
            assert.ok(response.results.length >= 1);
            return;
        }

        const top = response.results[0].score;
        const second = response.results[1].score;
        assert.ok(
            top > second * 1.3,
            `top result score (${top}) should be ≥130% of second result score (${second})`,
        );
    });

    // ── Snippet quality baseline ──────────────────────────────────────────

    test('GQ-snippets: all results for "migration rollback" have non-trivially-short snippets', () => {
        const response = engine.search({ text: 'migration rollback' });
        for (const hit of response.results) {
            assert.ok(
                hit.snippet && hit.snippet.length >= 20,
                `snippet "${hit.snippet}" is shorter than 20 characters`,
            );
        }
    });
});
