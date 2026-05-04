// test/suite/mcp/mcpAuthManager.test.ts

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpAuthManager } from '../../../src/mcp/mcpAuthManager';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Temp files / dirs created during tests — cleaned up in teardown. */
const _tempPaths: string[] = [];

/** Return an absolute path to a temp file that does NOT exist yet. */
function tempPath(suffix = ''): string {
    const p = path.join(
        os.tmpdir(),
        `cw-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}.txt`,
    );
    _tempPaths.push(p);
    return p;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('McpAuthManager', () => {
    const manager = new McpAuthManager();

    suiteTeardown(() => {
        for (const p of _tempPaths) {
            try { fs.unlinkSync(p); } catch { /* already gone */ }
        }
    });

    // ── getOrCreateToken ─────────────────────────────────────────────────────

    suite('getOrCreateToken()', () => {
        test('creates a token file when none exists', async () => {
            const p = tempPath();
            assert.ok(!fs.existsSync(p), 'precondition: file must not exist');

            const token = await manager.getOrCreateToken(p);

            assert.ok(fs.existsSync(p), 'token file was created');
            assert.strictEqual(token.length, 64, 'token is 32-byte hex = 64 chars');
            assert.match(token, /^[0-9a-f]{64}$/, 'token is lowercase hex');
        });

        test('returns the same token on repeated calls', async () => {
            const p = tempPath();
            const first = await manager.getOrCreateToken(p);
            const second = await manager.getOrCreateToken(p);
            assert.strictEqual(first, second, 'same token returned on second call');
        });

        test('returns existing token content when file already exists', async () => {
            const p = tempPath();
            const existing = 'a'.repeat(64);
            fs.writeFileSync(p, existing, 'utf8');

            const token = await manager.getOrCreateToken(p);
            assert.strictEqual(token, existing);
        });

        test('trims whitespace when reading existing token', async () => {
            const p = tempPath();
            const existing = 'b'.repeat(64);
            fs.writeFileSync(p, `  ${existing}\n`, 'utf8');

            const token = await manager.getOrCreateToken(p);
            assert.strictEqual(token, existing);
        });

        test('creates parent directories if they do not exist', async () => {
            const dir = path.join(os.tmpdir(), `cw-auth-subdir-${Date.now()}`);
            const p = path.join(dir, 'token.txt');
            _tempPaths.push(p, dir);

            const token = await manager.getOrCreateToken(p);

            assert.ok(fs.existsSync(dir), 'parent directory was created');
            assert.ok(fs.existsSync(p), 'token file was created inside nested directory');
            assert.strictEqual(token.length, 64);
        });

        test('throws when tokenPath is not absolute', async () => {
            await assert.rejects(
                () => manager.getOrCreateToken('relative/path.txt'),
                /must be an absolute path/,
            );
        });

        test('generated tokens are unique across calls', async () => {
            const p1 = tempPath('_a');
            const p2 = tempPath('_b');
            const t1 = await manager.getOrCreateToken(p1);
            const t2 = await manager.getOrCreateToken(p2);
            assert.notStrictEqual(t1, t2, 'two independently-created tokens must differ');
        });
    });

    // ── rotateToken ──────────────────────────────────────────────────────────

    suite('rotateToken()', () => {
        test('generates a new token and writes it to the file', async () => {
            const p = tempPath();
            const original = await manager.getOrCreateToken(p);
            const rotated = await manager.rotateToken(p);

            assert.notStrictEqual(rotated, original, 'rotated token differs from original');
            assert.strictEqual(rotated.length, 64);
            assert.match(rotated, /^[0-9a-f]{64}$/);
        });

        test('overwrites the existing token file', async () => {
            const p = tempPath();
            await manager.getOrCreateToken(p);
            const rotated = await manager.rotateToken(p);

            const onDisk = fs.readFileSync(p, 'utf8').trim();
            assert.strictEqual(onDisk, rotated, 'file on disk matches the returned token');
        });

        test('creates the file when it does not yet exist', async () => {
            const p = tempPath();
            assert.ok(!fs.existsSync(p), 'precondition: file must not exist');

            const token = await manager.rotateToken(p);
            assert.ok(fs.existsSync(p));
            assert.strictEqual(token.length, 64);
        });

        test('throws when tokenPath is not absolute', async () => {
            await assert.rejects(
                () => manager.rotateToken('relative/token.txt'),
                /must be an absolute path/,
            );
        });

        test('successive rotations each produce distinct tokens', async () => {
            const p = tempPath();
            const t1 = await manager.rotateToken(p);
            const t2 = await manager.rotateToken(p);
            const t3 = await manager.rotateToken(p);
            const tokens = new Set([t1, t2, t3]);
            assert.strictEqual(tokens.size, 3, 'all three rotated tokens are distinct');
        });
    });
});
