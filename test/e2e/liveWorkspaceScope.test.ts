// test/e2e/liveWorkspaceScope.test.ts
//
// Live-path workspace scoping — end-to-end through the real handlers.
//
// Regression cover for: a chat belonging to workspace B showing up in the
// Sessions view of a window whose open folder is workspace A. The batch
// collector and the cache restore already filtered by scope, but the live
// handlers (`onClineV4SessionDirChanged`, `onClineFileChanged`,
// `onRooCodeFileChanged`, `onAiderFileChanged`, `onFileChanged` for Claude)
// upserted straight into the index — and Cline 4.x keeps every workspace's
// chats in one machine-global folder (`~/.cline/data/sessions`), so any live
// chat leaked into every window.
//
// The handlers are private; they are invoked directly here (same spirit as
// `fileWatcher.test.ts`, which calls the collectors directly) so the test
// exercises parse + scope + index without depending on VS Code's watcher.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatWizardWatcher } from '../../src/watcher/fileWatcher';
import { WorkspaceScopeManager, ExtensionContextLike } from '../../src/watcher/workspaceScope';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeContext(): ExtensionContextLike {
    const store = new Map<string, unknown>();
    return {
        globalState: {
            get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
            update(key: string, value: unknown): Thenable<void> {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    };
}

interface Harness {
    watcher: ChatWizardWatcher;
    index: SessionIndex;
    lines: string[];
}

/**
 * Builds a watcher whose scope is pinned to `openFolders` / `selectedIds`
 * (the real manager reads `vscode.workspace.workspaceFolders`, which would make
 * the assertions depend on how the test host was launched).
 */
function makeHarness(openFolders: string[], selectedIds: string[] = []): Harness {
    const index = new SessionIndex();
    const lines: string[] = [];
    const channel = { appendLine: (msg: string) => lines.push(msg) } as unknown as vscode.OutputChannel;
    const scopeManager = new WorkspaceScopeManager(makeContext());
    (scopeManager as unknown as { getOpenFolderPaths: () => string[] }).getOpenFolderPaths = () => openFolders;
    (scopeManager as unknown as { getSelectedIds: () => string[] }).getSelectedIds = () => selectedIds;
    const watcher = new ChatWizardWatcher(index, channel, scopeManager);
    return { watcher, index, lines };
}

/** Invokes a private live handler (they are only reachable via a real FS event otherwise). */
function callPrivate(watcher: ChatWizardWatcher, name: string, ...args: unknown[]): unknown {
    const fn = (watcher as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    return fn.apply(watcher, args);
}

function tmpRoot(label: string): string {
    const dir = path.join(os.tmpdir(), `cw-live-scope-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function waitForHandler(p: unknown): Promise<void> {
    if (p instanceof Promise) { await p; }
}

/** Minimal indexed session, used to simulate a stale out-of-scope entry. */
function makeSession(id: string, source: Session['source'], workspacePath: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId: id,
        workspacePath,
        messages: [],
        filePath: path.join(workspacePath, `${id}.json`),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Writes `<root>/<id>/<id>.json` + `.messages.json` and returns the session dir. */
function writeCline4Session(root: string, id: string, workspaceRoot: string): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
        version: 1,
        session_id: id,
        source: 'vscode',
        started_at: '2026-11-19T09:25:24.060Z',
        status: 'running',
        provider: 'cline',
        model: 'cline-pass/deepseek-v4.1-flash-1017',
        cwd: workspaceRoot,
        workspace_root: workspaceRoot,
        prompt: 'Changes to the chat reader webview ENTITIES functionality:',
        metadata: {
            title: 'Changes to the chat reader webview ENTITIES functionality:',
            modelId: 'cline-pass/deepseek-v4.1-flash-1017',
        },
    };
    const transcript = {
        version: 1,
        updated_at: '2026-11-19T09:29:25.040Z',
        sessionId: id,
        messages: [
            {
                id: 'm1',
                role: 'user',
                ts: 1795080327429,
                content: [{ type: 'text', text: 'Changes to the chat reader webview ENTITIES functionality:' }],
            },
            {
                id: 'm2',
                role: 'assistant',
                ts: 1795080328000,
                content: [{ type: 'text', text: 'Working on it.' }],
            },
        ],
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, `${id}.messages.json`), JSON.stringify(transcript, null, 2), 'utf8');
    return dir;
}

/** Writes a legacy Cline/Roo task directory and returns its `api_conversation_history.json`. */
function writeLegacyTask(root: string, taskId: string, cwd: string): string {
    const taskDir = path.join(root, taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const uiMessages = [
        { ts: 1700000000000, type: 'say', say: 'task', text: 'Refactor this function', cwd, model: 'claude-3-opus' },
        { ts: 1700000060000, type: 'say', say: 'text', text: 'Sure, here is the refactored version.' },
    ];
    const apiHistory = [
        { role: 'user', content: 'Refactor this function' },
        { role: 'assistant', content: 'Sure, here is the refactored version.' },
    ];
    fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify(uiMessages), 'utf8');
    const apiPath = path.join(taskDir, 'api_conversation_history.json');
    fs.writeFileSync(apiPath, JSON.stringify(apiHistory), 'utf8');
    return apiPath;
}

/** Writes `<base>/<projectDirName>/<sessionId>.jsonl` and returns the file path. */
function writeClaudeSession(base: string, projectDirName: string, sessionId: string, cwd: string): string {
    const projectDir = path.join(base, projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const lines = [
        JSON.stringify({ type: 'summary', summary: `Session ${sessionId}`, leafUuid: `leaf-${sessionId}`, timestamp: '2024-01-15T10:00:00.000Z' }),
        JSON.stringify({ type: 'human', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] }, timestamp: '2024-01-15T10:00:01.000Z', uuid: `h-${sessionId}`, sessionId, cwd }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }, timestamp: '2024-01-15T10:00:02.000Z', uuid: `a-${sessionId}`, sessionId }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
}

/** Writes `.aider.chat.history.md` into `dir` and returns the file path. */
function writeAiderHistory(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, '.aider.chat.history.md');
    fs.writeFileSync(filePath, [
        '# aider chat started at 2024-11-15 09:23:45',
        '',
        '#### Help me refactor this function',
        '',
        'Sure! Here is the refactored version.',
        '',
    ].join('\n'), 'utf8');
    return filePath;
}

// ---------------------------------------------------------------------------
// Cline 4.x — `~/.cline/data/sessions` is machine-global (all workspaces)
// ---------------------------------------------------------------------------

suite('Live scope — Cline 4.x', () => {

    let root: string;
    let selling: string;
    let chatwizard: string;

    setup(() => {
        root = tmpRoot('cline4');
        selling = path.join(root, 'selling');
        chatwizard = path.join(root, 'ChatWizard');
        fs.mkdirSync(selling, { recursive: true });
        fs.mkdirSync(chatwizard, { recursive: true });
    });

    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('indexes a session whose workspace_root is the open folder', async () => {
        const dir = writeCline4Session(path.join(root, 'cline', 'sessions'), '1795000000000_in', selling);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onClineV4SessionDirChanged', dir));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });

    test('does NOT index a session from another workspace (ENTITIES chat leak)', async () => {
        const dir = writeCline4Session(path.join(root, 'cline', 'sessions'), '1795080323741_out', chatwizard);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onClineV4SessionDirChanged', dir));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
        assert.ok(
            h.lines.some(l => l.includes('skipped out-of-scope') && l.includes('1795080323741_out')),
            `expected a skip log line, got:\n${h.lines.join('\n')}`
        );
    });

    test('removes a stale out-of-scope copy that is already indexed', async () => {
        const id = '1795080323741_stale';
        const dir = writeCline4Session(path.join(root, 'cline', 'sessions'), id, chatwizard);
        const h = makeHarness([selling]);
        h.index.upsert(makeSession(id, 'cline', chatwizard));
        assert.strictEqual(h.index.size, 1);
        await waitForHandler(callPrivate(h.watcher, 'onClineV4SessionDirChanged', dir));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
    });

    test('a window with no open folder cannot be scoped — session is indexed', async () => {
        const dir = writeCline4Session(path.join(root, 'cline', 'sessions'), '1795000000001_nofolder', chatwizard);
        const h = makeHarness([]);
        await waitForHandler(callPrivate(h.watcher, 'onClineV4SessionDirChanged', dir));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });

    test('a sub-directory of the open folder is in scope', async () => {
        const nested = path.join(selling, 'selling-service');
        const dir = writeCline4Session(path.join(root, 'cline', 'sessions'), '1795000000002_nested', nested);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onClineV4SessionDirChanged', dir));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });
});

// ---------------------------------------------------------------------------
// Legacy Cline tasks + Roo Code tasks (VS Code globalStorage, all workspaces)
// ---------------------------------------------------------------------------

suite('Live scope — legacy Cline and Roo Code tasks', () => {

    let root: string;
    let selling: string;
    let chatwizard: string;

    setup(() => {
        root = tmpRoot('legacy');
        selling = path.join(root, 'selling');
        chatwizard = path.join(root, 'ChatWizard');
        fs.mkdirSync(selling, { recursive: true });
        fs.mkdirSync(chatwizard, { recursive: true });
    });

    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('cline: task whose cwd is the open folder is indexed', async () => {
        const apiPath = writeLegacyTask(path.join(root, 'tasks'), 'task-in', selling);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onClineFileChanged', vscode.Uri.file(apiPath)));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });

    test('cline: task from another workspace is not indexed', async () => {
        const apiPath = writeLegacyTask(path.join(root, 'tasks'), 'task-out', chatwizard);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onClineFileChanged', vscode.Uri.file(apiPath)));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
    });

    test('roocode: task from another workspace is not indexed', async () => {
        const apiPath = writeLegacyTask(path.join(root, 'roo-tasks'), 'roo-out', chatwizard);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onRooCodeFileChanged', vscode.Uri.file(apiPath)));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
    });
});

// ---------------------------------------------------------------------------
// Claude — `~/.claude/projects` is machine-global; scoped by project dir name
// ---------------------------------------------------------------------------

suite('Live scope — Claude', () => {

    let root: string;
    let projects: string;

    setup(() => {
        root = tmpRoot('claude');
        projects = path.join(root, '.claude', 'projects');
        fs.mkdirSync(projects, { recursive: true });
    });

    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('indexes a session whose project directory is selected', async () => {
        const file = writeClaudeSession(projects, 'c--repo-selling', 'sess-in', '/repo/selling');
        const h = makeHarness(['/repo/selling'], ['c--repo-selling']);
        await waitForHandler(callPrivate(h.watcher, 'onFileChanged', vscode.Uri.file(file), 'claude'));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });

    test('does NOT index a session whose project directory is not selected', async () => {
        const file = writeClaudeSession(projects, 'c--repo-ChatWizard', 'sess-out', '/repo/ChatWizard');
        const h = makeHarness(['/repo/selling'], ['c--repo-selling']);
        await waitForHandler(callPrivate(h.watcher, 'onFileChanged', vscode.Uri.file(file), 'claude'));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
        assert.ok(
            h.lines.some(l => l.includes('skipped out-of-scope') && l.includes('sess-out')),
            `expected a skip log line, got:\n${h.lines.join('\n')}`
        );
    });
});

// ---------------------------------------------------------------------------
// Aider — workspace-relative history file
// ---------------------------------------------------------------------------

suite('Live scope — Aider', () => {

    let root: string;

    setup(() => { root = tmpRoot('aider'); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('indexes a history file inside the open folder', async () => {
        const selling = path.join(root, 'selling');
        const file = writeAiderHistory(selling);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onAiderFileChanged', vscode.Uri.file(file)));
        assert.strictEqual(h.index.size, 1, h.lines.join('\n'));
    });

    test('does NOT index a history file outside the open folder', async () => {
        const selling = path.join(root, 'selling');
        const other = path.join(root, 'ChatWizard');
        fs.mkdirSync(selling, { recursive: true });
        const file = writeAiderHistory(other);
        const h = makeHarness([selling]);
        await waitForHandler(callPrivate(h.watcher, 'onAiderFileChanged', vscode.Uri.file(file)));
        assert.strictEqual(h.index.size, 0, h.lines.join('\n'));
    });
});

