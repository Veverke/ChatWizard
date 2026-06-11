// test/e2e/sidecarMetadataStore.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SidecarMetadataStore } from '../../src/index/sidecarMetadataStore';

suite('SidecarMetadataStore', () => {
    let tmpDir: string;
    let store: SidecarMetadataStore;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sidecar-test-'));
        store = new SidecarMetadataStore(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('load returns empty map when file does not exist', async () => {
        const map = await store.load();
        assert.strictEqual(map.size, 0);
    });

    test('set saves a session and get retrieves it', async () => {
        await store.set('sess-1', { sessionId: 'sess-1', customTitle: 'My Title' });
        const meta = await store.get('sess-1');
        assert.ok(meta);
        assert.strictEqual(meta.customTitle, 'My Title');
    });

    test('get returns undefined for unknown sessionId', async () => {
        const meta = await store.get('nonexistent');
        assert.strictEqual(meta, undefined);
    });

    test('load returns previously saved sessions', async () => {
        await store.set('sess-2', { sessionId: 'sess-2', customTitle: 'Another' });
        // Create new store instance to verify persistence
        const store2 = new SidecarMetadataStore(tmpDir);
        const map = await store2.load();
        assert.strictEqual(map.size, 1);
        assert.strictEqual(map.get('sess-2')?.customTitle, 'Another');
    });

    test('patch merges partial fields and sets updatedAt', async () => {
        const updated = await store.patch('sess-3', { customTitle: 'Patched Title' });
        assert.strictEqual(updated.customTitle, 'Patched Title');
        assert.ok(updated.updatedAt);
        // createdAt should be set too (first patch)
        assert.ok(updated.createdAt);
    });

    test('patch preserves existing createdAt on subsequent patches', async () => {
        const first = await store.patch('sess-4', { customTitle: 'First' });
        const firstCreatedAt = first.createdAt;
        await new Promise(r => setTimeout(r, 5)); // tiny delay to ensure different time
        const second = await store.patch('sess-4', { customTitle: 'Second' });
        assert.strictEqual(second.createdAt, firstCreatedAt);
        assert.strictEqual(second.customTitle, 'Second');
    });

    test('delete removes a session', async () => {
        await store.set('sess-5', { sessionId: 'sess-5' });
        await store.delete('sess-5');
        const meta = await store.get('sess-5');
        assert.strictEqual(meta, undefined);
    });

    test('delete is a no-op for nonexistent session', async () => {
        // Should not throw
        await store.delete('not-there');
    });

    test('setTitle updates only the customTitle', async () => {
        await store.set('sess-6', { sessionId: 'sess-6', isPinned: true });
        await store.setTitle('sess-6', 'New Custom Title');
        const meta = await store.get('sess-6');
        assert.strictEqual(meta?.customTitle, 'New Custom Title');
        assert.strictEqual(meta?.isPinned, true);
    });

    test('setPin updates only isPinned', async () => {
        await store.set('sess-7', { sessionId: 'sess-7', customTitle: 'Existing Title' });
        await store.setPin('sess-7', true);
        const meta = await store.get('sess-7');
        assert.strictEqual(meta?.isPinned, true);
        assert.strictEqual(meta?.customTitle, 'Existing Title');
    });

    test('load returns empty map for invalid JSON file', async () => {
        const filePath = path.join(tmpDir, 'chatwizard-metadata.json');
        fs.writeFileSync(filePath, 'NOT_VALID_JSON', 'utf-8');
        const store2 = new SidecarMetadataStore(tmpDir);
        const map = await store2.load();
        assert.strictEqual(map.size, 0);
    });

    test('load returns empty map when file contains non-array JSON', async () => {
        const filePath = path.join(tmpDir, 'chatwizard-metadata.json');
        fs.writeFileSync(filePath, JSON.stringify({ sessionId: 'oops' }), 'utf-8');
        const store2 = new SidecarMetadataStore(tmpDir);
        const map = await store2.load();
        assert.strictEqual(map.size, 0);
    });

    test('save creates storageDir if it does not exist', async () => {
        const nestedDir = path.join(tmpDir, 'nested', 'dir');
        const nestedStore = new SidecarMetadataStore(nestedDir);
        await nestedStore.set('sess-nested', { sessionId: 'sess-nested' });
        assert.ok(fs.existsSync(nestedDir));
    });

    test('addTag adds a lowercase normalised tag', async () => {
        await store.addTag('sess-t1', '  TypeScript  ');
        const meta = await store.get('sess-t1');
        assert.deepStrictEqual(meta?.tags, ['typescript']);
    });

    test('addTag ignores duplicate tags', async () => {
        await store.addTag('sess-t2', 'react');
        await store.addTag('sess-t2', 'React');
        const meta = await store.get('sess-t2');
        assert.deepStrictEqual(meta?.tags, ['react']);
    });

    test('addTag ignores empty/whitespace tags', async () => {
        await store.addTag('sess-t3', '   ');
        const meta = await store.get('sess-t3');
        assert.strictEqual(meta, undefined);
    });

    test('removeTag removes an existing tag', async () => {
        await store.addTag('sess-t4', 'ts');
        await store.addTag('sess-t4', 'react');
        await store.removeTag('sess-t4', 'ts');
        const meta = await store.get('sess-t4');
        assert.deepStrictEqual(meta?.tags, ['react']);
    });

    test('removeTag is a no-op when tag does not exist', async () => {
        await store.addTag('sess-t5', 'ts');
        await store.removeTag('sess-t5', 'nonexistent');
        const meta = await store.get('sess-t5');
        assert.deepStrictEqual(meta?.tags, ['ts']);
    });

    test('getAllTags returns tags sorted by count descending', async () => {
        await store.addTag('s1', 'ts');
        await store.addTag('s2', 'ts');
        await store.addTag('s3', 'react');
        const tags = await store.getAllTags();
        assert.strictEqual(tags[0].tag, 'ts');
        assert.strictEqual(tags[0].count, 2);
        assert.strictEqual(tags[1].tag, 'react');
        assert.strictEqual(tags[1].count, 1);
    });

    test('getAllTags returns empty array when no sessions have tags', async () => {
        const tags = await store.getAllTags();
        assert.deepStrictEqual(tags, []);
    });

    test('setSummary stores summary on the session', async () => {
        await store.setSummary('sess-sum', 'This is a summary.');
        const meta = await store.get('sess-sum');
        assert.strictEqual(meta?.summary, 'This is a summary.');
    });

    // ── Feature 29: Bookmarks ─────────────────────────────────────────────────

    test('addBookmark creates a bookmark with correct messageIndex', async () => {
        const bm = { messageIndex: 5, createdAt: new Date().toISOString() };
        await store.addBookmark('bm-sess', bm);
        const bookmarks = await store.getBookmarks('bm-sess');
        assert.strictEqual(bookmarks.length, 1);
        assert.strictEqual(bookmarks[0].messageIndex, 5);
        assert.ok(bookmarks[0].createdAt);
    });

    test('toggleBookmark off removes the bookmark', async () => {
        const bm = { messageIndex: 3, note: 'Important', createdAt: new Date().toISOString() };
        await store.addBookmark('bm-sess2', bm);
        let bookmarks = await store.getBookmarks('bm-sess2');
        assert.strictEqual(bookmarks.length, 1);

        // Toggle off (removes)
        const added = await store.toggleBookmark('bm-sess2', 3);
        assert.strictEqual(added, false); // false = removed
        bookmarks = await store.getBookmarks('bm-sess2');
        assert.strictEqual(bookmarks.length, 0);
    });

    test('toggleBookmark on adds the bookmark', async () => {
        // Toggle on (adds)
        const added = await store.toggleBookmark('bm-sess3', 7, 'My note');
        assert.strictEqual(added, true);
        const bookmarks = await store.getBookmarks('bm-sess3');
        assert.strictEqual(bookmarks.length, 1);
        assert.strictEqual(bookmarks[0].messageIndex, 7);
        assert.strictEqual(bookmarks[0].note, 'My note');
    });

    test('bookmarks survive serialization round-trip via sidecar JSON', async () => {
        const createdAt = '2026-06-01T10:00:00.000Z';
        await store.addBookmark('bm-roundtrip', { messageIndex: 2, note: 'Test note', createdAt });

        // Read back
        let bookmarks = await store.getBookmarks('bm-roundtrip');
        assert.strictEqual(bookmarks.length, 1);
        assert.strictEqual(bookmarks[0].messageIndex, 2);
        assert.strictEqual(bookmarks[0].note, 'Test note');
        assert.strictEqual(bookmarks[0].createdAt, createdAt);

        // Simulate re-load from disk (new store instance)
        const store2 = new (require('../../src/index/sidecarMetadataStore').SidecarMetadataStore)(tmpDir);
        bookmarks = await store2.getBookmarks('bm-roundtrip');
        assert.strictEqual(bookmarks.length, 1);
        assert.strictEqual(bookmarks[0].messageIndex, 2);
        assert.strictEqual(bookmarks[0].note, 'Test note');
        assert.strictEqual(bookmarks[0].createdAt, createdAt);
    });

    test('removeBookmark removes bookmark for a given messageIndex', async () => {
        await store.addBookmark('bm-sess4', { messageIndex: 1, createdAt: new Date().toISOString() });
        await store.addBookmark('bm-sess4', { messageIndex: 2, createdAt: new Date().toISOString() });
        let bookmarks = await store.getBookmarks('bm-sess4');
        assert.strictEqual(bookmarks.length, 2);

        await store.removeBookmark('bm-sess4', 1);
        bookmarks = await store.getBookmarks('bm-sess4');
        assert.strictEqual(bookmarks.length, 1);
        assert.strictEqual(bookmarks[0].messageIndex, 2);
    });

    test('removeBookmark is a no-op for nonexistent messageIndex', async () => {
        await store.addBookmark('bm-sess5', { messageIndex: 10, createdAt: new Date().toISOString() });
        // Should not throw
        await store.removeBookmark('bm-sess5', 999);
        const bookmarks = await store.getBookmarks('bm-sess5');
        assert.strictEqual(bookmarks.length, 1);
    });

    test('getBookmarks returns empty array for session with no bookmarks', async () => {
        const bookmarks = await store.getBookmarks('nonexistent-bm');
        assert.deepStrictEqual(bookmarks, []);
    });

    test('addBookmark replaces existing bookmark for the same messageIndex', async () => {
        const createdAt1 = '2026-01-01T00:00:00.000Z';
        const createdAt2 = '2026-06-01T00:00:00.000Z';
        await store.addBookmark('bm-sess6', { messageIndex: 0, note: 'Old note', createdAt: createdAt1 });
        await store.addBookmark('bm-sess6', { messageIndex: 0, note: 'New note', createdAt: createdAt2 });
        const bookmarks = await store.getBookmarks('bm-sess6');
        assert.strictEqual(bookmarks.length, 1); // replaced, not duplicated
        assert.strictEqual(bookmarks[0].note, 'New note');
    });
});
