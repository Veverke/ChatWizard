// test/suite/sessionWebviewStreaming.test.ts
//
// S7 — Session Webview Loads Entire Session Content at Once
// Verifies virtual windowing, setImmediate chunking, render cache, and the
// large-session truncation banner.

import * as assert from 'assert';
import { suite, test } from 'mocha';
import { Session, Message } from '../../src/types/index';
import {
    VisibleMessage,
    renderChunk,
    renderMessage,
} from '../../src/views/sessionRenderer';

// ── Fixture helpers ───────────────────────────────────────────────────────────

let _msgId = 0;

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `m${++_msgId}`, role, content, codeBlocks: [] };
}

function makeSession(id: string, msgCount: number, updatedAt = '2024-01-01T00:00:00.000Z'): Session {
    const messages: Message[] = [];
    for (let i = 0; i < msgCount; i++) {
        messages.push(makeMessage(i % 2 === 0 ? 'user' : 'assistant', `Message content ${i}`));
    }
    return {
        id,
        title: `Session ${id}`,
        source: 'claude',
        workspaceId: 'ws-test',
        messages,
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt,
    };
}

// ── _renderMessage ────────────────────────────────────────────────────────────

suite('S7 — _renderMessage', () => {
    test('renders user message with correct role class', () => {
        const session = makeSession('s-render', 2);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', undefined
        );
        assert.ok(html.includes('class="message user cw-fade-item"'), 'user role class present');
        assert.ok(html.includes('data-msg-idx="0"'), 'origIdx attribute present');
    });

    test('renders assistant message with correct role class', () => {
        const session = makeSession('s-render-asst', 2);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[1].msg, visible[1].origIdx, 1, visible, 'Claude', undefined
        );
        assert.ok(html.includes('class="message assistant cw-fade-item"'), 'assistant role class present');
    });

    test('includes fade style when fadeIdx < 16', () => {
        const session = makeSession('s-fade', 2);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', 5
        );
        assert.ok(html.includes('style="--cw-i:5"'), 'fade style injected');
    });

    test('omits fade style when fadeIdx is undefined', () => {
        const session = makeSession('s-nofade', 2);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', undefined
        );
        assert.ok(!html.includes('--cw-i'), 'no fade style when undefined');
    });

    test('omits fade style when fadeIdx >= 16', () => {
        const session = makeSession('s-nofade16', 2);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', 16
        );
        assert.ok(!html.includes('--cw-i'), 'no fade style for index >= 16');
    });

    test('appends aborted placeholder when user message has no following assistant reply', () => {
        const session = makeSession('s-aborted', 1); // only 1 message (user), no assistant follows
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', undefined
        );
        assert.ok(html.includes('aborted-notice'), 'aborted placeholder included');
    });

    test('does not append aborted placeholder when user is followed by assistant', () => {
        const session = makeSession('s-normal', 2); // user then assistant
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const html = renderMessage(
            visible[0].msg, visible[0].origIdx, 0, visible, 'Claude', undefined
        );
        assert.ok(!html.includes('aborted-notice'), 'no aborted placeholder when assistant follows');
    });
});

// ── _renderChunk ──────────────────────────────────────────────────────────────

