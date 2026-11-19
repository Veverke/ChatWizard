/**
 * test/unit/logsCommands.test.ts
 *
 * Wiring tests for the watch-logs Commands view (`src/logs/logsCommands.ts`).
 *
 * `registerLogCommands` is pure wiring: it registers one VS Code command per
 * action and delegates to the tree providers / log store it is given. These
 * tests capture the registered handlers (instead of exercising them through
 * `vscode.commands.executeCommand`) and drive each one against stubbed
 * providers, so the *routing* — which provider is refreshed, which filters are
 * written, which message is shown — is asserted without a real IDE session.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { registerLogCommands } from '../../src/logs/logsCommands';
import { closeEventWebview } from '../../src/logs/logEventWebview';
import { emptyLogFilters, LogViewFilters } from '../../src/logs/logFilters';
import { LogService } from '../../src/logs/logService';
import { CommandEvent, DiffEvent, FileOperationEvent, ToolCallEvent } from '../../src/logs/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function commandEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
    return {
        id: 'cmd-1',
        type: 'command',
        timestamp: '2026-01-02T10:00:00.000Z',
        tool: 'copilot',
        sessionId: 'sess-a',
        commandText: 'npm test',
        ...overrides,
    } as CommandEvent;
}

function diffEvent(overrides: Partial<DiffEvent> = {}): DiffEvent {
    return {
        id: 'diff-1',
        type: 'diff',
        timestamp: '2026-01-02T10:01:00.000Z',
        tool: 'copilot',
        sessionId: 'sess-a',
        filePath: '/repo/a.ts',
        diffText: '--- a/a.ts\n+++ b/a.ts\n-old\n+new\n',
        ...overrides,
    } as DiffEvent;
}

function toolCallEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
    return {
        id: 'tool-1',
        type: 'toolCall',
        timestamp: '2026-01-02T10:02:00.000Z',
        tool: 'copilot',
        sessionId: 'sess-a',
        toolName: 'read_files',
        arguments: { path: '/repo/a.ts' },
        ...overrides,
    } as ToolCallEvent;
}

function fileOperationEvent(overrides: Partial<FileOperationEvent> = {}): FileOperationEvent {
    return {
        id: 'file-1',
        type: 'fileOperation',
        timestamp: '2026-01-02T10:03:00.000Z',
        tool: 'copilot',
        sessionId: 'sess-a',
        operationType: 'patch',
        filePath: '/repo/a.ts',
        ...overrides,
    } as FileOperationEvent;
}

/** A filters-aware provider stub (`getFilters` / `setFilters` / `refresh`). */
function makeFiltersApi(initial: LogViewFilters = emptyLogFilters()) {
    const api = {
        current: { ...initial } as LogViewFilters,
        writes: [] as LogViewFilters[],
        getFilters: (): LogViewFilters => api.current,
        setFilters: (filters: LogViewFilters): void => { api.current = filters; api.writes.push(filters); },
        refresh: sinon.stub(),
    };
    return api;
}

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-logs-commands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
    /** Omit the composite provider so the per-provider fallbacks run. */
    withoutCommandsView?: boolean;
    /** Omit the timeline provider. */
    withoutTimeline?: boolean;
    /** Omit the diff explorer provider. */
    withoutDiffs?: boolean;
    /** Omit the tool-calls provider. */
    withoutToolCalls?: boolean;
    /** Log store handed to the handlers (undefined → "store unavailable"). */
    logService?: { getStats?: () => { tools: string[] }; getEvents?: () => unknown[] };
}

