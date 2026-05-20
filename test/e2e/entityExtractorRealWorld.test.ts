// test/e2e/entityExtractorRealWorld.test.ts
//
// Tests the entity extractor against sessions that look like real coding
// conversations — with actual file paths, function names, error messages,
// and decision phrases that a developer would write.
//
// The goal: verify that entities useful for search/linking are extracted,
// not just that the function doesn't throw.

import * as assert from 'assert';
import { extractEntities } from '../../src/analytics/entityExtractor';
import { Session, Message } from '../../src/types/index';

function makeSession(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Session {
    return {
        id: 'test-session',
        title: 'Test session',
        source: 'copilot',
        date: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: messages.map((m, i) => ({
            id: `msg-${i}`,
            role: m.role,
            content: m.content,
            timestamp: new Date().toISOString(),
            codeBlocks: [],
        })),
        workspace: '',
        model: 'gpt-4o',
        totalTokens: 0,
    } as unknown as Session;
}

suite('Entity Extractor — real-world coding conversations', () => {

    suite('file path extraction', () => {

        test('extracts TypeScript source file paths from conversation', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'I\'m getting a type error in src/auth/jwtMiddleware.ts. The verifyToken function at line 42 is failing.',
                },
                {
                    role: 'assistant',
                    content: 'Looking at src/auth/jwtMiddleware.ts — the issue is that you\'re importing from src/utils/tokenHelper.ts but the type signature changed. Update src/types/auth.ts to add the optional `expiresIn` field.',
                },
            ]);

            const result = extractEntities(session);

            assert.ok(
                result.filePaths.some(f => f.includes('jwtMiddleware.ts')),
                `Expected jwtMiddleware.ts, got: ${result.filePaths.join(', ')}`,
            );
            assert.ok(
                result.filePaths.some(f => f.includes('tokenHelper.ts')),
                `Expected tokenHelper.ts, got: ${result.filePaths.join(', ')}`,
            );
            assert.ok(
                result.filePaths.some(f => f.includes('auth.ts')),
                `Expected auth.ts, got: ${result.filePaths.join(', ')}`,
            );
        });

        test('extracts config and schema files', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'My tsconfig.json references packages/api/tsconfig.json but the build breaks. The schema is in prisma/schema.prisma.',
                },
            ]);

            const result = extractEntities(session);
            const jsonFiles = result.filePaths.filter(f => f.endsWith('.json'));
            assert.ok(jsonFiles.length > 0, 'Should extract .json config files');
            assert.ok(
                result.filePaths.some(f => f.includes('schema.prisma')),
                `Expected prisma schema file, got: ${result.filePaths.join(', ')}`,
            );
        });

    });

    suite('function/class name extraction', () => {

        test('extracts function names from code discussion', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'The function verifyJwtToken is throwing. I also need to refactor class AuthService.',
                },
                {
                    role: 'assistant',
                    content: 'Let\'s look at function verifyJwtToken — it\'s calling async function fetchUserById which doesn\'t handle the null case. The class AuthService needs a private method validateExpiry.',
                },
            ]);

            const result = extractEntities(session);
            assert.ok(
                result.functionNames.some(f => f === 'verifyJwtToken' || f.includes('verifyJwt')),
                `Expected verifyJwtToken, got: ${result.functionNames.join(', ')}`,
            );
            assert.ok(
                result.functionNames.some(f => f === 'AuthService' || f.includes('Auth')),
                `Expected AuthService, got: ${result.functionNames.join(', ')}`,
            );
        });

    });

    suite('error message extraction', () => {

        test('extracts TypeError from conversation', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'I\'m getting: TypeError: Cannot read properties of undefined (reading \'userId\'). This happens in the login handler.',
                },
                {
                    role: 'assistant',
                    content: 'That TypeError means req.user is undefined at that point. Add a null guard before accessing req.user.userId.',
                },
            ]);

            const result = extractEntities(session);
            assert.ok(
                result.errors.some(e => e.toLowerCase().includes('typeerror')),
                `Expected TypeError in errors, got: ${result.errors.join('; ')}`,
            );
        });

        test('extracts database errors like SQLITE_BUSY', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'Seeing SQLITE_BUSY errors when the watcher and the indexer run at the same time. How do I fix this?',
                },
            ]);

            const result = extractEntities(session);
            assert.ok(
                result.errors.some(e => e.includes('SQLITE_BUSY')),
                `Expected SQLITE_BUSY in errors, got: ${result.errors.join('; ')}`,
            );
        });

        test('extracts HTTP 4xx/5xx status codes from conversation', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'The webhook endpoint is returning 403 Forbidden even though the token looks right. Also getting 503 Service Unavailable from the upstream.',
                },
            ]);

            const result = extractEntities(session);
            const statusErrors = result.errors.filter(e => /4\d\d|5\d\d/.test(e));
            assert.ok(statusErrors.length >= 1, `Expected HTTP status errors, got: ${result.errors.join('; ')}`);
        });

    });

    suite('decision phrase extraction', () => {

        test('extracts "decided to use" phrases', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'Should we use Redis or Memcached for the session cache?',
                },
                {
                    role: 'assistant',
                    content: 'I decided to use Redis because it supports persistence and pub/sub. We went with ioredis as the client library because it has better TypeScript support than node-redis.',
                },
            ]);

            const result = extractEntities(session);
            assert.ok(
                result.decisions.length > 0,
                `Expected decision phrases, got none. Content was about Redis vs Memcached.`,
            );
        });

    });

    suite('end-to-end: a realistic debugging session', () => {

        // Simulates a real Copilot session about fixing a JWT expiry bug.
        // The session touches multiple files, has a real error, and ends with a decision.
        test('extracts files, errors, and decision from a multi-turn debug session', () => {
            const session = makeSession([
                {
                    role: 'user',
                    content: 'Getting JsonWebTokenError: invalid signature when the user tries to log in. The token is generated in src/auth/tokenService.ts and verified in src/middleware/authenticate.ts.',
                },
                {
                    role: 'assistant',
                    content: 'The mismatch usually means the JWT_SECRET used to sign in tokenService.ts differs from the one read in authenticate.ts. Check your .env loading. Also look at src/config/secrets.ts — if it reads from process.env before dotenv has loaded, you\'ll get undefined secret.',
                },
                {
                    role: 'user',
                    content: 'That was exactly it — dotenv.config() was being called after the import in src/config/secrets.ts. Fixed by moving it to src/index.ts at the top.',
                },
                {
                    role: 'assistant',
                    content: 'Good catch. Going forward, I decided to use a dedicated secrets.ts module that validates all required env vars on startup and throws early if any are missing, rather than letting them fail silently at runtime. This approach follows the fail-fast principle.',
                },
            ]);

            const result = extractEntities(session);

            // Should have extracted real file paths
            const files = result.filePaths;
            assert.ok(files.some(f => f.includes('tokenService.ts')), `Missing tokenService.ts: ${files.join(', ')}`);
            assert.ok(files.some(f => f.includes('authenticate.ts')), `Missing authenticate.ts: ${files.join(', ')}`);

            // Should have captured the JWT error
            assert.ok(
                result.errors.some(e => e.toLowerCase().includes('jsonwebtokenerror') || e.toLowerCase().includes('invalid signature')),
                `Expected JWT error, got: ${result.errors.join('; ')}`,
            );

            // Should have captured the decision about secrets
            assert.ok(result.decisions.length > 0, 'Expected at least one decision phrase from the final message');
        });

    });

});