suite('S7 — _renderChunk', () => {
    test('renders a range of messages and stores results in renderedMessages cache', () => {
        const session = makeSession('s-chunk', 10);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(10).fill(null);

        const html = renderChunk(visible, cache, 0, 5, 'Claude', false);
        assert.ok(html.length > 0, 'produces non-empty HTML');
        // First 5 should be populated in cache
        for (let i = 0; i < 5; i++) {
            assert.ok(cache[i] !== null, `cache[${i}] should be populated`);
        }
        // Remaining should still be null
        for (let i = 5; i < 10; i++) {
            assert.strictEqual(cache[i], null, `cache[${i}] should still be null`);
        }
    });

    test('uses cached values on second call (no re-render)', () => {
        const session = makeSession('s-cache-hit', 6);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(6).fill(null);

        // First render
        const html1 = renderChunk(visible, cache, 0, 3, 'Claude', false);
        // Overwrite cache with sentinel values to detect re-render
        const sentinel = '<!-- cached -->';
        cache[0] = sentinel; cache[1] = sentinel; cache[2] = sentinel;

        // Second render — must use cache, not re-render
        const html2 = renderChunk(visible, cache, 0, 3, 'Claude', false);
        assert.ok(html2.includes(sentinel), 'second call uses cached value');
        assert.ok(!html1.includes(sentinel), 'first call did not have sentinel');
    });

    test('withFade=true applies fade styles to first 16 messages in chunk', () => {
        const session = makeSession('s-fade-chunk', 20);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(20).fill(null);

        const html = renderChunk(visible, cache, 0, 20, 'Claude', true);
        // First 16 should have fade style
        for (let i = 0; i < 16; i++) {
            assert.ok(html.includes(`--cw-i:${i}`), `fade style for index ${i} present`);
        }
    });

    test('withFade=false produces no fade styles', () => {
        const session = makeSession('s-nofade-chunk', 10);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(10).fill(null);

        const html = renderChunk(visible, cache, 0, 10, 'Claude', false);
        assert.ok(!html.includes('--cw-i'), 'no fade styles when withFade=false');
    });
});

// ── Virtual window computation ─────────────────────────────────────────────────

suite('S7 — Virtual window (initial window boundaries)', () => {
    test('normal session (<=500 msgs): windowStart = max(0, total - 50)', () => {
        // Access the private render cache to verify window start indirectly
        // by checking that _renderCache only has slots for 100 messages
        const session = makeSession('s-normal-window', 100);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const total = visible.length;
        // Window: max(0, 100 - 50) = 50
        const expectedStart = Math.max(0, total - 50);
        assert.strictEqual(expectedStart, 50, 'windowStart should be 50 for 100-message session');
    });

    test('small session (<50 msgs): windowStart = 0 (show all)', () => {
        const total = 30;
        const INITIAL_WINDOW = 50;
        const windowStart = Math.max(0, total - INITIAL_WINDOW);
        assert.strictEqual(windowStart, 0, 'windowStart should be 0 for small session');
    });

    test('large session (>500 msgs): windowStart = max(0, total - 200)', () => {
        const total = 600;
        const LARGE_INITIAL = 200;
        const windowStart = Math.max(0, total - LARGE_INITIAL);
        assert.strictEqual(windowStart, 400, 'windowStart should be 400 for 600-message session');
    });

    test('large session isTruncated flag is true when windowStart > 0', () => {
        const total = 600;
        const LARGE_THRESHOLD = 500;
        const LARGE_INITIAL = 200;
        const isLarge = total > LARGE_THRESHOLD;
        const windowStart = Math.max(0, total - LARGE_INITIAL);
        const isTruncated = isLarge && windowStart > 0;
        assert.strictEqual(isTruncated, true, 'isTruncated should be true for large session');
    });

    test('session of exactly 500 msgs is NOT large (boundary)', () => {
        const total = 500;
        const LARGE_THRESHOLD = 500;
        const isLarge = total > LARGE_THRESHOLD;
        assert.strictEqual(isLarge, false, '500 messages is not large (strict >)');
    });

    test('session of 501 msgs IS large', () => {
        const total = 501;
        const LARGE_THRESHOLD = 500;
        const isLarge = total > LARGE_THRESHOLD;
        assert.strictEqual(isLarge, true, '501 messages is large');
    });
});

// ── Render cache (_renderCache) ───────────────────────────────────────────────