function createHarness(options: HarnessOptions = {}) {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const sandbox = sinon.createSandbox();

    sandbox.stub(vscode.commands, 'registerCommand').callsFake(((id: string, handler: (...args: never[]) => unknown) => {
        handlers.set(id, handler);
        return { dispose() { handlers.delete(id); } };
    }) as typeof vscode.commands.registerCommand);

    const executed: Array<{ command: string; args: unknown[] }> = [];
    const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').callsFake(
        ((command: string, ...args: unknown[]) => {
            executed.push({ command, args });
            return Promise.resolve(undefined);
        }) as typeof vscode.commands.executeCommand
    );

    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined as never);
    const error = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined as never);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined as never);
    const quickPick = sandbox.stub(vscode.window, 'showQuickPick');
    const inputBox = sandbox.stub(vscode.window, 'showInputBox');
    const clipboard = sandbox.stub(vscode.env.clipboard, 'writeText').resolves();
    const showTextDocument = sandbox.stub(vscode.window, 'showTextDocument').resolves(undefined as never);

    const panels: Array<Record<string, unknown>> = [];
    sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((() => {
        const panel = {
            title: '',
            webview: { html: '', onDidReceiveMessage: () => ({ dispose() { /* noop */ } }) },
            reveal: sinon.stub(),
            onDidDispose: sinon.stub(),
            dispose: sinon.stub(),
        };
        panels.push(panel);
        return panel;
    }) as unknown as typeof vscode.window.createWebviewPanel);

    const terminals: Array<{ name?: string; cwd?: unknown; sent: string[] }> = [];
    sandbox.stub(vscode.window, 'createTerminal').callsFake(((terminalOptions: vscode.TerminalOptions) => {
        const terminal = { name: terminalOptions.name, cwd: terminalOptions.cwd, sent: [] as string[] };
        terminals.push(terminal);
        return {
            show: () => undefined,
            sendText: (text: string) => { terminal.sent.push(text); },
        } as unknown as vscode.Terminal;
    }) as typeof vscode.window.createTerminal);

    const commands = options.withoutCommandsView
        ? undefined
        : Object.assign(makeFiltersApi(), {
            viewType: 'chatwizardCommands',
            section: sinon.stub().returns({ id: 'section' }),
        });

    const executedProvider = makeFiltersApi();
    const timeline = Object.assign(makeFiltersApi(), { setFilter: sinon.stub() });
    const diffs = makeFiltersApi();
    const toolCalls = makeFiltersApi();

    registerLogCommands(
        { subscriptions: { push: () => undefined } },
        executedProvider as never,
        options.withoutTimeline ? undefined : timeline as never,
        options.withoutDiffs ? undefined : diffs as never,
        commands as never,
        { commands: { reveal: sinon.stub().resolves(true), selection: [] } as never },
        options.logService as never,
        options.withoutToolCalls ? undefined : toolCalls as never
    );

    return {
        sandbox,
        handlers,
        commands,
        executedProvider,
        timeline,
        diffs,
        toolCalls,
        info,
        error,
        quickPick,
        inputBox,
        clipboard,
        executed,
        panels,
        terminals,
        showTextDocument,
        executeCommand,
        run: <T = unknown>(id: string, ...args: unknown[]): T => {
            const handler = handlers.get(id);
            assert.ok(handler, `command "${id}" was not registered`);
            return handler(...(args as never[])) as T;
        },
        dispose: () => { closeEventWebview(); sandbox.restore(); },
    };
}

type Harness = ReturnType<typeof createHarness>;

