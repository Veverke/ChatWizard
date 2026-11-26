/**
 * test/unit/sessionTreeContextMode.test.ts
 *
 * Tests the Sessions view's new "Group by Context" mode: the auto-classified
 * folder tree is rendered from its own store and never mixes with the user's
 * manual folders.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FolderStore } from '../../src/index/folderStore';
import type { SessionIndex } from '../../src/index/sessionIndex';
import { SessionTreeProvider, FolderGroupTreeItem } from '../../src/views/sessionTreeProvider';
import type { SessionSummary } from '../../src/types/index';

const AUTO_FOLDER_FILE = 'chatwizard-auto-folders.json';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-tree-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeSummary(id: string, title: string, updatedAt = '2024-01-01T00:00:00Z'): SessionSummary {
    return {
        id,
        title,
        source: 'copilot',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${id}.jsonl`,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt,
    };
}

/** Minimal SessionIndex stand-in for tree rendering. */
function makeIndex(summaries: SessionSummary[]): SessionIndex {
    return {
        size: summaries.length,
        getAllSummaries: () => summaries,
        get: () => undefined,
        getSidecarMeta: () => undefined,
        addChangeListener: () => ({ dispose: () => { /* no-op */ } }),
        addTypedChangeListener: () => ({ dispose: () => { /* no-op */ } }),
    } as unknown as SessionIndex;
}

suite('SessionTreeProvider — Group by Context', () => {
    let dir: string;

    setup(() => { dir = tmpDir(); });
    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('renders the auto-classified folder tree', async () => {
        const summaries = [makeSummary('s1', 'Merge conflict help'), makeSummary('s2', 'Cleanup branches')];
        const autoStore = new FolderStore(dir, AUTO_FOLDER_FILE);
        await autoStore.replaceTree([{
            name: 'Git',
            sessionIds: ['s1'],
            children: [{ name: 'Branching', sessionIds: ['s2'] }],
        }]);

        const provider = new SessionTreeProvider(makeIndex(summaries));
        provider.setAutoFolderStore(autoStore);
        provider.setGroupMode('context');

        const roots = provider.getChildren();
        assert.strictEqual(roots.length, 1);

        const root = roots[0] as FolderGroupTreeItem;
        assert.strictEqual(root.label, 'Git');
        assert.strictEqual(root.origin, 'auto');
        assert.ok(root.id?.startsWith('autoFolder:'), `unexpected id: ${root.id}`);

        const children = provider.getChildren(root);
        assert.strictEqual(children.length, 2);
        const childFolder = children[0] as FolderGroupTreeItem;
        assert.strictEqual(childFolder.label, 'Branching');
        assert.strictEqual(childFolder.origin, 'auto');

        const directSession = children[1] as { summary?: SessionSummary };
        assert.strictEqual(directSession.summary?.id, 's1');
    });

    test('shows a placeholder before the first classification', () => {
        const provider = new SessionTreeProvider(makeIndex([makeSummary('s1', 'Anything')]));
        const emptyStore = new FolderStore(dir, AUTO_FOLDER_FILE);
        void emptyStore.load();
        provider.setAutoFolderStore(emptyStore);
        provider.setGroupMode('context');

        const roots = provider.getChildren();
        assert.strictEqual(roots.length, 1);
        assert.strictEqual(provider.hasAutoFolders(), false);
    });

    test('the manual folder mode never shows auto-classified folders', async () => {
        const summaries = [makeSummary('s1', 'One')];
        const autoStore = new FolderStore(dir, AUTO_FOLDER_FILE);
        await autoStore.replaceTree([{ name: 'Git', sessionIds: ['s1'] }]);

        const provider = new SessionTreeProvider(makeIndex(summaries));
        provider.setAutoFolderStore(autoStore);
        provider.setFolderStore(new FolderStore(dir));
        provider.setGroupMode('folder');

        const roots = provider.getChildren();
        assert.ok(!roots.some(r => (r as FolderGroupTreeItem).folder?.name === 'Git'));
    });

    test('the view description names the active grouping mode', async () => {
        const provider = new SessionTreeProvider(makeIndex([makeSummary('s1', 'One')]));
        provider.setAutoFolderStore(new FolderStore(dir, AUTO_FOLDER_FILE));
        provider.setGroupMode('context');
        assert.ok(provider.getDescription().includes('context (auto)'));
        assert.strictEqual(provider.isGrouped(), true);
    });

    test('auto folders resolve their parent for tree reveal', async () => {
        const summaries = [makeSummary('s1', 'One')];
        const autoStore = new FolderStore(dir, AUTO_FOLDER_FILE);
        await autoStore.replaceTree([{
            name: 'Git',
            children: [{ name: 'Branching', sessionIds: ['s1'] }],
        }]);

        const provider = new SessionTreeProvider(makeIndex(summaries));
        provider.setAutoFolderStore(autoStore);
        provider.setGroupMode('context');

        const root = provider.getChildren()[0] as FolderGroupTreeItem;
        const child = provider.getChildren(root)[0] as FolderGroupTreeItem;
        const parent = provider.getParent(child) as FolderGroupTreeItem;

        assert.ok(parent instanceof FolderGroupTreeItem);
        assert.strictEqual(parent.label, 'Git');
        assert.strictEqual(parent.origin, 'auto');
    });

    test('shows an (unclassified) bucket for sessions the classifier did not place', async () => {
        const summaries = [
            makeSummary('s1', 'One'),
            makeSummary('s2', 'Two', '2024-02-02T00:00:00Z'),
        ];
        const autoStore = new FolderStore(dir, AUTO_FOLDER_FILE);
        await autoStore.replaceTree([{ name: 'Git', sessionIds: ['s1'] }]);

        const provider = new SessionTreeProvider(makeIndex(summaries));
        provider.setAutoFolderStore(autoStore);
        provider.setGroupMode('context');

        const roots = provider.getChildren();
        assert.strictEqual(roots.length, 2);

        const bucket = roots[1] as vscode.TreeItem;
        assert.strictEqual(bucket.label, '(unclassified)');
        assert.strictEqual(bucket.contextValue, 'autoFolderUnclassified');

        const children = provider.getChildren(bucket);
        assert.strictEqual(children.length, 1);
        assert.strictEqual((children[0] as { summary?: SessionSummary }).summary?.id, 's2');

        // Tree reveal for an unplaced session resolves to the bucket.
        const parent = provider.getParent(children[0]) as vscode.TreeItem;
        assert.strictEqual(parent.id, 'autoFolder:__unclassified__');
    });
});
