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
});
