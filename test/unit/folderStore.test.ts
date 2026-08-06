/**
 * test/unit/folderStore.test.ts
 *
 * Unit tests for the FolderStore persistence layer (Feature: Folder Organisation).
 * Each test uses an isolated temporary directory to prevent state leakage.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FolderStore } from '../../src/index/folderStore';
import { SessionFolder, SessionSummary, FolderStats } from '../../src/types/index';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Creates a temporary directory for test isolation. */
function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-folderstore-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/** Makes a minimal SessionSummary for stats tests. */
function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        id: overrides.id,
        source: overrides.source ?? 'copilot',
        title: overrides.title ?? `Session ${overrides.id}`,
        workspaceId: overrides.workspaceId ?? 'ws',
        workspacePath: overrides.workspacePath ?? '/ws',
        filePath: overrides.filePath ?? `/ws/${overrides.id}.jsonl`,
        createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        model: overrides.model,
        messageCount: overrides.messageCount ?? 2,
        userMessageCount: overrides.userMessageCount ?? 1,
        assistantMessageCount: overrides.assistantMessageCount ?? 1,
        fileSizeBytes: overrides.fileSizeBytes,
    };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

suite('FolderStore', () => {
    let store: FolderStore;
    let dir: string;

    setup(() => {
        dir = tmpDir();
        store = new FolderStore(dir);
    });

    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------
    // load / save basics
    // ------------------------------------------------------------------

    test('load returns empty map when file does not exist', async () => {
        const map = await store.load();
        assert.ok(map instanceof Map);
        assert.strictEqual(map.size, 0);
    });

    test('load returns empty map on corrupt JSON', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'chatwizard-folders.json'), 'not-json', 'utf-8');
        const map = await store.load();
        assert.strictEqual(map.size, 0);
    });

    test('save and load round-trip preserves folder data', async () => {
        const f1: SessionFolder = {
            id: 'f1', name: 'Work', parentId: null,
            sessionIds: ['s1', 's2'], childFolderIds: [],
            createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        };
        const map = new Map<string, SessionFolder>([['f1', f1]]);
        await store.save(map);

        // New store instance reads the file
        const store2 = new FolderStore(dir);
        const loaded = await store2.load();
        assert.strictEqual(loaded.size, 1);
        const loadedF1 = loaded.get('f1')!;
        assert.strictEqual(loadedF1.name, 'Work');
        assert.deepStrictEqual(loadedF1.sessionIds, ['s1', 's2']);
    });

    test('save writes atomically (temp file + rename)', async () => {
        const folderFile = path.join(dir, 'chatwizard-folders.json');
        const tmpFile = folderFile + '.tmp';

        const f1: SessionFolder = {
            id: 'f1', name: 'Atomic', parentId: null,
            sessionIds: [], childFolderIds: [],
            createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        };
        await store.save(new Map([['f1', f1]]));

        // The .tmp file should NOT exist after successful save
        assert.ok(fs.existsSync(folderFile), 'Folder file should exist');
        assert.ok(!fs.existsSync(tmpFile), 'Temp file should have been removed after save');
    });

    // ------------------------------------------------------------------
    // getAll / get / getRootFolders / getChildFolders
    // ------------------------------------------------------------------

    test('getAll returns cached data after load', async () => {
        const f1: SessionFolder = { id: 'f1', name: 'Root', parentId: null, sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        await store.save(new Map([['f1', f1]]));

        const all = await store.getAll();
        assert.strictEqual(all.size, 1);
    });

    test('get returns undefined for missing folder', async () => {
        const result = await store.get('nonexistent');
        assert.strictEqual(result, undefined);
    });

    test('get returns folder by ID', async () => {
        const f1: SessionFolder = { id: 'f1', name: 'Root', parentId: null, sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        await store.save(new Map([['f1', f1]]));
        const result = await store.get('f1');
        assert.ok(result);
        assert.strictEqual(result!.name, 'Root');
    });

    test('getRootFolders returns only root-level folders sorted by name', async () => {
        const f1: SessionFolder = { id: 'f1', name: 'B文件夹', parentId: null, sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        const f2: SessionFolder = { id: 'f2', name: 'A文件夹', parentId: null, sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        const sub: SessionFolder = { id: 'sub', name: 'Sub', parentId: 'f1', sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        const map = new Map<string, SessionFolder>([['f1', f1], ['f2', f2], ['sub', sub]]);
        await store.save(map);

        const roots = await store.getRootFolders();
        assert.strictEqual(roots.length, 2);
        assert.strictEqual(roots[0].id, 'f2'); // A before B
        assert.strictEqual(roots[1].id, 'f1');
    });

    test('getChildFolders returns children sorted by name', async () => {
        const parent: SessionFolder = { id: 'p1', name: 'Parent', parentId: null, sessionIds: [], childFolderIds: ['c2', 'c1'], createdAt: '', updatedAt: '' };
        const c1: SessionFolder = { id: 'c1', name: 'Beta', parentId: 'p1', sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        const c2: SessionFolder = { id: 'c2', name: 'Alpha', parentId: 'p1', sessionIds: [], childFolderIds: [], createdAt: '', updatedAt: '' };
        await store.save(new Map([['p1', parent], ['c1', c1], ['c2', c2]]));

        const children = await store.getChildFolders('p1');
        assert.strictEqual(children.length, 2);
        assert.strictEqual(children[0].id, 'c2'); // Alpha before Beta
        assert.strictEqual(children[1].id, 'c1');
    });

    test('getChildFolders returns empty for missing parent', async () => {
        const children = await store.getChildFolders('nonexistent');
        assert.deepStrictEqual(children, []);
    });

    // ------------------------------------------------------------------
    // getSessionFolderId
    // ------------------------------------------------------------------

    test('getSessionFolderId returns folder containing the session', async () => {
        const f1: SessionFolder = { id: 'f1', name: 'Work', parentId: null, sessionIds: ['s1', 's2'], childFolderIds: [], createdAt: '', updatedAt: '' };
        await store.save(new Map([['f1', f1]]));
        assert.strictEqual(await store.getSessionFolderId('s1'), 'f1');
        assert.strictEqual(await store.getSessionFolderId('s3'), undefined);
    });

    // ------------------------------------------------------------------
    // createFolder
    // ------------------------------------------------------------------

    test('createFolder creates a root folder', async () => {
        const folder = await store.createFolder('My Folder');
        assert.ok(folder.id.startsWith('f_'));
        assert.strictEqual(folder.name, 'My Folder');
        assert.strictEqual(folder.parentId, null);
        assert.deepStrictEqual(folder.sessionIds, []);
        assert.deepStrictEqual(folder.childFolderIds, []);
        assert.ok(folder.createdAt);
        assert.ok(folder.updatedAt);
    });

    test('createFolder creates a subfolder and links to parent', async () => {
        const parent = await store.createFolder('Parent');
        const child = await store.createFolder('Child', parent.id);
        assert.strictEqual(child.parentId, parent.id);

        const loadedParent = await store.get(parent.id);
        assert.ok(loadedParent);
        assert.deepStrictEqual(loadedParent!.childFolderIds, [child.id]);
    });

    test('createFolder rejects duplicate sibling name (case-insensitive)', async () => {
        await store.createFolder('My Folder');
        await assert.rejects(
            () => store.createFolder('my folder'),
            /already exists/
        );
    });

    test('createFolder allows same name at different levels', async () => {
        const parent = await store.createFolder('Project');
        await store.createFolder('Project', parent.id); // should not throw
    });

    test('createFolder trims whitespace from name', async () => {
        const folder = await store.createFolder('  Spaced  ');
        assert.strictEqual(folder.name, 'Spaced');
    });

    test('createFolder rejects empty name', async () => {
        await assert.rejects(
            () => store.createFolder('   '),
            /must not be empty/
        );
    });

    // ------------------------------------------------------------------
    // renameFolder
    // ------------------------------------------------------------------

    test('renameFolder changes folder name', async () => {
        const folder = await store.createFolder('Old Name');
        const renamed = await store.renameFolder(folder.id, 'New Name');
        assert.strictEqual(renamed.name, 'New Name');
        const loaded = await store.get(folder.id);
        assert.strictEqual(loaded!.name, 'New Name');
    });

    test('renameFolder rejects duplicate sibling name', async () => {
        await store.createFolder('Alpha');
        const beta = await store.createFolder('Beta');
        await assert.rejects(
            () => store.renameFolder(beta.id, 'alpha'),
            /already exists/
        );
    });

    test('renameFolder rejects empty name', async () => {
        const folder = await store.createFolder('Test');
        await assert.rejects(
            () => store.renameFolder(folder.id, '   '),
            /must not be empty/
        );
    });

    test('renameFolder throws for missing folder', async () => {
        await assert.rejects(
            () => store.renameFolder('nonexistent', 'New Name'),
            /not found/
        );
    });

    // ------------------------------------------------------------------
    // deleteFolder
    // ------------------------------------------------------------------

    test('deleteFolder removes a root folder', async () => {
        const folder = await store.createFolder('To Delete');
        await store.deleteFolder(folder.id);
        assert.strictEqual(await store.get(folder.id), undefined);
    });

    test('deleteFolder removes folder from parent childFolderIds', async () => {
        const parent = await store.createFolder('Parent');
        const child = await store.createFolder('Child', parent.id);
        await store.deleteFolder(child.id);

        const loadedParent = await store.get(parent.id);
        assert.ok(loadedParent);
        assert.deepStrictEqual(loadedParent!.childFolderIds, []);
    });

    test('deleteFolder recursively removes subfolders', async () => {
        const root = await store.createFolder('Root');
        const sub1 = await store.createFolder('Sub1', root.id);
        const sub2 = await store.createFolder('Sub2', sub1.id);
        await store.deleteFolder(root.id);

        assert.strictEqual(await store.get(root.id), undefined);
        assert.strictEqual(await store.get(sub1.id), undefined);
        assert.strictEqual(await store.get(sub2.id), undefined);
    });

    test('deleteFolder does not delete sessions (they become uncategorized)', async () => {
        const f1: SessionFolder = { id: 'f1', name: 'Work', parentId: null, sessionIds: ['s1', 's2'], childFolderIds: [], createdAt: '', updatedAt: '' };
        await store.save(new Map([['f1', f1]]));
        await store.deleteFolder('f1');
        // Sessions are not tracked in FolderStore itself — they just become unassigned
        assert.strictEqual(await store.getSessionFolderId('s1'), undefined);
    });

    // ------------------------------------------------------------------
    // moveSessionToFolder
    // ------------------------------------------------------------------

    test('moveSessionToFolder assigns session to folder', async () => {
        const folder = await store.createFolder('Work');
        await store.moveSessionToFolder('s1', folder.id);
        assert.strictEqual(await store.getSessionFolderId('s1'), folder.id);
    });

    test('moveSessionToFolder moves session between folders', async () => {
        const f1 = await store.createFolder('Folder A');
        const f2 = await store.createFolder('Folder B');
        await store.moveSessionToFolder('s1', f1.id);
        await store.moveSessionToFolder('s1', f2.id);
        assert.strictEqual(await store.getSessionFolderId('s1'), f2.id);

        const loadedF1 = await store.get(f1.id);
        assert.deepStrictEqual(loadedF1!.sessionIds, []);
    });

    test('moveSessionToFolder with undefined removes from folder', async () => {
        const folder = await store.createFolder('Work');
        await store.moveSessionToFolder('s1', folder.id);
        await store.moveSessionToFolder('s1', undefined);
        assert.strictEqual(await store.getSessionFolderId('s1'), undefined);
    });

    test('moveSessionToFolder does not duplicate session on re-add', async () => {
        const folder = await store.createFolder('Work');
        await store.moveSessionToFolder('s1', folder.id);
        await store.moveSessionToFolder('s1', folder.id); // re-add
        const loaded = await store.get(folder.id);
        assert.deepStrictEqual(loaded!.sessionIds, ['s1']); // still 1
    });

    // ------------------------------------------------------------------
    // moveFolder (drag-and-drop re-parenting)
    // ------------------------------------------------------------------

    test('moveFolder re-parents a root folder as subfolder', async () => {
        const parent = await store.createFolder('Parent');
        const child = await store.createFolder('Child');

        await store.moveFolder(child.id, parent.id);

        const loadedChild = await store.get(child.id);
        assert.strictEqual(loadedChild!.parentId, parent.id);

        const loadedParent = await store.get(parent.id);
        assert.ok(loadedParent!.childFolderIds.includes(child.id));
    });

    test('moveFolder to root level (undefined parent)', async () => {
        const parent = await store.createFolder('Parent');
        const child = await store.createFolder('Child', parent.id);

        await store.moveFolder(child.id, undefined);

        const loadedChild = await store.get(child.id);
        assert.strictEqual(loadedChild!.parentId, null);

        const loadedParent = await store.get(parent.id);
        assert.ok(!loadedParent!.childFolderIds.includes(child.id));
    });

    test('moveFolder rejects circular reference', async () => {
        const a = await store.createFolder('A');
        const b = await store.createFolder('B', a.id);
        // Try to move A into B (would create cycle)
        await assert.rejects(
            () => store.moveFolder(a.id, b.id),
            /descendant/
        );
    });

    test('moveFolder rejects duplicate sibling name', async () => {
        const parent = await store.createFolder('Parent');
        await store.createFolder('Existing', parent.id);
        const other = await store.createFolder('existing'); // same name at root
        await assert.rejects(
            () => store.moveFolder(other.id, parent.id),
            /already exists/
        );
    });

    test('moveFolder throws for missing source folder', async () => {
        await assert.rejects(
            () => store.moveFolder('nonexistent', undefined),
            /not found/
        );
    });

    // ------------------------------------------------------------------
    // getStats
    // ------------------------------------------------------------------

    test('getStats returns zeros for empty folder', async () => {
        const folder = await store.createFolder('Empty');
        const stats = await store.getStats(folder.id, []);
        assert.strictEqual(stats.totalChats, 0);
        assert.strictEqual(stats.totalSizeBytes, 0);
        assert.strictEqual(stats.totalSizeFormatted, '0 B');
        assert.deepStrictEqual(stats.sources, []);
        assert.deepStrictEqual(stats.models, []);
    });

    test('getStats aggregates sessions in folder', async () => {
        const folder = await store.createFolder('Work');
        await store.moveSessionToFolder('s1', folder.id);
        await store.moveSessionToFolder('s2', folder.id);

        const summaries = [
            makeSummary({ id: 's1', source: 'copilot', model: 'gpt-4', fileSizeBytes: 1000 }),
            makeSummary({ id: 's2', source: 'copilot', model: 'gpt-4', fileSizeBytes: 2000 }),
            makeSummary({ id: 's3', source: 'cursor', model: 'claude-3', fileSizeBytes: 500 }), // not in folder
        ];
        const stats = await store.getStats(folder.id, summaries);
        assert.strictEqual(stats.totalChats, 2);
        assert.strictEqual(stats.totalSizeBytes, 3000);
        assert.deepStrictEqual(stats.sources, ['copilot']);
        assert.deepStrictEqual(stats.models, ['gpt-4']);
    });

    test('getStats aggregates sessions across subfolders', async () => {
        const root = await store.createFolder('Root');
        const sub = await store.createFolder('Sub', root.id);
        await store.moveSessionToFolder('s1', root.id);
        await store.moveSessionToFolder('s2', sub.id);

        const summaries = [
            makeSummary({ id: 's1', source: 'copilot', model: 'gpt-4', fileSizeBytes: 1000 }),
            makeSummary({ id: 's2', source: 'cursor', model: 'claude-3', fileSizeBytes: 2000 }),
        ];
        const stats = await store.getStats(root.id, summaries);
        assert.strictEqual(stats.totalChats, 2);
        assert.strictEqual(stats.totalSizeBytes, 3000);
        assert.deepStrictEqual(stats.sources.sort(), ['copilot', 'cursor']);
        assert.deepStrictEqual(stats.models.sort(), ['claude-3', 'gpt-4']);
    });

    test('getStats handles circular references gracefully', async () => {
        // Manually create a circular folder structure
        const f1: SessionFolder = { id: 'f1', name: 'F1', parentId: 'f2', sessionIds: [], childFolderIds: ['f2'], createdAt: '', updatedAt: '' };
        const f2: SessionFolder = { id: 'f2', name: 'F2', parentId: 'f1', sessionIds: ['s1'], childFolderIds: ['f1'], createdAt: '', updatedAt: '' };
        await store.save(new Map([['f1', f1], ['f2', f2]]));

        const stats = await store.getStats('f1', [
            makeSummary({ id: 's1', source: 'copilot', fileSizeBytes: 500 }),
        ]);
        assert.strictEqual(stats.totalChats, 1); // s1 counted once
    });

    // ------------------------------------------------------------------
    // getCached
    // ------------------------------------------------------------------

    test('getCached returns null before first load', () => {
        assert.strictEqual(store.getCached(), null);
    });

    test('getCached returns map after load', async () => {
        await store.load();
        assert.ok(store.getCached() instanceof Map);
    });

    test('getCached returns map after save', async () => {
        await store.save(new Map());
        assert.ok(store.getCached() instanceof Map);
    });

    // ------------------------------------------------------------------
    // Persistence across store instances
    // ------------------------------------------------------------------

    test('data persists across different FolderStore instances', async () => {
        const f1 = await store.createFolder('Persistent');

        const store2 = new FolderStore(dir);
        const loaded = await store2.getAll();
        assert.strictEqual(loaded.size, 1);
        assert.ok(loaded.has(f1.id));
    });

    // ------------------------------------------------------------------
    // Concurrent safety (smoke tests)
    // ------------------------------------------------------------------

    test('consecutive createFolder calls produce unique IDs', async () => {
        const f1 = await store.createFolder('A');
        const f2 = await store.createFolder('B');
        const f3 = await store.createFolder('C');
        const ids = new Set([f1.id, f2.id, f3.id]);
        assert.strictEqual(ids.size, 3);
    });
});
