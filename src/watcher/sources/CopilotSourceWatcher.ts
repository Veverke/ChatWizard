// src/watcher/sources/CopilotSourceWatcher.ts
// Item 2: ISourceWatcher implementation for GitHub Copilot.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import {
    discoverCopilotWorkspacesAsync,
    discoverCopilotWorkspaces,
    listSessionFilesAsync,
    getWorkspaceStorageRoots,
} from '../../readers/copilotWorkspace';
import { parseCopilotSession } from '../../parsers/copilot';

export class CopilotSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'copilot';
    private readonly _deps: SourceWatcherDeps;
    private _disposables: vscode.Disposable[] = [];
    private _nodeWatchers: fs.FSWatcher[] = [];
    private _debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(deps: SourceWatcherDeps) {
        this._deps = deps;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress, selectedIds } = this._deps;
        try {
            const all = await discoverCopilotWorkspacesAsync();
            const workspaces = selectedIds.length > 0
                ? all.filter(ws => selectedIds.includes(ws.workspaceId))
                : all;

            if (selectedIds.length > 0 && workspaces.length === 0 && all.length > 0) {
                channel.appendLine(
                    `[Chat Wizard] Copilot scope filter produced 0 matches from ${all.length} workspace(s). ` +
                    `Filter: [${selectedIds.join(', ')}]. Discovered: [${all.map(ws => ws.workspaceId).join(', ')}]`
                );
            }

            const fileListsPerWorkspace = await Promise.all(
                workspaces.map(ws => listSessionFilesAsync(ws.storageDir))
            );
            const total = fileListsPerWorkspace.reduce((s, files) => s + files.length, 0);
            let current = 0;

            const wsResults = await Promise.all(workspaces.map(async (workspace, idx) => {
                const files = fileListsPerWorkspace[idx];
                const wsSessions: Session[] = [];
                const resolvedBase = await fs.promises.realpath(workspace.storageDir).catch(() => workspace.storageDir);
                for (const filePath of files) {
                    try {
                        const real = await fs.promises.realpath(filePath);
                        if (!real.startsWith(resolvedBase + path.sep) && real !== resolvedBase) {
                            channel.appendLine(`[security] Skipping ${filePath}: outside workspace storage`);
                            current++;
                            onProgress?.(current, total);
                            continue;
                        }
                    } catch {
                        current++;
                        onProgress?.(current, total);
                        continue;
                    }
                    try {
                        const result = parseCopilotSession(filePath, workspace.workspaceId, workspace.workspacePath);
                        if (result.session.messages.length > 0) { wsSessions.push(result.session); }
                    } catch { /* skip malformed */ }
                    current++;
                    onProgress?.(current, total);
                    if (onProgress && current % 10 === 0) {
                        await new Promise<void>(r => setImmediate(r));
                    }
                }
                return wsSessions;
            }));

            return wsResults.flat();
        } catch (err) {
            channel.appendLine(`[error] CopilotSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { index, channel } = this._deps;
        let copilotWorkspaces: ReturnType<typeof discoverCopilotWorkspaces> = [];
        try {
            const all = discoverCopilotWorkspaces();
            const selectedIds = this._deps.selectedIds;
            copilotWorkspaces = selectedIds.length > 0
                ? all.filter(ws => selectedIds.includes(ws.workspaceId))
                : all;
        } catch (err) {
            channel.appendLine(`[error] Failed to discover Copilot workspaces for watching: ${err}`);
        }

        for (const workspace of copilotWorkspaces) {
            const chatSessionsDir = path.join(workspace.storageDir, 'chatSessions');
            const pattern = new vscode.RelativePattern(vscode.Uri.file(chatSessionsDir), '*.jsonl');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            const wsId = workspace.workspaceId;
            const wsPath = workspace.workspacePath;

            watcher.onDidCreate((uri) => this._onFileChanged(uri.fsPath, wsId, wsPath));
            watcher.onDidChange((uri) => this._onFileChanged(uri.fsPath, wsId, wsPath));
            watcher.onDidDelete((uri) => {
                const sessionId = path.basename(uri.fsPath, '.jsonl');
                index.remove(sessionId);
                channel.appendLine(`[live] removed copilot session ${sessionId}`);
            });
            this._disposables.push(watcher);

            this._watchDirFast(chatSessionsDir, '.jsonl', (fullPath) => {
                if (!fs.existsSync(fullPath)) { return; }
                this._onFileChanged(fullPath, wsId, wsPath);
            });
        }

        // Chronicle watchers
        for (const root of getWorkspaceStorageRoots()) {
            const chroniclePattern = new vscode.RelativePattern(
                vscode.Uri.file(root),
                '**/GitHub.copilot-chat/debug-logs/session-store.db'
            );
            const chronicleWatcher = vscode.workspace.createFileSystemWatcher(chroniclePattern);
            // Chronicle merge is handled by ChatWizardWatcher — signal via a custom event
            chronicleWatcher.onDidCreate(() => this._onChronicleChange());
            chronicleWatcher.onDidChange(() => this._onChronicleChange());
            this._disposables.push(chronicleWatcher);
        }
    }

    /** Called when a Chronicle DB changes. Subclasses/orchestrators can override. */
    onChronicleChange?: () => void;

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
        for (const w of this._nodeWatchers) { try { w.close(); } catch { /* ignore */ } }
        this._nodeWatchers = [];
        for (const t of this._debounceMap.values()) { clearTimeout(t); }
        this._debounceMap.clear();
    }

    private _onFileChanged(filePath: string, wsId: string, wsPath: string | undefined): void {
        const { index, channel } = this._deps;
        try {
            const result = parseCopilotSession(filePath, wsId, wsPath);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] copilot upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] copilot live parse failed ${filePath}: ${err}`);
        }
    }

    private _onChronicleChange(): void {
        this.onChronicleChange?.();
    }

    private _watchDirFast(dir: string, ext: string, handler: (fullPath: string) => void): void {
        if (!fs.existsSync(dir)) { return; }
        try {
            const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename || !filename.endsWith(ext)) { return; }
                const fullPath = path.join(dir, filename);
                const prev = this._debounceMap.get(fullPath);
                if (prev) { clearTimeout(prev); }
                this._debounceMap.set(fullPath, setTimeout(() => {
                    this._debounceMap.delete(fullPath);
                    handler(fullPath);
                }, 300));
            });
            w.on('error', () => { /* swallow */ });
            this._nodeWatchers.push(w);
        } catch { /* not supported */ }
    }
}