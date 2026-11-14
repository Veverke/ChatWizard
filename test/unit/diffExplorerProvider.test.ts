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
import * as vscode from 'vscode';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import {
    DiffExplorerProvider,
    DiffEventLeafItem,
    DiffFileGroupItem,
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

    test('groups changes per file, newest first', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/repo/src/a.ts', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeDiff({ id: 'd2', filePath: '/repo/src/b.ts', timestamp: '2026-01-02T10:00:00.000Z' }),
            makeFileOp({ id: 'f1', filePath: '/repo/src/new.ts', timestamp: '2026-01-03T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        const files = provider.getFileGroups();

        assert.strictEqual(files.length, 3, 'one row per changed file');
        // Newest change first.
        assert.strictEqual(files[0].filePath, '/repo/src/new.ts');
        assert.strictEqual(files[0].newestTimestamp, '2026-01-03T10:00:00.000Z');
        assert.strictEqual(files[1].filePath, '/repo/src/b.ts');
        assert.strictEqual(files[2].filePath, '/repo/src/a.ts');

        // The file rows ARE the section's children — no workspace binder level.
        assert.deepStrictEqual(provider.getChildren(), files);
        assert.strictEqual(provider.getParent(files[0]), undefined, 'file groups are roots');

        // Each file expands to its change rows.
        const leaves = provider.getChildren(files[1]) as DiffEventLeafItem[];
        assert.strictEqual(leaves.length, 1);
        assert.strictEqual(leaves[0].event.id, 'd2');
        assert.strictEqual(provider.getParent(leaves[0]), files[1]);
    });

    test('patch file-operations are excluded (their DiffEvent carries the change)', () => {
        service.ingestEvents([
            makeFileOp({ id: 'f1', filePath: '/repo/src/a.ts', operationType: 'patch', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        assert.strictEqual(provider.getFileGroups().length, 0);
        assert.strictEqual(provider.getTotalEvents(), 0);
    });

    test('changes without a recorded workspace still list by file', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/x.ts', workspacePath: undefined, workspaceId: 'ws-99', timestamp: '2026-01-01T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        const files = provider.getFileGroups();
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].filePath, '/x.ts', 'the changed file is its own row');
    });

    test('diff rows activate the visual diff, file ops open the details webview', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/repo/src/a.ts', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeFileOp({ id: 'f1', filePath: '/repo/src/b.ts', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        const provider = new DiffExplorerProvider(service);
        const files = provider.getFileGroups();

        const diffLeaf = (provider.getChildren(files[1]) as DiffEventLeafItem[])[0];
        assert.strictEqual(diffLeaf.command?.command, 'chatwizard.logs.diff.viewDiff');
        assert.strictEqual(diffLeaf.command?.title, 'Open Visual Diff');

        const fileOpLeaf = (provider.getChildren(files[0]) as DiffEventLeafItem[])[0];
        assert.strictEqual(fileOpLeaf.command?.command, 'chatwizard.logs.diff.showDetails');
        assert.strictEqual(fileOpLeaf.command?.title, 'Show Change Details');
    });

    test('several changes to one file share a row and render lazily', () => {
        service.ingestEvents([
            makeDiff({ id: 'd1', filePath: '/repo/src/a.ts', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeDiff({ id: 'd2', filePath: '/repo/src/a.ts', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);

        const provider = new DiffExplorerProvider(service);
        // getChildren() before any getFileGroups() read exercises the lazy build.
        const files = provider.getChildren() as DiffFileGroupItem[];

        assert.strictEqual(files.length, 1, 'one row per file, however many changes');
        assert.strictEqual(files[0].events.length, 2);
        assert.strictEqual(files[0].newestTimestamp, '2026-01-02T10:00:00.000Z');

        // Change rows are leaves: asking for their children yields nothing.
        const [leaf] = provider.getChildren(files[0]) as DiffEventLeafItem[];
        assert.deepStrictEqual(provider.getChildren(leaf), []);
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

suite('DiffExplorerProvider — Phase 4 filters', () => {
    let dir: string;
    let service: LogService;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        service.ingestEvents([
            makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', filePath: '/repo/src/a.ts' }),
            makeDiff({ id: 'd2', timestamp: '2026-01-02T10:00:00.000Z', filePath: '/repo/src/app.ts', tool: 'cline' }),
            makeFileOp({ id: 'f1', timestamp: '2026-01-03T10:00:00.000Z', filePath: '/repo/docs/readme.md' }),
        ]);
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    const visibleIds = (provider: DiffExplorerProvider): string[] =>
        provider.getFileGroups().flatMap((f) => f.events.map((e) => e.id));

    test('search narrows by file path', () => {
        const provider = new DiffExplorerProvider(service);
        provider.setFilters({ search: 'app.ts' });
        assert.deepStrictEqual(visibleIds(provider), ['d2']);
        assert.strictEqual(provider.filtersActive(), true);
    });

    test('search also matches the patch text', () => {
        service.ingestEvents([
            makeDiff({
                id: 'd3',
                timestamp: '2026-01-04T10:00:00.000Z',
                filePath: '/repo/src/config.ts',
                diffText: '+retryLimit: 3\n',
            }),
        ]);
        const provider = new DiffExplorerProvider(service);
        provider.setFilters({ search: 'retryLimit' });
        assert.deepStrictEqual(visibleIds(provider), ['d3']);
    });

    test('agent filter narrows by tool and clearing restores everything', () => {
        const provider = new DiffExplorerProvider(service);
        provider.setFilters({ tool: 'cline' });
        assert.deepStrictEqual(visibleIds(provider), ['d2']);

        provider.setFilters({});
        assert.deepStrictEqual(visibleIds(provider).sort(), ['d1', 'd2', 'f1']);
        assert.strictEqual(provider.filtersActive(), false);
    });

    test('setWorkspaceScope restricts the Diff Explorer to the open folder', () => {
        service.ingestEvents([
            makeDiff({
                id: 'other-ws',
                timestamp: '2026-01-04T10:00:00.000Z',
                filePath: '/analytics/src/hook.ts',
                workspacePath: '/repos/vscode-extension-analytics',
            }),
            makeDiff({
                id: 'here',
                timestamp: '2026-01-05T10:00:00.000Z',
                filePath: '/chatwizard/src/extension.ts',
                workspacePath: '/repos/chatwizard',
            }),
        ]);

        const provider = new DiffExplorerProvider(service);
        assert.ok(visibleIds(provider).includes('other-ws'));

        provider.setWorkspaceScope(['/repos/chatwizard']);

        const visible = visibleIds(provider);
        assert.ok(visible.includes('here'));
        assert.ok(!visible.includes('other-ws'), 'another workspace’s diffs are hidden');

        provider.setWorkspaceScope([]);
        assert.ok(visibleIds(provider).includes('other-ws'), 'clearing the scope restores everything');
    });
});

suite('DiffExplorerProvider — row/helper edge cases', () => {
    test('only diffs and non-patch file operations are candidates', () => {
        const command = {
            type: 'command', id: 'c1', timestamp: '2026-01-01T10:00:00.000Z', tool: 'copilot', commandText: 'npm test',
        } as unknown as LogEvent;
        assert.strictEqual(isDiffCandidate(command), false);
    });

    test('diffStatsLabel handles a single known side', () => {
        const onlyRemoved = {
            ...(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' }) as DiffEvent),
            addedLines: undefined,
            removedLines: 2,
        };
        assert.strictEqual(diffStatsLabel(onlyRemoved), '+0 −2');
    });

    test('renderPatchMarkdown tolerates a missing timestamp, path and session', () => {
        const incomplete = {
            ...(makeDiff({ id: 'd1', timestamp: '' }) as DiffEvent),
            filePath: undefined,
            sessionId: undefined,
            addedLines: undefined,
            removedLines: 3,
        } as unknown as LogEvent;

        const md = renderPatchMarkdown(incomplete);
        assert.match(md, /unknown path/);
        assert.match(md, /\*\*When:\*\* unknown/);
        assert.match(md, /\+0 −3/);
        assert.ok(!md.includes('**Session:**'), 'no session row without a session id');
    });

    test('renderPatchMarkdown carries the rename source and raw payload', () => {
        const rename = {
            ...makeFileOp({ id: 'f1', timestamp: '2026-01-01T10:00:00.000Z', operationType: 'rename' }),
            oldPath: '/repo/src/a.ts',
            raw: '{"tool":"rename_file"}',
        } as unknown as LogEvent;

        const md = renderPatchMarkdown(rename);
        assert.match(md, /\*\*From:\*\* \/repo\/src\/a\.ts/);
        assert.match(md, /```json/);
    });

    test('diffEventTooltip singularises a single remaining line', () => {
        const exact = 'l1\nl2\nl3';
        assert.strictEqual(
            diffEventTooltip(makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z', diffText: exact }), 3),
            exact,
            'a patch at the limit is shown whole'
        );

        const oneMore = diffEventTooltip(
            makeDiff({ id: 'd2', timestamp: '2026-01-01T10:00:00.000Z', diffText: `${exact}\nl4` }),
            3
        );
        assert.match(oneMore, /1 more line —/);
    });

    test('DiffFileGroupItem renders leaf rows and singular descriptions', () => {
        const empty = new DiffFileGroupItem('/repo/src/a.ts', []);
        assert.strictEqual(empty.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.strictEqual(empty.description, '0 changes · /repo/src');
        assert.strictEqual(empty.newestTimestamp, '');

        const oneRow = new DiffFileGroupItem('a.ts', [makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' })]);
        assert.strictEqual(oneRow.description, '1 change', 'no folder → no · suffix');
        assert.strictEqual(oneRow.label, 'a.ts');

        const twoRows = new DiffFileGroupItem('/repo/src/a.ts', [
            makeDiff({ id: 'd1', timestamp: '2026-01-01T10:00:00.000Z' }),
            makeDiff({ id: 'd2', timestamp: '2026-01-02T10:00:00.000Z' }),
        ]);
        assert.strictEqual(twoRows.description, '2 changes · /repo/src');
        assert.strictEqual(twoRows.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });

    test('a broken store degrades to an empty tree instead of throwing', () => {
        const broken = { getEvents: () => { throw new Error('boom'); } } as unknown as LogService;
        const provider = new DiffExplorerProvider(broken);

        assert.deepStrictEqual(provider.getFileGroups(), []);
        assert.strictEqual(provider.getTotalEvents(), 0);
    });
});
