/**
 * test/unit/aiderLogHarvester.test.ts
 *
 * Phase 3 — Aider log harvester unit tests.
 * Verifies the bridge between the session-index event bus and the watch-logs
 * store: Aider session upserts re-index their `.aider.chat.history.md`,
 * removals drop rows, and a growing transcript never duplicates events.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { AiderLogHarvester } from '../../src/logs/aiderLogHarvester';
import { CommandEvent } from '../../src/logs/types';
import { Message, Session } from '../../src/types/index';

const TRANSCRIPT = [
    '# aider chat started at 2024-11-15 09:23:45',
    '',
    '> /run npm test',
    'PASS',
    '',
    '> !git status --short',
    '',
].join('\n');

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-aider-harvester-'));
}

function makeSession(source: Session['source'], id: string, filePath: string, workspacePath?: string): Session {
    const message: Message = {
        id: `${id}-u1`, role: 'user', content: 'hello', codeBlocks: [],
        timestamp: '2024-11-15T09:23:45.000Z',
    };
    return {
        id,
        title: 'Aider session',
        source,
        workspaceId: id,
        workspacePath,
        messages: [message],
        filePath,
        createdAt: '2024-11-15T09:23:45.000Z',
        updatedAt: '2024-11-15T09:23:45.000Z',
    };
}

suite('AiderLogHarvester — session-index bridge', () => {
    let dir: string;
    let service: LogService;
    let harvester: AiderLogHarvester;
    let historyFile: string;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        harvester = new AiderLogHarvester(service);
        historyFile = path.join(dir, '.aider.chat.history.md');
        fs.writeFileSync(historyFile, TRANSCRIPT, 'utf8');
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('an Aider session upsert indexes its transcript', () => {
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('aider', 'aider-1', historyFile, '/repo') });

        const events = service.getEvents({ type: 'command' }) as CommandEvent[];
        assert.strictEqual(events.length, 2);
        assert.deepStrictEqual(events.map((e) => e.commandText).sort(), ['git status --short', 'npm test']);
        assert.strictEqual(events[0].sessionId, 'aider-1');
        assert.strictEqual(events[0].sourcePath, historyFile);
    });

    test('sessions from other tools are ignored', () => {
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('cline', 'cline-1', historyFile) });
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('aider', 'aider-1', '') });
        assert.strictEqual(service.getEvents({}).length, 0);
    });

    test('a batch indexes every Aider session in it', () => {
        const second = path.join(dir, 'other.aider.chat.history.md');
        fs.writeFileSync(second, '> !pwd\n', 'utf8');

        harvester.handleIndexEvent({
            type: 'batch',
            sessions: [
                makeSession('aider', 'aider-1', historyFile),
                makeSession('aider', 'aider-2', second),
                makeSession('copilot', 'copilot-1', '/tmp/x.jsonl'),
            ],
        });

        assert.strictEqual(service.getEvents({ type: 'command' }).length, 3);
    });

    test('removing a session drops its events', () => {
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('aider', 'aider-1', historyFile) });
        assert.strictEqual(service.getEvents({}).length, 2);

        harvester.handleIndexEvent({ type: 'remove', sessionId: 'aider-1' });
        assert.strictEqual(service.getEvents({}).length, 0);
    });

    test('re-indexing a grown transcript replaces rows instead of duplicating them', () => {
        const session = makeSession('aider', 'aider-1', historyFile);
        harvester.handleIndexEvent({ type: 'upsert', session });
        assert.strictEqual(service.getEvents({}).length, 2);

        fs.appendFileSync(historyFile, '\n> /run npm run build\n', 'utf8');
        harvester.handleIndexEvent({ type: 'upsert', session });
        assert.strictEqual(service.getEvents({ type: 'command' }).length, 3);
    });

    test('onEventsChanged fires after a successful ingest', () => {
        let calls = 0;
        harvester.onEventsChanged = () => { calls++; };
        harvester.handleIndexEvent({ type: 'upsert', session: makeSession('aider', 'aider-1', historyFile) });
        assert.strictEqual(calls, 1);
    });

    test('a missing transcript never breaks the index pipeline', () => {
        const session = makeSession('aider', 'ghost', path.join(dir, 'deleted.md'));
        assert.doesNotThrow(() => harvester.handleIndexEvent({ type: 'upsert', session }));
        assert.strictEqual(service.getEvents({}).length, 0);
    });
});
