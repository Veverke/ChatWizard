/**
 * test/unit/liveSessionTracker.test.ts
 *
 * Unit tests for liveSessionTracker — pure class tracking live session updates.
 */

import * as assert from 'assert';
import { LiveSessionTracker } from '../../src/utils/liveSessionTracker';

suite('liveSessionTracker', () => {
    suite('LiveSessionTracker', () => {
        test('getActive returns empty for no records', () => {
            const tracker = new LiveSessionTracker();
            assert.deepStrictEqual(tracker.getActive(), []);
        });

        test('getMostRecent returns undefined for no records', () => {
            const tracker = new LiveSessionTracker();
            assert.strictEqual(tracker.getMostRecent(), undefined);
        });

        test('record adds entry and getActive returns it within window', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('copilot', 'session-1');
            const active = tracker.getActive(100_000); // generous window
            assert.strictEqual(active.length, 1);
            assert.strictEqual(active[0].sessionId, 'session-1');
            assert.strictEqual(active[0].source, 'copilot');
        });

        test('record replaces previous entry for same source', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('copilot', 'session-1');
            tracker.record('copilot', 'session-2');
            const active = tracker.getActive(100_000);
            assert.strictEqual(active.length, 1);
            assert.strictEqual(active[0].sessionId, 'session-2');
        });

        test('getActive respects windowMs parameter', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('copilot', 'session-1');
            // Use a negative window so nothing is within range
            const active = tracker.getActive(-1);
            assert.strictEqual(active.length, 0);
        });

        test('getActive returns multiple sources sorted most-recent first', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('cursor', 'cursor-session');
            // Small delay to ensure different timestamps
            tracker.record('copilot', 'copilot-session');
            const active = tracker.getActive(100_000);
            assert.strictEqual(active.length, 2);
            assert.strictEqual(active[0].sessionId, 'copilot-session'); // most recent first
            assert.strictEqual(active[1].sessionId, 'cursor-session');
        });

        test('getMostRecent returns the most recently recorded entry', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('cursor', 'old-session');
            tracker.record('copilot', 'new-session');
            const recent = tracker.getMostRecent();
            assert.ok(recent !== undefined);
            assert.strictEqual(recent!.sessionId, 'new-session');
        });

        test('getMostRecent returns undefined after no records', () => {
            const tracker = new LiveSessionTracker();
            assert.strictEqual(tracker.getMostRecent(), undefined);
        });

        test('onDidUpdate fires listeners on record', () => {
            const tracker = new LiveSessionTracker();
            let callCount = 0;
            const disposable = tracker.onDidUpdate(() => { callCount++; });
            tracker.record('copilot', 's1');
            assert.strictEqual(callCount, 1);
            tracker.record('copilot', 's2');
            assert.strictEqual(callCount, 2);
            disposable.dispose();
            tracker.record('copilot', 's3');
            assert.strictEqual(callCount, 2); // no longer listening
        });

        test('dispose of listener stops firing', () => {
            const tracker = new LiveSessionTracker();
            let callCount = 0;
            const disposable = tracker.onDidUpdate(() => { callCount++; });
            disposable.dispose();
            tracker.record('copilot', 's1');
            assert.strictEqual(callCount, 0);
        });

        test('multiple independent sources coexist', () => {
            const tracker = new LiveSessionTracker();
            tracker.record('copilot', 'cp-session');
            tracker.record('cursor', 'cs-session');
            tracker.record('windsurf', 'ws-session');
            const active = tracker.getActive(100_000);
            assert.strictEqual(active.length, 3);
            const sources = active.map(e => e.source).sort();
            assert.deepStrictEqual(sources, ['copilot', 'cursor', 'windsurf']);
        });
    });
});