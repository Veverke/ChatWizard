/**
 * test/unit/sessionCommandChips.panel.test.ts
 *
 * Integration wiring for the reader's per-response **Commands** chip:
 * `SessionWebviewPanel` builds the chips from the shared watch-logs store,
 * pushes live refreshes to open readers and ships the styles / handlers the
 * chip needs in the webview shell.
 */

import * as assert from 'assert';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';
import type { Session } from '../../src/types/index';
import type { CommandEvent, LogEvent, LogEventFilter } from '../../src/logs/types';

const SESSION_ID = 'chips-session';

function makeSession(): Session {
    return {
        id: SESSION_ID,
        title: 'Chip session',
        source: 'cline',
        workspaceId: 'ws',
        messages: [
            { id: 'm1', role: 'user', content: 'Run the tests', codeBlocks: [] },
            { id: 'm2', role: 'assistant', content: 'All green.', codeBlocks: [] },
        ],
        filePath: 'ui_messages.json',
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:01:00.000Z',
    };
}

function commandEvent(): CommandEvent {
    return {
        id: 'evt-1',
        type: 'command',
        timestamp: '2026-01-01T10:00:30.000Z',
        tool: 'cline',
        sessionId: SESSION_ID,
        commandText: 'npm test',
        exitCode: 0,
        messageIndex: 0,
    };
}

interface FakeSource {
    calls: LogEventFilter[];
    events: LogEvent[];
    throws?: boolean;
}

function installSource(): FakeSource {
    const source: FakeSource = { calls: [], events: [commandEvent()] };
    (SessionWebviewPanel as any)._logService = {
        getEvents(filter?: LogEventFilter): LogEvent[] {
            source.calls.push(filter ?? {});
            if (source.throws) { throw new Error('store unavailable'); }
            return source.events;
        },
    };
    return source;
}

function reset(): void {
    (SessionWebviewPanel as any)._panels.clear();
    (SessionWebviewPanel as any)._panelState.clear();
    (SessionWebviewPanel as any)._logService = undefined;
}

suite('SessionWebviewPanel – per-response Commands chips', () => {
    teardown(reset);

    test('builds the chip from the session-scoped log store', () => {
        const source = installSource();
        const { commandChips, logEvents } = (SessionWebviewPanel as any)._buildCommandChips(makeSession());

        assert.deepStrictEqual([...commandChips.keys()], [1], 'chip follows the response');
        assert.ok(commandChips.get(1)!.includes('npm test'));
        assert.strictEqual(logEvents.length, 1);
        assert.deepStrictEqual(source.calls, [{ sessionId: SESSION_ID, order: 'asc', limit: 5000 }]);
    });

    test('a degraded store yields no chips instead of breaking the reader', () => {
        const source = installSource();
        source.throws = true;

        const { commandChips, logEvents } = (SessionWebviewPanel as any)._buildCommandChips(makeSession());
        assert.strictEqual(commandChips.size, 0);
        assert.deepStrictEqual(logEvents, []);
    });

    test('refreshCommandChips pushes the rebuilt chips to every open reader', () => {
        installSource();
        const posted: any[] = [];
        const panel = { webview: { postMessage: (m: any) => { posted.push(m); return true; } } };

        (SessionWebviewPanel as any)._panels.set(SESSION_ID, panel);
        (SessionWebviewPanel as any)._panelState.set(SESSION_ID, { session: makeSession() });

        SessionWebviewPanel.refreshCommandChips();

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].type, 'commandsUpdated');
        assert.deepStrictEqual(posted[0].chips.map((chip: any) => chip.messageIndex), [1]);

        const state = (SessionWebviewPanel as any)._panelState.get(SESSION_ID);
        assert.deepStrictEqual([...state.commandChips.keys()], [1]);
        assert.strictEqual(state.logEvents.length, 1, 'events kept for opening a row');
    });

    test('the webview shell carries the chip styles, refresh handler and row click routing', () => {
        const html = (SessionWebviewPanel as any)._getShellHtml() as string;

        assert.ok(html.includes('.cw-cmd-chip {'), 'chip styling');
        assert.ok(html.includes('.cw-cmd-chip-slot'), 'slot styling');
        assert.ok(html.includes("data.type === 'commandsUpdated'"), 'live refresh handler');
        assert.ok(html.includes('function applyCommandChips'), 'slot updater');
        assert.ok(html.includes("type: 'openLogEvent'"), 'row click message');
        assert.ok(html.includes('function syncCommandChipSlots'), 'role filter follows the chip');
    });
});
