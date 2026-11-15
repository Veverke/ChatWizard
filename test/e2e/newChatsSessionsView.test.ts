// test/e2e/newChatsSessionsView.test.ts
//
// E2E regression suite for "a new chat does not show up in the Sessions view".
//
// The Cline 4.x and Copilot agent-host updates moved chat storage to brand-new
// locations (`~/.cline/data/sessions/<id>/` and
// `<COPILOT_HOME>/session-state/<id>/`). When discovery does not follow the new
// layout, chats created after the update never reach the Sessions view.
//
// For every platform Chat Wizard indexes, this suite:
//   1. starts from an empty, isolated storage layout (temp directories only),
//   2. creates a brand-new chat exactly where the platform writes it,
//   3. runs the same discovery + parse chain the extension runs on startup /
//      re-index, pushes the result through SessionIndex, and
//   4. verifies the chat is rendered by SessionTreeProvider — i.e. it appears
//      under the "Sessions" view.
//
// The final suite verifies the live contract: chats created *after* the
// Sessions view has been constructed show up without restarting the extension.
//
// Collection entry points used per platform:
//   - watcher.collect*Async(...) — the production collection methods; explicit
//     temp-root overrides keep the test away from real user storage.
//   - For Continue / Amazon Q / Gemini the collectors read their storage root
//     from `chatwizard.*StoragePath`, so the suite points those settings at the
//     temp roots and calls the collectors.
//   - Tabnine has no storage-path setting, so its discovery + parser are called
//     directly with the temp root (the same two functions the collector uses).
//
// Run just this suite:
//   npx vscode-test --run out/test/e2e/newChatsSessionsView.test.js
// (It also runs as part of the normal `npm test` e2e configuration.)

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SessionIndex } from '../../src/index/sessionIndex';
import {
    SessionTreeProvider,
    SessionTreeItem,
    SessionTreeNode,
    DateGroupTreeItem,
} from '../../src/views/sessionTreeProvider';
import { ChatWizardWatcher } from '../../src/watcher/fileWatcher';
import { WorkspaceScopeManager, ExtensionContextLike } from '../../src/watcher/workspaceScope';
import { Session, SessionSource } from '../../src/types/index';
import { createCursorDb, createWindsurfDb } from '../helpers/fixtureFactory';
import { discoverTabnineConversationsAsync } from '../../src/readers/tabnineWorkspace';
import { parseTabnineConversation } from '../../src/parsers/tabnine';

// ---------------------------------------------------------------------------
// Fixtures & small filesystem helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../..', 'test', 'fixtures');

function fixturePath(relativePath: string): string {
    return path.join(FIXTURES, ...relativePath.split('/'));
}

