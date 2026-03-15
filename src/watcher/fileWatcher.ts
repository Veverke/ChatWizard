import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionIndex } from '../index/sessionIndex';
import { parseCopilotSession } from '../parsers/copilot';
import { parseClaudeSession } from '../parsers/claude';
import {
    discoverCopilotWorkspaces,
    discoverCopilotWorkspacesAsync,
    listSessionFiles,
    listSessionFilesAsync,
} from '../readers/copilotWorkspace';
import { Session, SessionSource } from '../types/index';
import { resolveClaudeProjectsPath } from './configPaths';

export class ChatWizardWatcher implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private index: SessionIndex;
    private channel: vscode.OutputChannel;

    constructor(index: SessionIndex, channel: vscode.OutputChannel) {
        this.index = index;
        this.channel = channel;
    }

    async start(): Promise<void> {
        await this.buildInitialIndex();

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

        // Watch Copilot sessions
        let copilotWorkspaces: ReturnType<typeof discoverCopilotWorkspaces> = [];
        try {
            copilotWorkspaces = discoverCopilotWorkspaces();
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

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    private async buildInitialIndex(): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'ChatWizard: indexing sessions…',
                cancellable: false,
            },
            async (progress) => {
                const onProgress = (current: number, total: number) => {
                    progress.report({ message: `${current}/${total}` });
                };

                const [claudeSessions, copilotSessions] = await Promise.all([
                    this.collectClaudeSessionsAsync(onProgress),
                    this.collectCopilotSessionsAsync(onProgress),
                ]);

                const all = [...claudeSessions, ...copilotSessions];
                this.index.batchUpsert(all);
                this.channel.appendLine(`[init] Batch indexed ${all.length} sessions`);
            }
        );
    }

    /** Async: parse all Claude sessions using non-blocking directory reads. */
    async collectClaudeSessionsAsync(
        onProgress?: (current: number, total: number) => void
    ): Promise<Session[]> {
        const claudeProjectsDir = resolveClaudeProjectsPath();
        try {
            let exists = false;
            try { exists = (await fs.promises.stat(claudeProjectsDir)).isDirectory(); } catch { /* not found */ }
            if (!exists) { return []; }

            const projectDirEntries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true });
            const dirEntries = projectDirEntries.filter(d => d.isDirectory());

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
                    const session = this.parseFile(path.join(projectPath, file.name), 'claude');
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
        onProgress?: (current: number, total: number) => void
    ): Promise<Session[]> {
        try {
            const workspaces = await discoverCopilotWorkspacesAsync();

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
                for (const filePath of files) {
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

    /** Synchronous collectors kept for internal use by live-update code paths. */
    private collectClaudeSessions(): Session[] {
        const sessions: Session[] = [];
        const claudeProjectsDir = resolveClaudeProjectsPath();

        try {
            if (!fs.existsSync(claudeProjectsDir)) {
                return sessions;
            }

            const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

            for (const projectDir of projectDirs) {
                if (!projectDir.isDirectory()) { continue; }

                const projectPath = path.join(claudeProjectsDir, projectDir.name);

                try {
                    const files = fs.readdirSync(projectPath, { withFileTypes: true });

                    for (const file of files) {
                        if (!file.isFile() || !file.name.endsWith('.jsonl')) { continue; }

                        const session = this.parseFile(path.join(projectPath, file.name), 'claude');
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
                    const sessionFiles = listSessionFiles(workspace.storageDir);
                    for (const filePath of sessionFiles) {
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
                const result = parseClaudeSession(filePath);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join('; ')}`);
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

export async function startWatcher(
    index: SessionIndex,
    channel?: vscode.OutputChannel
): Promise<ChatWizardWatcher> {
    const ch = channel ?? vscode.window.createOutputChannel('ChatWizard');
    const watcher = new ChatWizardWatcher(index, ch);
    await watcher.start();
    return watcher;
}
