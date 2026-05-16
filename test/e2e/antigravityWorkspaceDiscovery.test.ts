// test/suite/antigravityWorkspaceDiscovery.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { discoverAntigravityConversationsAsync } from '../../src/readers/antigravityWorkspace';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(brainRoot: string, uuid: string): void {
    const logDir = path.join(brainRoot, uuid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'overview.txt'), '{}', 'utf-8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Antigravity Workspace Discovery', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-antigravity-disc-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array when brain directory does not exist', async () => {
        const results = await discoverAntigravityConversationsAsync(path.join(tmpDir, 'nonexistent'));
        assert.deepStrictEqual(results, []);
    });

    test('discovers a single conversation', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        makeConversation(tmpDir, uuid);

        const results = await discoverAntigravityConversationsAsync(tmpDir);

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].conversationId, uuid);
    });

    test('discovers multiple conversations', async () => {
        const uuids = [
            '11111111-0000-0000-0000-000000000001',
            '22222222-0000-0000-0000-000000000002',
            '33333333-0000-0000-0000-000000000003',
        ];
        for (const uuid of uuids) { makeConversation(tmpDir, uuid); }

        const results = await discoverAntigravityConversationsAsync(tmpDir);

        assert.strictEqual(results.length, uuids.length);
        const ids = results.map(r => r.conversationId).sort();
        assert.deepStrictEqual(ids, uuids.slice().sort());
    });

    test('overviewFile path is correct', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
        makeConversation(tmpDir, uuid);

        const results = await discoverAntigravityConversationsAsync(tmpDir);
        const expected = path.join(tmpDir, uuid, '.system_generated', 'logs', 'overview.txt');

        assert.strictEqual(results[0].overviewFile, expected);
    });

    test('skips entries without overview.txt', async () => {
        // Create a dir with no overview.txt
        const emptyUuid = 'ffffffff-0000-0000-0000-000000000000';
        fs.mkdirSync(path.join(tmpDir, emptyUuid), { recursive: true });

        // Create a valid one
        const validUuid = '00000000-0000-0000-0000-000000000001';
        makeConversation(tmpDir, validUuid);

        const results = await discoverAntigravityConversationsAsync(tmpDir);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].conversationId, validUuid);
    });

    test('skips files (only directories) at brain root', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
        makeConversation(tmpDir, uuid);
        // Stray file at brain root level
        fs.writeFileSync(path.join(tmpDir, 'stray.txt'), 'noise', 'utf-8');

        const results = await discoverAntigravityConversationsAsync(tmpDir);
        assert.strictEqual(results.length, 1);
    });
});
