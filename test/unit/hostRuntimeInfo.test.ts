/**
 * test/unit/hostRuntimeInfo.test.ts
 *
 * The record the extension writes so `scripts/rebuild-native.js` can target the
 * exact Electron the extension host runs on (VS Code no longer advertises its
 * Electron version). A missing/unwritable cache dir must never throw.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    HOST_RUNTIME_FILENAME,
    hostRuntimeInfoPath,
    readHostRuntimeInfo,
    recordHostRuntimeInfo,
} from '../../src/utils/hostRuntimeInfo';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-host-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

suite('hostRuntimeInfo — extension host ABI record', () => {
    let dir: string;

    setup(() => { dir = tmpDir(); });
    teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('recordHostRuntimeInfo writes the file name the rebuild script reads', () => {
        const versions = {
            electron: '43.8.6',
            node: '24.22.1',
            modules: '148',
            chrome: '150.0.7871.250',
        } as unknown as NodeJS.ProcessVersions;

        const info = recordHostRuntimeInfo(dir, '1.146.0', versions);

        assert.ok(info, 'record should be returned');
        assert.strictEqual(info!.electron, '43.8.6');
        assert.strictEqual(info!.modules, '148');
        assert.strictEqual(hostRuntimeInfoPath(dir), path.join(dir, HOST_RUNTIME_FILENAME));
        assert.ok(fs.existsSync(hostRuntimeInfoPath(dir)));
    });

    test('readHostRuntimeInfo round-trips the recorded values', () => {
        recordHostRuntimeInfo(dir, '1.146.0', {
            electron: '43.8.6',
            node: '24.22.1',
            modules: '148',
        } as unknown as NodeJS.ProcessVersions);

        const info = readHostRuntimeInfo(dir);
        assert.ok(info);
        assert.strictEqual(info!.vscodeVersion, '1.146.0');
        assert.strictEqual(info!.electron, '43.8.6');
        assert.strictEqual(info!.modules, '148');
        assert.ok(Date.parse(info!.recordedAt) > 0, 'recordedAt is an ISO timestamp');
    });

    test('readHostRuntimeInfo returns undefined when no record exists', () => {
        assert.strictEqual(readHostRuntimeInfo(path.join(dir, 'nope')), undefined);
    });

    test('a corrupt record is ignored instead of throwing', () => {
        fs.writeFileSync(hostRuntimeInfoPath(dir), '{ not json', 'utf8');
        assert.strictEqual(readHostRuntimeInfo(dir), undefined);
    });

    test('recordHostRuntimeInfo never throws on an unwritable directory', () => {
        const info = recordHostRuntimeInfo(path.join(dir, 'file-not-dir', '\0invalid'), '1.146.0');
        assert.strictEqual(info, undefined);
    });
});
