// test/e2e/integration/sessionFolderTree.test.ts
//
// Integration tests — Folder-based tree organisation.
//
// Exercises SessionTreeProvider.getChildren() in 'folder' group mode,
// FolderStore CRUD integration, folder stats, and drag-and-drop flows.
// The provider is constructed with a real SessionIndex + FolderStore so
// tests verify the full folder → subfolder → session pipeline.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionIndex } from '../../../src/index/sessionIndex';
import { FolderStore } from '../../../src/index/folderStore';
import {
    SessionTreeProvider,
    SessionTreeItem,
    FolderGroupTreeItem,
    LoadMoreTreeItem,
} from '../../../src/views/sessionTreeProvider';
import { SidecarMetadataStore } from '../../../src/index/sidecarMetadataStore';
import { Session } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temporary directory that is cleaned up after the suite. */
function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-folder-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/** Build a minimal Session for tree-view tests. */
function makeSession(overrides: Partial<Session> & { id: string }): Session {
    const { id, ...rest } = overrides;
    return {
        id,
        title: rest.title ?? `Session ${id}`,
        source: rest.source ?? 'copilot',
        workspaceId: rest.workspaceId ?? 'ws-default',
        workspacePath: rest.workspacePath ?? '/project',
        messages: rest.messages ?? [
            { id: `${id}-u`, role: 'user', content: 'Hello', timestamp: '2026-01-01T00:00:00.000Z', codeBlocks: [] },
            { id: `${id}-a`, role: 'assistant', content: 'Hi', timestamp: '2026-01-01T00:00:01.000Z', codeBlocks: [] },
        ],
        filePath: rest.filePath ?? `/project/${id}.jsonl`,
        createdAt: rest.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: rest.updatedAt ?? '2026-01-01T00:00:00.000Z',
        model: rest.model,
    };
}

/**
 * Flatten all session items from the tree, descending into both
 * FolderGroupTreeItem and DateGroupTreeItem groups.
 */
async function collectSessionItems(
    provider: SessionTreeProvider,
    element?: Parameters<SessionTreeProvider['getChildren']>[0]
): Promise<SessionTreeItem[]> {
    const rootChildren = await provider.getChildren(element);
    const items: SessionTreeItem[] = [];
    for (const child of rootChildren) {
        if (child instanceof SessionTreeItem) {
            items.push(child);
        } else if (child instanceof FolderGroupTreeItem) {
            const nested = await provider.getChildren(child);
            for (const n of nested) {
                if (n instanceof SessionTreeItem) {
                    items.push(n);
                } else if (n instanceof FolderGroupTreeItem) {
                    // Recurse into subfolders
                    const deeper = await provider.getChildren(n);
                    for (const d of deeper) {
                        if (d instanceof SessionTreeItem) { items.push(d); }
                    }
                }
            }
        }
    }
    return items;
}

