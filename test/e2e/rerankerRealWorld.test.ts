// test/e2e/rerankerRealWorld.test.ts
//
// Tests TfIdfReranker with content-rich sessions that mirror the realistic corpus
// ChatWizard would search over — sessions about actual engineering problems with
// substantial message content, not just titles.
//
// Key invariants verified:
//   - A query about "JWT authentication" ranks auth sessions above unrelated ones
//   - A query about "database connection pool" surfaces the DB session
//   - Sessions where query terms appear only in messages (not titles) are still found
//   - Original rank is preserved when TF-IDF scores are equal (stable sort)

import * as assert from 'assert';
import { TfIdfReranker } from '../../src/search/reranker';
import { Session } from '../../src/types/index';

function makeSession(
    id: string,
    title: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): { id: string; session: Session } {
    return {
        id,
        session: {
            id,
            title,
            source: 'copilot',
            date: '2025-05-01T10:00:00Z',
            createdAt: '2025-05-01T10:00:00Z',
            updatedAt: '2025-05-01T10:00:00Z',
            messages: messages.map((m, i) => ({
                id: `${id}-msg-${i}`,
                role: m.role,
                content: m.content,
                timestamp: '2025-05-01T10:00:00Z',
                codeBlocks: [],
            })),
            model: 'gpt-4o',
            totalTokens: 500,
            workspace: '/projects/app',
        } as unknown as Session,
    };
}

// ─── Fixture sessions ──────────────────────────────────────────────────────────

const jwtAuthSession = makeSession(
    'auth-jwt',
    'Implementing JWT authentication middleware',
    [
        { role: 'user', content: 'How do I add JWT authentication to my Express API? The verifyToken function needs to check the Authorization header and validate the JWT signature.' },
        { role: 'assistant', content: 'Here is a JWT middleware: use jsonwebtoken.verify() with your JWT_SECRET. The token goes in the Authorization Bearer header. Set expiresIn to 24h.' },
        { role: 'user', content: 'Getting JsonWebTokenError: invalid signature. I think my JWT_SECRET differs between sign and verify.' },
        { role: 'assistant', content: 'That is the classic JWT authentication mismatch. Ensure the same JWT_SECRET env variable is loaded before both tokenService and authenticate middleware.' },
    ],
);

const dbConnectionSession = makeSession(
    'db-pool',
    'Postgres connection pool exhaustion',
    [
        { role: 'user', content: 'My Postgres connection pool is exhausted. Getting "remaining connection slots are reserved for non-replication superuser connections". Running 4 app instances, each with pool max 100.' },
        { role: 'assistant', content: 'With 4 instances × 100 connections you are hitting the Postgres max_connections default of 100. Set pool max to floor((max_connections - 10) / num_instances). Also add pgBouncer for connection multiplexing.' },
        { role: 'user', content: 'What pool timeout settings should I use with pg.Pool?' },
        { role: 'assistant', content: 'Set idleTimeoutMillis: 30000 and connectionTimeoutMillis: 5000. These prevent leaked connections from blocking the pool. Always use pool.query() instead of pool.connect() to avoid manual release.' },
    ],
);

const lambdaColdStartSession = makeSession(
    'lambda-cold',
    'Reducing AWS Lambda cold start latency',
    [
        { role: 'user', content: 'My Lambda functions take 3-4 seconds on cold start. Using Node.js 20, AWS SDK v3, bundle is 18MB.' },
        { role: 'assistant', content: 'Import only the AWS SDK modules you need — @aws-sdk/client-s3 not the full AWS namespace. Move SDK clients outside the handler. Use esbuild with tree shaking to target <1MB bundle.' },
        { role: 'user', content: 'We have RDS Proxy in a VPC — is that adding to cold start?' },
        { role: 'assistant', content: 'VPC attachment adds roughly 1 second to Lambda cold start because of ENI provisioning. Consider using Lambda without VPC and accessing RDS Proxy via the public endpoint with IAM auth.' },
    ],
);

