// test/helpers/semanticCorpus.ts
//
// Loads and indexes the full semantic fixture corpus into a FullTextSearchEngine
// (and optionally a SessionIndex) in a single call.
//
// Fixture set (test/fixtures/semantic/):
//   auth-debugging-copilot.jsonl  — JWT 401, handleAuthError, token expiry, middleware
//   auth-debugging-claude.jsonl   — JWT, bearer token, unauthorized, auth handler
//   db-migration-copilot.jsonl    — Prisma migrate, schema drift, rollback
//   db-migration-cline/           — ALTER TABLE, down migration (Cline format)
//   postgres-perf-copilot.jsonl   — ECONNREFUSED 5432, slow query, EXPLAIN ANALYZE, N+1
//   microservices-design-claude.jsonl — microservices vs monolith, tradeoffs, event sourcing
//   css-animation-copilot.jsonl   — CSS transition, overflow hidden, display none
//   unrelated-ui-copilot.jsonl    — useState, useEffect, component unmount (no auth/DB/CSS terms)
//
// Note on cursor format: the cursor parser reads from SQLite databases, which cannot be
// stored as static files.  The css-animation fixture uses copilot JSONL format instead,
// which preserves the vocabulary goals of that fixture.

import * as path from 'path';
import { parseCopilotSession } from '../../src/parsers/copilot';
import { parseClaudeSession } from '../../src/parsers/claude';
import { parseClineTask } from '../../src/parsers/cline';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { SessionIndex } from '../../src/index/sessionIndex';
import type { Session } from '../../src/types/index';

const SEMANTIC_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'semantic');

// ---------------------------------------------------------------------------
// Parsed session references returned to callers for use in assertions
// ---------------------------------------------------------------------------

export interface SemanticCorpus {
    sessions: {
        authCopilot: Session;
        authClaude: Session;
        dbMigrationCopilot: Session;
        dbMigrationCline: Session;
        postgresPerf: Session;
        microservicesDesign: Session;
        cssAnimation: Session;
        unrelatedUi: Session;
    };
    /** All sessions as an array, for iterating. */
    all: Session[];
}

/**
 * Parses all 8 semantic fixture sessions.
 * Async because parseClineTask is async.
 */
export async function loadSemanticCorpus(): Promise<SemanticCorpus> {
    const { session: authCopilot } = parseCopilotSession(
        path.join(SEMANTIC_DIR, 'auth-debugging-copilot.jsonl'),
        'semantic-ws',
    );
    const { session: authClaude } = parseClaudeSession(
        path.join(SEMANTIC_DIR, 'auth-debugging-claude.jsonl'),
    );
    const { session: dbMigrationCopilot } = parseCopilotSession(
        path.join(SEMANTIC_DIR, 'db-migration-copilot.jsonl'),
        'semantic-ws',
    );
    const { session: dbMigrationCline } = await parseClineTask(
        path.join(SEMANTIC_DIR, 'db-migration-cline'),
    );
    const { session: postgresPerf } = parseCopilotSession(
        path.join(SEMANTIC_DIR, 'postgres-perf-copilot.jsonl'),
        'semantic-ws',
    );
    const { session: microservicesDesign } = parseClaudeSession(
        path.join(SEMANTIC_DIR, 'microservices-design-claude.jsonl'),
    );
    const { session: cssAnimation } = parseCopilotSession(
        path.join(SEMANTIC_DIR, 'css-animation-copilot.jsonl'),
        'semantic-ws',
    );
    const { session: unrelatedUi } = parseCopilotSession(
        path.join(SEMANTIC_DIR, 'unrelated-ui-copilot.jsonl'),
        'semantic-ws',
    );

    const all = [
        authCopilot, authClaude, dbMigrationCopilot, dbMigrationCline,
        postgresPerf, microservicesDesign, cssAnimation, unrelatedUi,
    ];

    return {
        sessions: {
            authCopilot, authClaude, dbMigrationCopilot, dbMigrationCline,
            postgresPerf, microservicesDesign, cssAnimation, unrelatedUi,
        },
        all,
    };
}

/**
 * Loads the corpus AND indexes all sessions into the provided engine instances.
 * Pass `null` for either engine if you only need one.
 */
export async function indexSemanticCorpus(
    ftEngine: FullTextSearchEngine | null,
    sessionIndex: SessionIndex | null,
): Promise<SemanticCorpus> {
    const corpus = await loadSemanticCorpus();
    for (const session of corpus.all) {
        if (ftEngine) { ftEngine.index(session); }
        if (sessionIndex) { sessionIndex.upsert(session); }
    }
    return corpus;
}
