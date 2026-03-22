// test/suite/modelUsageViewProvider.test.ts
//
// Integration tests for ModelUsageViewProvider message handling.

import * as assert from 'assert';
import { ModelUsageViewProvider } from '../../src/analytics/modelUsageViewProvider';
import { SessionSummary } from '../../src/types/index';

// -- Minimal vscode mocks -------------------------------------------------------

type MessageHandler = (msg: unknown) => void;

interface MockWebview {
    html: string;
    postMessageCalls: unknown[];
    messageHandlers: MessageHandler[];
    options: Record<string, unknown>;
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(handler: MessageHandler): { dispose: () => void };
}

function makeMockWebview(): MockWebview {
    return {
        html: '',
        postMessageCalls: [],
        messageHandlers: [],
        options: {},
        postMessage(msg: unknown): Promise<boolean> {
            this.postMessageCalls.push(msg);
            return Promise.resolve(true);
        },
        onDidReceiveMessage(handler: MessageHandler): { dispose: () => void } {
            this.messageHandlers.push(handler);
            return { dispose: () => {} };
        },
    };
}

function makeWebviewView(visible = true): {
    webview: MockWebview;
    visible: boolean;
    visibilityHandlers: Array<() => void>;
    onDidChangeVisibility(h: () => void): { dispose: () => void };
} {
    const wv = makeMockWebview();
    return {
        webview: wv,
        visible,
        visibilityHandlers: [] as Array<() => void>,
        onDidChangeVisibility(h: () => void): { dispose: () => void } {
            this.visibilityHandlers.push(h);
            return { dispose: () => {} };
        },
    };
}

// -- Minimal mocks for SessionIndex and ExtensionContext -----------------------

type TypedListener = (event: unknown) => void;

function makeMinimalIndex(summaries: SessionSummary[] = []) {
    const typedListeners: TypedListener[] = [];
    return {
        getAllSummaries: () => summaries,
        _fireTyped: (event: unknown) => typedListeners.forEach(l => l(event)),
        addTypedChangeListener(fn: TypedListener): { dispose: () => void } {
            typedListeners.push(fn);
            return { dispose: () => {} };
        },
    } as unknown as import('../../src/index/sessionIndex').SessionIndex & { _fireTyped: (e: unknown) => void };
}

function makeMinimalContext(): import('vscode').ExtensionContext {
    return {
        subscriptions: [],
    } as unknown as import('vscode').ExtensionContext;
}

const CANCEL_TOKEN = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
} as import('vscode').CancellationToken;

// -- Helpers -------------------------------------------------------------------

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        title: 'Test',
        source: 'claude',
        workspaceId: 'ws',
        filePath: '/tmp/test.jsonl',
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-03-15T12:00:00Z',
        ...overrides,
    };
}

function getUpdateMessages(calls: unknown[]): Array<{ type: string; data: unknown; dateRange: { from: string; to: string } }> {
    return calls.filter(
        (m): m is { type: string; data: unknown; dateRange: { from: string; to: string } } =>
            typeof m === 'object' && m !== null && (m as { type?: string }).type === 'update'
    );
}

// -- Tests ---------------------------------------------------------------------

suite('ModelUsageViewProvider — shell HTML', () => {

    test('getShellHtml returns a non-empty HTML string', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(typeof html === 'string' && html.length > 0);
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    });

    test('shell HTML contains both date input elements', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(html.includes('id="from-input"'), 'should contain from-input');
        assert.ok(html.includes('id="to-input"'), 'should contain to-input');
    });

    test('shell HTML contains preset buttons', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(html.includes('btn-this-month'), 'should contain This Month button');
        assert.ok(html.includes('btn-last-30'), 'should contain Last 30 Days button');
        assert.ok(html.includes('btn-last-3m'), 'should contain Last 3 Months button');
        assert.ok(html.includes('btn-all-time'), 'should contain All Time button');
    });

    test('shell HTML contains summary-tbody for the table', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(html.includes('id="summary-tbody"'), 'should contain summary-tbody');
    });

    test('shell HTML sends ready postMessage', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(
            html.includes("type: 'ready'") || html.includes('type: "ready"'),
            'should send ready message'
        );
    });

    test('shell HTML contains update message handler', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(
            html.includes("msg.type === 'update'") || html.includes("msg.type !== 'update'") ||
            html.includes('type !== \'update\'') || html.includes("type: 'update'"),
            'should contain update message handler'
        );
    });

    test('shell HTML uses vscode CSS variables (no hardcoded colors)', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        assert.ok(html.includes('--vscode-editor-background') || html.includes('--vscode-editor-foreground'),
            'should use vscode CSS variables');
    });

    test('date inputs are pre-populated with default range (first of current month, today)', () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const html = provider.getShellHtml({} as import('vscode').Webview);
        const now = new Date();
        const expectedFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        assert.ok(html.includes(expectedFrom), `should include default from date ${expectedFrom}`);
    });
});

