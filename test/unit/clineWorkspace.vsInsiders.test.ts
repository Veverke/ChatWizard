// test/unit/clineWorkspace.vsInsiders.test.ts
// Verifies that getClineCompatStorageRoot prefers 'Code - Insiders' over 'Code'
// when the Insiders tasks directory already exists on disk.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('getClineCompatStorageRoot — VS Code Insiders preference', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cline-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns Insiders path when Insiders tasks dir exists', () => {
        // Arrange: create Insiders tasks dir structure
        const isMac = process.platform === 'darwin';
        let insidersTasksDir: string;

        if (isMac) {
            insidersTasksDir = path.join(tmpDir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
        } else {
            insidersTasksDir = path.join(tmpDir, 'Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
        }
        fs.mkdirSync(insidersTasksDir, { recursive: true });

        // Patch platform-appropriate env vars so getClineCompatStorageRoot looks in tmpDir
        const originalAppData = process.env['APPDATA'];
        const originalXdgConfig = process.env['XDG_CONFIG_HOME'];
        const originalHome = process.env['HOME'];
        process.env['APPDATA'] = tmpDir;
        process.env['XDG_CONFIG_HOME'] = tmpDir;
        if (isMac) {
            process.env['HOME'] = tmpDir;
        }

        try {
            delete require.cache[require.resolve('../../src/readers/clineWorkspace')];
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getClineStorageRoot } = require('../../src/readers/clineWorkspace') as typeof import('../../src/readers/clineWorkspace');
            const result = getClineStorageRoot();
            assert.ok(result.includes('Code - Insiders'), `Expected Insiders path, got: ${result}`);
            assert.strictEqual(result, insidersTasksDir);
        } finally {
            process.env['APPDATA'] = originalAppData;
            process.env['XDG_CONFIG_HOME'] = originalXdgConfig;
            process.env['HOME'] = originalHome;
            delete require.cache[require.resolve('../../src/readers/clineWorkspace')];
        }
    });

    test('falls back to stable Code path when Insiders tasks dir does NOT exist', () => {
        // Arrange: only create stable Code tasks dir
        const isMac = process.platform === 'darwin';
        let stableTasksDir: string;

        if (isMac) {
            stableTasksDir = path.join(tmpDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
        } else {
            stableTasksDir = path.join(tmpDir, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
        }
        fs.mkdirSync(stableTasksDir, { recursive: true });

        const originalAppData = process.env['APPDATA'];
        const originalXdgConfig = process.env['XDG_CONFIG_HOME'];
        const originalHome = process.env['HOME'];
        process.env['APPDATA'] = tmpDir;
        process.env['XDG_CONFIG_HOME'] = tmpDir;
        if (isMac) {
            process.env['HOME'] = tmpDir;
        }

        try {
            delete require.cache[require.resolve('../../src/readers/clineWorkspace')];
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getClineStorageRoot } = require('../../src/readers/clineWorkspace') as typeof import('../../src/readers/clineWorkspace');
            const result = getClineStorageRoot();
            assert.ok(!result.includes('Code - Insiders'), `Should NOT use Insiders path, got: ${result}`);
            assert.strictEqual(result, stableTasksDir);
        } finally {
            process.env['APPDATA'] = originalAppData;
            process.env['XDG_CONFIG_HOME'] = originalXdgConfig;
            process.env['HOME'] = originalHome;
            delete require.cache[require.resolve('../../src/readers/clineWorkspace')];
        }
    });
});