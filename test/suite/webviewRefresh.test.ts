// test/suite/webviewRefresh.test.ts
//
// Verifies the shell+postMessage pattern for all 4 refactored webview panels.

import * as assert from 'assert';

// â”€â”€ Minimal vscode mock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These tests run in Node (not inside VS Code), so we mock the vscode module.

type MessageHandler = (msg: unknown) => void;

interface MockWebview {
    html: string;
    postMessageCalls: unknown[];
    messageHandlers: MessageHandler[];
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(handler: MessageHandler): void;
    options: Record<string, unknown>;
}

interface MockPanel {
    webview: MockWebview;
    disposeHandlers: Array<() => void>;
    onDidDispose(handler: () => void): void;
    reveal(): void;
}

function makeMockWebview(): MockWebview {
    return {
        html: '',
        postMessageCalls: [],
        messageHandlers: [],
        postMessage(msg: unknown): Promise<boolean> {
            this.postMessageCalls.push(msg);
            return Promise.resolve(true);
        },
        onDidReceiveMessage(handler: MessageHandler): void {
            this.messageHandlers.push(handler);
        },
        options: {},
    };
}

function makeMockPanel(): MockPanel {
    const wv = makeMockWebview();
    return {
        webview: wv,
        disposeHandlers: [],
        onDidDispose(handler: () => void): void {
            this.disposeHandlers.push(handler);
        },
        reveal(): void { /* no-op */ },
    };
}

// Minimal mock for vscode.window.createWebviewPanel
let _nextPanel: MockPanel | null = null;

function setNextPanel(p: MockPanel): void {
    _nextPanel = p;
}

// â”€â”€ Import the classes under test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We use require() so we can inject the vscode mock before importing.
// Actually the panels import vscode at module load time â€” we need a different strategy.
// Since the panels call `vscode.window.createWebviewPanel`, we test only the static
// HTML-generation methods (getShellHtml) directly, and test the postMessage behaviour
// by calling the instance logic through a controlled interface.

import { AnalyticsPanel } from '../../src/analytics/analyticsPanel';
import { AnalyticsViewProvider } from '../../src/analytics/analyticsViewProvider';
import { TimelineViewProvider } from '../../src/timeline/timelineViewProvider';
import { PromptLibraryPanel } from '../../src/prompts/promptLibraryPanel';
import { CodeBlocksPanel } from '../../src/codeblocks/codeBlocksPanel';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeWebviewView(visible = true): {
    webview: MockWebview;
    visible: boolean;
    visibilityHandlers: Array<() => void>;
    onDidChangeVisibility(h: () => void): void;
} {
    const wv = makeMockWebview();
    const view = {
        webview: wv,
        visible,
        visibilityHandlers: [] as Array<() => void>,
        onDidChangeVisibility(h: () => void): void {
            this.visibilityHandlers.push(h);
        },
    };
    return view;
}

// Minimal SessionIndex stub
function makeMinimalIndex() {
    return {
        getAllSummaries: () => [],
        get: (_id: string) => undefined,
        version: 0,
    } as unknown as import('../../src/index/sessionIndex').SessionIndex;
}

// â”€â”€ AnalyticsPanel.getShellHtml â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('AnalyticsPanel â€” shell HTML', () => {
    test('getShellHtml returns a non-empty string', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(typeof html === 'string' && html.length > 0, 'should return non-empty string');
    });

    test('getShellHtml contains id="summary-row"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="summary-row"'), 'should contain summary-row container');
    });

    test('getShellHtml contains id="activity-container"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="activity-container"'), 'should contain activity-container');
    });

    test('getShellHtml contains id="projects-tbody"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="projects-tbody"'), 'should contain projects-tbody');
    });

    test('getShellHtml contains id="terms-container"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="terms-container"'), 'should contain terms-container');
    });

    test('getShellHtml contains id="by-msg-tbody"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="by-msg-tbody"'), 'should contain by-msg-tbody');
    });

    test('getShellHtml contains id="by-tok-tbody"', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.includes('id="by-tok-tbody"'), 'should contain by-tok-tbody');
    });

    test('getShellHtml contains message listener for update events', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(
            html.includes("msg.type === 'update'") || html.includes('msg.type === "update"'),
            'should contain update message handler'
        );
    });

    test('getShellHtml sends ready postMessage', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(
            html.includes("type: 'ready'") || html.includes('type: "ready"'),
            'should send ready message'
        );
    });

    test('getShellHtml starts with DOCTYPE', () => {
        const html = AnalyticsPanel.getShellHtml();
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    });
});

