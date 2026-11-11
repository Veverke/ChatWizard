/**
 * test/unit/diffViewer.test.ts
 *
 * Phase 4 — visual (side-by-side) diff viewer unit tests.
 * Verifies the pure helpers that turn a captured patch into the two sides of
 * VS Code's native diff editor, plus the virtual-document provider that serves
 * those sides. The VS Code host is not required for the pure helpers.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    DIFF_SCHEME,
    DiffSideContentProvider,
    MAX_CACHED_DIFF_DOCUMENTS,
    MAX_PATCH_SIDE_LINES,
    baseNameOf,
    buildVisualDiffTitle,
    diffHeaderPath,
    diffSideUris,
    getDiffSideContentProvider,
    hasRenderableSides,
    openVisualDiff,
    reconstructDiffSides,
    registerDiffViewer,
} from '../../src/logs/diffViewer';
import { LogEvent } from '../../src/logs/types';

function makeDiff(overrides: Partial<LogEvent> = {}): LogEvent {
    return {
        type: 'diff',
        id: 'd1',
        timestamp: '2026-01-01T10:00:00.000Z',
        tool: 'cline',
        filePath: '/repo/src/formatDate.ts',
        diffText: '',
        ...overrides,
    } as LogEvent;
}

const GIT_DIFF = [
    '--- a/src/formatDate.ts\t2026-01-01 10:00:00.000000000 +0200',
    '+++ b/src/formatDate.ts\t2026-01-01 10:00:00.000000000 +0200',
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' export function fmt() {',
    '   return a;',
    ' }',
    '',
].join('\n');

suite('diffViewer — path helpers', () => {
    test('diffHeaderPath strips a/b prefixes and git timestamps', () => {
        assert.strictEqual(diffHeaderPath('a/src/a.ts'), 'src/a.ts');
        assert.strictEqual(diffHeaderPath('b/src/a.ts'), 'src/a.ts');
        assert.strictEqual(diffHeaderPath('b/src/a.ts\t2026-01-01 10:00:00'), 'src/a.ts');
        assert.strictEqual(diffHeaderPath('"b/src/with space.ts"'), 'src/with space.ts');
        assert.strictEqual(diffHeaderPath('apps/web/index.ts'), 'apps/web/index.ts');
        assert.strictEqual(diffHeaderPath('   '), undefined);
    });

    test('baseNameOf handles POSIX and Windows paths', () => {
        assert.strictEqual(baseNameOf('/repo/src/a.ts'), 'a.ts');
        assert.strictEqual(baseNameOf('C:\\repo\\src\\a.ts'), 'a.ts');
        assert.strictEqual(baseNameOf('a.ts'), 'a.ts');
        assert.strictEqual(baseNameOf(''), '');
    });
});

suite('diffViewer — reconstructDiffSides', () => {
    test('splits a standard unified diff into before/after with context', () => {
        const sides = reconstructDiffSides(GIT_DIFF);

        assert.strictEqual(sides.before, [
            'const a = 1;',
            'const b = 2;',
            'export function fmt() {',
            '  return a;',
            '}',
        ].join('\n'));
        assert.strictEqual(sides.after, [
            'const a = 1;',
            'const b = 3;',
            'const c = 4;',
            'export function fmt() {',
            '  return a;',
            '}',
        ].join('\n'));

        assert.strictEqual(sides.hunkCount, 1);
        assert.strictEqual(sides.hasHunks, true);
        assert.strictEqual(sides.addedLines, 2);
        assert.strictEqual(sides.removedLines, 1);
        assert.strictEqual(sides.oldPath, 'src/formatDate.ts');
        assert.strictEqual(sides.newPath, 'src/formatDate.ts');
        assert.strictEqual(sides.truncated, false);
        assert.ok(hasRenderableSides(sides));
    });

    test('additions-only patch (Copilot summarized) leaves the before side empty', () => {
        const sides = reconstructDiffSides([
            '--- a/src/p.ts',
            '+++ b/src/p.ts',
            '@@ modified by assistant @@',
            '+const x = 1;',
            '+const y = 2;',
        ].join('\n'));

        assert.strictEqual(sides.before, '');
        assert.strictEqual(sides.after, 'const x = 1;\nconst y = 2;');
        assert.strictEqual(sides.addedLines, 2);
        assert.strictEqual(sides.hunkCount, 1);
        assert.ok(hasRenderableSides(sides));
    });

    test('multiple hunks are concatenated on both sides', () => {
        const sides = reconstructDiffSides([
            '@@ -1,1 +1,1 @@',
            '-one',
            '+ONE',
            '@@ -10,1 +10,1 @@',
            '-ten',
            '+TEN',
        ].join('\n'));

        assert.strictEqual(sides.hunkCount, 2);
        assert.strictEqual(sides.before, 'one\nten');
        assert.strictEqual(sides.after, 'ONE\nTEN');
    });

    test('patches without a hunk header are parsed as one implicit hunk', () => {
        const sides = reconstructDiffSides('-old\n+new');
        assert.strictEqual(sides.hasHunks, false);
        assert.strictEqual(sides.before, 'old');
        assert.strictEqual(sides.after, 'new');
        assert.ok(hasRenderableSides(sides));
    });

    test('CRLF is normalized and "no newline" markers are ignored', () => {
        const sides = reconstructDiffSides('@@ -1 +1 @@\r\n-a\r\n+b\r\n\\ No newline at end of file\r\n');
        assert.strictEqual(sides.before, 'a');
        assert.strictEqual(sides.after, 'b');
    });

    test('removed lines that look like file headers stay inside the hunk', () => {
        // A removed SQL comment (`-- old`) serializes as `--- old`, an added one
        // as `+++ new` — neither may be mistaken for a header.
        const sides = reconstructDiffSides([
            '--- a/db/schema.sql',
            '+++ b/db/schema.sql',
            '@@ -1,2 +1,2 @@',
            '--- old comment',
            '+++ new comment',
            ' select 1;',
        ].join('\n'));

        assert.strictEqual(sides.oldPath, 'db/schema.sql');
        assert.strictEqual(sides.newPath, 'db/schema.sql');
        assert.strictEqual(sides.before, '-- old comment\nselect 1;');
        assert.strictEqual(sides.after, '++ new comment\nselect 1;');
    });

    test('empty / header-only patches are not renderable', () => {
        assert.ok(!hasRenderableSides(reconstructDiffSides('')));
        const headerOnly = reconstructDiffSides('--- a/x\n+++ b/x\n');
        assert.ok(!hasRenderableSides(headerOnly));
        assert.strictEqual(headerOnly.oldPath, 'x');
        assert.strictEqual(headerOnly.newPath, 'x');
    });

    test('a side never exceeds MAX_PATCH_SIDE_LINES', () => {
        const lines = ['@@ -0,0 +1 @@'];
        for (let i = 0; i < MAX_PATCH_SIDE_LINES + 5; i++) { lines.push(`+line ${i}`); }
        const sides = reconstructDiffSides(lines.join('\n'));

        assert.strictEqual(sides.truncated, true);
        assert.strictEqual(sides.after.split('\n').length, MAX_PATCH_SIDE_LINES);
    });
});

suite('diffViewer — titles and URIs', () => {
    test('buildVisualDiffTitle carries the file name, tool and stats', () => {
        const title = buildVisualDiffTitle(makeDiff({ addedLines: 3, removedLines: 2 }));
        assert.strictEqual(title, 'formatDate.ts — cline diff (+3 −2)');

        const noStats = buildVisualDiffTitle(makeDiff());
        assert.strictEqual(noStats, 'formatDate.ts — cline diff');
    });

    test('diffSideUris builds two distinct read-only URIs that keep the extension', () => {
        const event = makeDiff();
        const sides = reconstructDiffSides(GIT_DIFF);
        const { left, right } = diffSideUris(event, sides);

        assert.strictEqual(left.scheme, DIFF_SCHEME);
        assert.strictEqual(right.scheme, DIFF_SCHEME);
        assert.notStrictEqual(left.toString(), right.toString());
        assert.match(left.path, /formatDate\.ts$/, 'path keeps the real file name + extension');
        assert.match(right.path, /formatDate\.ts$/);
        assert.match(left.query, /side=before/);
        assert.match(right.query, /side=after/);
    });

    test('diffSideUris prefers the patch header path over the event path', () => {
        const event = makeDiff({ filePath: '/repo/src/other.ts' });
        const sides = reconstructDiffSides(GIT_DIFF);
        const { left } = diffSideUris(event, sides);
        assert.match(left.path, /formatDate\.ts$/);
    });
});

suite('diffViewer — DiffSideContentProvider', () => {
    test('serves registered content per URI and reports its size', () => {
        const provider = new DiffSideContentProvider();
        const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: '/a.ts', query: 'id=x&side=before' });

        assert.strictEqual(provider.provideTextDocumentContent(uri), '');
        provider.set(uri, 'before content');
        assert.strictEqual(provider.provideTextDocumentContent(uri), 'before content');
        assert.strictEqual(provider.size, 1);

        provider.dispose();
        assert.strictEqual(provider.size, 0);
    });

    test('drops the oldest document once the cache is full', () => {
        const provider = new DiffSideContentProvider();
        const make = (i: number): vscode.Uri => vscode.Uri.from({
            scheme: DIFF_SCHEME, path: `/${i}.ts`, query: `id=${i}`,
        });

        for (let i = 0; i < MAX_CACHED_DIFF_DOCUMENTS; i++) { provider.set(make(i), `content ${i}`); }
        assert.strictEqual(provider.size, MAX_CACHED_DIFF_DOCUMENTS);

        provider.set(make(MAX_CACHED_DIFF_DOCUMENTS), 'newest');
        assert.strictEqual(provider.size, MAX_CACHED_DIFF_DOCUMENTS);
        assert.strictEqual(provider.provideTextDocumentContent(make(0)), '', 'oldest entry evicted');
        assert.strictEqual(provider.provideTextDocumentContent(make(MAX_CACHED_DIFF_DOCUMENTS)), 'newest');

        provider.dispose();
    });
});


suite('diffViewer — extension-host smoke test', () => {
    test('the registered provider serves both sides as read-only documents', async () => {
        const bag: { dispose(): void }[] = [];
        registerDiffViewer({ subscriptions: bag });

        const event = makeDiff({ id: 'smoke-1', diffText: GIT_DIFF });
        const sides = reconstructDiffSides((event as { diffText: string }).diffText);
        const { left, right } = diffSideUris(event, sides);
        const provider = getDiffSideContentProvider();
        provider.set(left, sides.before);
        provider.set(right, sides.after);

        const [leftDoc, rightDoc] = await Promise.all([
            vscode.workspace.openTextDocument(left),
            vscode.workspace.openTextDocument(right),
        ]);

        assert.strictEqual(leftDoc.getText(), sides.before);
        assert.strictEqual(rightDoc.getText(), sides.after);
        assert.ok(!leftDoc.isDirty);
    });

    test('openVisualDiff opens a native diff editor tab for both sides', async () => {
        const bag: { dispose(): void }[] = [];
        registerDiffViewer({ subscriptions: bag });

        const event = makeDiff({ id: 'smoke-2', diffText: GIT_DIFF });
        const opened = await openVisualDiff(event);
        assert.strictEqual(opened, true);

        const diffTabs = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .filter((tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } =>
                tab.input instanceof vscode.TabInputTextDiff);
        const ours = diffTabs.find((tab) => tab.input.original.scheme === DIFF_SCHEME
            && tab.input.modified.scheme === DIFF_SCHEME);
        assert.ok(ours, 'a chatwizard-diff diff editor tab is open');
        assert.match(String(ours.input.original.query), /side=before/);
        assert.match(String(ours.input.modified.query), /side=after/);
    });

    test('openVisualDiff refuses non-diff events and empty patches', async () => {
        const bag: { dispose(): void }[] = [];
        registerDiffViewer({ subscriptions: bag });

        const command = {
            type: 'command', id: 'c1', timestamp: '2026-01-01T10:00:00.000Z',
            tool: 'cline', commandText: 'npm test',
        } as unknown as LogEvent;
        assert.strictEqual(await openVisualDiff(command), false);

        const empty = makeDiff({ id: 'smoke-empty', diffText: '' });
        assert.strictEqual(await openVisualDiff(empty), false);
    });
});


