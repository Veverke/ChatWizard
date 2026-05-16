// test/suite/aiderWorkspaceDiscovery.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    discoverAiderHistoryFilesAsync,
    AIDER_HISTORY_FILENAME,
    DEFAULT_AIDER_SEARCH_DEPTH,
    MAX_AIDER_SEARCH_DEPTH,
} from '../../src/readers/aiderWorkspace';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Aider Workspace Discovery', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-disc-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Empty directory ───────────────────────────────────────────────────────

    test('empty directory: returns empty array', async () => {
        const results = await discoverAiderHistoryFilesAsync([tmpDir]);
        assert.strictEqual(results.length, 0);
    });

    // ── History file at root ──────────────────────────────────────────────────

    test('.aider.chat.history.md at root is discovered', async () => {
        const historyFile = path.join(tmpDir, AIDER_HISTORY_FILENAME);
        fs.writeFileSync(historyFile, '# aider chat started at 2025-01-01 10:00:00\n');

        const results = await discoverAiderHistoryFilesAsync([tmpDir]);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].historyFile, historyFile);
        assert.strictEqual(results[0].workspacePath, tmpDir);
    });

    // ── configFile populated when .aider.conf.yml present ────────────────────

    test('configFile is set when .aider.conf.yml exists alongside history file', async () => {
        const historyFile = path.join(tmpDir, AIDER_HISTORY_FILENAME);
        const configFile  = path.join(tmpDir, '.aider.conf.yml');
        fs.writeFileSync(historyFile, '');
        fs.writeFileSync(configFile, 'model: gpt-4o\n');

        const results = await discoverAiderHistoryFilesAsync([tmpDir]);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].configFile, configFile);
    });

    test('configFile is undefined when .aider.conf.yml absent', async () => {
        const historyFile = path.join(tmpDir, AIDER_HISTORY_FILENAME);
        fs.writeFileSync(historyFile, '');

        const results = await discoverAiderHistoryFilesAsync([tmpDir]);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].configFile, undefined);
    });

    // ── Nested at depth 2 (within default depth) ─────────────────────────────

    test('.aider.chat.history.md nested 2 levels deep is found', async () => {
        const subDir = path.join(tmpDir, 'level1', 'level2');
        fs.mkdirSync(subDir, { recursive: true });
        const historyFile = path.join(subDir, AIDER_HISTORY_FILENAME);
        fs.writeFileSync(historyFile, '');

        const results = await discoverAiderHistoryFilesAsync([tmpDir], 3);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].historyFile, historyFile);
    });

    // ── Nested at depth 4 — excluded by default depth ─────────────────────────

    test('.aider.chat.history.md nested 4 levels deep excluded by default depth (3)', async () => {
        const subDir = path.join(tmpDir, 'a', 'b', 'c', 'd');
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, AIDER_HISTORY_FILENAME), '');

        const results = await discoverAiderHistoryFilesAsync([tmpDir], DEFAULT_AIDER_SEARCH_DEPTH);

        assert.strictEqual(results.length, 0);
    });

    // ── Depth cap ─────────────────────────────────────────────────────────────

    test('depth above MAX_AIDER_SEARCH_DEPTH is capped', async () => {
        // depth=99 should be capped at MAX_AIDER_SEARCH_DEPTH (5); file at depth 4 should be found
        const subDir = path.join(tmpDir, 'a', 'b', 'c', 'd');
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, AIDER_HISTORY_FILENAME), '');

        const results = await discoverAiderHistoryFilesAsync([tmpDir], 99);

        // With depth capped at 5, depth-4 file should be found
        assert.strictEqual(results.length, 1);
        assert.ok(results[0].historyFile.includes(path.join('c', 'd')));
    });

    // ── Symlink excluded ──────────────────────────────────────────────────────

    test('symlinked history file is excluded', async function () {
        // Skip if platform cannot create symlinks without admin rights
        const target = path.join(tmpDir, 'real.md');
        const link   = path.join(tmpDir, AIDER_HISTORY_FILENAME);
        fs.writeFileSync(target, '');
        try {
            fs.symlinkSync(target, link);
        } catch {
            this.skip();
            return;
        }

        const results = await discoverAiderHistoryFilesAsync([tmpDir]);

        assert.strictEqual(results.length, 0, 'symlinked file should be excluded');
    });

    // ── Deduplication across overlapping roots ────────────────────────────────

    test('duplicate roots produce deduplicated results', async () => {
        const historyFile = path.join(tmpDir, AIDER_HISTORY_FILENAME);
        fs.writeFileSync(historyFile, '');

        // Pass the same root twice
        const results = await discoverAiderHistoryFilesAsync([tmpDir, tmpDir]);

        assert.strictEqual(results.length, 1, 'duplicate roots must not produce duplicate results');
    });

    // ── Multiple roots ────────────────────────────────────────────────────────

    test('multiple distinct roots each contribute their files', async () => {
        const dir1 = path.join(tmpDir, 'proj1');
        const dir2 = path.join(tmpDir, 'proj2');
        fs.mkdirSync(dir1);
        fs.mkdirSync(dir2);
        fs.writeFileSync(path.join(dir1, AIDER_HISTORY_FILENAME), '');
        fs.writeFileSync(path.join(dir2, AIDER_HISTORY_FILENAME), '');

        const results = await discoverAiderHistoryFilesAsync([dir1, dir2]);

        assert.strictEqual(results.length, 2);
    });

    // ── Non-existent root ─────────────────────────────────────────────────────

    test('non-existent root returns empty array without throwing', async () => {
        const results = await discoverAiderHistoryFilesAsync([path.join(tmpDir, 'no-such-dir')]);
        assert.strictEqual(results.length, 0);
    });

    // ── Constants sanity ─────────────────────────────────────────────────────

    test('DEFAULT_AIDER_SEARCH_DEPTH is 3', () => {
        assert.strictEqual(DEFAULT_AIDER_SEARCH_DEPTH, 3);
    });

    test('MAX_AIDER_SEARCH_DEPTH is 5', () => {
        assert.strictEqual(MAX_AIDER_SEARCH_DEPTH, 5);
    });
});