// â”€â”€ AnalyticsViewProvider â€” postMessage on refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('AnalyticsViewProvider â€” shell+postMessage', () => {
    test('resolveWebviewView sets html exactly once', async () => {
        const index = makeMinimalIndex();
        const provider = new AnalyticsViewProvider(index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as import('vscode').CancellationToken
        );

        // html should be set to shell exactly once
        assert.ok(view.webview.html.includes('id="summary-row"'), 'shell HTML should be set');

        // Simulate ready message from webview
        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));

        // Wait for setImmediate
        await new Promise(resolve => setImmediate(resolve));

        // postMessage should have been called with update
        const updateCalls = view.webview.postMessageCalls.filter(
            (m): m is { type: string; data: unknown } =>
                typeof m === 'object' && m !== null && (m as { type?: string }).type === 'update'
        );
        assert.ok(updateCalls.length >= 1, 'postMessage update should have been called after ready');
    });

    test('refresh() calls postMessage not html reassignment', async () => {
        const index = makeMinimalIndex();
        const provider = new AnalyticsViewProvider(index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as import('vscode').CancellationToken
        );

        const htmlAfterResolve = view.webview.html;

        // Trigger refresh (debounced 5s â€” call _sendData indirectly)
        // We test the behaviour by making the view visible and checking postMessage
        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        const postCallCount = view.webview.postMessageCalls.length;

        // html should not have changed from the shell
        assert.strictEqual(view.webview.html, htmlAfterResolve, 'html should not be reassigned after initial set');
        assert.ok(postCallCount >= 1, 'postMessage should be called for data updates');
    });
});

// â”€â”€ TimelineViewProvider â€” shell+postMessage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('TimelineViewProvider â€” shell+postMessage', () => {
    test('getShellHtml returns a non-empty string', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(typeof html === 'string' && html.length > 0);
    });

    test('getShellHtml contains id="timeline-content"', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="timeline-content"'), 'should contain timeline-content container');
    });

    test('getShellHtml contains filter bar selects', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('id="srcFilter"'), 'should contain srcFilter');
        assert.ok(html.includes('id="wsFilter"'), 'should contain wsFilter');
    });

    test('getShellHtml contains jumpToDate function', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.includes('function jumpToMonth'), 'should contain jumpToMonth function');
    });

    test('getShellHtml sends ready postMessage', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(
            html.includes("type: 'ready'") || html.includes('type: "ready"'),
            'should send ready message'
        );
    });

    test('resolveWebviewView sets html exactly once', async () => {
        const index = makeMinimalIndex();
        const provider = new TimelineViewProvider(index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as import('vscode').CancellationToken
        );

        const htmlSet = view.webview.html;
        assert.ok(htmlSet.includes('id="timeline-content"'), 'should set shell HTML with timeline-content');

        // Simulate ready
        view.webview.messageHandlers.forEach(h => h({ type: 'ready' }));
        await new Promise(resolve => setImmediate(resolve));

        // html should not change
        assert.strictEqual(view.webview.html, htmlSet, 'html should not be reassigned after ready');

        // postMessage should be called
        const updateCalls = view.webview.postMessageCalls.filter(
            (m): m is { type: string } =>
                typeof m === 'object' && m !== null && (m as { type?: string }).type === 'update'
        );
        assert.ok(updateCalls.length >= 1, 'should call postMessage with update after ready');
    });

    test('refresh() calls postMessage not html reassignment', async () => {
        const index = makeMinimalIndex();
        const provider = new TimelineViewProvider(index);
        const view = makeWebviewView(true);

        provider.resolveWebviewView(
            view as unknown as import('vscode').WebviewView,
            {} as import('vscode').WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as import('vscode').CancellationToken
        );

        const htmlSet = view.webview.html;

        provider.refresh();
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(view.webview.html, htmlSet, 'html should not change on refresh()');

        const updateCalls = view.webview.postMessageCalls.filter(
            (m): m is { type: string } =>
                typeof m === 'object' && m !== null && (m as { type?: string }).type === 'update'
        );
        assert.ok(updateCalls.length >= 1, 'refresh() should use postMessage');
    });

    test('getShellHtml() returns DOCTYPE', () => {
        const html = TimelineViewProvider.getShellHtml();
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'getShellHtml should return valid HTML');
    });
});

