// test/e2e/gitContextReader.test.ts
// Feature 25 — Git/Branch Linkage

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { execFileSync } from 'child_process';
import { readGitContextAsync, GitContextCache } from '../../src/utils/gitContextReader';

/**
 * Remove a temp repo directory.
 *
 * On Windows `fs.rmSync` fails with EPERM on the `.git` tree (files Windows
 * refuses to unlink), and its built-in retries only multiply the wait: the old
 * 10 attempts x 3 retries x 200 ms plus 300 ms busy-waits took ~23 s, blowing
 * past mocha's 10 s hook timeout.  `cmd /c rmdir /s /q` removes the same tree
 * in ~150 ms, so try it right after a single fast `rmSync` attempt.
 *
 * Never throws — this is cleanup only.
 */
function removeTempRepo(dir: string): void {
    if (!dir || !fs.existsSync(dir)) { return; }
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
    } catch { /* EPERM on Windows — fall through to rmdir */ }
    try {
        execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { timeout: 5000, stdio: 'ignore' });
        if (!fs.existsSync(dir)) { return; }
    } catch { /* fall through to rename */ }
    // Last resort: rename so the next run isn't polluted; the OS reclaims TEMP.
    try { fs.renameSync(dir, dir + '.orphaned'); } catch { /* noop */ }
}

/** Create a temp git repo with one commit and return its path */
function createTempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-git-test-'));
    childProcess.execFileSync('git', ['init'], { cwd: dir });
    childProcess.execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    childProcess.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), '# test', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: dir });
    childProcess.execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    return dir;
}

suite('Feature 25 — Git Context Reader', () => {
    let repoDir: string;

    suiteSetup(() => {
        repoDir = createTempRepo();
    });

    suiteTeardown(() => {
        removeTempRepo(repoDir);
    });

    test('returns correct branch for a valid git repo', async () => {
        const ctx = await readGitContextAsync(repoDir);
        assert.ok(ctx !== undefined, 'should return a GitContext for a valid repo');
        assert.ok(typeof ctx.branch === 'string' && ctx.branch.length > 0, 'branch should be non-empty');
    });

    test('returns a commit hash for a valid git repo', async () => {
        const ctx = await readGitContextAsync(repoDir);
        assert.ok(ctx?.headCommit, 'headCommit should be populated');
        // Short SHA is typically 7+ chars
        assert.ok(ctx!.headCommit!.length >= 7, 'headCommit should be a reasonable short SHA');
    });

    test('returns undefined for a non-git directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-non-git-'));
        try {
            const ctx = await readGitContextAsync(tmpDir);
            assert.strictEqual(ctx, undefined, 'should return undefined for non-git directory');
        } finally {
            removeTempRepo(tmpDir);
        }
    });

    test('returns undefined for an empty path', async () => {
        const ctx = await readGitContextAsync('');
        assert.strictEqual(ctx, undefined, 'should return undefined for empty path');
    });

    test('does not throw for a non-existent path', async () => {
        const ctx = await readGitContextAsync('/nonexistent/path/that/does/not/exist');
        assert.strictEqual(ctx, undefined, 'should return undefined without throwing');
    });
});

suite('Feature 25 — Git Context Cache', () => {
    let repoDir: string;

    suiteSetup(() => {
        repoDir = createTempRepo();
    });

    suiteTeardown(() => {
        removeTempRepo(repoDir);
    });

    test('caches results and returns same object on second call', async () => {
        const cache = new GitContextCache(60_000);
        const first = await cache.getOrFetch(repoDir);
        const second = await cache.getOrFetch(repoDir);
        // Same reference since it's cached
        assert.strictEqual(first, second, 'cached result should be the same object');
    });

    test('invalidate() causes a fresh fetch on next call', async () => {
        const cache = new GitContextCache(60_000);
        const first = await cache.getOrFetch(repoDir);
        cache.invalidate(repoDir);
        const second = await cache.getOrFetch(repoDir);
        // Both should have the same branch (same repo), but may be different objects
        assert.strictEqual(first?.branch, second?.branch, 'branch should remain the same after re-fetch');
    });

    test('clear() removes all cached entries', async () => {
        const cache = new GitContextCache(60_000);
        await cache.getOrFetch(repoDir);
        cache.clear();
        // After clear, next call should re-fetch — just verify it doesn't throw
        const ctx = await cache.getOrFetch(repoDir);
        assert.ok(ctx !== undefined, 'should still return valid context after clear+refetch');
    });
});