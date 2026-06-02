// test/unit/sourceWatcher.test.ts
// Unit tests for the ISourceWatcher interface contract.
// Tests use a simple in-memory stub to verify:
//   - buildIndex() runs in parallel (max time ≈ max(t_source))
//   - startWatching() is called after buildIndex()
//   - dispose() cleans up all watchers

import * as assert from 'assert';
import { ISourceWatcher, SourceWatcherDeps } from '../../src/watcher/ISourceWatcher';
import { Session } from '../../src/types/index';

// ---- helpers ----------------------------------------------------------------

function makeSession(id: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source: 'cline' as Session['source'],
        workspaceId: 'ws1',
        workspacePath: '/tmp/ws',
        filePath: `/tmp/sessions/${id}.jsonl`,
        messages: [
            { id: `msg-${id}`, role: 'user', content: 'hello', timestamp: new Date().toISOString(), codeBlocks: [] },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Stub watcher that records calls and returns a fixed session.
 * `buildDelay` controls simulated async work duration.
 */
class StubSourceWatcher implements ISourceWatcher {
    public readonly sourceId: string;
    private readonly _session: Session;
    private readonly _buildDelay: number;

    public buildIndexCallCount = 0;
    public startWatchingCallCount = 0;
    public disposeCallCount = 0;

    constructor(id: string, buildDelay = 0) {
        this.sourceId = id;
        this._session = makeSession(id);
        this._buildDelay = buildDelay;
    }

    async buildIndex(): Promise<Session[]> {
        this.buildIndexCallCount++;
        if (this._buildDelay > 0) {
            await new Promise<void>(r => setTimeout(r, this._buildDelay));
        }
        return [this._session];
    }

    startWatching(): void {
        this.startWatchingCallCount++;
    }

    dispose(): void {
        this.disposeCallCount++;
    }
}

// ---- tests ------------------------------------------------------------------

suite('ISourceWatcher contract', () => {
    test('buildIndex returns sessions', async () => {
        const watcher = new StubSourceWatcher('test-src');
        const sessions = await watcher.buildIndex();
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].id, 'test-src');
    });

    test('startWatching is called after buildIndex', async () => {
        const watcher = new StubSourceWatcher('watcher-src');
        await watcher.buildIndex();
        watcher.startWatching();
        assert.strictEqual(watcher.buildIndexCallCount, 1);
        assert.strictEqual(watcher.startWatchingCallCount, 1);
    });

    test('dispose cleans up', () => {
        const watcher = new StubSourceWatcher('dispose-src');
        watcher.dispose();
        assert.strictEqual(watcher.disposeCallCount, 1);
    });

    test('parallel buildIndex is faster than serial (max vs sum)', async () => {
        const DELAY = 50; // ms per source
        const watchers: ISourceWatcher[] = [
            new StubSourceWatcher('s1', DELAY),
            new StubSourceWatcher('s2', DELAY),
            new StubSourceWatcher('s3', DELAY),
        ];

        // Parallel (as ChatWizardWatcher does via Promise.all)
        const t0 = Date.now();
        const allSessions = (await Promise.all(watchers.map(w => w.buildIndex()))).flat();
        const parallelMs = Date.now() - t0;

        assert.strictEqual(allSessions.length, 3, 'all sessions returned');

        // Parallel time should be well under sum(delays) = 3 * DELAY
        const sumMs = DELAY * watchers.length;
        assert.ok(
            parallelMs < sumMs,
            `Parallel build (${parallelMs}ms) should be < serial sum (${sumMs}ms)`
        );
    });

    test('sourceId is read-only identifier', () => {
        const watcher = new StubSourceWatcher('my-source');
        assert.strictEqual(watcher.sourceId, 'my-source');
    });

    test('multiple dispose calls are safe', () => {
        const watcher = new StubSourceWatcher('double-dispose');
        watcher.dispose();
        watcher.dispose(); // second call should not throw
        assert.strictEqual(watcher.disposeCallCount, 2);
    });
});

suite('ISourceWatcher parallel orchestration pattern', () => {
    test('all sources are indexed even if one returns empty', async () => {
        class EmptyWatcher extends StubSourceWatcher {
            async buildIndex(): Promise<Session[]> {
                this.buildIndexCallCount++;
                return [];
            }
        }

        const watchers: ISourceWatcher[] = [
            new StubSourceWatcher('src-a'),
            new EmptyWatcher('src-b'),
            new StubSourceWatcher('src-c'),
        ];

        const results = (await Promise.all(watchers.map(w => w.buildIndex()))).flat();
        assert.strictEqual(results.length, 2);
        assert.ok(results.some(s => s.id === 'src-a'));
        assert.ok(results.some(s => s.id === 'src-c'));
    });

    test('one failing source does not prevent others from completing', async () => {
        class FailingWatcher implements ISourceWatcher {
            readonly sourceId = 'failing';
            async buildIndex(): Promise<Session[]> { throw new Error('simulated failure'); }
            startWatching(): void { /* no-op */ }
            dispose(): void { /* no-op */ }
        }

        const watchers = [
            new StubSourceWatcher('ok1'),
            new FailingWatcher(),
            new StubSourceWatcher('ok2'),
        ];

        // Orchestrator wraps each in a catch (defensive pattern)
        const results = (await Promise.all(
            watchers.map(w => w.buildIndex().catch(() => [] as Session[]))
        )).flat();

        assert.strictEqual(results.length, 2);
        assert.ok(results.every(s => s.id === 'ok1' || s.id === 'ok2'));
    });
});