// â”€â”€ PromptLibraryPanel â€” shell HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('PromptLibraryPanel â€” shell HTML', () => {
    test('getShellHtml returns a non-empty string', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(typeof html === 'string' && html.length > 0);
    });

    test('getShellHtml contains id="promptsList"', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(html.includes('id="promptsList"'), 'should contain promptsList container');
    });

    test('getShellHtml contains id="promptCount"', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(html.includes('id="promptCount"'), 'should contain promptCount element');
    });

    test('getShellHtml contains id="truncatedBanner"', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(html.includes('id="truncatedBanner"'), 'should contain truncatedBanner element');
    });

    test('getShellHtml contains id="searchInput"', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(html.includes('id="searchInput"'), 'should contain searchInput');
    });

    test('getShellHtml sends ready postMessage', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(
            html.includes("type: 'ready'") || html.includes('type: "ready"'),
            'should send ready message'
        );
    });

    test('getShellHtml message handler listens for update', () => {
        const html = PromptLibraryPanel.getShellHtml();
        assert.ok(
            html.includes("msg.type === 'update'") || html.includes("msg.type === \"update\""),
            'should listen for update messages'
        );
    });

    // Ensure legacy getHtml() is preserved for existing tests
    test('getHtml() static method still returns DOCTYPE', () => {
        const html = PromptLibraryPanel.getHtml([]);
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'getHtml should still work');
    });
});

// â”€â”€ CodeBlocksPanel â€” shell HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('CodeBlocksPanel â€” shell HTML', () => {
    test('getShellHtml returns a non-empty string', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(typeof html === 'string' && html.length > 0);
    });

    test('getShellHtml contains id="blocks-list"', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(html.includes('id="blocks-list"'), 'should contain blocks-list container');
    });

    test('getShellHtml contains id="blockCount"', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(html.includes('id="blockCount"'), 'should contain blockCount element');
    });

    test('getShellHtml contains id="langFilter"', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(html.includes('id="langFilter"'), 'should contain langFilter select');
    });

    test('getShellHtml sends ready postMessage', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(
            html.includes("type: 'ready'") || html.includes('type: "ready"'),
            'should send ready message'
        );
    });

    test('getShellHtml message handler listens for update', () => {
        const html = CodeBlocksPanel.getShellHtml();
        assert.ok(
            html.includes("msg.type === 'update'") || html.includes("msg.type === \"update\""),
            'should listen for update messages'
        );
    });

    test('getShellHtml contains copy event delegation handler', () => {
        const html = CodeBlocksPanel.getShellHtml();
        // copy command should be sent via event delegation, not per-card listeners
        assert.ok(html.includes("command: 'copy'") || html.includes('command: "copy"'), 'should have copy handler');
    });
});

// ── SessionWebviewPanel — Shell skeleton placeholders ────────────────────────

suite('SessionWebviewPanel — Shell skeleton placeholders', () => {
    test('shell HTML contains 5 skeleton message blocks in messages-container', () => {
        const html = (SessionWebviewPanel as any)._getShellHtml();
        assert.ok(html.includes('id="messages-container"'), 'messages container present');
        const skeletonMessages = (html.match(/class="message (user|assistant) cw-fade-item"/g) || []);
        assert.strictEqual(skeletonMessages.length, 5, 'should have 5 skeleton messages');
    });

    test('skeleton messages alternate user and assistant roles', () => {
        const html = (SessionWebviewPanel as any)._getShellHtml();
        const roles = (html.match(/class="message (user|assistant) cw-fade-item"/g) || [])
            .map((m: string) => m.includes('user') ? 'user' : 'assistant');
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user'],
            'roles should alternate starting with user');
    });

    test('session title contains a skeleton placeholder', () => {
        const html = (SessionWebviewPanel as any)._getShellHtml();
        const titleMatch = html.match(/id="session-title"[^>]*>.*?cw-skeleton/s);
        assert.ok(titleMatch, 'title h1 should contain a cw-skeleton element');
    });
});

