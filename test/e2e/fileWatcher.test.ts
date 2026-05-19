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

// ---------------------------------------------------------------------------
// Helpers for new collect* tests
// ---------------------------------------------------------------------------

function makeWatcherWithMocks(selectedIds: string[] = []): ChatWizardWatcher {
    const index = new SessionIndex();
    const channel = makeChannel();
    const { context } = makeContext(selectedIds);
    const scopeManager = new WorkspaceScopeManager(context);
    return new ChatWizardWatcher(index, channel as unknown as import('vscode').OutputChannel, scopeManager);
}

function writeClineTask(root: string, taskId: string): string {
    const taskDir = path.join(root, taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const uiMessages = [
        { ts: 1700000000000, type: 'say', say: 'task', text: 'Refactor this function', cwd: '/home/user/project', model: 'claude-3-opus' },
        { ts: 1700000060000, type: 'say', say: 'text', text: 'Sure, here is the refactored version.' },
    ];
    fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify(uiMessages), 'utf-8');
    const apiHistory = [
        { role: 'user', content: 'Refactor this function' },
        { role: 'assistant', content: 'Sure, here is the refactored version.' },
    ];
    fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), JSON.stringify(apiHistory), 'utf-8');
    return taskDir;
}

function writeAiderHistory(dir: string, filename = '.aider.chat.history.md'): string {
    const filePath = path.join(dir, filename);
    const content = [
        '# aider chat started at 2024-11-15 09:23:45',
        '',
        '#### Help me refactor this function',
        '',
        'Sure! Here is the refactored version.',
        '',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

function writeAntigravityConversation(brainRoot: string, conversationId: string): void {
    const logDir = path.join(brainRoot, conversationId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const lines = [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-01T08:00:00Z', content: '<USER_REQUEST>\nWhat is 2+2?\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-02-01T08:00:05Z', content: 'The answer is 4.' }),
    ];
    fs.writeFileSync(path.join(logDir, 'overview.txt'), lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectClineTasksAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectClineTasksAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_cline_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for non-existent root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectClineTasksAsync(undefined, path.join(tmpDir, 'nonexistent'));
        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array for empty root directory', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectClineTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 0);
    });

    test('returns one session for a single valid Cline task', async () => {
        writeClineTask(tmpDir, 'task-001');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectClineTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 1);
    });

    test('returned session has source=cline', async () => {
        writeClineTask(tmpDir, 'task-002');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectClineTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions[0].source, 'cline');
    });

    test('returns all sessions from multiple tasks', async () => {
        writeClineTask(tmpDir, 'task-003');
        writeClineTask(tmpDir, 'task-004');
        writeClineTask(tmpDir, 'task-005');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectClineTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 3);
    });

    test('progress callback is called for each task', async () => {
        writeClineTask(tmpDir, 'task-prog-1');
        writeClineTask(tmpDir, 'task-prog-2');
        const watcher = makeWatcherWithMocks();
        const calls: Array<[number, number]> = [];
        await watcher.collectClineTasksAsync((cur, tot) => calls.push([cur, tot]), tmpDir);
        assert.ok(calls.length >= 2);
        const [lastCur, lastTot] = calls[calls.length - 1];
        assert.strictEqual(lastCur, lastTot);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectRooCodeTasksAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectRooCodeTasksAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_roo_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for non-existent root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectRooCodeTasksAsync(undefined, path.join(tmpDir, 'nonexistent'));
        assert.strictEqual(sessions.length, 0);
    });

    test('returns sessions for valid RooCode tasks', async () => {
        writeClineTask(tmpDir, 'roo-task-001');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectRooCodeTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 1);
    });

    test('returned session has source=roocode', async () => {
        writeClineTask(tmpDir, 'roo-task-002');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectRooCodeTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions[0].source, 'roocode');
    });

    test('returns empty for empty directory', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectRooCodeTasksAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 0);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectCursorSessionsAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectCursorSessionsAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_cursor_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for non-existent root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectCursorSessionsAsync(undefined, path.join(tmpDir, 'nonexistent'), path.join(tmpDir, 'no-global.db'));
        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array when root has no workspace subdirs', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectCursorSessionsAsync(undefined, tmpDir, path.join(tmpDir, 'no-global.db'));
        assert.strictEqual(sessions.length, 0);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectWindsurfSessionsAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectWindsurfSessionsAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_windsurf_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for non-existent root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectWindsurfSessionsAsync(undefined, path.join(tmpDir, 'nonexistent'));
        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array when root has no workspace subdirs', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectWindsurfSessionsAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 0);
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectAiderSessionsAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectAiderSessionsAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_aider_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for empty roots array', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAiderSessionsAsync(undefined, []);
        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array for directory with no aider history files', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAiderSessionsAsync(undefined, [tmpDir]);
        assert.strictEqual(sessions.length, 0);
    });

    test('returns session for directory with .aider.chat.history.md', async () => {
        writeAiderHistory(tmpDir);
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAiderSessionsAsync(undefined, [tmpDir]);
        assert.strictEqual(sessions.length, 1);
    });

    test('returned session has source=aider', async () => {
        writeAiderHistory(tmpDir);
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAiderSessionsAsync(undefined, [tmpDir]);
        assert.strictEqual(sessions[0].source, 'aider');
    });

    test('returns sessions from multiple root directories', async () => {
        const dir2 = path.join(os.tmpdir(), `cw_aider_test2_${Date.now()}`);
        fs.mkdirSync(dir2, { recursive: true });
        try {
            writeAiderHistory(tmpDir);
            writeAiderHistory(dir2);
            const watcher = makeWatcherWithMocks();
            const sessions = await watcher.collectAiderSessionsAsync(undefined, [tmpDir, dir2]);
            assert.strictEqual(sessions.length, 2);
        } finally {
            fs.rmSync(dir2, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// ChatWizardWatcher — collectAntigravitySessionsAsync
// ---------------------------------------------------------------------------

suite('ChatWizardWatcher — collectAntigravitySessionsAsync', () => {

    let tmpDir: string;

    setup(() => {
        tmpDir = path.join(os.tmpdir(), `cw_ag_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty array for non-existent brain root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAntigravitySessionsAsync(undefined, path.join(tmpDir, 'nonexistent'));
        assert.strictEqual(sessions.length, 0);
    });

    test('returns empty array for empty brain root', async () => {
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAntigravitySessionsAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 0);
    });

    test('returns session for valid Antigravity conversation', async () => {
        writeAntigravityConversation(tmpDir, 'conv-aaa-111');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAntigravitySessionsAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 1);
    });

    test('returned session has source=antigravity', async () => {
        writeAntigravityConversation(tmpDir, 'conv-bbb-222');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAntigravitySessionsAsync(undefined, tmpDir);
        assert.strictEqual(sessions[0].source, 'antigravity');
    });

    test('returns all sessions from multiple conversations', async () => {
        writeAntigravityConversation(tmpDir, 'conv-1');
        writeAntigravityConversation(tmpDir, 'conv-2');
        writeAntigravityConversation(tmpDir, 'conv-3');
        const watcher = makeWatcherWithMocks();
        const sessions = await watcher.collectAntigravitySessionsAsync(undefined, tmpDir);
        assert.strictEqual(sessions.length, 3);
    });

    test('progress callback is invoked for each conversation', async () => {
        writeAntigravityConversation(tmpDir, 'conv-p1');
        writeAntigravityConversation(tmpDir, 'conv-p2');
        const watcher = makeWatcherWithMocks();
        const calls: Array<[number, number]> = [];
        await watcher.collectAntigravitySessionsAsync((cur, tot) => calls.push([cur, tot]), tmpDir);
        assert.ok(calls.length >= 2);
    });
});
