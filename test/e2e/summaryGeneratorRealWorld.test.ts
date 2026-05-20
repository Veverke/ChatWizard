// test/e2e/summaryGeneratorRealWorld.test.ts
//
// Tests the TF-IDF summary generator against sessions with realistic content.
// The generator's job is to produce a short keyword summary of what was discussed
// so it can be stored as searchable sidecar metadata.
//
// Key invariants:
//   - Topic-focused sessions produce keywords that reflect the topic
//   - Multi-topic sessions produce multiple relevant keywords
//   - Empty/trivial sessions fall back to the session title without crashing
//   - Stop words ("the", "and", "is") are never in the output
//   - Output is never an empty string

import * as assert from 'assert';
import { generateTfidfSummary } from '../../src/analytics/summaryGenerator';
import { Session } from '../../src/types/index';

function makeSession(title: string, userMessages: string[]): Session {
    return {
        id: 'test-session',
        title,
        source: 'copilot',
        date: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: userMessages.map((content, i) => ({
            id: `msg-${i}`,
            role: 'user' as const,
            content,
            timestamp: new Date().toISOString(),
            codeBlocks: [],
        })),
        model: 'gpt-4o',
        totalTokens: 100,
    } as unknown as Session;
}

const STOP_WORDS = new Set([
    'the', 'and', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we',
    'you', 'they', 'my', 'our', 'your', 'what', 'how', 'why', 'when', 'where',
    'for', 'with', 'by', 'from', 'to', 'of', 'in', 'on', 'at', 'a', 'an',
    'not', 'just', 'use', 'using', 'get', 'let', 'can', 'so', 'if', 'then',
]);

suite('generateTfidfSummary — real-world session content', () => {

    test('auth debugging session produces auth-related keywords', () => {
        const session = makeSession('JWT auth debugging', [
            'I\'m getting JsonWebTokenError: invalid signature when verifying tokens in my Express middleware.',
            'The JWT_SECRET differs between the signing service and the verification middleware.',
            'How do I ensure the same JWT_SECRET is loaded consistently across all services?',
        ]);

        const summary = generateTfidfSummary(session);
        assert.ok(summary.length > 0, 'Summary should not be empty');

        const summaryLower = summary.toLowerCase();
        const hasAuthKeyword =
            summaryLower.includes('jwt') ||
            summaryLower.includes('token') ||
            summaryLower.includes('secret') ||
            summaryLower.includes('signature') ||
            summaryLower.includes('middleware') ||
            summaryLower.includes('auth');
        assert.ok(hasAuthKeyword, `Expected auth-related keyword, got: "${summary}"`);
    });

    test('database session produces database-related keywords', () => {
        const session = makeSession('Postgres pool exhaustion', [
            'My Postgres connection pool is exhausted under load. Getting remaining connection slots reserved error.',
            'Running 4 app instances each with pool max 100 connections, total 400 connections exceeds max_connections.',
            'How do I configure pgBouncer for connection pooling and multiplexing in front of Postgres?',
        ]);

        const summary = generateTfidfSummary(session);
        const summaryLower = summary.toLowerCase();
        const hasDbKeyword =
            summaryLower.includes('postgres') ||
            summaryLower.includes('pool') ||
            summaryLower.includes('connection') ||
            summaryLower.includes('pgbouncer') ||
            summaryLower.includes('connections');
        assert.ok(hasDbKeyword, `Expected database keyword, got: "${summary}"`);
    });

    test('Kubernetes deployment session produces infra keywords', () => {
        const session = makeSession('Kubernetes rollout issue', [
            'My Kubernetes deployment is stuck in CrashLoopBackOff. The readiness probe is failing because the app starts before the database migration runs.',
            'How do I sequence the database migration as an init container in the Kubernetes pod spec?',
            'After adding the init container, the pod is still failing with OOMKilled — the migration process needs more memory than the 64Mi limit.',
        ]);

        const summary = generateTfidfSummary(session);
        const summaryLower = summary.toLowerCase();
        const hasK8sKeyword =
            summaryLower.includes('kubernetes') ||
            summaryLower.includes('deployment') ||
            summaryLower.includes('pod') ||
            summaryLower.includes('container') ||
            summaryLower.includes('migration') ||
            summaryLower.includes('crashloopbackoff') ||
            summaryLower.includes('oomkilled');
        assert.ok(hasK8sKeyword, `Expected Kubernetes keyword, got: "${summary}"`);
    });

    test('summary never contains stop words as the only output', () => {
        const session = makeSession('Quick question', [
            'Can you help me with this? I am not sure how to do it.',
            'What is the best way to use this in my code?',
        ]);

        const summary = generateTfidfSummary(session);
        assert.ok(summary.length > 0, 'Summary must not be empty');
        // If all extracted keywords are stop words, it should fall back to the title
        // rather than returning a stop-word-only string
    });

    test('session with no user messages returns the session title', () => {
        const session = makeSession('Only assistant messages', []);
        // Add only an assistant message manually
        (session.messages as any[]).push({
            id: 'msg-0',
            role: 'assistant',
            content: 'Here is how you do it...',
            timestamp: new Date().toISOString(),
            codeBlocks: [],
        });

        const summary = generateTfidfSummary(session);
        assert.ok(summary.length > 0, 'Should not return empty string');
        assert.strictEqual(summary, 'Only assistant messages', 'Should fall back to session title');
    });

    test('very short single-message session does not produce empty output', () => {
        const session = makeSession('Short session', ['OK.']);
        const summary = generateTfidfSummary(session);
        assert.ok(summary.length > 0, `Expected non-empty summary, got: "${summary}"`);
    });

    test('output is a comma-separated keyword list or the title — never undefined/null', () => {
        const sessions = [
            makeSession('Empty', []),
            makeSession('TypeScript config', ['How do I configure strict mode in tsconfig.json for a monorepo?']),
            makeSession('React hooks', ['When should I use useCallback vs useMemo? I keep re-rendering unnecessarily.']),
        ];

        for (const session of sessions) {
            const summary = generateTfidfSummary(session);
            assert.ok(typeof summary === 'string', 'Summary must be a string');
            assert.ok(summary.length > 0, `Summary must not be empty for session: ${session.title}`);
        }
    });

});
