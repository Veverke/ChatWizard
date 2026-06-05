// test/e2e/duplicateDetector.test.ts
// Feature 33 — Duplicate Session Detection

import * as assert from 'assert';
import { detectDuplicates } from '../../src/analytics/duplicateDetector';
import type { Session } from '../../src/types/index';

function makeSession(id: string, title: string, firstMessage: string, msgCount = 3): Session {
    const messages = [
        { id: `${id}-u0`, role: 'user' as const, content: firstMessage, codeBlocks: [] },
        ...Array.from({ length: msgCount - 1 }, (_, i) => ({
            id: `${id}-a${i}`,
            role: 'assistant' as const,
            content: `Assistant response ${i}`,
            codeBlocks: [],
        })),
    ];
    return {
        id,
        title,
        source: 'claude',
        workspaceId: 'ws1',
        messages,
        filePath: `/tmp/${id}.jsonl`,
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
    };
}

suite('Feature 33 — Duplicate Session Detection', () => {
    test('returns empty array for empty input', () => {
        const groups = detectDuplicates([]);
        assert.strictEqual(groups.length, 0);
    });

    test('returns empty array when all sessions are unique', () => {
        const sessions = [
            makeSession('s1', 'JWT auth implementation', 'How do I implement JWT?'),
            makeSession('s2', 'Docker networking guide', 'How do Docker networks work?'),
            makeSession('s3', 'TypeScript generics', 'Explain TypeScript generics.'),
        ];
        const groups = detectDuplicates(sessions);
        assert.strictEqual(groups.length, 0, 'unique sessions should not be grouped');
    });

    test('detects exact-title duplicates', () => {
        const sessions = [
            makeSession('s1', 'JWT Auth Setup', 'How do I set up JWT?'),
            makeSession('s2', 'JWT Auth Setup', 'What is the best JWT library?'),
            makeSession('s3', 'Docker Networking', 'How do Docker networks work?'),
        ];
        const groups = detectDuplicates(sessions);
        const titleGroup = groups.find(g => g.reason === 'exact-title');
        assert.ok(titleGroup !== undefined, 'should find an exact-title group');
        assert.strictEqual(titleGroup!.duplicates.length, 1, 'should have one duplicate');
        assert.ok(
            titleGroup!.canonical.title.toLowerCase() === 'jwt auth setup',
            'canonical should be one of the jwt auth sessions'
        );
    });

    test('exact-title matching is case-insensitive', () => {
        const sessions = [
            makeSession('s1', 'My Session Title', 'First question'),
            makeSession('s2', 'MY SESSION TITLE', 'Second question'),
        ];
        const groups = detectDuplicates(sessions);
        assert.strictEqual(groups.length, 1, 'case-insensitive match should be found');
        assert.strictEqual(groups[0].reason, 'exact-title');
    });

    test('detects same-first-message duplicates', () => {
        const msg = 'How do I configure webpack for production?';
        const sessions = [
            makeSession('s1', 'Session A', msg),
            makeSession('s2', 'Session B', msg),  // different title, same first message
        ];
        const groups = detectDuplicates(sessions);
        assert.ok(groups.length > 0, 'same-first-message should be detected');
        const msgGroup = groups.find(g => g.reason === 'same-first-message');
        assert.ok(msgGroup !== undefined, 'reason should be same-first-message');
    });

    test('detects high-similarity near-duplicates', () => {
        const base = 'how do i configure webpack bundler for production deployment with code splitting';
        // Create a slightly different version of the same message
        const similar = 'how do i configure webpack bundler for production deployment with code-splitting';
        const sessions = [
            makeSession('s1', 'Title A', base, 4),
            makeSession('s2', 'Title B', similar, 4),
        ];
        const groups = detectDuplicates(sessions, { similarityThreshold: 0.80 });
        const simGroup = groups.find(g => g.reason === 'high-similarity');
        assert.ok(simGroup !== undefined, 'near-duplicate should be detected');
    });

    test('sessions with fewer messages than minMessagesForSimilarity are excluded from trigram check', () => {
        const base = 'how do i configure webpack bundler for production deployment with code splitting';
        const similar = 'how do i configure webpack bundler for production deployment with code-splitting';
        // Only 1 message each — should NOT be detected as similar
        const sessions = [
            makeSession('s1', 'Title A', base, 1),
            makeSession('s2', 'Title B', similar, 1),
        ];
        const groups = detectDuplicates(sessions, { minMessagesForSimilarity: 3 });
        const simGroup = groups.find(g => g.reason === 'high-similarity');
        assert.strictEqual(simGroup, undefined, 'short sessions should not be checked for similarity');
    });

    test('each session appears in at most one group', () => {
        const sessions = [
            makeSession('s1', 'Same Title', 'Same first message too'),
            makeSession('s2', 'Same Title', 'Same first message too'),
        ];
        const groups = detectDuplicates(sessions);
        const allDupeIds = groups.flatMap(g => [g.canonical.id, ...g.duplicates.map(d => d.id)]);
        const uniqueIds = new Set(allDupeIds);
        assert.strictEqual(uniqueIds.size, allDupeIds.length, 'each session should appear in at most one group');
    });

    test('canonical is the first session in input order', () => {
        const sessions = [
            makeSession('s1', 'My Title', 'My question'),
            makeSession('s2', 'My Title', 'Another question'),
            makeSession('s3', 'My Title', 'Yet another question'),
        ];
        const groups = detectDuplicates(sessions);
        assert.ok(groups.length > 0, 'should find duplicate group');
        assert.strictEqual(groups[0].canonical.id, 's1', 'first session should be canonical');
        assert.strictEqual(groups[0].duplicates.length, 2, 'should have 2 duplicates');
    });
});