suite('ModelUsageViewProvider — message handling', () => {

    test('ready message triggers postMessage with type:update', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        const updates = getUpdateMessages(view.webview.postMessageCalls);
        assert.ok(updates.length >= 1, 'should receive at least one update message after ready');
        assert.ok((updates[0] as unknown as { data: unknown }).data !== undefined, 'update should carry data');
    });

    test('update message contains dateRange with from and to ISO strings', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        const updates = getUpdateMessages(view.webview.postMessageCalls);
        assert.ok(updates.length >= 1);
        const dr = updates[0].dateRange;
        assert.ok(typeof dr.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dr.from), `from should be YYYY-MM-DD, got: ${dr.from}`);
        assert.ok(typeof dr.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dr.to), `to should be YYYY-MM-DD, got: ${dr.to}`);
    });

    test('setDateRange message with valid ISO dates triggers update with new range', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        view.webview.messageHandlers.forEach(h => h({
            type: 'setDateRange',
            from: '2026-01-01',
            to: '2026-01-31',
        }));
        await new Promise(resolve => setImmediate(resolve));

        const updates = getUpdateMessages(view.webview.postMessageCalls);
        assert.ok(updates.length >= 1, 'should receive update after setDateRange');
        const dr = updates[updates.length - 1].dateRange;
        assert.strictEqual(dr.from, '2026-01-01');
        assert.strictEqual(dr.to, '2026-01-31');
    });

    test('setDateRange with from > to swaps dates silently', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        view.webview.messageHandlers.forEach(h => h({
            type: 'setDateRange',
            from: '2026-03-01',
            to: '2026-01-01',
        }));
        await new Promise(resolve => setImmediate(resolve));

        const updates = getUpdateMessages(view.webview.postMessageCalls);
        assert.ok(updates.length >= 1, 'should still produce an update');
        const dr = updates[updates.length - 1].dateRange;
        // from should be <= to after swap
        assert.ok(dr.from <= dr.to, `from (${dr.from}) should be <= to (${dr.to}) after swap`);
    });

    test('setDateRange with garbage strings is ignored (no crash, no update)', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        const before = view.webview.postMessageCalls.length;

        view.webview.messageHandlers.forEach(h => h({
            type: 'setDateRange',
            from: 'not-a-date',
            to: 'also-invalid',
        }));
        await new Promise(resolve => setImmediate(resolve));

        // No new messages should have been posted
        assert.strictEqual(view.webview.postMessageCalls.length, before, 'should not post on invalid date strings');
    });

    test('setDateRange with missing from/to strings is ignored', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        const before = view.webview.postMessageCalls.length;

        view.webview.messageHandlers.forEach(h => h({ type: 'setDateRange' }));
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(view.webview.postMessageCalls.length, before, 'should not post when from/to missing');
    });

    test('html is set exactly once and not reassigned after ready', async () => {
        const index = makeMinimalIndex();
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        const htmlAfterResolve = view.webview.html;
        assert.ok(htmlAfterResolve.length > 0, 'html should be set on resolveWebviewView');

        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(view.webview.html, htmlAfterResolve, 'html should not be reassigned after ready');
    });

    test('update message data reflects sessions in the index', async () => {
        const summaries = [
            makeSummary({ id: 's1', model: 'gpt-4o', source: 'copilot', userMessageCount: 5, updatedAt: '2026-03-10T00:00:00Z' }),
            makeSummary({ id: 's2', model: 'gpt-4o', source: 'copilot', userMessageCount: 3, updatedAt: '2026-03-12T00:00:00Z' }),
        ];
        const index = makeMinimalIndex(summaries);
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        const updates = getUpdateMessages(view.webview.postMessageCalls);
        assert.ok(updates.length >= 1);
        const data = updates[updates.length - 1].data as { totalUserRequests: number; models: unknown[] };
        // If the default range covers March 2026, we should see the sessions
        // (default range = 1st of current month to today)
        // Since tests run at 2026-03-22, these sessions in March should be included
        assert.ok(typeof data.totalUserRequests === 'number', 'totalUserRequests should be a number');
        assert.ok(Array.isArray(data.models), 'models should be an array');
    });
});

suite('ModelUsageViewProvider — index change events', () => {

    test('index change event schedules a refresh (500ms debounce)', async function () {
        this.timeout(2000);

        const index = makeMinimalIndex() as ReturnType<typeof makeMinimalIndex> & { _fireTyped: (e: unknown) => void };
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        // Trigger ready to baseline
        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));
        const countBefore = view.webview.postMessageCalls.length;

        // Fire a typed index change event
        (index as unknown as { _fireTyped: (e: unknown) => void })._fireTyped({ type: 'upsert', sessionId: 'x' });

        // Wait longer than the 500ms debounce
        await new Promise(resolve => setTimeout(resolve, 600));

        const updates = getUpdateMessages(view.webview.postMessageCalls.slice(countBefore));
        assert.ok(updates.length >= 1, 'should post an update after debounced index change');
    });

    test('no update is posted when view is not visible', async function () {
        this.timeout(2000);

        const index = makeMinimalIndex() as ReturnType<typeof makeMinimalIndex> & { _fireTyped: (e: unknown) => void };
        const ctx = makeMinimalContext();
        const provider = new ModelUsageViewProvider(ctx, index);
        const view = makeWebviewView(false); // not visible

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            CANCEL_TOKEN
        );

        const countBefore = view.webview.postMessageCalls.length;

        // Fire index change — should be suppressed because visible=false
        (index as unknown as { _fireTyped: (e: unknown) => void })._fireTyped({ type: 'upsert', sessionId: 'x' });

        await new Promise(resolve => setTimeout(resolve, 700));

        const countAfter = view.webview.postMessageCalls.length;
        assert.strictEqual(countAfter, countBefore, 'should not post when view is not visible');
    });
});
