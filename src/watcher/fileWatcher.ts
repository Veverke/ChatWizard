import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionIndex } from '../index/sessionIndex';
import { parseCopilotSession } from '../parsers/copilot';
import { parseClaudeSession, DEFAULT_MAX_LINE_CHARS } from '../parsers/claude';
import {
    discoverCopilotWorkspaces,
    discoverCopilotWorkspacesAsync,
    listSessionFiles,
    listSessionFilesAsync,
} from '../readers/copilotWorkspace';
import { Session, SessionSource } from '../types/index';
import { resolveClaudeProjectsPath, resolveClineStoragePath, resolveRooCodeStoragePath, resolveCursorStoragePath } from './configPaths';
import { WorkspaceScopeManager } from './workspaceScope';
import { discoverClineTasksAsync, discoverRooCodeTasksAsync } from '../readers/clineWorkspace';
import { parseClineTask } from '../parsers/cline';
import { discoverCursorWorkspacesAsync } from '../readers/cursorWorkspace';
import { parseCursorWorkspace } from '../parsers/cursor';

export class ChatWizardWatcher implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private index: SessionIndex;
    private channel: vscode.OutputChannel;
    private scopeManager: WorkspaceScopeManager;

    constructor(index: SessionIndex, channel: vscode.OutputChannel, scopeManager: WorkspaceScopeManager) {
        this.index = index;
        this.channel = channel;
        this.scopeManager = scopeManager;
    }

    // SEC-6: Symlink traversal guards — ensure resolved path stays within base directory.

    /**
     * Returns true if `filePath`, after resolving all symlinks, is contained within
     * `resolvedBase`. Prevents symlink-based path traversal to files outside the
     * expected session directories.
     */
    private static _isSafeFilePath(resolvedBase: string, filePath: string): boolean {
        try {
            const realPath = fs.realpathSync(filePath);
            return realPath.startsWith(resolvedBase + path.sep) || realPath === resolvedBase;
        } catch {
            return false; // Cannot resolve → skip
        }
    }

    private static async _isSafeFilePathAsync(resolvedBase: string, filePath: string): Promise<boolean> {
        try {
            const realPath = await fs.promises.realpath(filePath);
            return realPath.startsWith(resolvedBase + path.sep) || realPath === resolvedBase;
        } catch {
            return false;
        }
    }

    async start(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        // SEC-10: per-source enable/disable settings
        const enabled       = cfg.get<boolean>('enabled', true);
        const indexClaude   = cfg.get<boolean>('indexClaude', true);
        const indexCopilot  = cfg.get<boolean>('indexCopilot', true);
        const indexCline    = cfg.get<boolean>('indexCline', true);
        const indexRooCode  = cfg.get<boolean>('indexRooCode', true);
        const indexCursor   = cfg.get<boolean>('indexCursor', true);

        if (!enabled) {
            this.channel.appendLine('[Chat Wizard] Extension disabled via chatwizard.enabled setting — skipping indexing and file watching.');
            // Fire an empty batch so tree providers clear their _loading state and show empty-state UI.
            this.index.batchUpsert([]);
            return;
        }

        await this.buildInitialIndex(indexClaude, indexCopilot, indexCline, indexRooCode, indexCursor);

        if (indexClaude) {
            // Watch Claude sessions
            const claudeBaseDir = resolveClaudeProjectsPath();
            const claudePattern = new vscode.RelativePattern(
                vscode.Uri.file(claudeBaseDir),
                '**/*.jsonl'
            );
            const claudeWatcher = vscode.workspace.createFileSystemWatcher(claudePattern);

            claudeWatcher.onDidCreate((uri) => this.onFileChanged(uri, 'claude'));
            claudeWatcher.onDidChange((uri) => this.onFileChanged(uri, 'claude'));
            claudeWatcher.onDidDelete((uri) => {
                const sessionId = path.basename(uri.fsPath, '.jsonl');
                this.index.remove(sessionId);
                this.channel.appendLine(`[live] removed session ${sessionId}`);
            });

            this.disposables.push(claudeWatcher);
        }

        if (indexCopilot) {
            // Watch Copilot sessions
            let copilotWorkspaces: ReturnType<typeof discoverCopilotWorkspaces> = [];
            try {
                const all = discoverCopilotWorkspaces();
                const selectedIds = this.scopeManager.getSelectedIds();
                // Empty selectedIds means no workspace in scope — watch nothing.
                copilotWorkspaces = all.filter(ws => selectedIds.includes(ws.workspaceId));
            } catch (err) {
                this.channel.appendLine(`[error] Failed to discover Copilot workspaces for watching: ${err}`);
            }

            for (const workspace of copilotWorkspaces) {
                const chatSessionsDir = path.join(workspace.storageDir, 'chatSessions');
                const copilotPattern = new vscode.RelativePattern(
                    vscode.Uri.file(chatSessionsDir),
                    '*.jsonl'
                );
                const copilotWatcher = vscode.workspace.createFileSystemWatcher(copilotPattern);

                copilotWatcher.onDidCreate((uri) =>
                    this.onFileChanged(uri, 'copilot', workspace.workspaceId, workspace.workspacePath)
                );
                copilotWatcher.onDidChange((uri) =>
                    this.onFileChanged(uri, 'copilot', workspace.workspaceId, workspace.workspacePath)
                );
                copilotWatcher.onDidDelete((uri) => {
                    const sessionId = path.basename(uri.fsPath, '.jsonl');
                    this.index.remove(sessionId);
                    this.channel.appendLine(`[live] removed session ${sessionId}`);
                });

                this.disposables.push(copilotWatcher);
            }
        }

        if (indexCline) {
            // Watch Cline task files
            const clineRoot = resolveClineStoragePath();
            const clinePattern = new vscode.RelativePattern(
                vscode.Uri.file(clineRoot),
                '**/api_conversation_history.json'
            );
            const clineWatcher = vscode.workspace.createFileSystemWatcher(clinePattern);

            clineWatcher.onDidCreate((uri) => this.onClineFileChanged(uri));
            clineWatcher.onDidChange((uri) => this.onClineFileChanged(uri));
            clineWatcher.onDidDelete((uri) => {
                // Task directory name is the parent of the changed file.
                const taskId = path.basename(path.dirname(uri.fsPath));
                this.index.remove(taskId);
                this.channel.appendLine(`[live] removed cline session ${taskId}`);
            });

            this.disposables.push(clineWatcher);
        }

        if (indexRooCode) {
            // Watch Roo Code task files
            const rooCodeRoot = resolveRooCodeStoragePath();
            const rooCodePattern = new vscode.RelativePattern(
                vscode.Uri.file(rooCodeRoot),
                '**/api_conversation_history.json'
            );
            const rooCodeWatcher = vscode.workspace.createFileSystemWatcher(rooCodePattern);

            rooCodeWatcher.onDidCreate((uri) => this.onRooCodeFileChanged(uri));
            rooCodeWatcher.onDidChange((uri) => this.onRooCodeFileChanged(uri));
            rooCodeWatcher.onDidDelete((uri) => {
                const taskId = path.basename(path.dirname(uri.fsPath));
                this.index.remove(taskId);
                this.channel.appendLine(`[live] removed roocode session ${taskId}`);
            });

            this.disposables.push(rooCodeWatcher);
        }

        if (indexCursor) {
            // Watch Cursor state.vscdb files
            const cursorRoot = resolveCursorStoragePath();
            const cursorPattern = new vscode.RelativePattern(
                vscode.Uri.file(cursorRoot),
                '**/state.vscdb'
            );
            const cursorWatcher = vscode.workspace.createFileSystemWatcher(cursorPattern);

            cursorWatcher.onDidCreate((uri) => this.onCursorFileChanged(uri));
            cursorWatcher.onDidChange((uri) => this.onCursorFileChanged(uri));
            cursorWatcher.onDidDelete((uri) => {
                // When a state.vscdb is deleted, we can't know which composerIds were in it.
                // Best effort: remove sessions whose filePath matches this vscdb.
                const vscdbPath = uri.fsPath;
                this.channel.appendLine(`[live] cursor state.vscdb deleted: ${vscdbPath}`);
                // Sessions keyed by composerId — log only; index cleanup happens on next rescan.
            });

            this.disposables.push(cursorWatcher);
        }
    }

    /**
     * Stops all active file watchers, clears the session index, and re-runs the full
     * discovery + indexing flow. Used when the workspace scope changes.
     */
    async restart(): Promise<void> {
        this.dispose();
        this.index.clear();
        await this.start();
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    private async buildInitialIndex(indexClaude: boolean, indexCopilot: boolean, indexCline: boolean, indexRooCode: boolean = true, indexCursor: boolean = true): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Chat Wizard: indexing sessions…',
                cancellable: false,
            },
            async (progress) => {
                const onProgress = (current: number, total: number) => {
                    progress.report({ message: `${current}/${total}` });
                };

                const selectedIds = this.scopeManager.getSelectedIds();
                if (selectedIds.length === 0) {
                    this.channel.appendLine('[Chat Wizard] Scope is empty — no sessions will be indexed.');
                } else {
                    this.channel.appendLine(`[Chat Wizard] Building index with scope filter: [${selectedIds.join(', ')}]`);
                }
                const [claudeSessions, copilotSessions, clineSessions, rooCodeSessions, cursorSessions] = await Promise.all([
                    // Always pass selectedIds (even empty array) — empty = index nothing, no fallback to all.
                    indexClaude   ? this.collectClaudeSessionsAsync(onProgress, selectedIds)  : Promise.resolve([]),
                    indexCopilot  ? this.collectCopilotSessionsAsync(onProgress, selectedIds) : Promise.resolve([]),
                    indexCline    ? this.collectClineTasksAsync(onProgress)                   : Promise.resolve([]),
                    indexRooCode  ? this.collectRooCodeTasksAsync(onProgress)                 : Promise.resolve([]),
                    indexCursor   ? this.collectCursorSessionsAsync(onProgress)               : Promise.resolve([]),
                ]);

                const cfg = vscode.workspace.getConfiguration('chatwizard');
                const all = applySessionFilters([...claudeSessions, ...copilotSessions, ...clineSessions, ...rooCodeSessions, ...cursorSessions], cfg, this.channel);
                this.index.batchUpsert(all);
                this.channel.appendLine(`[init] Batch indexed ${all.length} sessions`);
            }
        );
    }

    /** Async: parse all Claude sessions using non-blocking directory reads.
     *
     * @param onProgress           Optional progress callback.
     * @param selectedIds          When provided, only project directories whose name appears in
     *                             this list are processed (used for workspace scope filtering).
     * @param _claudeBaseDirOverride  Test-only: override the Claude projects base directory.
     */
    async collectClaudeSessionsAsync(
        onProgress?: (current: number, total: number) => void,
        selectedIds?: string[],
        _claudeBaseDirOverride?: string
    ): Promise<Session[]> {
        const claudeProjectsDir = resolveClaudeProjectsPath(_claudeBaseDirOverride);
        try {
            let exists = false;
            try { exists = (await fs.promises.stat(claudeProjectsDir)).isDirectory(); } catch { /* not found */ }
            if (!exists) { return []; }

            // SEC-6: resolve base once so per-file containment check is accurate for symlinks
            const resolvedBase = await fs.promises.realpath(claudeProjectsDir).catch(() => claudeProjectsDir);

            const projectDirEntries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true });
            const allDirEntries = projectDirEntries.filter(d => d.isDirectory());
            // Apply scope filter when selectedIds are provided
            const dirEntries = selectedIds
                ? allDirEntries.filter(d => selectedIds.includes(d.name))
                : allDirEntries;

            // Collect all file lists in parallel
            const fileLists = await Promise.all(dirEntries.map(async (d) => {
                const projectPath = path.join(claudeProjectsDir, d.name);
                try {
                    const files = await fs.promises.readdir(projectPath, { withFileTypes: true });
                    return { projectPath, files: files.filter(f => f.isFile() && f.name.endsWith('.jsonl')) };
                } catch {
                    return { projectPath, files: [] };
                }
            }));

            const total = fileLists.reduce((s, { files }) => s + files.length, 0);
            let current = 0;

            // Parse each directory's files in parallel across directories
            const dirResults = await Promise.all(fileLists.map(async ({ projectPath, files }) => {
                const dirSessions: Session[] = [];
                for (const file of files) {
                    const filePath = path.join(projectPath, file.name);
                    // SEC-6: skip files that resolve outside the projects base directory
                    if (!await ChatWizardWatcher._isSafeFilePathAsync(resolvedBase, filePath)) {
                        this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside base directory`);
                        current++;
                        onProgress?.(current, total);
                        continue;
                    }
                    const session = this.parseFile(filePath, 'claude');
                    if (session) { dirSessions.push(session); }
                    current++;
                    onProgress?.(current, total);
                }
                return dirSessions;
            }));

            return dirResults.flat();
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Claude sessions: ${err}`);
            return [];
        }
    }

    /** Async: parse all Copilot sessions using non-blocking discovery + parallel workspace reads. */
    async collectCopilotSessionsAsync(
        onProgress?: (current: number, total: number) => void,
        selectedIds?: string[]
    ): Promise<Session[]> {
        try {
            const all = await discoverCopilotWorkspacesAsync();
            const workspaces = selectedIds
                ? all.filter(ws => selectedIds.includes(ws.workspaceId))
                : all;

            if (selectedIds && workspaces.length === 0 && all.length > 0) {
                this.channel.appendLine(
                    `[Chat Wizard] Copilot scope filter produced 0 matches from ${all.length} discovered workspace(s). ` +
                    `Filter IDs: [${selectedIds.join(', ')}]. ` +
                    `Discovered: [${all.map(ws => ws.workspaceId).join(', ')}]`
                );
            }

            // Discover all session file paths across workspaces in parallel
            const fileListsPerWorkspace = await Promise.all(
                workspaces.map(ws => listSessionFilesAsync(ws.storageDir))
            );

            const total = fileListsPerWorkspace.reduce((s, files) => s + files.length, 0);
            let current = 0;

            // Parse each workspace's files in parallel
            const wsResults = await Promise.all(workspaces.map(async (workspace, idx) => {
                const files = fileListsPerWorkspace[idx];
                const wsSessions: Session[] = [];
                // SEC-6: resolve base once per workspace for symlink containment check
                const resolvedBase = await fs.promises.realpath(workspace.storageDir).catch(() => workspace.storageDir);
                for (const filePath of files) {
                    if (!await ChatWizardWatcher._isSafeFilePathAsync(resolvedBase, filePath)) {
                        this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside workspace storage`);
                        current++;
                        onProgress?.(current, total);
                        continue;
                    }
                    const session = this.parseFile(filePath, 'copilot', workspace.workspaceId, workspace.workspacePath);
                    if (session) { wsSessions.push(session); }
                    current++;
                    onProgress?.(current, total);
                }
                return wsSessions;
            }));

            return wsResults.flat();
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Copilot sessions: ${err}`);
            return [];
        }
    }

    /** Async: parse all Cline tasks using non-blocking directory reads. */
    async collectClineTasksAsync(
        onProgress?: (current: number, total: number) => void,
        _clineRootOverride?: string
    ): Promise<Session[]> {
        const root = _clineRootOverride ?? resolveClineStoragePath();
        try {
            const tasks = await discoverClineTasksAsync(root);
            const total = tasks.length;
            let current = 0;

            const results = await Promise.all(tasks.map(async (task) => {
                const result = await parseClineTask(task.storageDir);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Cline parse errors in ${task.storageDir}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 ||
                    result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            }));

            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Cline tasks: ${err}`);
            return [];
        }
    }

    /** Async: parse all Roo Code tasks using non-blocking directory reads. */
    async collectRooCodeTasksAsync(
        onProgress?: (current: number, total: number) => void,
        _rooCodeRootOverride?: string
    ): Promise<Session[]> {
        const root = _rooCodeRootOverride ?? resolveRooCodeStoragePath();
        try {
            const tasks = await discoverRooCodeTasksAsync(root);
            const total = tasks.length;
            let current = 0;

            const results = await Promise.all(tasks.map(async (task) => {
                const result = await parseClineTask(task.storageDir, undefined, 'roocode');
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Roo Code parse errors in ${task.storageDir}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 ||
                    result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            }));

            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Roo Code tasks: ${err}`);
            return [];
        }
    }

    /** Async: parse all Cursor sessions by reading state.vscdb files across discovered workspaces. */
    async collectCursorSessionsAsync(
        onProgress?: (current: number, total: number) => void,
        _cursorRootOverride?: string
    ): Promise<Session[]> {
        const root = _cursorRootOverride ?? resolveCursorStoragePath();
        try {
            const workspaces = await discoverCursorWorkspacesAsync(root);
            const total = workspaces.length;
            let current = 0;

            const wsResults = await Promise.all(workspaces.map(async (ws) => {
                const vscdbPath = require('path').join(ws.storageDir, 'state.vscdb');
                const parseResults = await parseCursorWorkspace(vscdbPath, ws.id, ws.workspacePath);
                current++;
                onProgress?.(current, total);

                const sessions: Session[] = [];
                for (const result of parseResults) {
                    if (result.errors.length > 0) {
                        this.channel.appendLine(
                            `[warn] Cursor parse errors in ${vscdbPath}: ${result.errors.join('; ')}`
                        );
                    }
                    if (result.session.messages.length === 0 ||
                        result.session.createdAt === new Date(0).toISOString()) {
                        continue;
                    }
                    sessions.push(result.session);
                }
                return sessions;
            }));

            return wsResults.flat();
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Cursor sessions: ${err}`);
            return [];
        }
    }

    /** Synchronous collectors kept for internal use by live-update code paths. */
    private collectClaudeSessions(): Session[] {
        const sessions: Session[] = [];
        const claudeProjectsDir = resolveClaudeProjectsPath();

        try {
            if (!fs.existsSync(claudeProjectsDir)) {
                return sessions;
            }

            // SEC-6: resolve base to defend against symlink traversal
            const resolvedBase = (() => { try { return fs.realpathSync(claudeProjectsDir); } catch { return claudeProjectsDir; } })();

            const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

            for (const projectDir of projectDirs) {
                if (!projectDir.isDirectory()) { continue; }

                const projectPath = path.join(claudeProjectsDir, projectDir.name);

                try {
                    const files = fs.readdirSync(projectPath, { withFileTypes: true });

                    for (const file of files) {
                        if (!file.isFile() || !file.name.endsWith('.jsonl')) { continue; }

                        const filePath = path.join(projectPath, file.name);
                        if (!ChatWizardWatcher._isSafeFilePath(resolvedBase, filePath)) {
                            this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside base directory`);
                            continue;
                        }
                        const session = this.parseFile(filePath, 'claude');
                        if (session) { sessions.push(session); }
                    }
                } catch (err) {
                    this.channel.appendLine(`[error] Failed to read Claude project directory ${projectPath}: ${err}`);
                }
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to collect Claude sessions: ${err}`);
        }

        return sessions;
    }

    private collectCopilotSessions(): Session[] {
        const sessions: Session[] = [];

        try {
            const workspaces = discoverCopilotWorkspaces();
            for (const workspace of workspaces) {
                try {
                    // SEC-6: resolve base to defend against symlink traversal
                    const resolvedBase = (() => { try { return fs.realpathSync(workspace.storageDir); } catch { return workspace.storageDir; } })();
                    const sessionFiles = listSessionFiles(workspace.storageDir);
                    for (const filePath of sessionFiles) {
                        if (!ChatWizardWatcher._isSafeFilePath(resolvedBase, filePath)) {
                            this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside workspace storage`);
                            continue;
                        }
                        const session = this.parseFile(filePath, 'copilot', workspace.workspaceId, workspace.workspacePath);
                        if (session) { sessions.push(session); }
                    }
                } catch (err) {
                    this.channel.appendLine(
                        `[error] Failed to collect Copilot sessions for workspace ${workspace.workspaceId}: ${err}`
                    );
                }
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to discover Copilot workspaces: ${err}`);
        }

        return sessions;
    }

    /**
     * Parse a single session file and return the Session object, or null if it
     * should be skipped (empty, epoch-dated, or parse error).
     * Does NOT modify the index — call index.upsert() or batchUpsert() separately.
     */
    private parseFile(
        filePath: string,
        source: SessionSource,
        workspaceId?: string,
        workspacePath?: string
    ): Session | null {
        try {
            if (source === 'claude') {
                const maxLineChars = vscode.workspace.getConfiguration('chatwizard')
                    .get<number>('maxLineLengthChars', DEFAULT_MAX_LINE_CHARS);
                const result = parseClaudeSession(filePath, maxLineChars);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                // Build session.parseErrors:
                //   - Actual JSON/read errors → listed verbatim in the banner.
                //   - Skipped-line entries → already represented as inline placeholder Messages;
                //     add a single summary line so the warning icon and banner appear too.
                const realErrors    = result.errors.filter(e => !e.includes('skipped — length'));
                const skippedErrors = result.errors.filter(e =>  e.includes('skipped — length'));
                const sessionErrors = [...realErrors];
                if (skippedErrors.length > 0) {
                    sessionErrors.push(
                        `${skippedErrors.length} message(s) were not shown because their source lines exceed ` +
                        `the size limit (chatwizard.maxLineLengthChars). ` +
                        `Inline notices mark their position in the conversation.`
                    );
                }
                if (sessionErrors.length > 0) {
                    result.session.parseErrors = sessionErrors;
                }
                if (result.session.messages.length === 0 || result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            } else if (source === 'copilot') {
                const result = parseCopilotSession(filePath, workspaceId!, workspacePath);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0) {
                    return null;
                }
                return result.session;
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to parse file ${filePath}: ${err}`);
        }
        return null;
    }

    /** Parse and immediately upsert a single file into the index (used for live file-change events). */
    private indexFile(
        filePath: string,
        source: SessionSource,
        workspaceId?: string,
        workspacePath?: string
    ): void {
        const session = this.parseFile(filePath, source, workspaceId, workspacePath);
        if (session) {
            this.index.upsert(session);
        } else {
            this.channel.appendLine(`[skip] empty/epoch session ${filePath}`);
        }
    }

    private async onClineFileChanged(uri: vscode.Uri): Promise<void> {
        // The watched file is api_conversation_history.json; its parent is the task dir.
        const taskDir = path.dirname(uri.fsPath);
        const taskId = path.basename(taskDir);
        const result = await parseClineTask(taskDir);
        if (result.errors.length > 0) {
            this.channel.appendLine(`[warn] Cline parse errors in ${taskDir}: ${result.errors.join('; ')}`);
        }
        if (result.session.messages.length === 0 ||
            result.session.createdAt === new Date(0).toISOString()) {
            this.channel.appendLine(`[skip] empty/epoch cline session ${taskId}`);
            return;
        }
        const before = this.index.size;
        this.index.upsert(result.session);
        const verb = this.index.size > before ? 'added' : 'updated';
        this.channel.appendLine(`[live] ${verb} cline session ${taskId}`);
    }

    private async onRooCodeFileChanged(uri: vscode.Uri): Promise<void> {
        const taskDir = path.dirname(uri.fsPath);
        const taskId = path.basename(taskDir);
        const result = await parseClineTask(taskDir, undefined, 'roocode');
        if (result.errors.length > 0) {
            this.channel.appendLine(`[warn] Roo Code parse errors in ${taskDir}: ${result.errors.join('; ')}`);
        }
        if (result.session.messages.length === 0 ||
            result.session.createdAt === new Date(0).toISOString()) {
            this.channel.appendLine(`[skip] empty/epoch roocode session ${taskId}`);
            return;
        }
        const before = this.index.size;
        this.index.upsert(result.session);
        const verb = this.index.size > before ? 'added' : 'updated';
        this.channel.appendLine(`[live] ${verb} roocode session ${taskId}`);
    }

    private async onCursorFileChanged(uri: vscode.Uri): Promise<void> {
        const vscdbPath = uri.fsPath;
        // workspaceId is the hash directory name (parent of state.vscdb)
        const workspaceId = path.basename(path.dirname(vscdbPath));
        // Try to resolve workspacePath from workspace.json in the same directory
        let workspacePath: string | undefined;
        try {
            const wsJson = path.join(path.dirname(vscdbPath), 'workspace.json');
            const raw = require('fs').readFileSync(wsJson, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.folder) {
                let decoded = decodeURIComponent(parsed.folder.replace('file://', ''));
                if (process.platform === 'win32' && decoded.startsWith('/')) {
                    decoded = decoded.slice(1);
                }
                workspacePath = decoded;
            }
        } catch {
            // workspace.json missing or unreadable — workspacePath stays undefined
        }

        const parseResults = await parseCursorWorkspace(vscdbPath, workspaceId, workspacePath);
        let upsertCount = 0;
        for (const result of parseResults) {
            if (result.errors.length > 0) {
                this.channel.appendLine(
                    `[warn] Cursor parse errors in ${vscdbPath}: ${result.errors.join('; ')}`
                );
            }
            if (result.session.messages.length === 0 ||
                result.session.createdAt === new Date(0).toISOString()) {
                continue;
            }
            this.index.upsert(result.session);
            upsertCount++;
        }
        this.channel.appendLine(`[live] cursor updated ${upsertCount} session(s) from ${vscdbPath}`);
    }

    private onFileChanged(
        uri: vscode.Uri,
        source: SessionSource,
        workspaceId?: string,
        workspacePath?: string
    ): void {
        const before = this.index.size;
        this.indexFile(uri.fsPath, source, workspaceId, workspacePath);
        const sessionId = path.basename(uri.fsPath, '.jsonl');
        const verb = this.index.size > before ? 'added' : 'updated';
        this.channel.appendLine(`[live] ${verb} session ${sessionId} (${source})`);
    }
}