const reactStateSession = makeSession(
    'react-state',
    'React state management with Zustand',
    [
        { role: 'user', content: 'Should I use Zustand or Redux for my React app? I have 15 components that share cart and user state.' },
        { role: 'assistant', content: 'For 15 components with shared state, Zustand is simpler — no boilerplate, no reducers. Create a useCartStore and useUserStore. Only add Redux if you need time-travel debugging or complex middleware.' },
        { role: 'user', content: 'How do I persist Zustand store to localStorage?' },
        { role: 'assistant', content: 'Use the persist middleware from zustand/middleware. Wrap your store creator with persist({}, { name: "cart-storage" }). It serializes to localStorage automatically.' },
    ],
);

const cssAnimationSession = makeSession(
    'css-anim',
    'CSS keyframe animation performance',
    [
        { role: 'user', content: 'My CSS animations are causing jank on mobile. Using transform and opacity transitions on a list of 200 items.' },
        { role: 'assistant', content: 'For 200 items, GPU compositing is key. Use will-change: transform on animated elements. Prefer transform: translateX() over left/margin — those trigger layout. Use contain: layout on the list container.' },
    ],
);

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('TfIdfReranker — real-world session corpus', () => {

    const reranker = new TfIdfReranker();

    const allSessions = [jwtAuthSession, dbConnectionSession, lambdaColdStartSession, reactStateSession, cssAnimationSession];

    test('query "JWT authentication" surfaces the auth session first', () => {
        const results = reranker.rerank('JWT authentication middleware', allSessions);
        assert.strictEqual(results[0].id, 'auth-jwt',
            `Expected auth-jwt first, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('query "postgres connection pool" surfaces the db session first', () => {
        const results = reranker.rerank('postgres connection pool exhausted', allSessions);
        assert.strictEqual(results[0].id, 'db-pool',
            `Expected db-pool first, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('query "Lambda cold start AWS" surfaces the Lambda session first', () => {
        const results = reranker.rerank('Lambda cold start AWS Node', allSessions);
        assert.strictEqual(results[0].id, 'lambda-cold',
            `Expected lambda-cold first, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('query "Zustand React state" surfaces the React session first', () => {
        const results = reranker.rerank('Zustand React state management', allSessions);
        assert.strictEqual(results[0].id, 'react-state',
            `Expected react-state first, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('query terms that appear only in messages (not title) still rank correctly', () => {
        // "pgBouncer" appears only in the db-pool session messages, not in its title
        const results = reranker.rerank('pgBouncer multiplexing', allSessions);
        assert.strictEqual(results[0].id, 'db-pool',
            `Expected db-pool from message content, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('query "JsonWebTokenError invalid signature" finds the auth session', () => {
        // This exact error string appears only in the auth session messages
        const results = reranker.rerank('JsonWebTokenError invalid signature JWT_SECRET', allSessions);
        assert.strictEqual(results[0].id, 'auth-jwt',
            `Expected auth-jwt first for error-based query, got: ${results.map(r => r.id).join(', ')}`);
    });

    test('result count always equals candidate count', () => {
        const results = reranker.rerank('typescript', allSessions);
        assert.strictEqual(results.length, allSessions.length);
    });

    test('completely unrelated query preserves original rank order (stable sort on zero scores)', () => {
        const twoSessions = [
            makeSession('first', 'First session', [{ role: 'user', content: 'Hello world' }]),
            makeSession('second', 'Second session', [{ role: 'user', content: 'Hello world too' }]),
        ];
        // Query has no overlap with either session
        const results = reranker.rerank('zzzzquantumzzzzblockchainnftzzz', twoSessions);
        assert.strictEqual(results[0].id, 'first', 'Stable sort: first should remain first on tie');
        assert.strictEqual(results[1].id, 'second');
    });

});
