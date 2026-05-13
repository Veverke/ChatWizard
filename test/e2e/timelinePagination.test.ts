// test/suite/timelinePagination.test.ts

import * as assert from 'assert';
import { buildTimeline, TimelineOptions } from '../../src/timeline/timelineBuilder';
import { Session, Message } from '../../src/types/index';

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeMsg(role: 'user' | 'assistant', content: string): Message {
    return { id: Math.random().toString(), role, content, codeBlocks: [] };
}

function makeSession(id: string, updatedAt: string, overrides: Partial<Session> = {}): Session {
    return {
        title: id,
        source: 'claude',
        workspaceId: 'ws',
        workspacePath: '/ws',
        messages: [makeMsg('user', 'hi')],
        filePath: '/tmp/x.jsonl',
        createdAt: updatedAt,
        updatedAt,
        id,
        ...overrides,
    };
}

// Sessions spread across 6 distinct months
const SESSIONS = [
    makeSession('jan-1',  '2025-01-10T00:00:00Z'),
    makeSession('feb-1',  '2025-02-05T00:00:00Z'),
    makeSession('feb-2',  '2025-02-20T00:00:00Z'),
    makeSession('mar-1',  '2025-03-15T00:00:00Z'),
    makeSession('apr-1',  '2025-04-01T00:00:00Z'),
    makeSession('apr-2',  '2025-04-22T00:00:00Z'),
    makeSession('may-1',  '2025-05-08T00:00:00Z'),
    makeSession('jun-1',  '2025-06-30T00:00:00Z'),
];

// â”€â”€ buildTimeline â€” no options (backward compat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('buildTimeline â€” S12 pagination options', () => {

    test('no options returns all entries sorted newest-first (backward compat)', () => {
        const result = buildTimeline(SESSIONS);
        assert.strictEqual(result.length, 8);
        assert.strictEqual(result[0].sessionId, 'jun-1');
        assert.strictEqual(result[result.length - 1].sessionId, 'jan-1');
    });

    // â”€â”€ monthCount â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('monthCount:1 returns only entries from the most recent month', () => {
        const result = buildTimeline(SESSIONS, { monthCount: 1 });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionId, 'jun-1');
    });

    test('monthCount:3 returns entries from the 3 most recent months', () => {
        const result = buildTimeline(SESSIONS, { monthCount: 3 });
        // Jun, May, Apr â†’ jun-1, may-1, apr-1, apr-2
        assert.strictEqual(result.length, 4);
        const ids = result.map(e => e.sessionId);
        assert.ok(ids.includes('jun-1'));
        assert.ok(ids.includes('may-1'));
        assert.ok(ids.includes('apr-1'));
        assert.ok(ids.includes('apr-2'));
        assert.ok(!ids.includes('mar-1'));
    });

    test('monthCount exceeding available months returns all entries', () => {
        const result = buildTimeline(SESSIONS, { monthCount: 99 });
        assert.strictEqual(result.length, 8);
    });

    test('monthCount:0 returns empty array', () => {
        const result = buildTimeline(SESSIONS, { monthCount: 0 });
        assert.strictEqual(result.length, 0);
    });

    // â”€â”€ before â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('before:Apr-1 excludes Apr and later', () => {
        const cutoff = new Date('2025-04-01T00:00:00Z');
        const result = buildTimeline(SESSIONS, { before: cutoff });
        const ids = result.map(e => e.sessionId);
        assert.ok(!ids.includes('apr-1'), 'apr-1 is at the cutoff, must be excluded');
        assert.ok(!ids.includes('apr-2'));
        assert.ok(!ids.includes('may-1'));
        assert.ok(!ids.includes('jun-1'));
        assert.ok(ids.includes('mar-1'));
        assert.ok(ids.includes('feb-1'));
    });

    test('before:very old date returns empty', () => {
        const result = buildTimeline(SESSIONS, { before: new Date('2020-01-01') });
        assert.strictEqual(result.length, 0);
    });

    test('before:far future returns all entries', () => {
        const result = buildTimeline(SESSIONS, { before: new Date('2099-01-01') });
        assert.strictEqual(result.length, 8);
    });

    // â”€â”€ before + monthCount combined â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('before + monthCount: load 3 months before April', () => {
        // Entries before Apr 1: Mar, Feb, Jan
        const cutoff = new Date('2025-04-01T00:00:00Z');
        const result = buildTimeline(SESSIONS, { before: cutoff, monthCount: 3 });
        // Mar, Feb(Ã—2), Jan
        assert.strictEqual(result.length, 4);
        const ids = result.map(e => e.sessionId);
        assert.ok(ids.includes('mar-1'));
        assert.ok(ids.includes('feb-1'));
        assert.ok(ids.includes('feb-2'));
        assert.ok(ids.includes('jan-1'));
    });

    test('before + monthCount:1 returns only the newest month before cutoff', () => {
        const cutoff = new Date('2025-04-01T00:00:00Z');
        const result = buildTimeline(SESSIONS, { before: cutoff, monthCount: 1 });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionId, 'mar-1');
    });

    // â”€â”€ result is still sorted newest-first after filtering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('result remains sorted newest-first with monthCount applied', () => {
        const result = buildTimeline(SESSIONS, { monthCount: 3 });
        for (let i = 0; i < result.length - 1; i++) {
            assert.ok(result[i].timestamp >= result[i + 1].timestamp,
                `Entry ${i} timestamp should be >= entry ${i+1}`);
        }
    });

    test('result remains sorted newest-first with before applied', () => {
        const result = buildTimeline(SESSIONS, { before: new Date('2025-05-01T00:00:00Z') });
        for (let i = 0; i < result.length - 1; i++) {
            assert.ok(result[i].timestamp >= result[i + 1].timestamp);
        }
    });

    // â”€â”€ empty input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('empty sessions with options returns []', () => {
        assert.deepStrictEqual(buildTimeline([], { monthCount: 3 }), []);
        assert.deepStrictEqual(buildTimeline([], { before: new Date() }), []);
    });
});

