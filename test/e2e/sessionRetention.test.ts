// test/e2e/sessionRetention.test.ts
// Feature 43 — Session Retention Controls

import * as assert from 'assert';
import { SessionIndex } from '../../src/index/sessionIndex';
import type { Session } from '../../src/types/index';

function makeSession(id: string, updatedAt: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'claude',
        workspaceId: 'ws1',
        messages: [{ id: `${id}-m0`, role: 'user', content: `content for ${id}`, codeBlocks: [] }],
        filePath: `/tmp/${id}.jsonl`,
        createdAt: updatedAt,
        updatedAt,
    };
}

/** Returns an ISO date string N days ago from now */
function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString();
}

suite('Feature 43 — Session Retention Controls', () => {
    let index: SessionIndex;

    setup(() => {
        index = new SessionIndex();
    });

    test('getAllSummaries() returns all sessions when retentionDays is 0 (default)', () => {
        index.batchUpsert([
            makeSession('recent', daysAgo(10)),
            makeSession('old', daysAgo(400)),
        ]);
        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 2, 'all sessions should be visible with retentionDays=0');
    });

    test('getAllSummaries() excludes sessions older than retentionDays when set > 0', () => {
        index.batchUpsert([
            makeSession('recent', daysAgo(10)),
            makeSession('old', daysAgo(400)),
        ]);
        index.setRetentionDays(30);
        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 1, 'only recent session should appear');
        assert.strictEqual(summaries[0].id, 'recent');
    });

    test('getAllSummaries() includes all sessions when retentionDays is set back to 0', () => {
        index.batchUpsert([
            makeSession('recent', daysAgo(10)),
            makeSession('old', daysAgo(400)),
        ]);
        index.setRetentionDays(30);
        assert.strictEqual(index.getAllSummaries().length, 1);

        index.setRetentionDays(0);
        assert.strictEqual(index.getAllSummaries().length, 2, 'all sessions restored when retentionDays=0');
    });

    test('search() respects retention filter', () => {
        index.batchUpsert([
            makeSession('recent', daysAgo(5)),
            makeSession('old', daysAgo(200)),
        ]);
        index.setRetentionDays(30);
        const results = index.search('content for');
        assert.strictEqual(results.length, 1, 'only recent session should match');
        assert.strictEqual(results[0].id, 'recent');
    });

    test('setRetentionDays invalidates the summary cache', () => {
        index.batchUpsert([
            makeSession('s1', daysAgo(5)),
            makeSession('s2', daysAgo(100)),
        ]);
        const before = index.getAllSummaries().length;
        assert.strictEqual(before, 2);
        index.setRetentionDays(30);
        const after = index.getAllSummaries().length;
        assert.strictEqual(after, 1, 'cache should be invalidated after setRetentionDays');
    });

    test('sessions exactly at the cutoff boundary are included', () => {
        // A session with updatedAt = exactly retentionDays ago should be included
        const cutoffTime = new Date(Date.now() - 30 * 86_400_000 + 5000).toISOString(); // 5 sec inside window
        index.batchUpsert([makeSession('boundary', cutoffTime)]);
        index.setRetentionDays(30);
        const summaries = index.getAllSummaries();
        assert.strictEqual(summaries.length, 1, 'session within window should be included');
    });

    test('setRetentionDays fires change listeners', () => {
        let notified = false;
        index.addChangeListener(() => { notified = true; });
        index.batchUpsert([makeSession('s1', daysAgo(5))]);
        notified = false;
        index.setRetentionDays(7);
        assert.ok(notified, 'change listeners should fire when retentionDays changes');
    });

    test('setRetentionDays does not fire listeners when value unchanged', () => {
        index.setRetentionDays(30); // set initial
        let notified = false;
        index.addChangeListener(() => { notified = true; });
        index.setRetentionDays(30); // same value
        assert.strictEqual(notified, false, 'no notification when value unchanged');
    });
});