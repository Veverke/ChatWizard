/**
 * test/unit/diffExplorerProvider.test.ts
 *
 * Phase 3 — Diff Explorer panel unit tests.
 * Verifies selection semantics (patch file-ops excluded in favour of their
 * paired DiffEvent), workspace/file grouping, ordering and the markdown
 * renderer used by the "Open Patch" action.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    DiffExplorerProvider,
    DiffEventLeafItem,
    isDiffCandidate,
    diffStatsLabel,
    diffEventDescription,
    diffEventTooltip,
    pathToDisplayInfo,
    renderPatchMarkdown,
} from '../../src/logs/diffExplorerProvider';
import { DiffEvent, LogEvent } from '../../src/logs/types';

function makeDiff(overrides: Partial<LogEvent> & { id: string; timestamp: string }): LogEvent {
    return {
        type: 'diff',
        tool: 'copilot',
        sessionId: 'sess-a',
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        filePath: '/repo/src/a.ts',
        diffText: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        addedLines: 1,
        removedLines: 1,
        ...overrides,
    } as LogEvent;
}

function makeFileOp(overrides: Partial<LogEvent> & { id: string; timestamp: string }): LogEvent {
    return {
        type: 'fileOperation',
        tool: 'copilot',
        sessionId: 'sess-a',
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        filePath: '/repo/src/new.ts',
        operationType: 'create',
        detail: 'tool: create_file',
        ...overrides,
    } as LogEvent;
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-diffs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('DiffExplorerProvider — selection & display helpers', () => {
    test('isDiffCandidate keeps diffs + typed file ops, drops patch ops', () => {
        assert.ok(isDiffCandidate(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' })));
        assert.ok(isDiffCandidate(makeFileOp({ id: 'f1', timestamp: '2026-01-01T10:00:00.000Z', operationType: 'delete' })));
        assert.ok(!isDiffCandidate(makeFileOp({ id: 'f2', timestamp: '2026-01-01T10:00:00.000Z', operationType: 'patch' })));
    });

    test('diffStatsLabel handles known and unknown stats', () => {
        assert.strictEqual(diffStatsLabel(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' }) as DiffEvent), '+1 −1');
        assert.strictEqual(
            diffStatsLabel({ type: 'diff', id: 'd2', timestamp: '2026-01-01T10:00:00.000Z', tool: 'copilot', filePath: '/x', diffText: '' } as DiffEvent),
            '±?'
        );
    });

    test('diffEventDescription mentions kind + tool', () => {
        const d = diffEventDescription(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.match(d, /Diff \/ Patch/);
        assert.match(d, /copilot/);
        const f = diffEventDescription(makeFileOp({ id: 'f1', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.match(f, /create/);
    });

    test('pathToDisplayInfo splits basename/dirname (windows-safe)', () => {
        assert.deepStrictEqual(pathToDisplayInfo('/repo/src/a.ts'), { basename: 'a.ts', dirname: '/repo/src' });
        assert.deepStrictEqual(pathToDisplayInfo('plain.txt'), { basename: 'plain.txt', dirname: '' });
    });

    test('renderPatchMarkdown produces a markdown doc with the diff', () => {
        const md = renderPatchMarkdown(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' }));
        assert.match(md, /^## Diff/m);
        assert.match(md, /\/repo\/src\/a\.ts/);
        assert.match(md, /```diff/);
        assert.match(md, /\+new/);
        assert.match(md, /-old/);
    });
});
suite('DiffExplorerProvider — grouping and ordering', () => {
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

    test('groups diffs per workspace → per file with newest first', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/repo/src/a.ts', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeDiff({ id: 'd2', filePath: '/repo/src/b.ts', timestamp: '2026-01-02T10:00:00.000Z' }),
            makeFileOp({ id: 'f1', filePath: '/repo/src/new.ts', timestamp: '2026-01-03T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        const workspaces = provider.getWorkspaceGroups();

        assert.strictEqual(workspaces.length, 1);
        assert.strictEqual(workspaces[0].label, 'repo', 'workspace group uses the basename');

        const files = workspaces[0].groups;
        assert.strictEqual(files.length, 3);
        // Newest change first.
        assert.strictEqual(files[0].newestTimestamp, '2026-01-03T10:00:00.000Z');
        assert.strictEqual(files[1].filePath, '/repo/src/b.ts');

        // Each file expands to its change rows.
        const leaves = provider.getChildren(files[1]) as DiffEventLeafItem[];
        assert.strictEqual(leaves.length, 1);
        assert.strictEqual(leaves[0].event.id, 'd2');
    });

    test('patch file-operations are excluded (their DiffEvent carries the change)', () => {
        service.ingestEvents([
            makeFileOp({ id: 'f1', filePath: '/repo/src/a.ts', operationType: 'patch', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        assert.strictEqual(provider.getWorkspaceGroups().length, 0);
        assert.strictEqual(provider.getTotalEvents(), 0);
    });

    test('events with no workspace path collapse into an id-based group', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/x.ts', workspacePath: undefined, workspaceId: 'ws-99', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        const workspaces = provider.getWorkspaceGroups();
        assert.strictEqual(workspaces.length, 1);
        assert.strictEqual(workspaces[0].workspaceKey, 'id:ws-99');
        assert.strictEqual(workspaces[0].label, 'Unknown workspace');
    });

    test('diff rows activate the visual diff, file ops open the details webview', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/repo/src/a.ts', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeFileOp({ id: 'f1', filePath: '/repo/src/b.ts', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        const provider = new DiffExplorerProvider(service);
        const files = provider.getWorkspaceGroups()[0].groups;

        const diffLeaf = (provider.getChildren(files[1]) as DiffEventLeafItem[])[0];
        assert.strictEqual(diffLeaf.command?.command, 'chatwizard.logs.diff.viewDiff');
        assert.strictEqual(diffLeaf.command?.title, 'Open Visual Diff');

        const fileOpLeaf = (provider.getChildren(files[0]) as DiffEventLeafItem[])[0];
        assert.strictEqual(fileOpLeaf.command?.command, 'chatwizard.logs.diff.showDetails');
        assert.strictEqual(fileOpLeaf.command?.title, 'Show Change Details');
    });

    test('diff tooltips show a short patch preview instead of the whole patch', () => {
        const short = makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' });
        assert.strictEqual(diffEventTooltip(short), (short as DiffEvent).diffText);

        const longDiff = makeDiff({
            id: 'd2',
            timestamp: '2026-01-01T10:00:00.000Z',
            diffText: Array.from({ length: 60 }, (_, i) => `+line ${i}`).join('\n'),
        });
        const tooltip = diffEventTooltip(longDiff, 10);
        assert.strictEqual(tooltip.split('\n').length, 11, 'preview lines + ellipsis line');
        assert.match(tooltip, /more lines — open the visual diff/);

        // File operations have no patch text: their tooltip is the markdown card.
        const fileOp = makeFileOp({ id: 'f1', timestamp: '2026-01-01T10:00:00.000Z' });
        assert.match(diffEventTooltip(fileOp), /## File operation/);
    });
});