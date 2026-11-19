// test/unit/sessionWebviewPanel.loadAll.test.ts
// Unit tests for the "Load all messages" control of the session reader:
// the full-transcript batch streamer and the search/Ctrl+F integration that
// makes a search cover the whole conversation instead of the initial excerpt.

import * as assert from 'assert';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';

type Posted = { [key: string]: any };

const PANEL_ID = 'load-all-session';

interface Harness {
    state:   any;
    posted:  Posted[];
}

function makeHarness(total: number, windowEnd: number): Harness {
    const posted: Posted[] = [];
    const visibleMessages = Array.from({ length: total }, (_, i) => ({
        msg: { role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` },
        origIdx: i,
    }));
    const state: any = {
        session: {
            id: PANEL_ID, title: 'Load all', source: 'cline',
            messages: [], createdAt: '', updatedAt: '',
        },
        visibleMessages,
        renderedMessages: new Array(total).fill(null),
        windowStart: 0,
        windowEnd,
        streamVersion: 1,
        assistantLabel: 'Cline',
        panel: { webview: { postMessage: (m: Posted) => { posted.push(m); return true; } } },
    };
    (SessionWebviewPanel as any)._panelState.set(PANEL_ID, state);
    return { state, posted };
}

suite('SessionWebviewPanel – Load all messages', () => {
    teardown(() => {
        (SessionWebviewPanel as any)._panelState.delete(PANEL_ID);
        SessionWebviewPanel._renderCache.clear();
    });

    test('streams every remaining message in CHUNK_SIZE batches', async () => {
        const { state, posted } = makeHarness(95, 50);

        await SessionWebviewPanel._loadAllMessages(PANEL_ID);

        const chunks = posted.filter(m => m.type === 'appendChunk');
        assert.strictEqual(chunks.length, 3, 'expected 3 batches for 45 remaining messages');
        assert.deepStrictEqual(chunks.map(c => c.newWindowEnd), [70, 90, 95]);
        assert.deepStrictEqual(chunks.map(c => c.hasMore), [true, true, false]);
        assert.ok(chunks.every(c => c.loadAll === true), 'batches must be flagged loadAll');
        assert.strictEqual(state.windowEnd, 95, 'window end must reach the last message');
    });

    test('batches cover the remaining messages once, in order', async () => {
        const { posted } = makeHarness(95, 50);

        await SessionWebviewPanel._loadAllMessages(PANEL_ID);

        const indices = posted
            .filter(m => m.type === 'appendChunk')
            .flatMap(m => [...String(m.messagesHtml).matchAll(/data-msg-idx="(\d+)"/g)]
                .map(mm => Number(mm[1])));
        assert.deepStrictEqual(indices, Array.from({ length: 45 }, (_, i) => 50 + i));
    });

    test('sends exactly one terminating loadAllDone message', async () => {
        const { posted } = makeHarness(95, 50);

        await SessionWebviewPanel._loadAllMessages(PANEL_ID);

        const done = posted.filter(m => m.type === 'loadAllDone');
        assert.strictEqual(done.length, 1);
        assert.strictEqual(done[0].hasMore, false);
        assert.strictEqual(done[0].loaded, 95);
        assert.strictEqual(done[0].total, 95);
    });

    test('terminates immediately when everything is already loaded', async () => {
        const { posted } = makeHarness(95, 95);

        await SessionWebviewPanel._loadAllMessages(PANEL_ID);

        assert.strictEqual(posted.length, 1, 'only the terminator is posted');
        assert.strictEqual(posted[0].type, 'loadAllDone');
        assert.strictEqual(posted[0].hasMore, false);
    });

    test('aborts without a terminator when a newer render supersedes it', async () => {
        const { state, posted } = makeHarness(95, 50);

        const streaming = SessionWebviewPanel._loadAllMessages(PANEL_ID);
        state.streamVersion = 2; // panel re-shown while streaming
        await streaming;

        assert.strictEqual(posted.filter(m => m.type === 'loadAllDone').length, 0);
        assert.ok(state.windowEnd < 95, 'streaming must stop on abort');
    });

    test('waits for the initial window stream before appending', async () => {
        const { state, posted } = makeHarness(95, 50);
        state.streamInFlight = true;

        const streaming = SessionWebviewPanel._loadAllMessages(PANEL_ID);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(posted.length, 0, 'no batch may overlap the initial stream');

        state.streamInFlight = false;
        await streaming;

        assert.strictEqual(state.windowEnd, 95);
        assert.strictEqual(posted.filter(m => m.type === 'appendChunk').length, 3);
    });

    test('load-more also waits for the initial stream (no duplicate appends)', async () => {
        const { state, posted } = makeHarness(95, 50);
        state.streamInFlight = true;

        const loading = SessionWebviewPanel._loadMoreMessages(PANEL_ID);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(posted.length, 0, 'no chunk may overlap the initial stream');

        state.streamInFlight = false;
        await loading;

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(state.windowEnd, 70);
    });

    test('unknown panel id is ignored', async () => {
        await SessionWebviewPanel._loadAllMessages('does-not-exist');
    });
});


suite('SessionWebviewPanel – Load all messages UI wiring', () => {
    const html = (SessionWebviewPanel as any)._getShellHtml() as string;

    test('"Load all messages" button sits at the top of the chat (sticky toolbar)', () => {
        const toolbarStart = html.indexOf('<div class="toolbar">');
        const containerStart = html.indexOf('id="messages-container"');
        assert.ok(toolbarStart > -1 && containerStart > toolbarStart, 'toolbar precedes the messages');
        const toolbar = html.slice(toolbarStart, containerStart);
        assert.ok(toolbar.includes('id="load-all-btn"'), 'load-all button lives in the top toolbar');
        assert.ok(toolbar.includes('>Load all messages<'), 'button is labelled');
    });

    test('button carries a spinner that only shows while loading', () => {
        assert.ok(html.includes('id="load-all-btn-label"'), 'label span is present');
        assert.ok(html.includes('#load-all-btn .cw-spinner'), 'spinner styling is present');
        assert.ok(html.includes('@keyframes cw-spin'), 'spinner animation is present');
        assert.ok(html.includes("classList.toggle('cw-loading', _loadingAll)"), 'spinner toggled while loading');
    });

    test('Ctrl+F loads the whole transcript before searching', () => {
        const at = html.indexOf("e.key === 'f'");
        assert.ok(at > -1, 'Ctrl+F handler is present');
        const handler = html.slice(at, at + 600);
        assert.ok(/startLoadAll\(\)/.test(handler), 'Ctrl+F starts a full load');
    });

    test('a search queues itself behind the full load instead of searching the excerpt', () => {
        const at = html.indexOf('function runSearch(');
        assert.ok(at > -1, 'runSearch is present');
        const body = html.slice(at, at + 1200);
        assert.ok(/_pendingSearchQuery = query/.test(body), 'search term is queued');
        assert.ok(/startLoadAll\(\);/.test(body), 'search starts a full load');
        assert.ok(/if \(_loadingAll\) \{ return; \}/.test(body), 'search waits for the load to finish');
    });

    test('completion re-runs the queued search and clears the spinner', () => {
        const at = html.indexOf('function finishLoadAll(');
        assert.ok(at > -1, 'finishLoadAll is present');
        const body = html.slice(at, at + 900);
        assert.ok(/_loadingAll = false/.test(body), 'spinner state cleared');
        assert.ok(/runSearch\(query\)/.test(body), 'queued search re-runs');
    });
});
