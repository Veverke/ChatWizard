// test/e2e/liveSessionTracker.test.ts

import * as assert from 'assert';
import { LiveSessionTracker } from '../../src/utils/liveSessionTracker';

suite('LiveSessionTracker', () => {

    // ── record / getActive ─────────────────────────────────────────────────

    test('record then getActive returns the entry within window', () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'sess-1');

        const active = tracker.getActive(2 * 60 * 60 * 1000); // 2 h window
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0].sessionId, 'sess-1');
        assert.strictEqual(active[0].source, 'copilot');
    });

    test('record twice for same source keeps only the latest', () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'sess-1');
        tracker.record('copilot', 'sess-2');

        const active = tracker.getActive();
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0].sessionId, 'sess-2');
    });

    test('two different sources both appear in getActive', () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'cp-1');
        tracker.record('claude', 'cl-1');

        const active = tracker.getActive();
        assert.strictEqual(active.length, 2);
        const sources = active.map(e => e.source).sort();
        assert.deepStrictEqual(sources, ['claude', 'copilot']);
    });

    test('getActive returns most-recent first', () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'cp-1');
        tracker.record('claude', 'cl-1');

        const active = tracker.getActive();
        // The last record() call is 'claude', so it should sort first
        assert.strictEqual(active[0].source, 'claude');
    });

    test('getActive with very small window excludes old entries', async () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'cp-old');

        // Wait 5 ms then call with 1 ms window — entry should be excluded
        await new Promise(r => setTimeout(r, 5));
        const active = tracker.getActive(1); // 1 ms window
        assert.strictEqual(active.length, 0);
    });

    // ── getMostRecent ──────────────────────────────────────────────────────

    test('getMostRecent returns undefined when empty', () => {
        const tracker = new LiveSessionTracker();
        assert.strictEqual(tracker.getMostRecent(), undefined);
    });

    test('getMostRecent returns the last recorded entry regardless of window', async () => {
        const tracker = new LiveSessionTracker();
        tracker.record('cline', 'c-1');

        await new Promise(r => setTimeout(r, 5));
        // getActive with 1 ms window excludes it but getMostRecent should still return it
        assert.strictEqual(tracker.getActive(1).length, 0);

        const most = tracker.getMostRecent();
        assert.ok(most);
        assert.strictEqual(most.sessionId, 'c-1');
    });

    test('getMostRecent returns the most recently recorded across sources', () => {
        const tracker = new LiveSessionTracker();
        tracker.record('copilot', 'cp-1');
        tracker.record('claude', 'cl-1');

        const most = tracker.getMostRecent();
        assert.ok(most);
        assert.strictEqual(most.source, 'claude');
        assert.strictEqual(most.sessionId, 'cl-1');
    });

    // ── onDidUpdate ────────────────────────────────────────────────────────

    test('onDidUpdate fires when record is called', () => {
        const tracker = new LiveSessionTracker();
        let callCount = 0;
        tracker.onDidUpdate(() => { callCount++; });

        tracker.record('copilot', 'sess-1');
        tracker.record('copilot', 'sess-2');

        assert.strictEqual(callCount, 2);
    });

    test('onDidUpdate dispose stops future notifications', () => {
        const tracker = new LiveSessionTracker();
        let callCount = 0;
        const sub = tracker.onDidUpdate(() => { callCount++; });

        tracker.record('copilot', 'sess-1');
        sub.dispose();
        tracker.record('copilot', 'sess-2');

        assert.strictEqual(callCount, 1);
    });
});
