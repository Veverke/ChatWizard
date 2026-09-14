/**
 * test/unit/executedCommandsProvider.test.ts
 *
 * Phase 2 — Executed Commands panel unit tests.
 * Verifies grouping (per session, newest first), display helpers, and the
 * pure functions the tree renders. Provider is constructed against an in-memory
 * `LogService` so no VS Code host is needed.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    ExecutedCommandsProvider,
    ExecCommandsGroupItem,
    ExecCommandsLeafItem,
    firstLineOf,
    formatExitBadge,
} from '../../src/logs/executedCommandsProvider';
import { CommandEvent } from '../../src/logs/types';

function makeCommand(overrides: Partial<CommandEvent> & { id: string; timestamp: string }): CommandEvent {
    return {
        type: 'command',
        tool: 'copilot',
        commandText: 'npm test',
        sessionId: 's1',
        ...overrides,
    } as CommandEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-exec-commands-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('ExecutedCommandsProvider — display helpers', () => {
    test('firstLineOf trims and truncates', () => {
        assert.strictEqual(firstLineOf('npm test'), 'npm test');
        assert.strictEqual(firstLineOf('  git status  '), 'git status');
        assert.strictEqual(firstLineOf('', 5), '');
        assert.strictEqual(firstLineOf('abcdefghij', 5), 'abcd…');
    });

    test('formatExitBadge maps undefined/0/nonzero', () => {
        assert.strictEqual(formatExitBadge(undefined), 'exit ?');
        assert.strictEqual(formatExitBadge(0), '✓ exit 0');
        assert.strictEqual(formatExitBadge(1), '✗ exit 1');
        assert.strictEqual(formatExitBadge(2), '✗ exit 2');
    });
});
suite('ExecutedCommandsProvider — grouping and ordering', () => {
    let dir: string;
    let service: LogService;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('groups commands by session and orders sessions newest-first', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'git add .' }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'npm test' }),
            makeCommand({ id: 'c3', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z', commandText: 'npm run build' }),
        ]);

        const provider = new ExecutedCommandsProvider(service, (id) => (id === 'sess-b' ? 'Build session' : undefined));
        const groups = provider.getGroups();

        assert.strictEqual(groups.length, 2);
        // Session B has the newest command → first.
        assert.strictEqual(groups[0].sessionId, 'sess-b');
        assert.strictEqual(groups[0].label, 'Build session', 'title resolver supplies friendly name');
        assert.strictEqual(groups[1].label, 'Session sess-a', 'fallback label when no title resolved');
    });

    test('commands inside a session are sorted newest-first', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z' }),
            makeCommand({ id: 'c3', sessionId: 'sess-a', timestamp: '2026-01-01T09:00:00.000Z' }),
        ]);

        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as ExecCommandsLeafItem[];
        assert.deepStrictEqual(leaves.map((l) => l.event.id), ['c2', 'c1', 'c3']);
    });

    test('getParent resolves a leaf back to its group', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeCommand({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-01T11:00:00.000Z' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[1]) as ExecCommandsLeafItem[];
        const parent = provider.getParent(leaves[0]) as ExecCommandsGroupItem;
        assert.strictEqual(parent.sessionId, leaves[0].event.sessionId);
    });

    test('refresh rebuilds from the store (drop + re-add reflected)', () => {
        service.ingestEvents([
            makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);
        const provider = new ExecutedCommandsProvider(service);
        assert.strictEqual(provider.getGroups().length, 1);

        service.ingestEvents([
            makeCommand({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        provider.refresh();
        assert.strictEqual(provider.getGroups().length, 2);
    });

    test('empty store → no groups', () => {
        const provider = new ExecutedCommandsProvider(service);
        assert.deepStrictEqual(provider.getGroups(), []);
        assert.deepStrictEqual(provider.getChildren(), []);
    });

    test('leaf tooltip exposes the full command text', () => {
        const longCommand = 'npm run build -- --config webpack.prod.js --mode production';
        service.ingestEvents([makeCommand({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: longCommand })]);
        const provider = new ExecutedCommandsProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as ExecCommandsLeafItem[];
        assert.strictEqual(leaves[0].tooltip, longCommand);
    });
});