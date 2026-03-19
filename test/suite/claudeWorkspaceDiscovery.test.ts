// test/suite/claudeWorkspaceDiscovery.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolveClaudeWorkspacePath,
    discoverClaudeWorkspacesAsync,
} from '../../src/readers/claudeWorkspace';

// ---------------------------------------------------------------------------
// resolveClaudeWorkspacePath
// ---------------------------------------------------------------------------

suite('resolveClaudeWorkspacePath', () => {

    // Windows-style paths ---------------------------------------------------

    test('decodes a standard Windows path', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('c--Repos-Personal-ChatWizard'),
            'C:\\Repos\\Personal\\ChatWizard'
        );
    });

    test('decodes a Windows path with a single path component', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('c--MyProject'),
            'C:\\MyProject'
        );
    });

    test('decodes a Windows path on a non-C drive', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('d--Work-projects-foo'),
            'D:\\Work\\projects\\foo'
        );
    });

    test('preserves mixed-case path component names', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('c--Repos-Personal-bAInder'),
            'C:\\Repos\\Personal\\bAInder'
        );
    });

    // Unix-style paths ------------------------------------------------------

    test('decodes a standard Unix path', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('-home-user-projects-foo'),
            '/home/user/projects/foo'
        );
    });

    test('decodes a Unix path with a single path component', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('-workspace'),
            '/workspace'
        );
    });

    test('decodes a deeply nested Unix path', () => {
        assert.strictEqual(
            resolveClaudeWorkspacePath('-srv-www-html-app'),
            '/srv/www/html/app'
        );
    });

    // Edge cases ------------------------------------------------------------

    test('returns undefined for an empty string', () => {
        assert.strictEqual(resolveClaudeWorkspacePath(''), undefined);
    });

    test('returns undefined for a plain name with no separator pattern', () => {
        // No leading '-' and no Windows 'x--' prefix — unrecognised
        assert.strictEqual(resolveClaudeWorkspacePath('someRandomDir'), undefined);
    });

    test('returns undefined for a Windows prefix with no rest (only drive + --)', () => {
        // "c--" alone: winMatch[2] would be empty string — regex requires (.+) so no match
        assert.strictEqual(resolveClaudeWorkspacePath('c--'), undefined);
    });

    test('returns undefined for multi-letter prefix (not a drive letter)', () => {
        assert.strictEqual(resolveClaudeWorkspacePath('cd--path-to-something'), undefined);
    });
});

// ---------------------------------------------------------------------------
// discoverClaudeWorkspacesAsync
// ---------------------------------------------------------------------------

suite('discoverClaudeWorkspacesAsync', () => {

    let tmpDir: string;

    setup(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cw-claude-disc-'));
    });

    teardown(async () => {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array when projects directory does not exist', async () => {
        const result = await discoverClaudeWorkspacesAsync(path.join(tmpDir, 'nonexistent'));
        assert.deepStrictEqual(result, []);
    });

    test('returns empty array for an empty projects directory', async () => {
        const result = await discoverClaudeWorkspacesAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });

    test('skips directories whose name cannot be decoded', async () => {
        await fs.promises.mkdir(path.join(tmpDir, 'unrecognisedDirName'));
        const result = await discoverClaudeWorkspacesAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });

    test('skips non-directory entries', async () => {
        await fs.promises.writeFile(path.join(tmpDir, 'c--Repos-foo'), '');
        const result = await discoverClaudeWorkspacesAsync(tmpDir);
        assert.deepStrictEqual(result, []);
    });

    test('returns a ScopedWorkspace for a valid Windows-encoded directory', async () => {
        const dirName = 'c--Repos-Personal-ChatWizard';
        await fs.promises.mkdir(path.join(tmpDir, dirName));
        const result = await discoverClaudeWorkspacesAsync(tmpDir);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, dirName);
        assert.strictEqual(result[0].source, 'claude');
        assert.strictEqual(result[0].workspacePath, 'C:\\Repos\\Personal\\ChatWizard');
        assert.strictEqual(result[0].storageDir, path.join(tmpDir, dirName));
    });

    test('returns a ScopedWorkspace for a valid Unix-encoded directory', async () => {
        const dirName = '-home-user-projects-foo';
        await fs.promises.mkdir(path.join(tmpDir, dirName));
        const result = await discoverClaudeWorkspacesAsync(tmpDir);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, dirName);
        assert.strictEqual(result[0].source, 'claude');
        assert.strictEqual(result[0].workspacePath, '/home/user/projects/foo');
        assert.strictEqual(result[0].storageDir, path.join(tmpDir, dirName));
    });

    test('returns multiple entries when multiple valid directories exist', async () => {
        const dirs = ['c--Repos-foo', 'c--Repos-bar', '-home-user-baz'];
        for (const d of dirs) {
            await fs.promises.mkdir(path.join(tmpDir, d));
        }
        const result = await discoverClaudeWorkspacesAsync(tmpDir);
        assert.strictEqual(result.length, 3);
        const ids = result.map(r => r.id).sort();
        assert.deepStrictEqual(ids, dirs.slice().sort());
    });

    test('mixes valid and invalid directories, returning only valid ones', async () => {
        await fs.promises.mkdir(path.join(tmpDir, 'c--Repos-valid'));
        await fs.promises.mkdir(path.join(tmpDir, 'unrecognised'));
        const result = await discoverClaudeWorkspacesAsync(tmpDir);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'c--Repos-valid');
    });
});
