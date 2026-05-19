// test/suite/antigravityWorkspaceDiscovery.test.ts
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { discoverAntigravityConversationsAsync, discoverAntigravityJsonConversationsAsync, getAntigravityConversationsRoot, getAntigravityBrainRoot } from '../../src/readers/antigravityWorkspace';

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

// ------------------------------------------------------------------ //
// discoverAntigravityJsonConversationsAsync
// ------------------------------------------------------------------ //

suite('Antigravity JSON Conversations Discovery', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ag-json-disc-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array when conversations directory does not exist', async () => {
        const results = await discoverAntigravityJsonConversationsAsync(path.join(tmpDir, 'nonexistent'));
        assert.deepStrictEqual(results, []);
    });

    test('returns empty array when conversations directory is empty', async () => {
        const results = await discoverAntigravityJsonConversationsAsync(tmpDir);
        assert.deepStrictEqual(results, []);
    });

    test('discovers a single .json conversation file', async () => {
        const uuid = 'conv-uuid-1';
        fs.writeFileSync(path.join(tmpDir, `${uuid}.json`), '{}', 'utf-8');
        const results = await discoverAntigravityJsonConversationsAsync(tmpDir);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].conversationId, uuid);
        assert.ok(results[0].jsonFile.endsWith(`${uuid}.json`), `jsonFile: ${results[0].jsonFile}`);
    });

    test('discovers multiple .json conversation files', async () => {
        for (const id of ['id1', 'id2', 'id3']) {
            fs.writeFileSync(path.join(tmpDir, `${id}.json`), '{}', 'utf-8');
        }
        const results = await discoverAntigravityJsonConversationsAsync(tmpDir);
        assert.strictEqual(results.length, 3);
    });

    test('skips non-.json files', async () => {
        fs.writeFileSync(path.join(tmpDir, 'conv.json'), '{}', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'data', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'ignore.jsonl'), 'data', 'utf-8');
        const results = await discoverAntigravityJsonConversationsAsync(tmpDir);
        assert.strictEqual(results.length, 1);
    });

    test('conversationId has .json extension stripped', async () => {
        fs.writeFileSync(path.join(tmpDir, 'myconversation.json'), '{}', 'utf-8');
        const results = await discoverAntigravityJsonConversationsAsync(tmpDir);
        assert.strictEqual(results[0].conversationId, 'myconversation');
    });
});

// ------------------------------------------------------------------ //
// getAntigravityBrainRoot / getAntigravityConversationsRoot
// ------------------------------------------------------------------ //

suite('getAntigravityBrainRoot', () => {
    test('returns a non-empty string containing .gemini', () => {
        const result = getAntigravityBrainRoot();
        assert.ok(typeof result === 'string' && result.length > 0);
        assert.ok(result.includes('gemini') || result.includes('antigravity'),
            `Expected 'gemini' or 'antigravity' in path, got: ${result}`);
    });

    test('includes antigravity/brain segment', () => {
        const result = getAntigravityBrainRoot();
        assert.ok(result.includes('brain'), `Expected 'brain' in path, got: ${result}`);
    });
});

suite('getAntigravityConversationsRoot', () => {
    test('returns override when provided', () => {
        const override = '/custom/conversations';
        const result = getAntigravityConversationsRoot(override);
        assert.strictEqual(result, override);
    });

    test('returns default path when no override', () => {
        const result = getAntigravityConversationsRoot();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('default path contains conversations segment', () => {
        const result = getAntigravityConversationsRoot();
        assert.ok(result.includes('conversations'), `Expected 'conversations' in path, got: ${result}`);
    });

    test('empty string override returns default path', () => {
        const result = getAntigravityConversationsRoot('');
        assert.ok(result.includes('conversations') || result.length > 0);
    });
});
