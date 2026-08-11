// test/e2e/kbEngine.test.ts
// Feature 23 — KB Engine: cleanSummary, buildKbEntries, grouped map, onProgress

import * as assert from 'assert';
import { cleanSummary, buildKbEntries } from '../../src/analytics/kbEngine';
import type { Session, SessionMetadata } from '../../src/types/index';

function makeSession(content: string, overrides?: Partial<Session>): Session {
    return {
        id: 'test-' + Math.random().toString(36).slice(2, 8),
        title: 'Test Session',
        source: 'copilot',
        workspaceId: 'ws1',
        messages: [{ id: 'm0', role: 'user', content, codeBlocks: [] }],
        filePath: '/tmp/test.jsonl',
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
        ...overrides,
    };
}

suite('Feature 23 — KB Engine', () => {
    suite('cleanSummary', () => {
        test('strips "User requested to" prefix', () => {
            assert.strictEqual(
                cleanSummary('User requested to continue a chat feature'),
                'continue a chat feature',
            );
        });

        test('strips "User is" prefix', () => {
            assert.strictEqual(
                cleanSummary('User is troubleshooting a Copilot extension'),
                'troubleshooting a Copilot extension',
            );
        });

        test('strips "User wants to" prefix', () => {
            assert.strictEqual(
                cleanSummary('User wants to refactor the authentication module'),
                'refactor the authentication module',
            );
        });

        test('strips "User asks to" prefix', () => {
            assert.strictEqual(
                cleanSummary('User asks to implement a new feature'),
                'implement a new feature',
            );
        });

        test('strips "User asked to" prefix', () => {
            assert.strictEqual(
                cleanSummary('User asked to migrate the database schema'),
                'migrate the database schema',
            );
        });

        test('passes through text without a prefix', () => {
            assert.strictEqual(
                cleanSummary('Fix the login page CSS'),
                'Fix the login page CSS',
            );
        });

        test('handles empty string', () => {
            assert.strictEqual(cleanSummary(''), '');
        });
    });

    suite('buildKbEntries', () => {
        test('returns empty result for empty sessions array', async () => {
            const result = await buildKbEntries([], null);
            assert.strictEqual(result.total, 0);
            assert.strictEqual(result.entries.length, 0);
            assert.strictEqual(result.grouped.size, 0);
        });

        test('classifies sessions — all fallback to "Other" in test env', async () => {
            const sessions = [
                makeSession('We decided to use PostgreSQL for the trade-off benefits'),
                makeSession('Watch out for this footgun — it is tricky'),
                makeSession('The layered architecture uses separate service components'),
            ];

            const result = await buildKbEntries(sessions, null);

            assert.strictEqual(result.total, 3);
            assert.strictEqual(result.entries.length, 3);

            // No LLM or embedding engine in test env → all "Other"
            assert.strictEqual(result.entries[0].type, 'Other');
            assert.strictEqual(result.entries[1].type, 'Other');
            assert.strictEqual(result.entries[2].type, 'Other');

            // grouped map
            assert.ok(result.grouped.has('Other'));
            assert.strictEqual(result.grouped.get('Other')!.length, 3);
        });

        test('groups multiple entries into "Other" in test env', async () => {
            const sessions = [
                makeSession('boring neutral content'),
                makeSession('also boring — no keywords at all'),
                makeSession('We decided to go with option A'),
            ];

            const result = await buildKbEntries(sessions, null);

            // All "Other" in test env (no LLM, no embedding engine)
            assert.strictEqual(result.entries[0].type, 'Other');
            assert.strictEqual(result.entries[1].type, 'Other');
            assert.strictEqual(result.entries[2].type, 'Other');

            assert.strictEqual(result.grouped.get('Other')!.length, 3);
        });

        test('applies default categories when none provided', async () => {
            const sessions = [makeSession('boring neutral content')];
            const result = await buildKbEntries(sessions, null);
            assert.strictEqual(result.entries[0].type, 'Other');
        });

        test('applies custom categories when provided', async () => {
            // With custom categories, classifySessionWithCategories will try LLM,
            // fail (no LM API in test), then fallback to embedding (not available),
            // then return "Other".
            const sessions = [makeSession('boring neutral content')];
            const result = await buildKbEntries(sessions, null, ['bug', 'feature', 'learning']);
            assert.strictEqual(result.entries[0].type, 'Other');
        });

        test('uses sidecar cache for tags and summary', async () => {
            const session = makeSession('We decided to go with option A', { id: 'sid-1' });
            const cache = new Map<string, SessionMetadata>();
            cache.set('sid-1', {
                sessionId: 'sid-1',
                tags: ['tag-a', 'tag-b'],
            });

            const result = await buildKbEntries([session], cache);
            assert.strictEqual(result.entries[0].tags.length, 2);
            assert.deepStrictEqual(result.entries[0].tags, ['tag-a', 'tag-b']);
        });

        test('uses session title as fallback summary when no sidecar summary', async () => {
            const session = makeSession('We decided to go with option A', {
                title: 'My Custom Title',
            });
            const result = await buildKbEntries([session], null);
            // summary falls back to session.title when no sidecar meta
            assert.strictEqual(result.entries[0].summary, 'My Custom Title');
        });

        test('preserves entry order (pre-allocated array)', async () => {
            const sessions = [
                makeSession('We decided to go with A'),
                makeSession('boring neutral content'),
                makeSession('Watch out for this footgun'),
            ];

            const result = await buildKbEntries(sessions, null);
            assert.strictEqual(result.entries[0].sessionId, sessions[0].id);
            assert.strictEqual(result.entries[1].sessionId, sessions[1].id);
            assert.strictEqual(result.entries[2].sessionId, sessions[2].id);
        });

        test('calls onProgress with correct counts', async () => {
            const sessions = [
                makeSession('boring neutral content'),
                makeSession('We decided to go with A'),
                makeSession('Watch out for this footgun'),
            ];

            const calls: Array<{ done: number; total: number }> = [];
            const result = await buildKbEntries(sessions, null, undefined, (done, total) => {
                calls.push({ done, total });
            });

            assert.strictEqual(calls.length, 3);
            assert.strictEqual(calls[0].done, 1);
            assert.strictEqual(calls[0].total, 3);
            assert.strictEqual(calls[1].done, 2);
            assert.strictEqual(calls[1].total, 3);
            assert.strictEqual(calls[2].done, 3);
            assert.strictEqual(calls[2].total, 3);
        });

        test('onProgress is not called when omitted', async () => {
            const sessions = [makeSession('boring neutral content')];
            // Should not throw
            await buildKbEntries(sessions, null);
        });
    });
});