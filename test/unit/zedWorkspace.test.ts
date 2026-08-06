/**
 * test/unit/zedWorkspace.test.ts
 *
 * Unit tests for zedWorkspace — pure async discovery functions.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { discoverZedConversationsAsync } from '../../src/readers/zedWorkspace';

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-zed-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('zedWorkspace', () => {
    suite('discoverZedConversationsAsync', () => {
        test('returns empty when directory does not exist', async () => {
            const files = await discoverZedConversationsAsync('/nonexistent/directory');
            assert.deepStrictEqual(files, []);
        });

        test('returns empty when directory is empty', async () => {
            const dir = tmpDir();
            try {
                const files = await discoverZedConversationsAsync(dir);
                assert.deepStrictEqual(files, []);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('discovers .json files in directory', async () => {
            const dir = tmpDir();
            try {
                fs.writeFileSync(path.join(dir, 'conv1.json'), '{}', 'utf-8');
                fs.writeFileSync(path.join(dir, 'conv2.json'), '{}', 'utf-8');
                fs.writeFileSync(path.join(dir, 'notes.txt'), 'not json', 'utf-8');
                const files = await discoverZedConversationsAsync(dir);
                assert.strictEqual(files.length, 2);
                assert.ok(files.every(f => f.endsWith('.json')));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('returns files with absolute paths', async () => {
            const dir = tmpDir();
            try {
                fs.writeFileSync(path.join(dir, 'conv.json'), '{}', 'utf-8');
                const files = await discoverZedConversationsAsync(dir);
                assert.ok(path.isAbsolute(files[0]));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});