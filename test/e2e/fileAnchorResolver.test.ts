// test/e2e/fileAnchorResolver.test.ts
//
// Tests for the pure-logic paths in fileAnchorResolver — specifically the
// early-exit cases that don't require VS Code workspace APIs.
//
// The VS Code workspace.workspaceFolders will be empty (or null) in the test
// environment, so these tests verify behaviour when no workspace folder is
// available, without exercising the vscode.workspace.findFiles codepath
// in a way that could hang or fail unpredictably.

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { resolveAnchorPath, resolveAnchorPaths } from '../../src/utils/fileAnchorResolver';

suite('fileAnchorResolver — resolveAnchorPath', () => {

    // ── Early-exit: falsy / non-string input ─────────────────────────────────

    test('returns undefined for empty string', async () => {
        const result = await resolveAnchorPath('');
        assert.strictEqual(result, undefined);
    });

    test('returns undefined for null-like value coerced to string', async () => {
        // Pass undefined cast to string via any to test the guard
        const result = await resolveAnchorPath(undefined as unknown as string);
        assert.strictEqual(result, undefined);
    });

    // ── Absolute path that exists on disk ────────────────────────────────────

    test('returns the path when it is absolute and exists on disk', async () => {
        // Use os.tmpdir() which is guaranteed to exist on every OS
        const existingDir = os.tmpdir();
        // Create a temporary file we know exists
        const tmpFile = path.join(existingDir, `anchor-test-${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, 'test');
        try {
            const result = await resolveAnchorPath(tmpFile);
            assert.strictEqual(result, tmpFile);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    // ── Absolute path that does NOT exist ────────────────────────────────────

    test('returns undefined for an absolute path that does not exist', async () => {
        const nonExistent = path.join(os.tmpdir(), `no-such-file-${Date.now()}.ts`);
        const result = await resolveAnchorPath(nonExistent);
        assert.strictEqual(result, undefined);
    });

    // ── Relative path with repoRoot ───────────────────────────────────────────

    test('resolves relative path against repoRoot when file exists', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-repo-'));
        const fileName = `resolver-test-${Date.now()}.ts`;
        const filePath = path.join(tmpDir, fileName);
        fs.writeFileSync(filePath, '// test');
        try {
            const result = await resolveAnchorPath(fileName, tmpDir);
            assert.strictEqual(result, filePath);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('returns undefined when relative path does not exist under repoRoot', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-repo2-'));
        try {
            const result = await resolveAnchorPath('nonexistent-file.ts', tmpDir);
            assert.strictEqual(result, undefined);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ── Relative path without extension (no glob search triggered) ───────────

    test('returns undefined for relative path with no extension (no glob attempt)', async () => {
        // path.extname('somefile') === '' → glob search branch is skipped
        const result = await resolveAnchorPath('somefile');
        assert.strictEqual(result, undefined);
    });

});

suite('fileAnchorResolver — resolveAnchorPaths', () => {

    test('returns empty array for empty input', async () => {
        const result = await resolveAnchorPaths([]);
        assert.deepStrictEqual(result, []);
    });

    test('returns only resolved entries, skipping unresolvable refs', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-batch-'));
        const existingFile = path.join(tmpDir, 'real.ts');
        fs.writeFileSync(existingFile, '// real');
        try {
            const refs = [
                existingFile,                         // absolute, exists → resolved
                path.join(tmpDir, 'ghost.ts'),        // absolute, doesn't exist → skipped
                '',                                   // empty → skipped
            ];
            const result = await resolveAnchorPaths(refs);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].ref, existingFile);
            assert.strictEqual(result[0].absPath, existingFile);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('resolves multiple files that exist', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-multi-'));
        const files = ['a.ts', 'b.ts', 'c.ts'].map(n => {
            const p = path.join(tmpDir, n);
            fs.writeFileSync(p, '// content');
            return p;
        });
        try {
            const result = await resolveAnchorPaths(files);
            assert.strictEqual(result.length, 3);
            result.forEach((r, i) => {
                assert.strictEqual(r.absPath, files[i]);
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});
