/**
 * test/unit/windsurfLogHarvester.test.ts
 *
 * Phase 3 — Windsurf log harvester unit tests.
 * Windsurf stores all of a workspace's chats in one `state.vscdb`, so the
 * harvester's job is to parse that database *once* per change and keep its
 * events in sync. The Cascade reader is injected here, so no SQLite is needed.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { WindsurfLogHarvester } from '../../src/logs/windsurfLogHarvester';
import { Message, Session } from '../../src/types/index';

const CASCADE = JSON.stringify({
    sessions: [
        { sessionId: 'cascade-1', messages: [{ role: 'assistant', content: '```bash\nnpm test\n```' }] },
        { sessionId: 'cascade-2', messages: [{ role: 'assistant', content: '```bash\nnpm run build\n```' }] },
    ],
});

/** Give the fire-and-forget ingest a chance to finish. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-windsurf-harvester-'));
}

function makeSession(id: string, filePath: string, source: Session['source'] = 'windsurf'): Session {
    const message: Message = { id: `${id}-u1`, role: 'user', content: 'hi', codeBlocks: [] };
    return {
        id,
        title: 'Cascade session',
        source,
        workspaceId: 'ws-hash',
        workspacePath: '/repo',
        messages: [message],
        filePath,
        createdAt: '2024-11-15T09:23:45.000Z',
        updatedAt: '2024-11-15T09:23:45.000Z',
    };
}

suite('WindsurfLogHarvester — one database, many sessions', () => {
    let dir: string;
    let service: LogService;
    let vscdbPath: string;
    let reads: string[];

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        vscdbPath = path.join(dir, 'ws-hash', 'state.vscdb');
        fs.mkdirSync(path.dirname(vscdbPath), { recursive: true });
        fs.writeFileSync(vscdbPath, 'not-really-sqlite', 'utf8');
        reads = [];
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    function makeHarvester(payload: string | undefined = CASCADE): WindsurfLogHarvester {
        return new WindsurfLogHarvester(service, {
            readCascadeData: async (p) => { reads.push(p); return payload; },
        });
    }

    test('a session upsert parses the database and ingests its events', async () => {
        const harvester = makeHarvester();
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('windsurf-1', vscdbPath) });
        await flush();

        assert.deepStrictEqual(reads, [vscdbPath], 'the database is read once');
        const events = service.getEvents({ type: 'command' });
        assert.deepStrictEqual(
            events.map((e) => (e as { commandText: string }).commandText).sort(),
            ['npm run build', 'npm test']
        );
        assert.strictEqual(events[0].tool, 'windsurf');
        assert.strictEqual(harvester.trackedDatabases, 1);
    });

    test('a batch of sessions from one database reads it only once', async () => {
        const harvester = makeHarvester();
        harvester.handleIndexEvent({
            type: 'batch',
            sessions: [
                makeSession('windsurf-1', vscdbPath),
                makeSession('windsurf-2', vscdbPath),
                makeSession('windsurf-3', vscdbPath),
            ],
        });
        await flush();

        assert.strictEqual(reads.length, 1);
        assert.strictEqual(service.getEvents({ type: 'command' }).length, 2, 'no duplicated rows');
    });
});

suite('WindsurfLogHarvester — change detection', () => {
    let dir: string;
    let service: LogService;
    let vscdbPath: string;
    let reads: string[];

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        vscdbPath = path.join(dir, 'ws-hash', 'state.vscdb');
        fs.mkdirSync(path.dirname(vscdbPath), { recursive: true });
        fs.writeFileSync(vscdbPath, 'not-really-sqlite', 'utf8');
        reads = [];
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    function makeHarvester(payload: string | undefined = CASCADE): WindsurfLogHarvester {
        return new WindsurfLogHarvester(service, {
            readCascadeData: async (p) => { reads.push(p); return payload; },
        });
    }

    test('an unchanged database is skipped, a rewritten one is re-parsed', async () => {
        const harvester = makeHarvester();
        const session = makeSession('windsurf-1', vscdbPath);

        harvester.handleIndexEvent({ type: 'upsert', session });
        await flush();
        assert.strictEqual(reads.length, 1);

        // Same size + mtime → skipped.
        harvester.handleIndexEvent({ type: 'upsert', session });
        await flush();
        assert.strictEqual(reads.length, 1);

        // Grow the file so its stamp changes.
        fs.appendFileSync(vscdbPath, '-grown', 'utf8');
        harvester.handleIndexEvent({ type: 'upsert', session });
        await flush();
        assert.strictEqual(reads.length, 2);
        assert.strictEqual(service.getEvents({ type: 'command' }).length, 2, 're-ingest replaces rows');
    });

    test('non-Windsurf sessions are ignored', async () => {
        const harvester = makeHarvester();
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('cursor-1', vscdbPath, 'cursor') });
        await flush();

        assert.deepStrictEqual(reads, []);
        assert.strictEqual(service.getEvents({}).length, 0);
    });

    test('removing a session drops its events', async () => {
        const harvester = makeHarvester();
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('windsurf-1', vscdbPath) });
        await flush();
        assert.strictEqual(service.getEvents({}).length, 2);

        harvester.handleIndexEvent({ type: 'remove', sessionId: 'cascade-1' });
        assert.strictEqual(service.getEvents({}).length, 1);
    });

    test('clear resets the change-detection cache', async () => {
        const harvester = makeHarvester();
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('windsurf-1', vscdbPath) });
        await flush();
        assert.strictEqual(harvester.trackedDatabases, 1);

        harvester.handleIndexEvent({ type: 'clear' });
        assert.strictEqual(harvester.trackedDatabases, 0);
    });

    test('an unreadable database yields an error without touching the store', async () => {
        const harvester = new WindsurfLogHarvester(service, {
            readCascadeData: async () => undefined,
        });
        const result = await harvester.ingestWorkspaceDb(vscdbPath, 'ws-hash', '/repo');

        assert.strictEqual(result.ingested, 0);
        assert.strictEqual(result.errors.length, 1);
        assert.match(result.errors[0], /Cannot read cascade.sessionData/);
        assert.strictEqual(service.getEvents({}).length, 0);
    });
});

