/**
 * test/unit/tabnineWorkspace.test.ts
 *
 * Unit tests for tabnineWorkspace — pure async discovery functions.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { discoverTabnineConversationsAsync } from '../../src/readers/tabnineWorkspace';

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-tabnine-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

suite('tabnineWorkspace', () => {
    suite('discoverTabnineConversationsAsync', () => {
        test('returns empty when directory does not exist', async () => {
            const files = await discoverTabnineConversationsAsync('/nonexistent/directory');
            assert.deepStrictEqual(files, []);
        });

        test('returns empty when directory is empty', async () => {
            const dir = tmpDir();
            try {
                const files = await discoverTabnineConversationsAsync(dir);
                assert.deepStrictEqual(files, []);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('discovers .json files in directory', async () => {
            const dir = tmpDir();
            try {
                fs.writeFileSync(path.join(dir, 'chat1.json'), '{}', 'utf-8');
                fs.writeFileSync(path.join(dir, 'chat2.json'), '{}', 'utf-8');
                fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a json', 'utf-8');
                const files = await discoverTabnineConversationsAsync(dir);
                assert.strictEqual(files.length, 2);
                assert.ok(files.every(f => f.endsWith('.json')));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('returns files with absolute paths', async () => {
            const dir = tmpDir();
            try {
                fs.writeFileSync(path.join(dir, 'chat.json'), '{}', 'utf-8');
                const files = await discoverTabnineConversationsAsync(dir);
                assert.ok(path.isAbsolute(files[0]));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});