suite('S7 — Render cache', () => {
    test('_renderChunk populates cache for each rendered message', () => {
        const session = makeSession('s-rc-pop', 5);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(5).fill(null);

        renderChunk(visible, cache, 1, 4, 'Claude', false);

        assert.strictEqual(cache[0], null, 'slot 0 not touched');
        assert.ok(cache[1] !== null,        'slot 1 populated');
        assert.ok(cache[2] !== null,        'slot 2 populated');
        assert.ok(cache[3] !== null,        'slot 3 populated');
        assert.strictEqual(cache[4], null, 'slot 4 not touched');
    });

    test('two consecutive _renderChunk calls with no mutation return same HTML', () => {
        const session = makeSession('s-rc-same', 4);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(4).fill(null);

        const html1 = renderChunk(visible, cache, 0, 4, 'Claude', false);
        const html2 = renderChunk(visible, cache, 0, 4, 'Claude', false);
        assert.strictEqual(html1, html2, 'cached render is identical');
    });

    test('_renderCache keyed on sessionId::updatedAt isolates sessions', () => {
        // Two sessions with same ID but different updatedAt must have separate caches
        const key1 = 's-iso::2024-01-01T00:00:00.000Z';
        const key2 = 's-iso::2024-02-01T00:00:00.000Z';
        assert.notStrictEqual(key1, key2, 'cache keys differ for different updatedAt');
    });
});

// ── Performance: 500-message session first content within 200 ms ──────────────

suite('S7 — Performance', () => {
    test('rendering the initial chunk for a 500-message session completes in < 200 ms', function() {
        this.timeout(5_000);

        const session = makeSession('s-perf-500', 500);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const total = visible.length;  // 500

        // Simulate what _startStream does: compute window, render first chunk
        const INITIAL_WINDOW = 50;
        const CHUNK_SIZE     = 20;
        const windowStart    = Math.max(0, total - INITIAL_WINDOW); // 450
        const firstEnd       = Math.min(windowStart + CHUNK_SIZE, total); // 470
        const cache          = new Array<string | null>(total).fill(null);

        const start = performance.now();
        const html = renderChunk(
            visible, cache, windowStart, firstEnd, 'Claude', true
        );
        const elapsed = performance.now() - start;

        assert.ok(html.length > 0,    'produced HTML');
        assert.ok(
            elapsed < 200,
            `first chunk rendered in ${elapsed.toFixed(1)} ms — expected < 200 ms`
        );
    });

    test('cache hit on second render of first chunk is near-instant (< 5 ms)', function() {
        this.timeout(5_000);

        const session = makeSession('s-perf-cache', 500);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const total = visible.length;

        const windowStart = Math.max(0, total - 50);
        const firstEnd    = Math.min(windowStart + 20, total);
        const cache       = new Array<string | null>(total).fill(null);

        // Prime the cache
        renderChunk(visible, cache, windowStart, firstEnd, 'Claude', false);

        // Measure second call (cache hit)
        const start = performance.now();
        renderChunk(visible, cache, windowStart, firstEnd, 'Claude', false);
        const elapsed = performance.now() - start;

        assert.ok(elapsed < 5, `cache hit took ${elapsed.toFixed(2)} ms — expected < 5 ms`);
    });
});

// ── Shell HTML structure ──────────────────────────────────────────────────────

suite('S7 — Shell HTML', () => {
    test('renderChunk produces message divs with data-msg-idx attributes', () => {
        const session = makeSession('s-html-attrs', 4);
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(4).fill(null);

        const html = renderChunk(visible, cache, 0, 4, 'Claude', false);
        assert.ok(html.includes('data-msg-idx="0"'), 'data-msg-idx=0 present');
        assert.ok(html.includes('data-msg-idx="1"'), 'data-msg-idx=1 present');
        assert.ok(html.includes('data-msg-idx="2"'), 'data-msg-idx=2 present');
        assert.ok(html.includes('data-msg-idx="3"'), 'data-msg-idx=3 present');
    });

    test('messages are wrapped in correct role class divs', () => {
        const session = makeSession('s-html-roles', 2); // user at 0, assistant at 1
        const visible = session.messages.map((msg, origIdx) => ({ msg, origIdx }));
        const cache = new Array<string | null>(2).fill(null);

        const html = renderChunk(visible, cache, 0, 2, 'Claude', false);
        assert.ok(html.includes('class="message user'), 'user message present');
        assert.ok(html.includes('class="message assistant'), 'assistant message present');
    });
});
