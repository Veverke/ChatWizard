/**
 * test/unit/sharedCachePath.test.ts
 *
 * Unit tests for Feature 24b — shared cache path resolution.
 * Pure logic, no native modules or VS Code API needed.
 */

import * as assert from 'assert';
import * as path from 'path';
import { getDefaultSharedCacheDir, resolveSharedCacheDir, resolveCacheDbPath } from '../../src/utils/sharedCachePath';

suite('SharedCachePath — path resolution', () => {
    const DB_FILENAME = 'chatwizard-cache.db';

    // ── getDefaultSharedCacheDir ─────────────────────────────────────────────

    test('getDefaultSharedCacheDir returns a non-empty string', () => {
        const dir = getDefaultSharedCacheDir();
        assert.ok(typeof dir === 'string' && dir.length > 0);
    });

    test('getDefaultSharedCacheDir ends with ChatWizard (or chatwizard on Linux)', () => {
        const dir = getDefaultSharedCacheDir();
        const platform = process.platform;
        const expectedSuffix = platform === 'linux' ? 'chatwizard' : 'ChatWizard';
        assert.ok(
            dir.endsWith(expectedSuffix),
            `Expected "${dir}" to end with "${expectedSuffix}"`
        );
    });

    test('getDefaultSharedCacheDir is an absolute path', () => {
        const dir = getDefaultSharedCacheDir();
        assert.ok(path.isAbsolute(dir), `Expected absolute path, got "${dir}"`);
    });

    test('getDefaultSharedCacheDir does not contain IDE-specific segments', () => {
        const dir = getDefaultSharedCacheDir();
        const ideSegments = ['Code', 'Cursor', 'Windsurf', 'Zed'];
        for (const seg of ideSegments) {
            assert.ok(
                !dir.includes(seg),
                `Path "${dir}" should not contain IDE-specific segment "${seg}"`
            );
        }
    });

    // ── resolveSharedCacheDir ────────────────────────────────────────────────

    test('resolveSharedCacheDir(undefined) returns the default', () => {
        const result = resolveSharedCacheDir(undefined);
        assert.strictEqual(result, getDefaultSharedCacheDir());
    });

    test('resolveSharedCacheDir("") returns the default', () => {
        const result = resolveSharedCacheDir('');
        assert.strictEqual(result, getDefaultSharedCacheDir());
    });

    test('resolveSharedCacheDir("  ") returns the default (whitespace)', () => {
        const result = resolveSharedCacheDir('  ');
        // Trimming means whitespace-only is treated as empty
        assert.strictEqual(result, getDefaultSharedCacheDir());
    });

    test('resolveSharedCacheDir("/custom/path") returns the custom path', () => {
        const custom = '/custom/path';
        const result = resolveSharedCacheDir(custom);
        assert.strictEqual(result, custom);
    });

    test('resolveSharedCacheDir("C:\\Custom\\Dir") returns the custom path (Windows-style)', () => {
        const custom = 'C:\\Custom\\Dir';
        const result = resolveSharedCacheDir(custom);
        assert.strictEqual(result, custom);
    });

    // ── resolveCacheDbPath ───────────────────────────────────────────────────

    test('resolveCacheDbPath(undefined) returns default dir + db filename', () => {
        const result = resolveCacheDbPath(undefined);
        const expected = path.join(getDefaultSharedCacheDir(), DB_FILENAME);
        assert.strictEqual(result, expected);
    });

    test('resolveCacheDbPath("") returns default dir + db filename', () => {
        const result = resolveCacheDbPath('');
        const expected = path.join(getDefaultSharedCacheDir(), DB_FILENAME);
        assert.strictEqual(result, expected);
    });

    test('resolveCacheDbPath("/custom") returns custom path + db filename', () => {
        const result = resolveCacheDbPath('/custom');
        assert.strictEqual(result, path.join('/custom', DB_FILENAME));
    });

    test('resolveCacheDbPath ends with .db extension', () => {
        const result = resolveCacheDbPath(undefined);
        assert.ok(result.endsWith('.db'), `Expected "${result}" to end with .db`);
    });

    // ── OS-specific path shape (soft assertions) ──────────────────────────────
    // These verify the shape is correct for the current OS without being
    // overly brittle about exact values.

    test('default path on Windows has expected shape', () => {
        if (process.platform !== 'win32') { return; }
        const dir = getDefaultSharedCacheDir();
        // Windows: %LOCALAPPDATA%\ChatWizard
        assert.ok(dir.includes('AppData\\Local'), `Expected AppData\\Local in path, got "${dir}"`);
        assert.ok(dir.endsWith('ChatWizard'), `Expected ChatWizard suffix, got "${dir}"`);
    });

    test('default path on macOS has expected shape', () => {
        if (process.platform !== 'darwin') { return; }
        const dir = getDefaultSharedCacheDir();
        // macOS: ~/Library/Application Support/ChatWizard
        assert.ok(dir.includes('Library'), `Expected Library in path, got "${dir}"`);
        assert.ok(dir.includes('Application Support'), `Expected Application Support in path, got "${dir}"`);
        assert.ok(dir.endsWith('ChatWizard'), `Expected ChatWizard suffix, got "${dir}"`);
    });

    test('default path on Linux has expected shape', () => {
        if (process.platform !== 'linux') { return; }
        const dir = getDefaultSharedCacheDir();
        // Linux: ~/.local/share/chatwizard
        assert.ok(dir.includes('.local/share'), `Expected .local/share in path, got "${dir}"`);
        assert.ok(dir.endsWith('chatwizard'), `Expected chatwizard suffix, got "${dir}"`);
    });
});