// test/e2e/archiveWorkflow.test.ts
//
// End-to-end tests for the complete session archive lifecycle.
// These tests exercise the round-trip from Session object → JSON string → archive
// → restore from archive → back to Session object, which is exactly what
// extension.ts does when wiring the archive to the index change listener.
//
// Tests here intentionally avoid VS Code APIs so they run as pure Node.js.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionArchive } from '../../src/archive/sessionArchive';
import { Session, Message, SessionSource } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `${role}-${Math.random().toString(36).slice(2)}`, role, content, codeBlocks: [] };
}

/**
 * Creates a realistic Session object with multiple messages.
 * Mirrors the shape written by extension.ts: JSON.stringify(session)
 */
function makeRealisticSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: overrides.title ?? `Session ${overrides.id}`,
        source: overrides.source ?? 'copilot',
        workspaceId: overrides.workspaceId ?? 'ws-archive-test',
        workspacePath: overrides.workspacePath ?? '/home/user/myproject',
        model: overrides.model,
        filePath: overrides.filePath ?? `/tmp/sessions/${overrides.id}.jsonl`,
        createdAt:  overrides.createdAt  ?? '2026-01-15T10:00:00.000Z',
        updatedAt:  overrides.updatedAt  ?? '2026-01-15T11:30:00.000Z',
        messages: overrides.messages ?? [
            makeMessage('user',      'How does the session archive work?'),
            makeMessage('assistant', 'It mirrors raw session content to an on-disk JSON store…'),
            makeMessage('user',      'Does it survive VS Code restarts?'),
            makeMessage('assistant', 'Yes — the manifest is persisted to `archive-manifest.json`.'),
        ],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Suite: round-trip fidelity
// ---------------------------------------------------------------------------

suite('Archive workflow — round-trip fidelity', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-workflow-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('save(JSON.stringify(session)) then loadRaw+JSON.parse restores session intact', async () => {
        const original = makeRealisticSession({ id: 'rt-001', title: 'Round-trip test' });
        await archive.save(original.id, original.source, JSON.stringify(original));

        const raw = await archive.loadRaw(original.id, original.source);
        assert.ok(raw, 'loadRaw should return content');
        const restored = JSON.parse(raw!) as Session;

        assert.strictEqual(restored.id, original.id);
        assert.strictEqual(restored.title, original.title);
        assert.strictEqual(restored.source, original.source);
        assert.strictEqual(restored.workspaceId, original.workspaceId);
        assert.strictEqual(restored.workspacePath, original.workspacePath);
        assert.strictEqual(restored.createdAt, original.createdAt);
        assert.strictEqual(restored.updatedAt, original.updatedAt);
    });

    test('messages are fully preserved through round-trip', async () => {
        const original = makeRealisticSession({ id: 'rt-002' });
        await archive.save(original.id, original.source, JSON.stringify(original));

        const raw = await archive.loadRaw(original.id, original.source);
        const restored = JSON.parse(raw!) as Session;

        assert.strictEqual(restored.messages.length, original.messages.length,
            'Message count should be preserved');
        for (let i = 0; i < original.messages.length; i++) {
            assert.strictEqual(restored.messages[i].role,    original.messages[i].role);
            assert.strictEqual(restored.messages[i].content, original.messages[i].content);
        }
    });

    test('session with code blocks survives round-trip', async () => {
        const codeMsg = makeMessage('assistant',
            'Here is a TypeScript snippet:\n\n```typescript\nconst x: number = 42;\n```');
        const original = makeRealisticSession({
            id: 'rt-code',
            messages: [
                makeMessage('user', 'Show me a TypeScript example.'),
                codeMsg,
            ],
        });
        await archive.save(original.id, original.source, JSON.stringify(original));

        const raw = await archive.loadRaw(original.id, original.source);
        const restored = JSON.parse(raw!) as Session;
        assert.ok(restored.messages[1].content.includes('```typescript'),
            'Code block should survive round-trip');
    });

    test('session with optional model field survives round-trip', async () => {
        const original = makeRealisticSession({ id: 'rt-model', model: 'gpt-4o' });
        await archive.save(original.id, original.source, JSON.stringify(original));

        const raw = await archive.loadRaw(original.id, original.source);
        const restored = JSON.parse(raw!) as Session;
        assert.strictEqual(restored.model, 'gpt-4o');
    });

    test('session with archived=true field survives round-trip', async () => {
        const original: Session = { ...makeRealisticSession({ id: 'rt-arch' }), archived: true };
        await archive.save(original.id, original.source, JSON.stringify(original));

        const raw = await archive.loadRaw(original.id, original.source);
        const restored = JSON.parse(raw!) as Session;
        assert.strictEqual(restored.archived, true);
    });

});

// ---------------------------------------------------------------------------
// Suite: multi-session manifest
// ---------------------------------------------------------------------------