/** Let the fire-and-forget async handlers settle. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
}


// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

suite('logsCommands — registration', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('registers every command the view and its context menus contribute', () => {
        const expected = [
            'chatwizard.logs.search',
            'chatwizard.logs.filterByAgent',
            'chatwizard.logs.toggleFailures',
            'chatwizard.logs.clearFilters',
            'chatwizard.logs.filterMenu',
            'chatwizard.logs.showStats',
            'chatwizard.showExecutedCommands',
            'chatwizard.execCommands.copy',
            'chatwizard.execCommands.openSession',
            'chatwizard.execCommands.refresh',
            'chatwizard.execCommands.runInTerminal',
            'chatwizard.execCommands.showDetails',
            'chatwizard.showToolCalls',
            'chatwizard.logs.toolCalls.refresh',
            'chatwizard.logs.toolCalls.copy',
            'chatwizard.logs.toolCalls.openSession',
            'chatwizard.logs.toolCalls.showDetails',
            'chatwizard.showUnifiedTimeline',
            'chatwizard.logs.timeline.refresh',
            'chatwizard.logs.timeline.filter',
            'chatwizard.logs.timeline.copyCommand',
            'chatwizard.logs.timeline.openSession',
            'chatwizard.logs.timeline.openDiff',
            'chatwizard.logs.timeline.showDetails',
            'chatwizard.showDiffExplorer',
            'chatwizard.logs.diffs.refresh',
            'chatwizard.logs.diff.viewDiff',
            'chatwizard.logs.diff.openPatch',
            'chatwizard.logs.diff.copy',
            'chatwizard.logs.diff.openFile',
            'chatwizard.logs.diff.showDetails',
            'chatwizard.logs.refreshAll',
            'chatwizard.logs.showSelectedDetails',
        ];

        for (const id of expected) {
            assert.ok(h.handlers.has(id), `command "${id}" is not registered`);
        }
    });
});


// ---------------------------------------------------------------------------
// View-wide filters
// ---------------------------------------------------------------------------

suite('logsCommands — view-wide filters', () => {
    let h: Harness;

    setup(() => { h = createHarness({ logService: { getStats: () => ({ tools: ['copilot'] }) } }); });
    teardown(() => h.dispose());

    test('toggleFailures flips the failures-only filter both ways', () => {
        h.run('chatwizard.logs.toggleFailures');
        assert.strictEqual(h.commands!.current.failuresOnly, true);
        assert.match(String(h.info.firstCall.args[0]), /Showing failures only/i);

        h.run('chatwizard.logs.toggleFailures');
        assert.strictEqual(h.commands!.current.failuresOnly, undefined);
        assert.match(String(h.info.secondCall.args[0]), /Showing all agent log events/i);
    });

    test('clearFilters writes an empty filter set', () => {
        h.commands!.setFilters({ search: 'npm', failuresOnly: true });

        h.run('chatwizard.logs.clearFilters');

        assert.deepStrictEqual(h.commands!.current, {});
        assert.match(String(h.info.firstCall.args[0]), /filters cleared/i);
    });

    test('search ignores a cancelled input box', async () => {
        h.inputBox.resolves(undefined);

        await h.run('chatwizard.logs.search');

        assert.deepStrictEqual(h.commands!.current, {}, 'nothing is written when the user cancels');
    });

    test('search stores the normalized query and announces it', async () => {
        h.inputBox.resolves('  npm   test ');

        await h.run('chatwizard.logs.search');

        assert.strictEqual(h.commands!.current.search, 'npm   test');
        assert.match(String(h.info.firstCall.args[0]), /Agent logs filtered by text/i);
    });

    test('search clears an existing query when the box is emptied', async () => {
        h.commands!.setFilters({ search: 'old' });
        h.inputBox.resolves('');

        await h.run('chatwizard.logs.search');

        assert.strictEqual(h.commands!.current.search, undefined);
        assert.match(String(h.info.firstCall.args[0]), /filters cleared/i, 'no filter left → cleared message');
    });

    test('filterByAgent explains itself when the log store is unavailable', async () => {
        const bare = createHarness();
        try {
            await bare.run('chatwizard.logs.filterByAgent');
            assert.match(String(bare.info.firstCall.args[0]), /log store is not available/i);
            assert.strictEqual(bare.quickPick.called, false);
        } finally {
            bare.dispose();
        }
    });

    test('filterByAgent reports an empty index instead of opening a picker', async () => {
        const empty = createHarness({ logService: { getStats: () => ({ tools: [] }) } });
        try {
            await empty.run('chatwizard.logs.filterByAgent');
            assert.match(String(empty.info.firstCall.args[0]), /No agent log events indexed yet/i);
            assert.strictEqual(empty.quickPick.called, false);
        } finally {
            empty.dispose();
        }
    });

    test('filterByAgent survives a failing stats call', async () => {
        const failing = createHarness({
            logService: { getStats: () => { throw new Error('db locked'); } },
        });
        try {
            await failing.run('chatwizard.logs.filterByAgent');
            assert.match(String(failing.info.firstCall.args[0]), /No agent log events indexed yet/i);
        } finally {
            failing.dispose();
        }
    });

    test('filterByAgent applies the picked agent and can clear it again', async () => {
        h.quickPick.resolves({ label: 'GitHub Copilot', description: 'copilot', value: 'copilot' } as never);

        await h.run('chatwizard.logs.filterByAgent');
        assert.strictEqual(h.commands!.current.tool, 'copilot');
        assert.match(String(h.info.firstCall.args[0]), /Agent logs filtered by agent/i);

        h.quickPick.resolves({ label: 'All agents', description: 'no agent filter', value: undefined } as never);
        await h.run('chatwizard.logs.filterByAgent');
        assert.strictEqual(h.commands!.current.tool, undefined);
    });

    test('filterByAgent leaves the filters untouched when the picker is dismissed', async () => {
        h.quickPick.resolves(undefined);

        await h.run('chatwizard.logs.filterByAgent');

        assert.deepStrictEqual(h.commands!.current, {});
    });
});


// ---------------------------------------------------------------------------
// Filter menu + stats report
// ---------------------------------------------------------------------------

suite('logsCommands — filter menu and stats', () => {
    let h: Harness;

    setup(() => { h = createHarness({ logService: { getStats: () => ({ tools: ['copilot'] }) } }); });
    teardown(() => h.dispose());

    test('the menu offers every filter action and a stats entry', async () => {
        h.quickPick.resolves(undefined);

        await h.run('chatwizard.logs.filterMenu');

        const items = h.quickPick.firstCall.args[0] as Array<{ label: string; action: string }>;
        assert.strictEqual(items.length, 6);
        assert.deepStrictEqual(
            items.map((item) => item.action),
            ['search', 'agent', 'failures', 'kinds', 'clear', 'stats']
        );
        assert.strictEqual(h.executed.length, 0, 'dismissing the menu runs nothing');
    });

    test('the menu reflects the active filters', async () => {
        h.commands!.setFilters({ search: 'npm', tool: 'copilot', failuresOnly: true, types: ['command'] });
        h.quickPick.resolves(undefined);

        await h.run('chatwizard.logs.filterMenu');

        const items = h.quickPick.firstCall.args[0] as Array<{ label: string; description?: string }>;
        const labels = items.map((item) => item.label);
        assert.ok(labels.includes('$(pass) Show All Events'), 'failures filter is ON');
        assert.match(String(items[1].description), /GitHub Copilot|Copilot/i);
        assert.match(String(items[3].description), /Command|command/);
    });

    test('every menu action dispatches to its command', async () => {
        const dispatch: Array<[string, string]> = [
            ['search', 'chatwizard.logs.search'],
            ['agent', 'chatwizard.logs.filterByAgent'],
            ['failures', 'chatwizard.logs.toggleFailures'],
            ['kinds', 'chatwizard.logs.timeline.filter'],
            ['clear', 'chatwizard.logs.clearFilters'],
            ['stats', 'chatwizard.logs.showStats'],
        ];

        for (const [action, command] of dispatch) {
            h.executed.length = 0;
            h.quickPick.resolves({ action } as never);
            await h.run('chatwizard.logs.filterMenu');
            assert.deepStrictEqual(h.executed.map((e) => e.command), [command], `action ${action}`);
        }
    });

    test('showStats reports a missing store', async () => {
        const bare = createHarness();
        try {
            assert.strictEqual(await bare.run('chatwizard.logs.showStats'), undefined);
            assert.match(String(bare.info.firstCall.args[0]), /log store is not available/i);
        } finally {
            bare.dispose();
        }
    });

    test('showStats reports an empty index', async () => {
        const empty = createHarness({ logService: { getEvents: () => [] } });
        try {
            assert.strictEqual(await empty.run('chatwizard.logs.showStats'), undefined);
            assert.match(String(empty.info.firstCall.args[0]), /No agent log events indexed yet/i);
        } finally {
            empty.dispose();
        }
    });

    test('showStats opens a Markdown report for the indexed events', async () => {
        const stats = createHarness({
            logService: { getEvents: () => [commandEvent(), commandEvent({ id: 'cmd-2', commandText: 'git status' })] },
        });
        try {
            const doc = await stats.run<vscode.TextDocument>('chatwizard.logs.showStats');

            assert.ok(doc, 'the report document is returned');
            assert.ok(doc.getText().length > 0);
            assert.ok(stats.showTextDocument.calledOnce, 'the report is revealed');
        } finally {
            stats.dispose();
        }
    });

    test('showStats turns a store failure into an error message', async () => {
        const failing = createHarness({
            logService: { getEvents: () => { throw new Error('db is gone'); } },
        });
        try {
            assert.strictEqual(await failing.run('chatwizard.logs.showStats'), undefined);
            assert.match(String(failing.error.firstCall.args[0]), /Could not build the agent log stats report/i);
            assert.match(String(failing.error.firstCall.args[0]), /db is gone/);
        } finally {
            failing.dispose();
        }
    });
});


// ---------------------------------------------------------------------------
// Section commands
// ---------------------------------------------------------------------------

suite('logsCommands — section show commands', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('every "Show …" command focuses the Commands view and reveals its section', async () => {
        const sections: Array<[string, string]> = [
            ['chatwizard.showExecutedCommands', 'executedCommands'],
            ['chatwizard.showToolCalls', 'toolCalls'],
            ['chatwizard.showUnifiedTimeline', 'timeline'],
            ['chatwizard.showDiffExplorer', 'diffs'],
        ];

        for (const [command, subView] of sections) {
            h.executed.length = 0;
            h.commands!.section.resetHistory();

            h.run(command);
            await settle();

            assert.deepStrictEqual(
                h.executed.map((e) => e.command),
                ['chatwizardCommands.focus'],
                `${command} focuses the view`
            );
            assert.deepStrictEqual(h.commands!.section.firstCall.args, [subView], `${command} reveals ${subView}`);
        }
    });

    test('a missing Commands provider still focuses the view', async () => {
        const bare = createHarness({ withoutCommandsView: true });
        try {
            bare.run('chatwizard.showToolCalls');
            await settle();
            assert.deepStrictEqual(bare.executed.map((e) => e.command), ['chatwizardCommands.focus']);
        } finally {
            bare.dispose();
        }
    });

    test('a failing focus command is swallowed (the view may be hidden)', async () => {
        h.executeCommand.rejects(new Error('command not found'));

        h.run('chatwizard.showDiffExplorer');
        await settle();

        assert.ok(h.executeCommand.called, 'the handler must not throw when focusing fails');
    });
});

// ---------------------------------------------------------------------------
// Terminal Commands section
// ---------------------------------------------------------------------------

suite('logsCommands — executed commands', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('copy writes the command text (and ignores a missing item)', () => {
        h.run('chatwizard.execCommands.copy');
        assert.strictEqual(h.clipboard.called, false);

        h.run('chatwizard.execCommands.copy', { event: commandEvent() });

        assert.strictEqual(h.clipboard.firstCall.args[0], 'npm test');
        assert.match(String(h.info.firstCall.args[0]), /Copied executed command/i);
    });

    test('openSession forwards the session id', () => {
        h.run('chatwizard.execCommands.openSession', { event: commandEvent({ sessionId: 'sess-42' }) });

        const last = h.executed.at(-1);
        assert.strictEqual(last?.command, 'chatwizard.openSession');
        assert.deepStrictEqual(last?.args, [{ id: 'sess-42' }]);
    });

    test('openSession explains events that carry no session', () => {
        h.run('chatwizard.execCommands.openSession', { event: commandEvent({ sessionId: undefined }) });

        assert.match(String(h.error.firstCall.args[0]), /not attached to a session/i);
        assert.strictEqual(h.executed.length, 0);
    });

    test('refresh refreshes the commands provider', () => {
        h.run('chatwizard.execCommands.refresh');
        assert.strictEqual(h.executedProvider.refresh.calledOnce, true);
    });

    test('runInTerminal asks for a command when nothing is selected', async () => {
        assert.strictEqual(await h.run('chatwizard.execCommands.runInTerminal'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select an executed command first/i);
        assert.strictEqual(h.terminals.length, 0);

        await h.run('chatwizard.execCommands.runInTerminal', { event: toolCallEvent() });
        assert.strictEqual(h.info.callCount, 2, 'tool calls are not runnable');
        assert.strictEqual(h.terminals.length, 0);
    });

    test('runInTerminal re-runs the command in its captured folder', async () => {
        const cwd = tmpDir();
        try {
            const terminal = await h.run<vscode.Terminal | undefined>(
                'chatwizard.execCommands.runInTerminal',
                { event: commandEvent({ commandText: 'npm run build', cwd }) }
            );

            assert.ok(terminal, 'a terminal is returned');
            assert.strictEqual(h.terminals.length, 1);
            assert.strictEqual(h.terminals[0].name, 'Chat Wizard: npm run build');
            assert.strictEqual(h.terminals[0].cwd, cwd);
            assert.deepStrictEqual(h.terminals[0].sent, ['npm run build']);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    test('runInTerminal also accepts a raw CommandEvent (webview button)', async () => {
        await h.run('chatwizard.execCommands.runInTerminal', commandEvent({ commandText: 'git status' }));

        assert.strictEqual(h.terminals.length, 1);
        assert.strictEqual(h.terminals[0].name, 'Chat Wizard: git status');
    });

    test('showDetails opens the detail webview for commands only', () => {
        assert.strictEqual(h.run('chatwizard.execCommands.showDetails'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select a command first/i);

        const panel = h.run<vscode.WebviewPanel | undefined>('chatwizard.execCommands.showDetails', { event: commandEvent() });
        assert.ok(panel, 'the command detail panel opens');
        assert.strictEqual(h.panels.length, 1);
    });
});


// ---------------------------------------------------------------------------
// LLM tool calls section
// ---------------------------------------------------------------------------

suite('logsCommands — tool calls', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('refresh refreshes the tool-calls provider', () => {
        h.run('chatwizard.logs.toolCalls.refresh');
        assert.strictEqual(h.toolCalls.refresh.calledOnce, true);
    });

    test('copy writes the tool-call input and ignores missing items', () => {
        h.run('chatwizard.logs.toolCalls.copy');
        assert.strictEqual(h.clipboard.called, false);

        h.run('chatwizard.logs.toolCalls.copy', { event: toolCallEvent() });

        assert.ok(h.clipboard.calledOnce);
        assert.ok(String(h.clipboard.firstCall.args[0]).length > 0);
        assert.match(String(h.info.firstCall.args[0]), /Copied tool call/i);
    });

    test('openSession forwards the tool call session', () => {
        h.run('chatwizard.logs.toolCalls.openSession', { event: toolCallEvent({ sessionId: 'sess-tools' }) });

        const last = h.executed.at(-1);
        assert.strictEqual(last?.command, 'chatwizard.openSession');
        assert.deepStrictEqual(last?.args, [{ id: 'sess-tools' }]);
    });

    test('showDetails requires a tool-call row', () => {
        assert.strictEqual(h.run('chatwizard.logs.toolCalls.showDetails'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select a tool call first/i);

        assert.strictEqual(h.run('chatwizard.logs.toolCalls.showDetails', { event: commandEvent() }), undefined);
        assert.strictEqual(h.info.callCount, 2, 'a command row is not a tool call');

        const panel = h.run<vscode.WebviewPanel | undefined>(
            'chatwizard.logs.toolCalls.showDetails',
            { event: toolCallEvent() }
        );
        assert.ok(panel);
    });
});


// ---------------------------------------------------------------------------
// Unified Timeline section
// ---------------------------------------------------------------------------

suite('logsCommands — unified timeline', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('refresh refreshes the timeline provider', () => {
        h.run('chatwizard.logs.timeline.refresh');
        assert.strictEqual(h.timeline.refresh.calledOnce, true);
    });

    test('the kind filter can be set and cleared', async () => {
        h.quickPick.resolves({ label: 'All event kinds', description: 'no filter', value: undefined } as never);
        await h.run('chatwizard.logs.timeline.filter');
        assert.deepStrictEqual(h.timeline.setFilter.firstCall.args, [undefined]);
        assert.match(String(h.info.firstCall.args[0]), /showing all event kinds/i);

        h.quickPick.resolves({ label: 'Commands', description: 'only command events', value: 'command' } as never);
        await h.run('chatwizard.logs.timeline.filter');
        assert.deepStrictEqual(h.timeline.setFilter.secondCall.args, [['command']]);
        assert.match(String(h.info.secondCall.args[0]), /showing command events only/i);
    });

    test('a dismissed kind picker leaves the timeline filter alone', async () => {
        h.quickPick.resolves(undefined);
        await h.run('chatwizard.logs.timeline.filter');
        assert.strictEqual(h.timeline.setFilter.called, false);
    });

    test('the kind filter is a no-op without a timeline provider', async () => {
        const bare = createHarness({ withoutTimeline: true });
        try {
            await bare.run('chatwizard.logs.timeline.filter');
            assert.strictEqual(bare.quickPick.called, false);
        } finally {
            bare.dispose();
        }
    });

    test('copyCommand only copies command events', () => {
        h.run('chatwizard.logs.timeline.copyCommand');
        assert.strictEqual(h.clipboard.called, false);
        h.run('chatwizard.logs.timeline.copyCommand', { event: toolCallEvent() });
        assert.strictEqual(h.clipboard.called, false, 'non-command rows have no command text');

        h.run('chatwizard.logs.timeline.copyCommand', { event: commandEvent() });
        assert.strictEqual(h.clipboard.firstCall.args[0], 'npm test');
        assert.match(String(h.info.firstCall.args[0]), /Copied executed command/i);
    });

    test('openSession forwards the timeline row session', () => {
        h.run('chatwizard.logs.timeline.openSession', { event: commandEvent({ sessionId: 'sess-timeline' }) });

        const last = h.executed.at(-1);
        assert.strictEqual(last?.command, 'chatwizard.openSession');
        assert.deepStrictEqual(last?.args, [{ id: 'sess-timeline' }]);
    });

    test('openDiff opens the visual diff when the patch is renderable', async () => {
        await h.run('chatwizard.logs.timeline.openDiff', { event: diffEvent() });

        assert.ok(h.executed.some((e) => e.command === 'vscode.diff'), 'the native diff editor is used');
    });

    test('openDiff falls back to the patch text when nothing is renderable', async () => {
        await h.run('chatwizard.logs.timeline.openDiff', { event: diffEvent({ diffText: '' }) });

        assert.strictEqual(h.executed.some((e) => e.command === 'vscode.diff'), false);
        assert.ok(h.showTextDocument.called, 'the raw patch opens in a text editor');
    });

    test('openDiff ignores calls without a row', async () => {
        await h.run('chatwizard.logs.timeline.openDiff');
        assert.strictEqual(h.executed.length, 0);
        assert.strictEqual(h.showTextDocument.called, false);
    });

    test('showDetails requires an event row', () => {
        assert.strictEqual(h.run('chatwizard.logs.timeline.showDetails'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select an event first/i);

        const panel = h.run<vscode.WebviewPanel | undefined>(
            'chatwizard.logs.timeline.showDetails',
            { event: fileOperationEvent() }
        );
        assert.ok(panel);
    });
});


// ---------------------------------------------------------------------------
// Diff Explorer section + shared title-bar actions
// ---------------------------------------------------------------------------

suite('logsCommands — diffs', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('refresh refreshes the diff explorer', () => {
        h.run('chatwizard.logs.diffs.refresh');
        assert.strictEqual(h.diffs.refresh.calledOnce, true);
    });

    test('viewDiff requires a change row', async () => {
        assert.strictEqual(await h.run('chatwizard.logs.diff.viewDiff'), false);
        assert.match(String(h.info.firstCall.args[0]), /Select a change first/i);

        assert.strictEqual(await h.run('chatwizard.logs.diff.viewDiff', { event: toolCallEvent() }), false);
        assert.strictEqual(h.info.callCount, 2, 'a tool call is not a change');
    });

    test('viewDiff opens the visual diff for a renderable patch', async () => {
        assert.strictEqual(await h.run('chatwizard.logs.diff.viewDiff', { event: diffEvent() }), true);
        assert.ok(h.executed.some((e) => e.command === 'vscode.diff'));
        assert.strictEqual(h.panels.length, 0, 'no fallback webview is needed');
    });

    test('viewDiff falls back to the change details when there is no patch text', async () => {
        const panel = await h.run<vscode.WebviewPanel | undefined>(
            'chatwizard.logs.diff.viewDiff',
            { event: fileOperationEvent() }
        );

        assert.ok(panel, 'the detail webview opens instead');
        assert.match(String(h.info.firstCall.args[0]), /captured no diff text/i);
    });

    test('openPatch opens the raw patch and ignores a missing item', () => {
        h.run('chatwizard.logs.diff.openPatch');
        assert.strictEqual(h.showTextDocument.called, false);

        h.run('chatwizard.logs.diff.openPatch', { event: diffEvent() });
        assert.ok(h.showTextDocument.calledOnce, 'the patch opens in an editor');
    });

    test('copy writes diff text or the reconstructed patch', () => {
        h.run('chatwizard.logs.diff.copy');
        assert.strictEqual(h.clipboard.called, false);

        h.run('chatwizard.logs.diff.copy', { event: diffEvent() });
        assert.strictEqual(h.clipboard.firstCall.args[0], diffEvent().diffText);

        h.run('chatwizard.logs.diff.copy', { event: fileOperationEvent() });
        assert.ok(String(h.clipboard.secondCall.args[0]).length > 0, 'file operations render a patch summary');
        assert.match(String(h.info.secondCall.args[0]), /Copied change/i);
    });

    test('openFile reports events without a path', async () => {
        h.run('chatwizard.logs.diff.openFile');
        assert.strictEqual(h.error.called, false);

        h.run('chatwizard.logs.diff.openFile', { event: fileOperationEvent({ filePath: undefined }) });
        await settle();
        assert.match(String(h.error.firstCall.args[0]), /does not carry a file path/i);
    });

    test('openFile reports files that no longer exist', async () => {
        const gone = path.join(os.tmpdir(), `cw-missing-file-${Date.now()}.ts`);

        h.run('chatwizard.logs.diff.openFile', { event: fileOperationEvent({ filePath: gone }) });
        await settle();

        assert.match(String(h.error.firstCall.args[0]), /File no longer exists/i);
        assert.strictEqual(h.showTextDocument.called, false);
    });

    test('openFile reveals an existing file', async () => {
        const dir = tmpDir();
        const file = path.join(dir, 'a.ts');
        fs.writeFileSync(file, 'export const a = 1;\n', 'utf8');
        try {
            h.run('chatwizard.logs.diff.openFile', { event: fileOperationEvent({ filePath: file }) });
            await settle();

            assert.ok(h.showTextDocument.calledOnce, 'the file is opened');
            assert.strictEqual(h.error.called, false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('diff showDetails requires a change row', () => {
        assert.strictEqual(h.run('chatwizard.logs.diff.showDetails'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select a change first/i);

        assert.strictEqual(h.run('chatwizard.logs.diff.showDetails', { event: toolCallEvent() }), undefined);
        assert.strictEqual(h.info.callCount, 2);

        const panel = h.run<vscode.WebviewPanel | undefined>(
            'chatwizard.logs.diff.showDetails',
            { event: fileOperationEvent() }
        );
        assert.ok(panel);
    });
});


// ---------------------------------------------------------------------------
// Shared title-bar actions
// ---------------------------------------------------------------------------

suite('logsCommands — shared view actions', () => {
    let h: Harness;

    setup(() => { h = createHarness(); });
    teardown(() => h.dispose());

    test('showSelectedDetails explains an empty selection', async () => {
        assert.strictEqual(await h.run('chatwizard.logs.showSelectedDetails'), undefined);
        assert.match(String(h.info.firstCall.args[0]), /Select a row in the Commands view first/i);
    });

    test('showSelectedDetails prefers the visual diff and falls back to details', async () => {
        assert.strictEqual(await h.run('chatwizard.logs.showSelectedDetails', { event: diffEvent() }), true);
        assert.ok(h.executed.some((e) => e.command === 'vscode.diff'));

        const panel = await h.run<vscode.WebviewPanel | undefined>(
            'chatwizard.logs.showSelectedDetails',
            { event: toolCallEvent() }
        );
        assert.ok(panel, 'non-diff rows open the detail webview');
    });

    test('refreshAll delegates to the composite provider when there is one', () => {
        h.run('chatwizard.logs.refreshAll');

        assert.strictEqual(h.commands!.refresh.calledOnce, true);
        assert.strictEqual(h.executedProvider.refresh.called, false);
        assert.strictEqual(h.diffs.refresh.called, false);
    });

    test('refreshAll refreshes every section provider when the view is not composed', () => {
        const bare = createHarness({ withoutCommandsView: true });
        try {
            bare.run('chatwizard.logs.refreshAll');

            assert.strictEqual(bare.executedProvider.refresh.calledOnce, true);
            assert.strictEqual(bare.timeline.refresh.calledOnce, true);
            assert.strictEqual(bare.diffs.refresh.calledOnce, true);
            assert.strictEqual(bare.toolCalls.refresh.calledOnce, true);
        } finally {
            bare.dispose();
        }
    });

    test('filters fall back to the individual providers without the composite view', async () => {
        const bare = createHarness({ withoutCommandsView: true });
        try {
            bare.inputBox.resolves('npm test');
            await bare.run('chatwizard.logs.search');

            assert.strictEqual(bare.executedProvider.current.search, 'npm test');
            assert.strictEqual(bare.timeline.current.search, 'npm test');
            assert.strictEqual(bare.diffs.current.search, 'npm test');
            assert.strictEqual(bare.toolCalls.current.search, 'npm test');

            bare.run('chatwizard.logs.clearFilters');
            assert.deepStrictEqual(bare.diffs.current, {});
        } finally {
            bare.dispose();
        }
    });

    test('announceFilters lists the active filter dimensions', async () => {
        h.commands!.setFilters({
            search: 'npm',
            tool: 'copilot',
            failuresOnly: true,
            types: ['command', 'error'],
        });
        h.inputBox.resolves('npm');

        await h.run('chatwizard.logs.search');

        const message = String(h.info.lastCall.args[0]);
        assert.match(message, /text “npm”/);
        assert.match(message, /agent/i);
        assert.match(message, /failures only/i);
        assert.match(message, /kind/i);
    });
});