/** Copies a fixture file or directory to `destination` (created if needed). */
function copyFixture(relativePath: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(fixturePath(relativePath), destination, { recursive: true });
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function writeJsonFile(filePath: string, value: unknown): void {
    writeTextFile(filePath, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// VS Code configuration helpers
// ---------------------------------------------------------------------------

interface ConfigSnapshot {
    key: string;
    previous: string | undefined;
}

async function setChatwizardSetting(key: string, value: string): Promise<ConfigSnapshot> {
    const cfg = vscode.workspace.getConfiguration('chatwizard');
    const previous = cfg.get<string>(key);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    return { key, previous };
}

async function restoreChatwizardSetting(snapshot: ConfigSnapshot): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('chatwizard');
    await cfg.update(snapshot.key, snapshot.previous, vscode.ConfigurationTarget.Global);
}

// ---------------------------------------------------------------------------
// Watcher / tree-view helpers
// ---------------------------------------------------------------------------

function makeWatcher(index: SessionIndex): ChatWizardWatcher {
    const context: ExtensionContextLike = {
        globalState: {
            get: <T>(): T | undefined => undefined,
            update: () => Promise.resolve(),
        },
    };
    // ChatWizardWatcher only calls appendLine on the channel; a stub keeps the
    // test output clean without touching the real Chat Wizard output channel.
    const channel = { appendLine: (): void => undefined } as unknown as vscode.OutputChannel;
    return new ChatWizardWatcher(index, channel, new WorkspaceScopeManager(context));
}

/**
 * Walks the whole Sessions tree (flat, date, branch, tag and folder grouping)
 * and returns every rendered SessionTreeItem.
 */
function collectSessionsInView(provider: SessionTreeProvider): SessionTreeItem[] {
    const found: SessionTreeItem[] = [];
    const visited = new Set<SessionTreeNode>();

    const walk = (element?: SessionTreeNode): void => {
        for (const child of provider.getChildren(element)) {
            if (child instanceof SessionTreeItem) {
                found.push(child);
                continue;
            }
            if (visited.has(child)) { continue; }
            visited.add(child);
            walk(child);
        }
    };

    walk(undefined);
    return found;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) { return; }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    assert.fail(message);
}

// ---------------------------------------------------------------------------
// Isolated storage harness
// ---------------------------------------------------------------------------

/**
 * Every directory a platform could write to. All of them live under one
 * `mkdtemp` root so the suite can clean up with a single `rmSync`.
 */
interface Harness {
    root: string;
    copilotWorkspaceRoot: string;
    copilotProject: string;
    copilotAgentRoot: string;
    copilotAgentProject: string;
    claudeRoot: string;
    clineRoot: string;
    clineV4Root: string;
    clineV4Project: string;
    rooRoot: string;
    cursorRoot: string;
    cursorProject: string;
    windsurfRoot: string;
    windsurfProject: string;
    aiderProject: string;
    antigravityRoot: string;
    continueRoot: string;
    amazonqRoot: string;
    geminiRoot: string;
    tabnineRoot: string;
}

function makeHarness(): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-new-chats-'));

    const harness: Harness = {
        root,
        copilotWorkspaceRoot: path.join(root, 'copilot-workspaceStorage'),
        copilotProject: path.join(root, 'projects', 'copilot-project'),
        copilotAgentRoot: path.join(root, 'copilot-home', 'session-state'),
        copilotAgentProject: path.join(root, 'projects', 'copilot-agent-project'),
        claudeRoot: path.join(root, 'claude-projects'),
        clineRoot: path.join(root, 'cline-globalStorage', 'tasks'),
        clineV4Root: path.join(root, 'cline-data', 'sessions'),
        clineV4Project: path.join(root, 'projects', 'cline-v4-project'),
        rooRoot: path.join(root, 'roo-globalStorage', 'tasks'),
        cursorRoot: path.join(root, 'cursor-workspaceStorage'),
        cursorProject: path.join(root, 'projects', 'cursor-project'),
        windsurfRoot: path.join(root, 'windsurf-workspaceStorage'),
        windsurfProject: path.join(root, 'projects', 'windsurf-project'),
        aiderProject: path.join(root, 'projects', 'aider-project'),
        antigravityRoot: path.join(root, 'antigravity-brain'),
        continueRoot: path.join(root, 'continue-sessions'),
        amazonqRoot: path.join(root, 'amazonq-storage'),
        geminiRoot: path.join(root, 'gemini-storage'),
        tabnineRoot: path.join(root, 'tabnine-chat'),
    };

    // Workspace folders must exist on disk: Cursor/Windsurf/Copilot discovery
    // skips storage entries whose workspace path no longer exists.
    for (const projectDir of [
        harness.copilotProject,
        harness.copilotAgentProject,
        harness.clineV4Project,
        harness.cursorProject,
        harness.windsurfProject,
        harness.aiderProject,
    ]) {
        fs.mkdirSync(projectDir, { recursive: true });
    }

    return harness;
}

function workspaceJson(projectPath: string): string {
    return JSON.stringify({ folder: vscode.Uri.file(projectPath).toString() });
}

// ---------------------------------------------------------------------------
// Platform-specific "new chat" writers
// ---------------------------------------------------------------------------