suite('Archive workflow — multi-session manifest', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wf-multi-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('save 3 sessions; new instance loadAllSources() returns all 3', async () => {
        const sessions = [
            makeRealisticSession({ id: 'ms-1', title: 'First session' }),
            makeRealisticSession({ id: 'ms-2', title: 'Second session', source: 'claude' }),
            makeRealisticSession({ id: 'ms-3', title: 'Third session',  source: 'copilot' }),
        ];
        for (const s of sessions) {
            await archive.save(s.id, s.source, JSON.stringify(s));
        }

        // Simulate VS Code restart
        const archive2 = new SessionArchive(tmpDir);
        const all = await archive2.loadAllSources();

        assert.strictEqual(all.length, 3, 'All 3 sessions should be found after restart');
        const ids = new Set(all.map(a => a.sessionId));
        assert.ok(ids.has('ms-1') && ids.has('ms-2') && ids.has('ms-3'), 'All session IDs should be present');
    });

    test('save sessions across 3 sources; loadAll(source) returns only matching source', async () => {
        await archive.save('x-copilot', 'copilot', JSON.stringify(makeRealisticSession({ id: 'x-copilot', source: 'copilot' })));
        await archive.save('x-claude',  'claude',  JSON.stringify(makeRealisticSession({ id: 'x-claude',  source: 'claude'  })));
        await archive.save('x-cursor',  'cursor',  JSON.stringify(makeRealisticSession({ id: 'x-cursor',  source: 'cursor'  })));

        const copilotSessions = await archive.loadAll('copilot');
        assert.strictEqual(copilotSessions.length, 1);
        assert.strictEqual(copilotSessions[0].sessionId, 'x-copilot');

        const claudeSessions = await archive.loadAll('claude');
        assert.strictEqual(claudeSessions.length, 1);
        assert.strictEqual(claudeSessions[0].sessionId, 'x-claude');
    });

    test('concurrent saves to different sources do not corrupt manifest', async () => {
        // Save 6 sessions in rapid parallel (all to different source+id combinations)
        const pairs: Array<{ id: string; source: SessionSource }> = [
            { id: 'c1', source: 'copilot' }, { id: 'c2', source: 'copilot' },
            { id: 'cl1', source: 'claude' }, { id: 'cl2', source: 'claude' },
            { id: 'cu1', source: 'cursor' }, { id: 'cu2', source: 'cursor' },
        ];
        await Promise.all(pairs.map(({ id, source }) =>
            archive.save(id, source, JSON.stringify(makeRealisticSession({ id, source })))
        ));

        const stats = await archive.stats();
        assert.strictEqual(stats.totalSessions, 6, 'All 6 sessions should be indexed after concurrent saves');
    });

});

// ---------------------------------------------------------------------------
// Suite: delete-then-findAnySource workflow
// ---------------------------------------------------------------------------

suite('Archive workflow — delete lifecycle', () => {

    let tmpDir: string;
    let archive: SessionArchive;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wf-del-'));
        archive = new SessionArchive(tmpDir);
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('full delete lifecycle: save → findAnySource → delete → findAnySource returns undefined', async () => {
        const session = makeRealisticSession({ id: 'dl-001' });
        await archive.save(session.id, session.source, JSON.stringify(session));

        // Confirm it exists
        const found = await archive.findAnySource('dl-001');
        assert.ok(found !== undefined, 'session should exist after save');

        // Delete it
        const deleted = await archive.delete('dl-001', 'copilot');
        assert.strictEqual(deleted, true);

        // Confirm it's gone
        const afterDelete = await archive.findAnySource('dl-001');
        assert.strictEqual(afterDelete, undefined, 'session should be gone after delete');
    });

    test('delete workflow with source mismatch: delete(id, wrongSource) returns false, session remains', async () => {
        const session = makeRealisticSession({ id: 'dl-wrong-src', source: 'claude' });
        await archive.save(session.id, session.source, JSON.stringify(session));

        // Try to delete with wrong source
        const result = await archive.delete('dl-wrong-src', 'copilot');
        assert.strictEqual(result, false, 'delete with wrong source should return false');

        // Original should still be findable
        const still = await archive.findAnySource('dl-wrong-src');
        assert.ok(still !== undefined, 'original session should still exist');
        assert.strictEqual(still!.source, 'claude');
    });

    test('saveCount → deleteCount → stats cycle is consistent', async () => {
        const N = 5;
        for (let i = 0; i < N; i++) {
            const s = makeRealisticSession({ id: `cycle-${i}`, source: 'copilot' });
            await archive.save(s.id, s.source, JSON.stringify(s));
        }
        assert.strictEqual((await archive.stats()).totalSessions, N, `Should have ${N} sessions`);

        // Delete 2 sessions
        await archive.delete('cycle-1', 'copilot');
        await archive.delete('cycle-3', 'copilot');
        assert.strictEqual((await archive.stats()).totalSessions, N - 2, `Should have ${N - 2} sessions after deleting 2`);

        // Remaining sessions should still be retrievable
        for (const id of ['cycle-0', 'cycle-2', 'cycle-4']) {
            const raw = await archive.loadRaw(id, 'copilot');
            assert.ok(raw, `Session "${id}" should still be loadable`);
        }
    });

});
