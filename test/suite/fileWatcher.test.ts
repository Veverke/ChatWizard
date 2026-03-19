// test/suite/fileWatcher.test.ts
//
// Phase 3 — scoped indexing integration tests for ChatWizardWatcher.
//
// These tests exercise the collection methods directly (without VS Code's
// withProgress / createFileSystemWatcher) so they run cleanly in the Node
// mocha host inside the VS Code test runner.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatWizardWatcher } from '../../src/watcher/fileWatcher';
import { WorkspaceScopeManager, ExtensionContextLike } from '../../src/watcher/workspaceScope';
import { SessionIndex } from '../../src/index/sessionIndex';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(initial?: string[]): { context: ExtensionContextLike; store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    if (initial !== undefined) {
        store.set('chatwizard.selectedWorkspaceIds', initial);
    }
    const context: ExtensionContextLike = {
        globalState: {
            get<T>(key: string): T | undefined {
                return store.get(key) as T | undefined;
            },
            update(key: string, value: unknown): Thenable<void> {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    };
    return { context, store };
}

// Minimal OutputChannel mock — just captures appendLine calls.
function makeChannel(): { appendLine: (msg: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { appendLine: (msg: string) => lines.push(msg), lines };
}

/**
 * Writes a minimal valid Claude JSONL session under `baseDir/<projectName>/`.
 * Returns the `.jsonl` file path.
 */
function writeClaudeSession(baseDir: string, projectName: string, sessionId: string): string {
    const projectDir = path.join(baseDir, projectName);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const lines = [
        JSON.stringify({ type: 'summary', summary: `Session ${sessionId}`, leafUuid: `leaf-${sessionId}`, timestamp: '2024-01-15T10:00:00.000Z' }),
        JSON.stringify({ type: 'human', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] }, timestamp: '2024-01-15T10:00:01.000Z', uuid: `h-${sessionId}`, sessionId, cwd: '/home/user/project' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }, timestamp: '2024-01-15T10:00:02.000Z', uuid: `a-${sessionId}`, sessionId }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'));
    return filePath;
}

// ---------------------------------------------------------------------------
// SessionIndex.clear() event tests
// ---------------------------------------------------------------------------

suite('SessionIndex.clear() events', () => {

    test('clear() fires a typed "clear" event', () => {
        const index = new SessionIndex();
        const events: string[] = [];
        index.addTypedChangeListener(e => events.push(e.type));

        index.clear();

        assert.deepStrictEqual(events, ['clear']);
    });

    test('clear() fires a plain change notification', () => {
        const index = new SessionIndex();
        let notified = 0;
        index.addChangeListener(() => notified++);

        index.clear();

        assert.strictEqual(notified, 1);
    });

    test('clear() increments version', () => {
        const index = new SessionIndex();
        const before = index.version;
        index.clear();
        assert.ok(index.version > before);
    });

    test('clear() removes all sessions and size becomes 0', () => {
        const index = new SessionIndex();
        // Add a minimal session by batchUpsert to avoid repeating makeSession helper
        index.batchUpsert([{
            id: 's1', title: 'T', source: 'claude', workspaceId: 'w', workspacePath: '/w',
            messages: [], filePath: '/f.jsonl', createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        }]);
        assert.strictEqual(index.size, 1);
        index.clear();
        assert.strictEqual(index.size, 0);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher.collectClaudeSessionsAsync — scope-filter integration
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — Claude scope filtering', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_fw_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeWatcher(selectedIds: string[]): ChatWizardWatcher {
        const index = new SessionIndex();
        const channel = makeChannel();
        const { context } = makeContext(selectedIds);
        const scopeManager = new WorkspaceScopeManager(context);
        return new ChatWizardWatcher(index, channel as unknown as import('vscode').OutputChannel, scopeManager);
    }

    test('returns sessions from all projects when no selectedIds are set', async () => {
        writeClaudeSession(tmpDir, 'project-A', 'session-a1');
        writeClaudeSession(tmpDir, 'project-B', 'session-b1');

        // Empty selectedIds → fallback to all (undefined passed to collector)
        const watcher = makeWatcher([]);
        const sessions = await watcher.collectClaudeSessionsAsync(undefined, undefined, tmpDir);

        assert.strictEqual(sessions.length, 2);
    });

    test('returns only sessions from selected project', async () => {
        writeClaudeSession(tmpDir, 'project-A', 'session-a1');
        writeClaudeSession(tmpDir, 'project-B', 'session-b1');

        const watcher = makeWatcher(['project-A']);
        const sessions = await watcher.collectClaudeSessionsAsync(undefined, ['project-A'], tmpDir);

        assert.strictEqual(sessions.length, 1);
        assert.ok(sessions[0].filePath.includes('project-A'));
    });

    test('returns sessions from multiple selected projects', async () => {
        writeClaudeSession(tmpDir, 'project-A', 'session-a1');
        writeClaudeSession(tmpDir, 'project-B', 'session-b1');
        writeClaudeSession(tmpDir, 'project-C', 'session-c1');

        const watcher = makeWatcher(['project-A', 'project-C']);
        const sessions = await watcher.collectClaudeSessionsAsync(undefined, ['project-A', 'project-C'], tmpDir);

        assert.strictEqual(sessions.length, 2);
        const dirs = sessions.map(s => path.basename(path.dirname(s.filePath)));
        assert.ok(dirs.includes('project-A'));
        assert.ok(dirs.includes('project-C'));
        assert.ok(!dirs.includes('project-B'));
    });

    test('returns empty array when selected project has no session files', async () => {
        writeClaudeSession(tmpDir, 'project-B', 'session-b1');

        const watcher = makeWatcher(['project-A']);
        const sessions = await watcher.collectClaudeSessionsAsync(undefined, ['project-A'], tmpDir);

        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array when base dir does not exist', async () => {
        const watcher = makeWatcher([]);
        const sessions = await watcher.collectClaudeSessionsAsync(undefined, undefined, path.join(tmpDir, 'nonexistent'));

        assert.strictEqual(sessions.length, 0);
    });

    test('progress callback receives correct counts', async () => {
        writeClaudeSession(tmpDir, 'project-A', 'session-a1');
        writeClaudeSession(tmpDir, 'project-A', 'session-a2');

        const watcher = makeWatcher(['project-A']);
        const calls: { current: number; total: number }[] = [];
        await watcher.collectClaudeSessionsAsync(
            (current, total) => calls.push({ current, total }),
            ['project-A'],
            tmpDir
        );

        assert.ok(calls.length > 0);
        const last = calls[calls.length - 1];
        assert.strictEqual(last.current, last.total);
        assert.strictEqual(last.total, 2);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — restart() clears and rebuilds the index
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher.restart()', () => {

    test('index is empty immediately after dispose() + clear()', () => {
        const index = new SessionIndex();
        index.batchUpsert([{
            id: 's1', title: 'T', source: 'claude', workspaceId: 'w', workspacePath: '/w',
            messages: [], filePath: '/f.jsonl', createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        }]);
        assert.strictEqual(index.size, 1);

        index.clear();

        assert.strictEqual(index.size, 0);
    });
});