/** Cline 4.x: `<sessionsRoot>/<id>/<id>.json` + `<id>.messages.json`. */
function writeClineV4Chat(harness: Harness, sessionId: string): void {
    const sessionDir = path.join(harness.clineV4Root, sessionId);
    writeJsonFile(path.join(sessionDir, `${sessionId}.json`), {
        version: 1,
        session_id: sessionId,
        source: 'vscode',
        started_at: '2026-11-11T17:49:46.484Z',
        ended_at: '2026-11-11T17:50:21.384Z',
        status: 'completed',
        provider: 'cline',
        model: 'cline-pass/deepseek-v4.1-flash-1017',
        cwd: harness.clineV4Project,
        workspace_root: harness.clineV4Project,
        prompt: 'New Cline 4.x chat',
        metadata: {
            title: 'New Cline 4.x chat',
            modelId: 'cline-pass/deepseek-v4.1-flash-1017',
        },
    });
    writeJsonFile(path.join(sessionDir, `${sessionId}.messages.json`), {
        version: 1,
        updated_at: '2026-11-11T17:50:21.384Z',
        sessionId,
        messages: [
            {
                id: 'm1',
                role: 'user',
                ts: 1794419388263,
                content: [{ type: 'text', text: '<user_input mode="act">New Cline 4.x chat</user_input>' }],
            },
            {
                id: 'm2',
                role: 'assistant',
                ts: 1794419389559,
                content: [{ type: 'text', text: 'Cline 4.x keeps chats under ~/.cline/data/sessions.' }],
            },
        ],
    });
}

/** Copilot agent-host: `<COPILOT_HOME>/session-state/<id>/{events.jsonl,workspace.yaml}`. */
function writeCopilotAgentChat(harness: Harness, sessionId: string): void {
    const sessionDir = path.join(harness.copilotAgentRoot, sessionId);

    writeTextFile(path.join(sessionDir, 'workspace.yaml'), [
        `id: ${sessionId}`,
        `cwd: ${harness.copilotAgentProject}`,
        `git_root: ${harness.copilotAgentProject}`,
        'repository: Veverke/ChatWizard',
        'host_type: github',
        'branch: v1.7-fixes',
        'client_name: vscode-agent-host',
        'name: New Copilot agent-host chat',
        'user_named: false',
        'created_at: 2026-11-12T23:23:17.872Z',
        'updated_at: 2026-11-12T23:23:47.027Z',
        '',
    ].join('\n'));

    const events = [
        {
            type: 'session.start',
            data: {
                sessionId,
                selectedModel: 'gpt-6-luna',
                context: { cwd: harness.copilotAgentProject, branch: 'v1.7-fixes' },
            },
            id: 'ev-1',
            timestamp: '2026-11-12T23:23:18.820Z',
        },
        {
            type: 'user.message',
            data: { content: 'New Copilot agent-host chat' },
            id: 'ev-2',
            timestamp: '2026-11-12T23:23:49.070Z',
        },
        {
            type: 'assistant.message',
            data: { content: 'Copilot agent-host session created.' },
            id: 'ev-3',
            timestamp: '2026-11-12T23:23:55.000Z',
        },
    ];
    writeTextFile(
        path.join(sessionDir, 'events.jsonl'),
        events.map(event => JSON.stringify(event)).join('\n') + '\n'
    );
}

// ---------------------------------------------------------------------------
// Platform matrix — one entry per chat platform the extension indexes
// ---------------------------------------------------------------------------

interface NewChatPlatform {
    /** Human-readable name used in test titles. */
    readonly name: string;
    /** Source the collected session(s) must carry. */
    readonly source: SessionSource;
    /** Creates the platform's brand-new chat in the isolated harness. */
    createChat(harness: Harness): void;
    /** Runs the production discovery + parse chain for this platform. */
    collect(harness: Harness, watcher: ChatWizardWatcher): Promise<Session[]>;
}