/** Collect all FolderGroupTreeItems at the root level. */
async function collectFolderItems(
    provider: SessionTreeProvider,
): Promise<FolderGroupTreeItem[]> {
    const rootChildren = await provider.getChildren(undefined);
    return rootChildren.filter((c): c is FolderGroupTreeItem => c instanceof FolderGroupTreeItem);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('SessionTreeProvider — folder group mode', function () {
    this.timeout(20_000);

    let index: SessionIndex;
    let folderStore: FolderStore;
    let provider: SessionTreeProvider;
    let dir: string;

    setup(async () => {
        dir = tmpDir();
        index = new SessionIndex();
        folderStore = new FolderStore(dir);
        await folderStore.load();
        provider = new SessionTreeProvider(index);
        provider.setFolderStore(folderStore);
        provider.setGroupMode('folder');
    });

    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------
    // Root-level folder display
    // ------------------------------------------------------------------

    test('root shows FolderGroupTreeItems when mode is folder', async () => {
        await folderStore.createFolder('Work');
        await folderStore.createFolder('Personal');

        // Add a session that is NOT in a folder → "(uncategorized)" group
        index.upsert(makeSession({ id: 's1' }));

        const folders = await collectFolderItems(provider);
        assert.ok(folders.length >= 2, `Expected at least 2 folder items, got ${folders.length}`);

        const names = folders.map(f => f.folder.name);
        assert.ok(names.includes('Work'));
        assert.ok(names.includes('Personal'));
    });

    test('folder items show session count in description', async () => {
        const f = await folderStore.createFolder('Work');
        await folderStore.moveSessionToFolder('s1', f.id);
        index.upsert(makeSession({ id: 's1' }));

        const folders = await collectFolderItems(provider);
        const work = folders.find(ff => ff.folder.name === 'Work');
        assert.ok(work, 'Work folder should be present');
        assert.ok(typeof work!.description === 'string' && (work!.description as string).includes('1 session'),
            `Expected '1 session' in description, got '${work!.description}'`);
    });

    // ------------------------------------------------------------------
    // Sessions inside folders
    // ------------------------------------------------------------------

    test('sessions inside a folder appear as children', async () => {
        const f = await folderStore.createFolder('Work');
        await folderStore.moveSessionToFolder('s1', f.id);
        await folderStore.moveSessionToFolder('s2', f.id);
        index.upsert(makeSession({ id: 's1' }));
        index.upsert(makeSession({ id: 's2' }));

        const allSessions = await collectSessionItems(provider);
        assert.strictEqual(allSessions.length, 2);
    });

    test('uncategorized sessions appear under (uncategorized) group', async () => {
        index.upsert(makeSession({ id: 'uncat1' }));
        index.upsert(makeSession({ id: 'uncat2' }));

        const folders = await collectFolderItems(provider);
        const uncategorized = folders.find(f => f.folder.name === '(uncategorized)');
        assert.ok(uncategorized, '(uncategorized) folder should be present');
    });

    test('moving sessions between folders updates the tree', async () => {
        const f1 = await folderStore.createFolder('A');
        const f2 = await folderStore.createFolder('B');
        await folderStore.moveSessionToFolder('s1', f1.id);
        index.upsert(makeSession({ id: 's1' }));

        // Move from A → B
        await folderStore.moveSessionToFolder('s1', f2.id);

        // Find sessions in folder A
        const rootChildren = await provider.getChildren(undefined);
        const folderA = rootChildren.find(
            c => c instanceof FolderGroupTreeItem && (c as FolderGroupTreeItem).folder.id === f1.id
        ) as FolderGroupTreeItem;
        assert.ok(folderA, 'Folder A should be present');

        const aChildren = await provider.getChildren(folderA);
        const aSessions = aChildren.filter(c => c instanceof SessionTreeItem);
        assert.strictEqual(aSessions.length, 0, 'Folder A should have no sessions after move');
    });

    // ------------------------------------------------------------------
    // Subfolder expansion
    // ------------------------------------------------------------------

    test('subfolders appear as children of parent folder', async () => {
        const parent = await folderStore.createFolder('Projects');
        const child = await folderStore.createFolder('ChatWizard', parent.id);
        await folderStore.moveSessionToFolder('s1', child.id);
        index.upsert(makeSession({ id: 's1' }));

        // Get root folders
        const rootFolders = await collectFolderItems(provider);
        const projects = rootFolders.find(f => f.folder.id === parent.id);
        assert.ok(projects, 'Parent folder should be present');

        // Expand parent: children should include FolderGroupTreeItem for the subfolder
        const parentChildren = await provider.getChildren(projects!);
        const subfolderItem = parentChildren.find(c => c instanceof FolderGroupTreeItem) as FolderGroupTreeItem;
        assert.ok(subfolderItem, 'Subfolder should appear as a child of parent');
        assert.strictEqual(subfolderItem.folder.id, child.id);

        // Expand subfolder: children should include the session
        const subChildren = await provider.getChildren(subfolderItem);
        const sessionItem = subChildren.find(c => c instanceof SessionTreeItem) as SessionTreeItem;
        assert.ok(sessionItem, 'Session should appear inside subfolder');
        assert.strictEqual(sessionItem.summary.id, 's1');
    });

    // ------------------------------------------------------------------
    // Folder stats (tooltip)
    // ------------------------------------------------------------------

    test('folder tooltip shows total chats, size, sources, models', async () => {
        const f = await folderStore.createFolder('Analytics');
        await folderStore.moveSessionToFolder('s1', f.id);
        await folderStore.moveSessionToFolder('s2', f.id);
        index.upsert(makeSession({ id: 's1', source: 'copilot', model: 'gpt-4' }));
        index.upsert(makeSession({ id: 's2', source: 'cursor', model: 'claude-3' }));

        const folders = await collectFolderItems(provider);
        const analytics = folders.find(ff => ff.folder.id === f.id);
        assert.ok(analytics, 'Analytics folder should be present');

        const stats = analytics!.stats;
        assert.strictEqual(stats.totalChats, 2);
        assert.ok(stats.totalSizeFormatted.length > 0);
        assert.ok(stats.sources.includes('copilot'));
        assert.ok(stats.sources.includes('cursor'));
    });

    test('folder tooltip includes subfolder sessions in totals', async () => {
        const root = await folderStore.createFolder('Root');
        const sub = await folderStore.createFolder('Sub', root.id);
        await folderStore.moveSessionToFolder('s1', root.id);
        await folderStore.moveSessionToFolder('s2', sub.id);
        index.upsert(makeSession({ id: 's1', source: 'copilot', model: 'gpt-4' }));
        index.upsert(makeSession({ id: 's2', source: 'cursor', model: 'claude-3' }));

        const folders = await collectFolderItems(provider);
        const rootFolder = folders.find(ff => ff.folder.id === root.id);
        assert.ok(rootFolder, 'Root folder should be present');
        assert.strictEqual(rootFolder!.stats.totalChats, 2, 'Root folder stats should include subfolder session');
    });

    // ------------------------------------------------------------------
    // LoadMore inside folders
    // ------------------------------------------------------------------

    test('folders support pagination via LoadMoreTreeItem', async () => {
        const f = await folderStore.createFolder('Large');
        for (let i = 0; i < 55; i++) {
            const sid = `s${i}`;
            await folderStore.moveSessionToFolder(sid, f.id);
            index.upsert(makeSession({ id: sid, title: `Session ${i}` }));
        }

        const folders = await collectFolderItems(provider);
        const largeFolder = folders.find(ff => ff.folder.id === f.id);
        assert.ok(largeFolder, 'Large folder should be present');

        const children = await provider.getChildren(largeFolder!);
        const loadMore = children.find(c => c instanceof LoadMoreTreeItem);
        assert.ok(loadMore, 'LoadMore item should appear when there are many sessions');
    });

    // ------------------------------------------------------------------
    // Switching modes
    // ------------------------------------------------------------------

    test('switching away from folder mode hides folder groups', async () => {
        const f = await folderStore.createFolder('Work');
        await folderStore.moveSessionToFolder('s1', f.id);
        index.upsert(makeSession({ id: 's1' }));

        provider.setGroupMode('none');
        const rootChildren = await provider.getChildren(undefined);
        const folderItems = rootChildren.filter(c => c instanceof FolderGroupTreeItem);
        assert.strictEqual(folderItems.length, 0, 'No folder items should appear in flat mode');
    });

    test('switching back to folder mode restores folder groups', async () => {
        const f = await folderStore.createFolder('Work');
        await folderStore.moveSessionToFolder('s1', f.id);
        index.upsert(makeSession({ id: 's1' }));

        provider.setGroupMode('none');
        provider.setGroupMode('folder');
        const folders = await collectFolderItems(provider);
        assert.ok(folders.length > 0, 'Folder items should reappear');
    });

    // ------------------------------------------------------------------
    // getParent
    // ------------------------------------------------------------------

    test('getParent returns the folder for a session inside a folder', async () => {
        const f = await folderStore.createFolder('Work');
        await folderStore.moveSessionToFolder('s1', f.id);
        index.upsert(makeSession({ id: 's1' }));

        const allSessions = await collectSessionItems(provider);
        const sessionItem = allSessions.find(s => s.summary.id === 's1');
        assert.ok(sessionItem, 'Session s1 should be in the tree');

        const parent = provider.getParent(sessionItem!);
        assert.ok(parent instanceof FolderGroupTreeItem, 'Parent should be a FolderGroupTreeItem');
        assert.strictEqual((parent as FolderGroupTreeItem).folder.id, f.id);
    });

    test('getParent returns the parent folder for a subfolder', async () => {
        const parent = await folderStore.createFolder('Parent');
        const child = await folderStore.createFolder('Child', parent.id);

        const rootChildren = await provider.getChildren(undefined);
        const parentFolder = rootChildren.find(
            c => c instanceof FolderGroupTreeItem && (c as FolderGroupTreeItem).folder.id === parent.id
        ) as FolderGroupTreeItem;
        assert.ok(parentFolder, 'Parent folder should be present');

        const parentChildren = await provider.getChildren(parentFolder);
        const childFolder = parentChildren.find(c => c instanceof FolderGroupTreeItem) as FolderGroupTreeItem;
        assert.ok(childFolder, 'Child folder should be present');
        assert.strictEqual(childFolder.folder.id, child.id);

        // getParent for the subfolder should return the parent folder
        const grandParent = provider.getParent(childFolder);
        assert.ok(grandParent instanceof FolderGroupTreeItem);
        assert.strictEqual((grandParent as FolderGroupTreeItem).folder.id, parent.id);
    });

    // ------------------------------------------------------------------
    // Drag-and-drop support (folder re-parenting via store)
    // ------------------------------------------------------------------

    test('moveFolder re-parents folder through store', async () => {
        const a = await folderStore.createFolder('A');
        const b = await folderStore.createFolder('B');

        await folderStore.moveFolder(b.id, a.id);

        const loadedB = await folderStore.get(b.id);
        assert.strictEqual(loadedB!.parentId, a.id);

        const loadedA = await folderStore.get(a.id);
        assert.ok(loadedA!.childFolderIds.includes(b.id));
    });

    test('moveFolder to root', async () => {
        const parent = await folderStore.createFolder('Parent');
        const child = await folderStore.createFolder('Child', parent.id);

        await folderStore.moveFolder(child.id, undefined);

        const loadedChild = await folderStore.get(child.id);
        assert.strictEqual(loadedChild!.parentId, null);
    });

    test('moving session to folder via store updates tree correctly', async () => {
        const f = await folderStore.createFolder('Folder');
        index.upsert(makeSession({ id: 's1' }));
        index.upsert(makeSession({ id: 's2' }));

        await folderStore.moveSessionToFolder('s1', f.id);
        await folderStore.moveSessionToFolder('s2', f.id);

        // Verify they're inside the folder
        const rootChildren = await provider.getChildren(undefined);
        const folderItem = rootChildren.find(
            c => c instanceof FolderGroupTreeItem && (c as FolderGroupTreeItem).folder.id === f.id
        ) as FolderGroupTreeItem;
        assert.ok(folderItem);

        const folderChildren = await provider.getChildren(folderItem);
        const folderSessions = folderChildren.filter(c => c instanceof SessionTreeItem);
        assert.strictEqual(folderSessions.length, 2);
    });
});
