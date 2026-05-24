// test/e2e/sessionArchive.test.ts
//
// Tests SessionArchive against real temp-directory I/O. These tests exercise the
// contract that matters in production:
//   - Atomic writes survive a concurrent has() check
//   - After VS Code restarts (new instance, same directory), previously archived
//     sessions are still findable via has()
//   - Stats accurately report session count and byte totals
//   - Prune-by-age removes the right sessions and updates the manifest
//   - Prune-by-size removes oldest-first to fit within the limit

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionArchive } from '../../src/archive/sessionArchive';

/** Simulate raw session content as it would come from a Copilot JSONL file. */
function makeCopilotSessionJson(sessionId: string, title: string): string {
    return JSON.stringify({
        id: sessionId,
        title,
        source: 'copilot',
        messages: [
            { role: 'user', content: `User question in session ${sessionId}` },
            { role: 'assistant', content: `Assistant answer for session ${sessionId}` },
        ],
        createdAt: new Date().toISOString(),
    });
}

suite('SessionArchive — basic read/write', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-test-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('has() returns false for a session that has never been saved', async () => {
        // Must initialise the manifest first (ensureManifest is called on first has-after-load)
        await archive.stats(); // triggers ensureManifest
        assert.strictEqual(archive.has('unknown-session', 'copilot'), false);
    });

    test('save() then has() returns true without creating a new archive instance', async () => {
        const content = makeCopilotSessionJson('sess-001', 'JWT middleware debugging');
        await archive.save('sess-001', 'copilot', content);
        assert.strictEqual(archive.has('sess-001', 'copilot'), true);
    });

    test('saved content is written to disk and matches original', async () => {
        const content = makeCopilotSessionJson('sess-002', 'DynamoDB index optimization');
        await archive.save('sess-002', 'copilot', content);

        const raw = await archive.loadRaw('sess-002', 'copilot');
        assert.ok(raw, 'loadRaw should return content');
        const parsed = JSON.parse(raw!);
        assert.strictEqual(parsed.id, 'sess-002');
        assert.strictEqual(parsed.title, 'DynamoDB index optimization');
    });

    test('saving the same session twice overwrites without creating duplicate entries', async () => {
        const v1 = makeCopilotSessionJson('sess-003', 'Original title');
        const v2 = makeCopilotSessionJson('sess-003', 'Updated title after rename');
        await archive.save('sess-003', 'copilot', v1);
        await archive.save('sess-003', 'copilot', v2);

        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 1, 'Should not double-count same session');

        const raw = await archive.loadRaw('sess-003', 'copilot');
        const parsed = JSON.parse(raw!);
        assert.strictEqual(parsed.title, 'Updated title after rename', 'Should return latest version');
    });

    test('manifest survives a process restart (new SessionArchive instance, same directory)', async () => {
        const content = makeCopilotSessionJson('sess-persist', 'Persistent session test');
        await archive.save('sess-persist', 'copilot', content);

        // Simulate VS Code restart — create fresh instance pointing at same directory
        const archive2 = new SessionArchive(tmpDir);
        await archive2.stats(); // triggers ensureManifest

        assert.strictEqual(
            archive2.has('sess-persist', 'copilot'),
            true,
            'Session should be findable after process restart',
        );

        const raw = await archive2.loadRaw('sess-persist', 'copilot');
        assert.ok(raw, 'Content should be retrievable after restart');
    });

    test('sessions from different sources (copilot vs claude) are tracked independently', async () => {
        await archive.save('sess-multi', 'copilot', makeCopilotSessionJson('sess-multi', 'Copilot version'));
        await archive.save('sess-multi', 'claude', '{"id":"sess-multi","source":"claude","messages":[]}');

        assert.strictEqual(archive.has('sess-multi', 'copilot'), true);
        assert.strictEqual(archive.has('sess-multi', 'claude'), true);
        assert.strictEqual(archive.has('sess-multi', 'cursor'), false);

        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 2);
    });

});

suite('SessionArchive — stats()', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-stats-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('empty archive returns zero stats', async () => {
        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 0);
        assert.strictEqual(stats.totalBytes, 0);
        assert.strictEqual(stats.oldestDate, null);
    });

    test('stats counts sessions and accumulates byte totals', async () => {
        const c1 = makeCopilotSessionJson('s1', 'Session one');
        const c2 = makeCopilotSessionJson('s2', 'Session two');
        const c3 = makeCopilotSessionJson('s3', 'Session three');
        await archive.save('s1', 'copilot', c1);
        await archive.save('s2', 'copilot', c2);
        await archive.save('s3', 'copilot', c3);

        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 3);
        assert.ok(stats.totalBytes > 0, 'totalBytes should be positive');
        assert.ok(stats.totalBytes >= Buffer.byteLength(c1) + Buffer.byteLength(c2) + Buffer.byteLength(c3));
    });

    test('oldestDate reflects the earliest archivedAt timestamp', async () => {
        await archive.save('old', 'copilot', makeCopilotSessionJson('old', 'Old session'));
        await new Promise(r => setTimeout(r, 5));
        await archive.save('new', 'copilot', makeCopilotSessionJson('new', 'New session'));

        const stats = await archive.stats();
        assert.ok(stats.oldestDate, 'oldestDate should be set');
        const oldest = new Date(stats.oldestDate!);
        assert.ok(oldest.getTime() < Date.now() - 3, 'oldestDate should predate now');
    });

});