const PLATFORMS: NewChatPlatform[] = [
    {
        name: 'GitHub Copilot Chat (workspaceStorage/chatSessions)',
        source: 'copilot',
        createChat(harness) {
            const storageDir = path.join(harness.copilotWorkspaceRoot, 'copilot-workspace-hash');
            const chatSessionsDir = path.join(storageDir, 'chatSessions');
            writeTextFile(path.join(storageDir, 'workspace.json'), workspaceJson(harness.copilotProject));
            copyFixture('copilot/sample-session.jsonl', path.join(chatSessionsDir, 'new-chat.jsonl'));
        },
        collect(_harness, watcher) {
            return watcher.collectCopilotSessionsAsync(undefined, undefined);
        },
    },
    {
        name: 'GitHub Copilot agent-host (session-state/events.jsonl)',
        source: 'copilot',
        createChat(harness) {
            writeCopilotAgentChat(harness, 'copilot-agent-new-chat');
        },
        collect(harness, watcher) {
            return watcher.collectCopilotAgentSessionsAsync(undefined, harness.copilotAgentRoot);
        },
    },
    {
        name: 'Claude Code (projects/<project>/*.jsonl)',
        source: 'claude',
        createChat(harness) {
            copyFixture(
                'claude/sample-session.jsonl',
                path.join(harness.claudeRoot, 'new-project', 'new-claude-chat.jsonl')
            );
        },
        collect(harness, watcher) {
            return watcher.collectClaudeSessionsAsync(undefined, undefined, harness.claudeRoot);
        },
    },
    {
        name: 'Cline legacy (globalStorage/tasks/<id>)',
        source: 'cline',
        createChat(harness) {
            copyFixture('cline/sample-task', path.join(harness.clineRoot, 'cline-legacy-new-chat'));
        },
        collect(harness, watcher) {
            return watcher.collectClineTasksAsync(undefined, harness.clineRoot);
        },
    },
    {
        name: 'Cline 4.x (data/sessions/<id>)',
        source: 'cline',
        createChat(harness) {
            writeClineV4Chat(harness, 'cline-v4-new-chat');
        },
        collect(harness, watcher) {
            return watcher.collectClineV4SessionsAsync(undefined, harness.clineV4Root);
        },
    },
    {
        name: 'Roo Code (globalStorage/tasks/<id>)',
        source: 'roocode',
        createChat(harness) {
            copyFixture('roocode/sample-task', path.join(harness.rooRoot, 'roo-new-chat'));
        },
        collect(harness, watcher) {
            return watcher.collectRooCodeTasksAsync(undefined, harness.rooRoot);
        },
    },
    {
        name: 'Cursor (workspaceStorage/<hash>/state.vscdb)',
        source: 'cursor',
        createChat(harness) {
            const storageDir = path.join(harness.cursorRoot, 'cursor-workspace-hash');
            writeTextFile(path.join(storageDir, 'workspace.json'), workspaceJson(harness.cursorProject));
            createCursorDb(path.join(storageDir, 'state.vscdb'));
        },
        collect(harness, watcher) {
            // Point the global-DB read at a path that does not exist: the
            // workspace DB alone must surface the new chat.
            return watcher.collectCursorSessionsAsync(
                undefined,
                harness.cursorRoot,
                path.join(harness.root, 'missing-cursor-global.vscdb')
            );
        },
    },
    {
        name: 'Windsurf (workspaceStorage/<hash>/state.vscdb)',
        source: 'windsurf',
        createChat(harness) {
            const storageDir = path.join(harness.windsurfRoot, 'windsurf-workspace-hash');
            writeTextFile(path.join(storageDir, 'workspace.json'), workspaceJson(harness.windsurfProject));
            createWindsurfDb(path.join(storageDir, 'state.vscdb'));
        },
        collect(harness, watcher) {
            return watcher.collectWindsurfSessionsAsync(undefined, harness.windsurfRoot);
        },
    },
    {
        name: 'Aider (.aider.chat.history.md)',
        source: 'aider',
        createChat(harness) {
            copyFixture(
                'aider/sample/.aider.chat.history.md',
                path.join(harness.aiderProject, '.aider.chat.history.md')
            );
        },
        collect(harness, watcher) {
            return watcher.collectAiderSessionsAsync(undefined, [harness.aiderProject]);
        },
    },
    {
        name: 'Google Antigravity (brain/<conversation>)',
        source: 'antigravity',
        createChat(harness) {
            copyFixture(
                'antigravity/brain/a1b2c3d4-0000-0000-0000-000000000001',
                path.join(harness.antigravityRoot, 'antigravity-new-chat')
            );
        },
        collect(harness, watcher) {
            return watcher.collectAntigravitySessionsAsync(undefined, harness.antigravityRoot);
        },
    },
    {
        name: 'Continue.dev (sessions/*.jsonl)',
        source: 'continue',
        createChat(harness) {
            copyFixture(
                'continue/postgres-pool-jsonl.jsonl',
                path.join(harness.continueRoot, 'continue-new-chat.jsonl')
            );
        },
        // The collector resolves `chatwizard.continueStoragePath` (pointed at
        // the harness root in setup) and runs this same discovery + parse pair.
        collect(_harness, watcher) {
            return watcher.collectContinueSessionsAsync();
        },
    },
    {
        name: 'Amazon Q Developer (history/*.json)',
        source: 'amazonq',
        createChat(harness) {
            copyFixture(
                'amazonq/lambda-cold-start-shape-a.json',
                path.join(harness.amazonqRoot, 'history', 'amazonq-new-chat.json')
            );
        },
        collect(_harness, watcher) {
            return watcher.collectAmazonQSessionsAsync();
        },
    },
    {
        name: 'Gemini Code Assist (conversations/*.json)',
        source: 'geminiCodeAssist',
        createChat(harness) {
            copyFixture(
                'geminiCodeAssist/monorepo-build.json',
                path.join(harness.geminiRoot, 'conversations', 'gemini-new-chat.json')
            );
        },
        collect(_harness, watcher) {
            return watcher.collectGeminiSessionsAsync();
        },
    },
    {
        name: 'Tabnine Chat (chat/*.json)',
        source: 'tabnine',
        createChat(harness) {
            copyFixture('tabnine/sample-chat.json', path.join(harness.tabnineRoot, 'tabnine-new-chat.json'));
        },
        // Tabnine has no storage-path setting: the collector scans the default
        // VS Code globalStorage location, so the suite calls its discovery +
        // parser directly against the harness root.
        async collect(harness) {
            const files = await discoverTabnineConversationsAsync(harness.tabnineRoot);
            return files
                .map(filePath => parseTabnineConversation(filePath).session)
                .filter(session => session.messages.length > 0);
        },
    },
];