/**
 * Applies the `chatwizard.oldestSessionDate` and `chatwizard.maxSessions` settings
 * to a collected batch of sessions, returning the filtered/trimmed list.
 *
 * - `oldestSessionDate` (YYYY-MM-DD): sessions whose `createdAt` date portion is
 *   strictly before this date are excluded. Time is ignored; comparison is by date only.
 * - `maxSessions` (positive integer): after the date filter, only the N most recently
 *   updated sessions are kept. 0 or negative = no limit.
 */
function applySessionFilters(
    sessions: Session[],
    cfg: vscode.WorkspaceConfiguration,
    channel: vscode.OutputChannel
): Session[] {
    const oldestDate = cfg.get<string>('oldestSessionDate', '').trim();
    const maxSessions = cfg.get<number>('maxSessions', 0);

    let result = sessions;

    if (oldestDate) {
        const before = result.length;
        result = result.filter(s => s.updatedAt.slice(0, 10) >= oldestDate);
        const dropped = before - result.length;
        channel.appendLine(`[Chat Wizard] Date filter (>= ${oldestDate}): kept ${result.length}, dropped ${dropped} session(s).`);
    } else {
        channel.appendLine(`[Chat Wizard] Date filter: not set, all ${result.length} session(s) kept.`);
    }

    if (maxSessions > 0 && result.length > maxSessions) {
        // Keep the N most recently updated sessions.
        result = result
            .slice()
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, maxSessions);
        channel.appendLine(`[Chat Wizard] Session cap (${maxSessions}) applied — retained ${result.length} session(s).`);
    }

    return result;
}

export async function startWatcher(
    index: SessionIndex,
    channel?: vscode.OutputChannel,
    scopeManager?: WorkspaceScopeManager
): Promise<ChatWizardWatcher> {
    const ch = channel ?? vscode.window.createOutputChannel('Chat Wizard');
    // When no scope manager is provided (legacy / tests), create a no-op instance
    // whose empty selection triggers the all-workspace fallback inside start().
    const mgr = scopeManager ?? new WorkspaceScopeManager({
        globalState: {
            get: () => undefined,
            update: (_key: string, _value: unknown) => Promise.resolve(),
        },
    });
    const watcher = new ChatWizardWatcher(index, ch, mgr);
    await watcher.start();
    return watcher;
}