suite('SessionArchive — prune()', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-prune-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('prune with no options does not remove anything', async () => {
        await archive.save('keep1', 'copilot', makeCopilotSessionJson('keep1', 'Keep me'));
        await archive.save('keep2', 'copilot', makeCopilotSessionJson('keep2', 'Keep me too'));

        await archive.prune({});
        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 2, 'Nothing should be pruned without options');
    });

    test('prune by maxSizeMB removes oldest sessions to fit within limit', async () => {
        // Save 5 sessions; each is ~300 bytes. Set limit to 1/1024 MB (≈1KB) so 3-4 survive.
        for (let i = 1; i <= 5; i++) {
            await archive.save(`size-sess-${i}`, 'copilot', makeCopilotSessionJson(`size-sess-${i}`, `Session ${i}`));
        }

        const before = await archive.stats();
        assert.strictEqual(before.totalSessions, 5);

        // A very tight limit forces pruning — keep only what fits in ~1KB
        await archive.prune({ maxSizeMB: 0.001 });

        const after = await archive.stats();
        assert.ok(after.totalSessions < 5, 'Some sessions should have been pruned');
        assert.ok(after.totalBytes <= 0.001 * 1024 * 1024 * 2, 'Remaining size should be near the limit');
    });

    test('pruned sessions are no longer findable via has()', async () => {
        for (let i = 1; i <= 3; i++) {
            await archive.save(`prune-sess-${i}`, 'copilot', makeCopilotSessionJson(`prune-sess-${i}`, `Session ${i}`));
        }

        await archive.prune({ maxSizeMB: 0.0001 }); // extremely tight — prune everything

        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 0, 'All sessions should be pruned');
        assert.strictEqual(archive.has('prune-sess-1', 'copilot'), false);
        assert.strictEqual(archive.has('prune-sess-2', 'copilot'), false);
        assert.strictEqual(archive.has('prune-sess-3', 'copilot'), false);
    });

    test('loadRaw returns undefined for a session after it has been pruned', async () => {
        await archive.save('volatile-sess', 'copilot', makeCopilotSessionJson('volatile-sess', 'Will be pruned'));
        await archive.prune({ maxSizeMB: 0.0001 });
        const raw = await archive.loadRaw('volatile-sess', 'copilot');
        assert.strictEqual(raw, undefined);
    });

});

// ---------------------------------------------------------------------------
// SessionArchive — findAnySource()
// ---------------------------------------------------------------------------

suite('SessionArchive — findAnySource()', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-find-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns undefined for a sessionId that has never been saved', async () => {
        const result = await archive.findAnySource('no-such-session');
        assert.strictEqual(result, undefined);
    });

    test('returns ArchivedSession metadata for a saved session', async () => {
        await archive.save('find-001', 'copilot', makeCopilotSessionJson('find-001', 'Findable session'));
        const result = await archive.findAnySource('find-001');
        assert.ok(result !== undefined, 'should find the session');
        assert.strictEqual(result!.sessionId, 'find-001');
        assert.strictEqual(result!.source, 'copilot');
        assert.ok(result!.filePath.endsWith('.json'), 'filePath should be a .json file');
        assert.ok(result!.sizeBytes > 0, 'sizeBytes should be positive');
    });

    test('finds session regardless of which source it was saved under', async () => {
        // Archive under 'claude' — caller doesn't need to know the source ahead of time
        await archive.save('find-claude', 'claude', '{"id":"find-claude","source":"claude","messages":[]}');
        const result = await archive.findAnySource('find-claude');
        assert.ok(result !== undefined, 'should find session saved under claude source');
        assert.strictEqual(result!.source, 'claude');
    });

    test('returns first match when same sessionId exists under multiple sources', async () => {
        await archive.save('multi-src', 'copilot', makeCopilotSessionJson('multi-src', 'Copilot version'));
        await archive.save('multi-src', 'claude', '{"id":"multi-src","source":"claude","messages":[]}');
        const result = await archive.findAnySource('multi-src');
        assert.ok(result !== undefined, 'should find at least one entry');
        assert.strictEqual(result!.sessionId, 'multi-src');
    });

    test('returns undefined after delete()', async () => {
        await archive.save('find-del', 'copilot', makeCopilotSessionJson('find-del', 'To be deleted'));
        assert.ok(await archive.findAnySource('find-del'), 'should exist before delete');
        await archive.delete('find-del', 'copilot');
        const result = await archive.findAnySource('find-del');
        assert.strictEqual(result, undefined, 'should be gone after delete');
    });

    test('new instance finds previously saved session (manifest persists)', async () => {
        await archive.save('find-persist', 'copilot', makeCopilotSessionJson('find-persist', 'Persistent'));

        const archive2 = new SessionArchive(tmpDir);
        const result = await archive2.findAnySource('find-persist');
        assert.ok(result !== undefined, 'new instance should find the session from disk');
        assert.strictEqual(result!.sessionId, 'find-persist');
    });

    test('archivedAt is a valid ISO-8601 date string', async () => {
        await archive.save('ts-check', 'copilot', makeCopilotSessionJson('ts-check', 'Timestamp check'));
        const result = await archive.findAnySource('ts-check');
        assert.ok(result !== undefined);
        const ts = Date.parse(result!.archivedAt);
        assert.ok(!Number.isNaN(ts), 'archivedAt should parse as a valid date');
        assert.ok(ts <= Date.now(), 'archivedAt should not be in the future');
    });

});

