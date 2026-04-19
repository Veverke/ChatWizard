// test/suite/windsurfWorkspaceDiscovery.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getWindsurfStorageRoot, discoverWindsurfWorkspacesAsync } from '../../src/readers/windsurfWorkspace';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

function createMinimalVscdb(dbPath: string): void {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.close();
}

function createWorkspaceJson(dir: string, folderPath: string): void {
    const encoded = encodeURIComponent(folderPath).replace(/%2F/g, '/');
    const folder = `file://${process.platform === 'win32' ? '/' : ''}${encoded}`;
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ folder }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Windsurf Workspace Discovery', () => {
    let tmpDir: string;
    // A temp directory that actually exists on disk (used as "workspace root").
    let realWorkspacePath: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-windsurf-disc-'));
        // Create a real directory to satisfy the `access(workspacePath)` guard.
        realWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-windsurf-ws-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(realWorkspacePath, { recursive: true, force: true });
    });

    // ── getWindsurfStorageRoot ────────────────────────────────────────────────

    test('getWindsurfStorageRoot returns a non-empty string on current OS', () => {
        const root = getWindsurfStorageRoot();
        assert.ok(typeof root === 'string' && root.length > 0);
        assert.ok(root.includes('Windsurf'));
    });

    // ── discoverWindsurfWorkspacesAsync ───────────────────────────────────────

    test('empty directory returns empty array', async () => {
        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.deepStrictEqual(results, []);
    });

    test('non-existent root returns empty array', async () => {
        const results = await discoverWindsurfWorkspacesAsync(
            path.join(tmpDir, 'does-not-exist')
        );
        assert.deepStrictEqual(results, []);
    });

    test('valid workspace dir with workspace.json + state.vscdb is returned', async () => {
        const wsDir = path.join(tmpDir, 'abc123hash');
        fs.mkdirSync(wsDir);
        createMinimalVscdb(path.join(wsDir, 'state.vscdb'));
        createWorkspaceJson(wsDir, realWorkspacePath);

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, 'abc123hash');
        assert.strictEqual(results[0].source, 'windsurf');
        assert.strictEqual(results[0].storageDir, wsDir);
    });

    test('directory missing state.vscdb is excluded', async () => {
        const wsDir = path.join(tmpDir, 'no-db-hash');
        fs.mkdirSync(wsDir);
        createWorkspaceJson(wsDir, realWorkspacePath);
        // No state.vscdb created.

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.strictEqual(results.length, 0);
    });

    test('directory missing workspace.json is excluded', async () => {
        const wsDir = path.join(tmpDir, 'no-ws-json-hash');
        fs.mkdirSync(wsDir);
        createMinimalVscdb(path.join(wsDir, 'state.vscdb'));
        // No workspace.json created.

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.strictEqual(results.length, 0);
    });

    test('workspace whose path does not exist on disk is excluded', async () => {
        const wsDir = path.join(tmpDir, 'deleted-ws-hash');
        fs.mkdirSync(wsDir);
        createMinimalVscdb(path.join(wsDir, 'state.vscdb'));
        createWorkspaceJson(wsDir, '/path/that/does/not/exist/12345');

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.strictEqual(results.length, 0);
    });

    test('file (not directory) entries at root level are excluded', async () => {
        fs.writeFileSync(path.join(tmpDir, 'somefile.txt'), 'data');

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.strictEqual(results.length, 0);
    });

    test('multiple valid workspaces all returned', async () => {
        for (const hash of ['hash-a', 'hash-b', 'hash-c']) {
            const wsDir = path.join(tmpDir, hash);
            fs.mkdirSync(wsDir);
            createMinimalVscdb(path.join(wsDir, 'state.vscdb'));
            createWorkspaceJson(wsDir, realWorkspacePath);
        }

        const results = await discoverWindsurfWorkspacesAsync(tmpDir);
        assert.strictEqual(results.length, 3);
        const ids = results.map(r => r.id).sort();
        assert.deepStrictEqual(ids, ['hash-a', 'hash-b', 'hash-c']);
    });
});
