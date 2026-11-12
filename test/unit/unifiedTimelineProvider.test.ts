/**
 * test/unit/unifiedTimelineProvider.test.ts
 *
 * Phase 3 — Unified Timeline panel unit tests.
 * Verifies display helpers, per-session grouping/ordering and the kind filter.
 * Provider is constructed against an in-memory `LogService` so no VS Code
 * host is needed (same pattern as executedCommandsProvider.test.ts).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    UnifiedTimelineProvider,
    TimelineEventItem,
    TimelineGroupItem,
    formatEventTime,
    eventPrimaryLabel,
    eventDescription,
    eventIconId,
    eventTooltip,
} from '../../src/logs/unifiedTimelineProvider';
import { LogEvent } from '../../src/logs/types';

function makeEvent(overrides: Partial<LogEvent> & { id: string; timestamp: string }): LogEvent {
    return {
        type: 'command',
        tool: 'copilot',
        sessionId: 'sess-a',
        workspacePath: '/repo',
        commandText: 'npm test',
        ...overrides,
    } as LogEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-timeline-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('UnifiedTimelineProvider — display helpers', () => {
    test('formatEventTime renders HH:MM from ISO timestamps', () => {
        // Build the timestamp from local wall-clock time so the expectation is
        // timezone-independent.
        const localTenish = new Date(2026, 0, 1, 10, 5, 0);
        assert.strictEqual(formatEventTime(localTenish.toISOString()), '10:05');
        assert.strictEqual(formatEventTime(undefined), '');
        assert.strictEqual(formatEventTime('not-a-date'), '');
    });

    test('eventPrimaryLabel adapts per event kind', () => {
        assert.strictEqual(eventPrimaryLabel(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' })), 'npm test');
        assert.strictEqual(
            eventPrimaryLabel(makeEvent({ id: 'c2', timestamp: '2026-01-01T10:00:00.000Z', type: 'fileOperation', operationType: 'create', filePath: '/src/n.ts' })),
            'create /src/n.ts'
        );
        assert.strictEqual(
            eventPrimaryLabel(makeEvent({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/src/n.ts', diffText: '--- a/x\n+++ b/x\n' })),
            '/src/n.ts'
        );
        assert.strictEqual(
            eventPrimaryLabel(makeEvent({ id: 't1', timestamp: '2026-01-01T10:00:00.000Z', type: 'toolCall', toolName: 'run_in_terminal' })),
            'run_in_terminal'
        );
        assert.strictEqual(
            eventPrimaryLabel(makeEvent({ id: 'e1', timestamp: '2026-01-01T10:00:00.000Z', type: 'error', message: 'command failed' })),
            'command failed'
        );
    });

    test('eventIconId reflects severity signals', () => {
        assert.strictEqual(eventIconId(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 })), 'terminal');
        assert.strictEqual(eventIconId(makeEvent({ id: 'c2', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 1 })), 'error');
        assert.strictEqual(eventIconId(makeEvent({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/x', diffText: '' })), 'diff');
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'w1', timestamp: '2026-01-01T10:00:00.000Z', type: 'error', message: 'warn', severity: 'warning' })),
            'warning'
        );
    });

    test('eventDescription includes kind + relevant metadata', () => {
        const desc = eventDescription(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 }));
        assert.match(desc, /Executed Command/);
        assert.match(desc, /exit 0/);
        const diffDesc = eventDescription(makeEvent({
            id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/x', diffText: '', addedLines: 2, removedLines: 1,
        }));
        assert.match(diffDesc, /Diff \/ Patch/);
        assert.match(diffDesc, /\+2 −1/);
    });
});
suite('UnifiedTimelineProvider — grouping, ordering and filter', () => {
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

    test('groups all event kinds per session, newest group first', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'git add .' }),
            makeEvent({ id: 'd1', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z', type: 'diff', filePath: '/x.ts', diffText: '' }),
        ]);

        const provider = new UnifiedTimelineProvider(service, (id) => (id === 'sess-b' ? 'Release session' : undefined));
        const groups = provider.getGroups();

        assert.strictEqual(groups.length, 2);
        assert.strictEqual(groups[0].sessionKey, 'sess-b');
        assert.strictEqual(groups[0].label, 'Release session', 'title resolver supplies friendly name');
        assert.strictEqual(groups[1].label, 'Session sess-a');
    });

    test('events inside a group are sorted newest-first', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeEvent({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z' }),
            makeEvent({ id: 'c3', sessionId: 'sess-a', timestamp: '2026-01-01T09:00:00.000Z' }),
        ]);

        const provider = new UnifiedTimelineProvider(service);
        const group = provider.getGroups()[0];
        const leaves = provider.getChildren(group) as TimelineEventItem[];
        assert.deepStrictEqual(leaves.map((l) => l.event.id), ['c2', 'c1', 'c3']);
    });

    test('kind filter narrows the rendered events', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeEvent({ id: 'e1', sessionId: 'sess-a', timestamp: '2026-01-01T10:01:00.000Z', type: 'error', message: 'fail' }),
        ]);

        const provider = new UnifiedTimelineProvider(service);
        provider.setFilter(['error']);
        const groups = provider.getGroups();
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].events.length, 1);
        assert.strictEqual(groups[0].events[0].id, 'e1');
        assert.deepStrictEqual(provider.getFilter(), ['error']);
    });

    test('unsessioned events are bucketed under a tool: fallback group', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: undefined, timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);
        const provider = new UnifiedTimelineProvider(service);
        const groups = provider.getGroups();
        assert.strictEqual(groups.length, 1);
        assert.match(groups[0].sessionKey, /^tool:/);
    });

    test('refresh picks up new events from the store', () => {
        service.ingestEvents([makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' })]);
        const provider = new UnifiedTimelineProvider(service);
        assert.strictEqual(provider.getGroups().length, 1);

        service.ingestEvents([makeEvent({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z' })]);
        provider.refresh();
        assert.strictEqual(provider.getGroups().length, 2);
    });

    test('leaf items set a double-click command to show full contents', () => {
        service.ingestEvents([makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' })]);
        const provider = new UnifiedTimelineProvider(service);
        const leaves = provider.getChildren(provider.getGroups()[0]) as TimelineEventItem[];
        assert.strictEqual(leaves[0].command?.command, 'chatwizard.logs.timeline.showDetails');
        assert.strictEqual(leaves[0].command?.title, 'Show Event Details');
    });
});

suite('UnifiedTimelineProvider — Phase 4 filters', () => {
    let dir: string;
    let service: LogService;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', commandText: 'npm test', exitCode: 0 }),
            makeEvent({ id: 'c2', sessionId: 'sess-a', timestamp: '2026-01-01T10:05:00.000Z', commandText: 'npm run build', exitCode: 1 }),
            makeEvent({
                id: 'e1',
                sessionId: 'sess-a',
                timestamp: '2026-01-01T10:10:00.000Z',
                type: 'error',
                message: 'build failed',
            } as LogEvent),
            makeEvent({
                id: 'd1',
                sessionId: 'sess-b',
                timestamp: '2026-01-02T10:00:00.000Z',
                type: 'diff',
                tool: 'cline',
                filePath: '/repo/src/app.ts',
                diffText: '+x',
            } as LogEvent),
        ]);
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    const visibleIds = (provider: UnifiedTimelineProvider): string[] =>
        provider.getGroups().flatMap((g) => g.events.map((e) => e.id));

    test('search matches command text, error messages and file paths', () => {
        const provider = new UnifiedTimelineProvider(service);
        provider.setFilters({ search: 'npm run' });
        assert.deepStrictEqual(visibleIds(provider), ['c2']);

        provider.setFilters({ search: 'failed' });
        assert.deepStrictEqual(visibleIds(provider), ['e1']);

        provider.setFilters({ search: 'app.ts' });
        assert.deepStrictEqual(visibleIds(provider), ['d1']);
        assert.strictEqual(provider.filtersActive(), true);
    });

    test('agent filter narrows by tool', () => {
        const provider = new UnifiedTimelineProvider(service);
        provider.setFilters({ tool: 'cline' });
        assert.deepStrictEqual(visibleIds(provider), ['d1']);
    });

    test('failuresOnly keeps failed commands and errors', () => {
        const provider = new UnifiedTimelineProvider(service);
        provider.setFilters({ failuresOnly: true });
        assert.deepStrictEqual(visibleIds(provider), ['e1', 'c2']);
    });

    test('kind filters combine with the new dimensions', () => {
        const provider = new UnifiedTimelineProvider(service);
        provider.setFilters({ types: ['command'], failuresOnly: true });
        assert.deepStrictEqual(visibleIds(provider), ['c2']);
        assert.deepStrictEqual(provider.getFilter(), ['command']);
        assert.strictEqual(provider.getFilters().failuresOnly, true);

        // Legacy kind-only setter keeps the other facets intact.
        provider.setFilter(undefined);
        assert.deepStrictEqual(visibleIds(provider), ['e1', 'c2']);
        assert.strictEqual(provider.getFilters().failuresOnly, true);
    });
});

suite('UnifiedTimelineProvider — tooltips, tree plumbing and title fallbacks', () => {
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

    test('eventTooltip surfaces everything known per event kind', () => {
        assert.strictEqual(
            eventTooltip(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/repo', raw: 'raw-line' })),
            'npm test\ncwd: /repo\nraw-line'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({ id: 'c2', timestamp: '2026-01-01T10:00:00.000Z' })),
            'npm test'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'f1', timestamp: '2026-01-01T10:00:00.000Z', type: 'fileOperation',
                operationType: 'move', filePath: '/b.ts', oldPath: '/a.ts', detail: 'tool: move_file',
            })),
            '/b.ts\nfrom: /a.ts\ntool: move_file'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 't1', timestamp: '2026-01-01T10:00:00.000Z', type: 'toolCall',
                toolName: 'read_file', arguments: { path: '/a.ts' },
            })),
            'read_file\n{\n  "path": "/a.ts"\n}'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/a.ts', diffText: '--- a\n+++ b',
            })),
            '--- a\n+++ b'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'e1', timestamp: '2026-01-01T10:00:00.000Z', type: 'error',
                message: 'boom', stackTrace: 'at x', raw: 'raw-err',
            })),
            'boom\nat x\nraw-err'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'p1', timestamp: '2026-01-01T10:00:00.000Z', type: 'plannerStep',
                description: 'Plan the work', status: 'done',
            })),
            'Plan the work\ndone'
        );
    });

    test('eventDescription covers every kind and exit-code shape', () => {
        const desc = (o: Partial<LogEvent>) =>
            eventDescription(makeEvent({ id: 'x', timestamp: '2026-01-01T10:00:00.000Z', ...o }));

        assert.match(desc({}), /exit \?/);
        assert.match(desc({ exitCode: 0 }), /exit 0/);
        assert.match(desc({ exitCode: 2 }), /exit 2/);
        assert.match(desc({ type: 'fileOperation', operationType: 'create', filePath: '/a.ts', detail: 'via tool' }), /via tool/);
        const noDetail = desc({ type: 'fileOperation', operationType: 'create', filePath: '/a.ts' });
        assert.match(noDetail, /create/);
        assert.ok(!noDetail.includes('via tool'), `unexpected detail: ${noDetail}`);
        assert.match(desc({ type: 'diff', filePath: '/a.ts', diffText: '', addedLines: 3, removedLines: 1 }), /\+3 −1/);
        assert.match(desc({ type: 'diff', filePath: '/a.ts', diffText: '' }), /^Diff \/ Patch/);
        assert.match(desc({ type: 'toolCall', toolName: 'x' }), /^Tool Call/);
        assert.match(desc({ type: 'error', message: 'x', severity: 'warning' }), /warning/);
        assert.match(desc({ type: 'error', message: 'x' }), /^Error \/ Failure/);
        assert.match(desc({ type: 'plannerStep', description: 'x' }), /^Planner Step/);
    });

    test('eventIconId maps exit codes and severities to codicons', () => {
        assert.strictEqual(eventIconId(makeEvent({ id: 'a', timestamp: '2026-01-01T10:00:00.000Z' })), 'run');
        assert.strictEqual(eventIconId(makeEvent({ id: 'b', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 })), 'terminal');
        assert.strictEqual(eventIconId(makeEvent({ id: 'c', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 1 })), 'error');
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'd', timestamp: '2026-01-01T10:00:00.000Z', type: 'error', message: 'x', severity: 'warning' })),
            'warning'
        );
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'e', timestamp: '2026-01-01T10:00:00.000Z', type: 'error', message: 'x' })),
            'error'
        );
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'f', timestamp: '2026-01-01T10:00:00.000Z', type: 'fileOperation', operationType: 'create', filePath: '/a' })),
            'file'
        );
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'g', timestamp: '2026-01-01T10:00:00.000Z', type: 'diff', filePath: '/a', diffText: '' })),
            'diff'
        );
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'h', timestamp: '2026-01-01T10:00:00.000Z', type: 'toolCall', toolName: 't' })),
            'tools'
        );
        assert.strictEqual(
            eventIconId(makeEvent({ id: 'i', timestamp: '2026-01-01T10:00:00.000Z', type: 'plannerStep', description: 'd' })),
            'list-unordered'
        );
    });
});


suite('UnifiedTimelineProvider — tree plumbing and title fallbacks', () => {
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

    test('getChildren lazily builds the tree without an explicit refresh', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const provider = new UnifiedTimelineProvider(service);
        const roots = provider.getChildren() as TimelineGroupItem[];
        assert.strictEqual(roots.length, 1);
        assert.strictEqual(roots[0].sessionKey, 'sess-a');

        const leaves = provider.getChildren(roots[0]) as TimelineEventItem[];
        assert.deepStrictEqual(leaves.map((l) => l.event.id), ['c1']);

        // Leaves have no children of their own.
        assert.deepStrictEqual(provider.getChildren(leaves[0]), []);
    });

    test('getTreeItem returns the same node and getParent links leaves to their group', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeEvent({ id: 'c2', sessionId: 'sess-b', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);

        const provider = new UnifiedTimelineProvider(service);
        const groups = provider.getGroups();
        assert.strictEqual(provider.getTreeItem(groups[0]), groups[0]);

        const [leaf] = provider.getChildren(groups[0]) as TimelineEventItem[];
        assert.strictEqual(provider.getParent(leaf)?.sessionKey, 'sess-b');
        assert.strictEqual(provider.getParent(groups[0]), undefined, 'groups are roots');
    });

    test('group titles fall back for unsessioned events and long ids', () => {
        service.ingestEvents([
            makeEvent({ id: 'unsessioned', sessionId: undefined, tool: 'cursor', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeEvent({ id: 'long', sessionId: 'abcdefghijklmnopqrstuvwxyz', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);

        // A resolver returning a blank title must not override the fallback.
        const provider = new UnifiedTimelineProvider(service, () => '   ');
        const labels = provider.getGroups().map((g) => g.label);

        assert.ok(labels.includes('cursor (unsessioned)'), `labels: ${labels.join(', ')}`);
        assert.ok(labels.includes('Session abcdefghijkl'), `labels: ${labels.join(', ')}`);
    });

    test('a failing store degrades to an empty tree instead of throwing', () => {
        const broken = { getEvents: () => { throw new Error('store down'); } } as unknown as LogService;
        const provider = new UnifiedTimelineProvider(broken);
        assert.deepStrictEqual(provider.getGroups(), []);
        assert.deepStrictEqual(provider.getChildren(), []);
    });

    test('tooltips omit optional sections that are missing', () => {
        assert.strictEqual(
            eventTooltip(makeEvent({ id: 'c1', timestamp: '2026-01-01T10:00:00.000Z' })),
            'npm test',
            'no cwd / no raw → command text only'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'f1', timestamp: '2026-01-01T10:00:00.000Z', type: 'fileOperation',
                operationType: 'create', filePath: '/a.ts',
            })),
            '/a.ts'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 't1', timestamp: '2026-01-01T10:00:00.000Z', type: 'toolCall', toolName: 'read_file',
            })),
            'read_file'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'e1', timestamp: '2026-01-01T10:00:00.000Z', type: 'error', message: 'boom',
            })),
            'boom'
        );
        assert.strictEqual(
            eventTooltip(makeEvent({
                id: 'p1', timestamp: '2026-01-01T10:00:00.000Z', type: 'plannerStep', description: 'Plan',
            })),
            'Plan'
        );
    });

    test('group and leaf items expose their tree metadata', () => {
        service.ingestEvents([
            makeEvent({ id: 'c1', sessionId: 'sess-a', timestamp: '2026-01-01T10:00:00.000Z', workspacePath: '/repo' }),
        ]);

        const provider = new UnifiedTimelineProvider(service);
        const [group] = provider.getGroups();
        assert.strictEqual(group.sessionKey, 'sess-a');
        assert.strictEqual(group.events.length, 1);

        const [leaf] = provider.getChildren(group) as TimelineEventItem[];
        assert.strictEqual(leaf.contextValue, 'logsEvent.command');
        assert.ok(leaf.command, 'leaves open the detail webview on activation');
    });

    test('group descriptions pluralize counts and tolerate a missing workspace path', () => {
        const two = new TimelineGroupItem('k', 'Title', [
            makeEvent({ id: 'a', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeEvent({ id: 'b', timestamp: '2026-01-01T11:00:00.000Z' }),
        ], '/repo');
        assert.strictEqual(two.description, '2 events · /repo');

        const single = new TimelineGroupItem('k', 'Title', [
            makeEvent({ id: 'a', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);
        assert.strictEqual(single.description, '1 event');

        const empty = new TimelineGroupItem('k2', 'Title', []);
        assert.strictEqual(empty.description, '0 events');
    });

    test('leaves mark failing commands with an error-coloured icon', () => {
        const failing = new TimelineEventItem(makeEvent({ id: 'f', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 1 }));
        assert.ok(failing.iconPath, 'nonzero exit gets a themed colour');

        const passing = new TimelineEventItem(makeEvent({ id: 'p', timestamp: '2026-01-01T10:00:00.000Z', exitCode: 0 }));
        assert.ok(passing.iconPath);

        const notACommand = new TimelineEventItem(makeEvent({
            id: 'n', timestamp: '2026-01-01T10:00:00.000Z', type: 'toolCall', toolName: 'read_file',
        }));
        assert.ok(notACommand.iconPath);
    });
});

