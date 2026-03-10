import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionIndex } from '../index/sessionIndex';
import { parseCopilotSession } from '../parsers/copilot';
import { parseClaudeSession } from '../parsers/claude';
import { discoverCopilotWorkspaces, listSessionFiles } from '../readers/copilotWorkspace';
import { SessionSource } from '../types/index';

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
        const claudeBaseDir = path.join(os.homedir(), '.claude', 'projects');
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
        this.indexAllClaudeSessions();
        this.indexAllCopilotSessions();
    }

    private indexAllClaudeSessions(): void {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

        try {
            if (!fs.existsSync(claudeProjectsDir)) {
                return;
            }

            const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

            for (const projectDir of projectDirs) {
                if (!projectDir.isDirectory()) {
                    continue;
                }

                const projectPath = path.join(claudeProjectsDir, projectDir.name);

                try {
                    const files = fs.readdirSync(projectPath, { withFileTypes: true });

                    for (const file of files) {
                        if (!file.isFile() || !file.name.endsWith('.jsonl')) {
                            continue;
                        }

                        this.indexFile(path.join(projectPath, file.name), 'claude');
                    }
                } catch (err) {
                    this.channel.appendLine(`[error] Failed to read Claude project directory ${projectPath}: ${err}`);
                }
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to index Claude sessions: ${err}`);
        }
    }

    private indexAllCopilotSessions(): void {
        try {
            const workspaces = discoverCopilotWorkspaces();
            for (const workspace of workspaces) {
                try {
                    const sessionFiles = listSessionFiles(workspace.storageDir);
                    for (const filePath of sessionFiles) {
                        this.indexFile(filePath, 'copilot', workspace.workspaceId, workspace.workspacePath);
                    }
                } catch (err) {
                    this.channel.appendLine(
                        `[error] Failed to index Copilot sessions for workspace ${workspace.workspaceId}: ${err}`
                    );
                }
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to discover Copilot workspaces: ${err}`);
        }
    }

    private indexFile(
        filePath: string,
        source: SessionSource,
        workspaceId?: string,
        workspacePath?: string
    ): void {
        try {
            if (source === 'claude') {
                const result = parseClaudeSession(filePath);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 || result.session.createdAt === new Date(0).toISOString()) {
                    this.channel.appendLine(`[skip] empty/epoch session ${filePath}`);
                    return;
                }
                this.index.upsert(result.session);
            } else if (source === 'copilot') {
                const result = parseCopilotSession(filePath, workspaceId!, workspacePath);
                if (result.errors.length > 0) {
                    this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0) {
                    this.channel.appendLine(`[skip] empty session ${filePath}`);
                    return;
                }
                this.index.upsert(result.session);
            }
        } catch (err) {
            this.channel.appendLine(`[error] Failed to index file ${filePath}: ${err}`);
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
