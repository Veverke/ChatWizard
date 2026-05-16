// test/suite/manageWorkspacesSessionCount.test.ts
//
// Tests for the session-counting and byte-accumulation logic inside the
// manageWatchedWorkspaces command.
//
// Because the counting/accumulation logic is embedded in a VS Code command
// registration closure (which requires a live QuickPick and vscode APIs),
// we extract and test the pure algorithmic parts in isolation:
//   1.  indexCountForIds  — session counting from a SessionIndex
//   2.  Byte map accumulation — additive reduction with duplicate IDs (Code + Insiders)
//
// Bugs caught by this suite:
//   Bug A: byteMap.set() overwrote on duplicate ID — bytes from one VS Code variant lost.
//   Bug B: allIds contained duplicate IDs → bytes / disk counts doubled.
//   Bug C: indexCountForIds used filePath prefix only → Claude counted correctly but
//          Copilot sessions from Code-Insiders (same workspaceId, different storageDir) missed.

import * as assert from 'assert';
import * as path from 'path';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, Message } from '../../src/types/index';
import { ScopedWorkspace } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers — mirror the logic from manageWorkspaces.ts so we test the same
// algorithm without needing a live VS Code host.
// ---------------------------------------------------------------------------

let _seq = 0;

function makeMsg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m${++_seq}`, role, content, codeBlocks: [] };
}

function makeSession(
    id: string,
    workspaceId: string,
    source: Session['source'] = 'copilot',
    filePath?: string
): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId,
        messages: [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')],
        filePath: filePath ?? `/storage/${workspaceId}/chatSessions/${id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

function makeScopedWorkspace(id: string, source: ScopedWorkspace['source'], storageDir: string, workspacePath = `/projects/${id}`): ScopedWorkspace {
    return { id, source, workspacePath, storageDir };
}

/**
 * Pure reimplementation of `indexCountForIds` from manageWorkspaces.ts.
 * Must stay in sync with the source. Purpose: allow unit-testing without VS Code.
 */
function indexCountForIds(
    allSummaries: ReturnType<SessionIndex['getAllSummaries']>,
    allAvailable: ScopedWorkspace[],
    ids: string[]
): number {
    const idSet = new Set(ids);
    const storageDirs = ids.map(id => {
        const ws = allAvailable.find(w => w.id === id);
        return ws ? path.normalize(ws.storageDir) : null;
    }).filter((d): d is string => d !== null);

    return allSummaries.filter(s =>
        idSet.has(s.workspaceId) ||
        storageDirs.some(dir => path.normalize(s.filePath).startsWith(dir + path.sep))
    ).length;
}

/**
 * Pure reimplementation of byte map accumulation from manageWorkspaces.ts.
 * Additive — duplicate IDs sum rather than overwrite.
 */
function buildByteMap(
    allAvailable: ScopedWorkspace[],
    byteCounts: number[]
): Map<string, number> {
    const map = new Map<string, number>();
    allAvailable.forEach((ws, i) => {
        map.set(ws.id, (map.get(ws.id) ?? 0) + byteCounts[i]);
    });
    return map;
}

/**
 * Pure reimplementation of allIds deduplication.
 */
function buildAllIds(group: ScopedWorkspace[]): string[] {
    return [...new Set(group.map(ws => ws.id))];
}

// ---------------------------------------------------------------------------
// Suite A: indexCountForIds — Copilot sessions via workspaceId match
// ---------------------------------------------------------------------------

suite('manageWorkspaces — indexCountForIds (Copilot)', () => {

    test('counts sessions matching workspaceId exactly', () => {
        const index = new SessionIndex();
        const ws = makeScopedWorkspace('hash001', 'copilot', '/Code/User/workspaceStorage/hash001');
        index.upsert(makeSession('s1', 'hash001'));
        index.upsert(makeSession('s2', 'hash001'));
        index.upsert(makeSession('s3', 'other-ws')); // should not count

        const count = indexCountForIds(index.getAllSummaries(), [ws], ['hash001']);
        assert.strictEqual(count, 2);
    });

    test('BUG regression: counts sessions from Code-Insiders root (same workspaceId, different storageDir)', () => {
        // When the same workspace is open in both Code-stable and Code-Insiders,
        // both storage roots produce a ScopedWorkspace with the SAME workspaceId (hash).
        // Sessions are indexed with that workspaceId regardless of which root they came from.
        // indexCountForIds must count them by workspaceId, not by storageDir prefix alone.
        const HASH = 'sharedHash999';
        const stableWs   = makeScopedWorkspace(HASH, 'copilot', `C:/AppData/Code/User/workspaceStorage/${HASH}`);
        const insidersWs = makeScopedWorkspace(HASH, 'copilot', `C:/AppData/Code - Insiders/User/workspaceStorage/${HASH}`);

        const index = new SessionIndex();
        // Sessions were loaded from the stable root — their filePath has the stable storageDir
        index.upsert(makeSession('s-stable-1', HASH, 'copilot',
            `C:/AppData/Code/User/workspaceStorage/${HASH}/chatSessions/s-stable-1.jsonl`));
        // Sessions loaded from Insiders root
        index.upsert(makeSession('s-insiders-1', HASH, 'copilot',
            `C:/AppData/Code - Insiders/User/workspaceStorage/${HASH}/chatSessions/s-insiders-1.jsonl`));

        // The group row uses deduplicated IDs, so allIds = [HASH]
        const allAvailable = [stableWs, insidersWs];
        const allIds = buildAllIds(allAvailable.filter(w => w.id === HASH));

        const count = indexCountForIds(index.getAllSummaries(), allAvailable, allIds);
        assert.strictEqual(count, 2, 'should count sessions from BOTH storage roots');
    });

    test('returns 0 when no sessions match', () => {
        const index = new SessionIndex();
        const ws = makeScopedWorkspace('hash001', 'copilot', '/storage/hash001');
        const count = indexCountForIds(index.getAllSummaries(), [ws], ['hash001']);
        assert.strictEqual(count, 0);
    });
});

// ---------------------------------------------------------------------------
// Suite B: indexCountForIds — Claude sessions via filePath prefix
// ---------------------------------------------------------------------------

suite('manageWorkspaces — indexCountForIds (Claude)', () => {

    test('counts Claude sessions via filePath prefix (workspaceId is session UUID, not storage hash)', () => {
        // Claude sessions have workspaceId = session UUID (filename), so they CANNOT be
        // matched by workspaceId set membership. filePath prefix is the only reliable match.
        const STORAGE_DIR = '/home/user/.claude/projects/-repos-myapp';
        const ws = makeScopedWorkspace('-repos-myapp', 'claude', STORAGE_DIR);

        const index = new SessionIndex();
        const sessionUuid1 = 'a1b2c3d4-0000-0000-0000-000000000001';
        const sessionUuid2 = 'a1b2c3d4-0000-0000-0000-000000000002';
        // Claude session: workspaceId = UUID, filePath under storageDir
        index.upsert(makeSession(sessionUuid1, sessionUuid1, 'claude',
            `${STORAGE_DIR}/${sessionUuid1}.jsonl`));
        index.upsert(makeSession(sessionUuid2, sessionUuid2, 'claude',
            `${STORAGE_DIR}/${sessionUuid2}.jsonl`));
        // Session from a different project — should not match
        index.upsert(makeSession('other-uuid', 'other-uuid', 'claude',
            '/home/user/.claude/projects/-repos-other/other-uuid.jsonl'));

        const count = indexCountForIds(index.getAllSummaries(), [ws], ['-repos-myapp']);
        assert.strictEqual(count, 2, 'should count Claude sessions via filePath prefix');
    });

    test('does not count Claude sessions from a different project', () => {
        const ws = makeScopedWorkspace('-repos-projectA', 'claude', '/claude/projects/-repos-projectA');
        const index = new SessionIndex();
        index.upsert(makeSession('uuid-x', 'uuid-x', 'claude',
            '/claude/projects/-repos-projectB/uuid-x.jsonl'));

        const count = indexCountForIds(index.getAllSummaries(), [ws], ['-repos-projectA']);
        assert.strictEqual(count, 0);
    });
});

// ---------------------------------------------------------------------------
// Suite C: indexCountForIds — mixed Copilot + Claude group (single folder row)
// ---------------------------------------------------------------------------

suite('manageWorkspaces — indexCountForIds (mixed sources)', () => {

    test('sums Copilot and Claude sessions when grouped under same folder', () => {
        const STORAGE_COPILOT = '/Code/User/workspaceStorage/hash123';
        const STORAGE_CLAUDE  = '/claude/projects/-repos-myapp';

        const copilotWs = makeScopedWorkspace('hash123',      'copilot', STORAGE_COPILOT);
        const claudeWs  = makeScopedWorkspace('-repos-myapp', 'claude',  STORAGE_CLAUDE);

        const index = new SessionIndex();
        // Copilot sessions — matched by workspaceId
        index.upsert(makeSession('cop-1', 'hash123', 'copilot', `${STORAGE_COPILOT}/chatSessions/cop-1.jsonl`));
        index.upsert(makeSession('cop-2', 'hash123', 'copilot', `${STORAGE_COPILOT}/chatSessions/cop-2.jsonl`));
        // Claude sessions — matched by filePath prefix
        index.upsert(makeSession('uuid-a', 'uuid-a', 'claude', `${STORAGE_CLAUDE}/uuid-a.jsonl`));

        const allAvailable = [copilotWs, claudeWs];
        const allIds = ['hash123', '-repos-myapp'];
        const count = indexCountForIds(index.getAllSummaries(), allAvailable, allIds);
        assert.strictEqual(count, 3, 'should sum Copilot + Claude sessions');
    });
});

// ---------------------------------------------------------------------------
// Suite D: Byte map accumulation — duplicate IDs (Code + Code-Insiders)
// ---------------------------------------------------------------------------

suite('manageWorkspaces — byte map accumulation with duplicate IDs', () => {

    test('BUG regression: does NOT overwrite when same ID appears twice (two storage roots)', () => {
        const HASH = 'dupHash';
        const stableWs   = makeScopedWorkspace(HASH, 'copilot', `/Code/User/workspaceStorage/${HASH}`);
        const insidersWs = makeScopedWorkspace(HASH, 'copilot', `/Code - Insiders/User/workspaceStorage/${HASH}`);

        // stable root has 100 bytes of sessions; Insiders root has 200 bytes
        const allAvailable = [stableWs, insidersWs];
        const byteCounts   = [100, 200];

        const byteMap = buildByteMap(allAvailable, byteCounts);
        assert.strictEqual(byteMap.get(HASH), 300, 'bytes from both roots must be summed, not overwritten');
    });

    test('does not double-count when IDs are unique', () => {
        const wsA = makeScopedWorkspace('ws-a', 'copilot', '/storage/ws-a');
        const wsB = makeScopedWorkspace('ws-b', 'copilot', '/storage/ws-b');

        const byteMap = buildByteMap([wsA, wsB], [500, 1000]);
        assert.strictEqual(byteMap.get('ws-a'), 500);
        assert.strictEqual(byteMap.get('ws-b'), 1000);
    });
});

// ---------------------------------------------------------------------------
// Suite E: allIds deduplication
// ---------------------------------------------------------------------------

suite('manageWorkspaces — allIds deduplication', () => {

    test('BUG regression: duplicate IDs from same hash in two roots are deduplicated', () => {
        const HASH = 'sharedHash';
        const stableWs   = makeScopedWorkspace(HASH, 'copilot', `/Code/workspaceStorage/${HASH}`);
        const insidersWs = makeScopedWorkspace(HASH, 'copilot', `/Code - Insiders/workspaceStorage/${HASH}`);

        const allIds = buildAllIds([stableWs, insidersWs]);
        assert.deepStrictEqual(allIds, [HASH], 'allIds must contain the hash only once');
    });

    test('does not deduplicate genuinely distinct IDs', () => {
        const wsA = makeScopedWorkspace('ws-a', 'copilot', '/storage/ws-a');
        const wsB = makeScopedWorkspace('ws-b', 'claude',  '/storage/ws-b');

        const allIds = buildAllIds([wsA, wsB]);
        assert.deepStrictEqual([...allIds].sort(), ['ws-a', 'ws-b']);
    });
});
