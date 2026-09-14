/**
 * test/unit/copilotLogHarvester.test.ts
 *
 * Phase 2 — Copilot log harvester unit tests.
 * Verifies the bridge between the session-index event bus and the watch-logs
 * store: session upserts re-index events, removals drop rows, and batches keep
 * the store in sync with zero extra filesystem watching.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, Message } from '../../src/types/index';
import { LogService } from '../../src/logs/logService';
import { createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { CopilotLogHarvester } from '../../src/logs/copilotLogHarvester';

const TERMINAL_UUID = '7b3a4f9e-1234-5678-abcd-ef0123456789';

function snapshotLine(sessionId: string, creationDate = 1705400000000): string {
    return JSON.stringify({ kind: 0, v: { version: 3, sessionId, creationDate, requests: [], inputState: {} } });
}

function turnLine(requestId: string, timestamp: number, userText: string, response: unknown[]): string {
    return JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{ requestId, timestamp, message: { text: userText, parts: [] }, response }],
    });
}

function tmpDir(): string {
    const d = path.join(os.tmpdir(), `cw-copilot-harvester-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/** Build a fake Copilot session JSONL path + Session object with a command turn. */
function makeCopilotSessionWithCommand(dir: string, sessionId: string): { filePath: string; session: Session } {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const lines = [
        snapshotLine(sessionId),
        turnLine('r1', 1705400005000, 'Run tests', [{
            kind: 'toolInvocationSerialized',
            value: JSON.stringify({ tool: 'run_in_terminal', arguments: { command: 'npm test', terminalId: TERMINAL_UUID } }),
        }]),
        turnLine('r2', 1705400009000, `[Terminal ${TERMINAL_UUID} notification: command completed with exit code 0]`, []),
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    const userMsg: Message = { id: 'u1', role: 'user', content: 'Run tests', timestamp: '2026-01-01T00:00:00.000Z', codeBlocks: [] };
    const session: Session = {
        id: sessionId,
        title: 'Run tests',
        source: 'copilot',
        workspaceId: 'ws-hash',
        workspacePath: '/repo',
        messages: [userMsg],
        filePath,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
    return { filePath, session };
}
suite('CopilotLogHarvester — session-index bridge', () => {
    let dir: string;
    let service: LogService;
    let harvester: CopilotLogHarvester;

    setup(() => {
        dir = tmpDir();
        service = new LogService(dir, createDefaultLogSourceRegistry());
        harvester = new CopilotLogHarvester(service);
    });

    teardown(() => {
        try { service.dispose(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('upsert event ingests the session file into the log store', () => {
        const { filePath, session } = makeCopilotSessionWithCommand(dir, 'sess-a');
        const index = new SessionIndex();

        let refreshed = 0;
        harvester.onEventsChanged = () => { refreshed++; };
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));

        index.upsert(session);

        const stored = service.getEvents({ sessionId: 'sess-a' });
        assert.ok(stored.some((e) => e.type === 'command'), 'a CommandEvent should be stored');
        assert.ok(stored.some((e) => e.type === 'toolCall'), 'a ToolCallEvent should be stored');
        assert.strictEqual(refreshed, 1, 'onEventsChanged fires once after upsert');
        assert.ok(fs.existsSync(filePath)); // sanity: the path was real
    });

    test('re-upsert removes stale rows first (live JSONL rewrite)', () => {
        const { session } = makeCopilotSessionWithCommand(dir, 'sess-rewrite');
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));

        index.upsert(session);

        // Simulate the file being rewritten with a second command appended.
        const appendedPath = session.filePath!;
        const extraLine = turnLine('r3', 1705400010000, 'Build', [{
            kind: 'toolInvocationSerialized',
            value: JSON.stringify({ tool: 'run_in_terminal', arguments: { command: 'npm run build' } }),
        }]);
        fs.appendFileSync(appendedPath, `\n${extraLine}`, 'utf8');

        // Re-ingest the same file (as the live watcher would).
        harvester.ingestSessionFile(appendedPath, 'ws-hash', '/repo');

        const events = service.getEvents({ sessionId: 'sess-rewrite' });
        assert.strictEqual(events.filter((e) => e.type === 'command').length, 2, 'should have both commands, no stale duplicates');
    });
test('batch event ingests every Copilot session once', () => {
        const { session: s1 } = makeCopilotSessionWithCommand(dir, 'sess-b1');
        const { session: s2 } = makeCopilotSessionWithCommand(dir, 'sess-b2');
        const index = new SessionIndex();

        let refreshes = 0;
        harvester.onEventsChanged = () => { refreshes++; };
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));

        index.batchUpsert([s1, s2]);

        assert.strictEqual(service.getEventCountForSource(s1.filePath!), 2); // command + toolCall
        assert.strictEqual(service.getEventCountForSource(s2.filePath!), 2);
        assert.strictEqual(refreshes, 2, 'one refresh per ingested session');
    });

    test('remove event drops only that session’s events', () => {
        const { session: s1 } = makeCopilotSessionWithCommand(dir, 'sess-x');
        const { session: s2 } = makeCopilotSessionWithCommand(dir, 'sess-y');
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));

        index.batchUpsert([s1, s2]);
        assert.strictEqual(service.getStats().totalEvents, 4);

        index.remove(s1.id);
        assert.strictEqual(service.getStats().totalEvents, 2);
        assert.strictEqual(service.getEvents().every((e) => e.sessionId === 'sess-y'), true);
    });

    test('non-copilot sessions are ignored', () => {
        const claudeSession: Session = {
            id: 'claude-1',
            title: 'Claude session',
            source: 'claude',
            workspaceId: 'ws-claude',
            messages: [],
            filePath: '/tmp/x.jsonl',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const index = new SessionIndex();
        index.addTypedChangeListener((ev) => harvester.handleIndexEvent(ev));
        index.upsert(claudeSession);
        assert.strictEqual(service.getStats().totalEvents, 0);
    });

    test('ingestSessionFile reports ingested count and parse errors', () => {
        const { filePath } = makeCopilotSessionWithCommand(dir, 'sess-report');
        const result = harvester.ingestSessionFile(filePath, 'ws-hash', '/repo');
        assert.strictEqual(result.ingested, 2);
        assert.strictEqual(result.errors.length, 0);
    });
});