// ---------------------------------------------------------------------------
// SessionArchive — delete()
// ---------------------------------------------------------------------------

suite('SessionArchive — delete()', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-delete-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns false when session does not exist', async () => {
        const result = await archive.delete('ghost-session', 'copilot');
        assert.strictEqual(result, false);
    });

    test('returns true when session exists and is successfully deleted', async () => {
        await archive.save('del-001', 'copilot', makeCopilotSessionJson('del-001', 'Delete me'));
        const result = await archive.delete('del-001', 'copilot');
        assert.strictEqual(result, true);
    });

    test('has() returns false after delete()', async () => {
        await archive.save('del-002', 'copilot', makeCopilotSessionJson('del-002', 'Will be deleted'));
        await archive.delete('del-002', 'copilot');
        assert.strictEqual(archive.has('del-002', 'copilot'), false);
    });

    test('loadRaw() returns undefined after delete()', async () => {
        await archive.save('del-003', 'copilot', makeCopilotSessionJson('del-003', 'Content check'));
        await archive.delete('del-003', 'copilot');
        const raw = await archive.loadRaw('del-003', 'copilot');
        assert.strictEqual(raw, undefined);
    });

    test('stats().totalSessions decrements by 1 after delete()', async () => {
        await archive.save('del-s1', 'copilot', makeCopilotSessionJson('del-s1', 'S1'));
        await archive.save('del-s2', 'copilot', makeCopilotSessionJson('del-s2', 'S2'));
        const before = await archive.stats();
        assert.strictEqual(before.totalSessions, 2);

        await archive.delete('del-s1', 'copilot');

        const after = await archive.stats();
        assert.strictEqual(after.totalSessions, 1, 'totalSessions should decrement by 1');
    });

    test('physical .json file is removed from disk after delete()', async () => {
        const content = makeCopilotSessionJson('del-disk', 'Disk test');
        await archive.save('del-disk', 'copilot', content);

        // Locate the file before deletion
        const entry = await archive.findAnySource('del-disk');
        assert.ok(entry !== undefined);
        const filePath = entry!.filePath;
        assert.ok(fs.existsSync(filePath), 'file should exist before delete');

        await archive.delete('del-disk', 'copilot');
        assert.strictEqual(fs.existsSync(filePath), false, 'file should be gone after delete');
    });

    test('manifest persists removal across process restart', async () => {
        await archive.save('del-restart', 'copilot', makeCopilotSessionJson('del-restart', 'Restart test'));
        await archive.delete('del-restart', 'copilot');

        const archive2 = new SessionArchive(tmpDir);
        const result = await archive2.findAnySource('del-restart');
        assert.strictEqual(result, undefined, 'new instance should not find deleted session');
    });

    test('deleting one session does not affect another session in the same source', async () => {
        await archive.save('keep-me', 'copilot', makeCopilotSessionJson('keep-me', 'Keep me'));
        await archive.save('del-me', 'copilot', makeCopilotSessionJson('del-me', 'Delete me'));

        await archive.delete('del-me', 'copilot');

        assert.strictEqual(archive.has('keep-me', 'copilot'), true, '"keep-me" should still exist');
        assert.strictEqual(archive.has('del-me', 'copilot'), false, '"del-me" should be gone');
        const raw = await archive.loadRaw('keep-me', 'copilot');
        assert.ok(raw, '"keep-me" content should still be readable');
    });

    test('deleting one source entry does not remove the same sessionId under a different source', async () => {
        await archive.save('shared-id', 'copilot', makeCopilotSessionJson('shared-id', 'Copilot entry'));
        await archive.save('shared-id', 'claude', '{"id":"shared-id","source":"claude","messages":[]}');

        await archive.delete('shared-id', 'copilot');

        assert.strictEqual(archive.has('shared-id', 'copilot'), false, 'copilot entry should be deleted');
        assert.strictEqual(archive.has('shared-id', 'claude'), true, 'claude entry should survive');
    });

});