// ---------------------------------------------------------------------------
// Shared per-test lifecycle
// ---------------------------------------------------------------------------

interface TestContext {
    harness: Harness;
    configSnapshots: ConfigSnapshot[];
}

async function createTestContext(): Promise<TestContext> {
    const harness = makeHarness();
    const configSnapshots = [
        await setChatwizardSetting('copilotStoragePath', harness.copilotWorkspaceRoot),
        await setChatwizardSetting('continueStoragePath', harness.continueRoot),
        await setChatwizardSetting('amazonQStoragePath', harness.amazonqRoot),
        await setChatwizardSetting('geminiCodeAssistStoragePath', harness.geminiRoot),
    ];
    return { harness, configSnapshots };
}

async function disposeTestContext(context: TestContext): Promise<void> {
    for (const snapshot of context.configSnapshots) {
        await restoreChatwizardSetting(snapshot);
    }
    fs.rmSync(context.harness.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suite 1 — one new chat per platform
// ---------------------------------------------------------------------------

suite('New chats — every platform appears in the Sessions view', function () {
    this.timeout(60_000);

    let context: TestContext;

    setup(async () => {
        context = await createTestContext();
    });

    teardown(async () => {
        if (context) { await disposeTestContext(context); }
    });

    for (const platform of PLATFORMS) {
        test(`${platform.name} — a new chat appears in Sessions`, async () => {
            const { harness } = context;
            const index = new SessionIndex();
            const watcher = makeWatcher(index);

            // 1. Isolated storage starts empty — otherwise a false positive
            //    could hide a discovery failure.
            const before = await platform.collect(harness, watcher);
            assert.strictEqual(
                before.length,
                0,
                `${platform.name}: expected no chats before the new chat is created`
            );

            // 2. Create the chat exactly where the platform writes it.
            platform.createChat(harness);

            // 3. Collect it through the production discovery + parse chain.
            const sessions = await platform.collect(harness, watcher);
            assert.ok(sessions.length > 0, `${platform.name}: the new chat was not discovered`);
            for (const session of sessions) {
                assert.strictEqual(
                    session.source,
                    platform.source,
                    `${platform.name}: collected session has source "${session.source}"`
                );
                assert.ok(
                    session.messages.length > 0,
                    `${platform.name}: the new chat parsed with zero messages`
                );
            }

            // 4. Push it through the index and render the Sessions view.
            index.batchUpsert(sessions);
            const provider = new SessionTreeProvider(index);
            const visible = collectSessionsInView(provider);

            assert.strictEqual(
                visible.length,
                index.getAllSummaries().length,
                `${platform.name}: the Sessions view rendered ${visible.length} of ` +
                `${index.getAllSummaries().length} indexed chat(s)`
            );
            const visibleIds = new Set(visible.map(item => item.summary.id));
            for (const session of sessions) {
                assert.ok(
                    visibleIds.has(session.id),
                    `${platform.name}: session "${session.id}" is missing from the Sessions view`
                );
            }
        });
    }
});

// ---------------------------------------------------------------------------
// Suite 2 — all platforms at once in the default (date-grouped) view
// ---------------------------------------------------------------------------

suite('New chats — all platforms appear together in the Sessions view', function () {
    this.timeout(120_000);

    let context: TestContext;

    setup(async () => {
        context = await createTestContext();
    });

    teardown(async () => {
        if (context) { await disposeTestContext(context); }
    });

    test('one new chat in every platform yields one visible session per platform', async () => {
        const { harness } = context;
        const index = new SessionIndex();
        const watcher = makeWatcher(index);

        const collected: Session[] = [];
        for (const platform of PLATFORMS) {
            platform.createChat(harness);
            const sessions = await platform.collect(harness, watcher);
            assert.ok(sessions.length > 0, `${platform.name}: no session collected after creating a chat`);
            collected.push(...sessions);
        }

        index.batchUpsert(collected);

        // Default grouping (date) — the same tree the user sees on first open.
        const provider = new SessionTreeProvider(index);
        assert.strictEqual(provider.getGroupMode(), 'date');

        const rootNodes = provider.getChildren(undefined);
        assert.ok(rootNodes.length > 0, 'the Sessions view is empty');
        assert.ok(
            rootNodes.every(node => node instanceof DateGroupTreeItem),
            'the default Sessions view should be date-grouped'
        );

        const visible = collectSessionsInView(provider);
        const visibleSources = new Set(visible.map(item => item.summary.source));

        for (const platform of PLATFORMS) {
            assert.ok(
                visibleSources.has(platform.source),
                `${platform.name}: source "${platform.source}" is missing from the Sessions view`
            );
        }

        assert.strictEqual(
            visible.length,
            index.getAllSummaries().length,
            `the Sessions view rendered ${visible.length} of ${index.getAllSummaries().length} indexed chats`
        );

        const summaryCount = index.getAllSummaries().length;
        assert.ok(
            provider.getDescription().startsWith(`${summaryCount} session`),
            `the Sessions view header count does not match the index: "${provider.getDescription()}"`
        );
    });
});

// ---------------------------------------------------------------------------
// Suite 3 — live update (no restart)
// ---------------------------------------------------------------------------

suite('New chats — live update of an open Sessions view', function () {
    this.timeout(120_000);

    let context: TestContext;

    setup(async () => {
        context = await createTestContext();
    });

    teardown(async () => {
        if (context) { await disposeTestContext(context); }
    });

    test('chats created after the view is open appear without restarting', async () => {
        const { harness } = context;
        const index = new SessionIndex();
        const provider = new SessionTreeProvider(index);

        let refreshCount = 0;
        const subscription = provider.onDidChangeTreeData(() => { refreshCount++; });

        try {
            // The extension fires one index pass even when nothing is found;
            // this clears the provider's initial "Indexing sessions…" state.
            index.batchUpsert([]);
            assert.deepStrictEqual(
                collectSessionsInView(provider),
                [],
                'the Sessions view should start empty'
            );

            const watcher = makeWatcher(index);
            const collected: Session[] = [];
            for (const platform of PLATFORMS) {
                platform.createChat(harness);
                collected.push(...await platform.collect(harness, watcher));
            }
            assert.ok(collected.length > 0, 'no new chats were collected');

            // Simulate the live file watchers: every parsed chat is upserted
            // into the shared index while the view is already open.
            for (const session of collected) {
                index.upsert(session);
            }

            await waitFor(
                () => refreshCount > 0,
                'the Sessions view never refreshed after new chats were indexed'
            );

            const visible = collectSessionsInView(provider);
            const visibleIds = new Set(visible.map(item => item.summary.id));
            for (const session of collected) {
                assert.ok(
                    visibleIds.has(session.id),
                    `session "${session.id}" (${session.source}) did not appear after the live refresh`
                );
            }
        } finally {
            subscription.dispose();
        }
    });
});
