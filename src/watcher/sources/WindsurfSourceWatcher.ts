// src/watcher/sources/WindsurfSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Windsurf.

import * as vscode from 'vscode';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveWindsurfStoragePath } from '../configPaths';
import { discoverWindsurfWorkspacesAsync } from '../../readers/windsurfWorkspace';
import { parseWindsurfWorkspace } from '../../parsers/windsurf';

export class WindsurfSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'windsurf';
    private readonly _deps: SourceWatcherDeps;
    private readonly _rootOverride?: string;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps, rootOverride?: string) {
        this._deps = deps;
        this._rootOverride = rootOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        const root = this._rootOverride ?? resolveWindsurfStoragePath();
        try {
            const workspaces = await discoverWindsurfWorkspacesAsync(root);
            const total = workspaces.length;
            let current = 0;
            const wsResults = await Promise.all(workspaces.map(async (ws) => {
                const vscdbPath = path.join(ws.storageDir, 'state.vscdb');
                const parseResults = await parseWindsurfWorkspace(vscdbPath, ws.id, ws.workspacePath);
                current++;
                onProgress?.(current, total);
                const sessions: Session[] = [];
                for (const result of parseResults) {
                    if (result.errors.length > 0) {
                        channel.appendLine(`[warn] Windsurf parse errors in ${vscdbPath}: ${result.errors.join('; ')}`);
                    }
                    if (result.session.messages.length > 0 &&
                        result.session.createdAt !== new Date(0).toISOString()) {
                        sessions.push(result.session);
                    }
                }
                return sessions;
            }));
            return wsResults.flat();
        } catch (err) {
            channel.appendLine(`[error] WindsurfSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { channel } = this._deps;
        const windsurfRoot = this._rootOverride ?? resolveWindsurfStoragePath();
        const pattern = new vscode.RelativePattern(vscode.Uri.file(windsurfRoot), '**/state.vscdb');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            channel.appendLine(`[live] windsurf state.vscdb deleted: ${uri.fsPath}`);
        });
        this._disposables.push(watcher);
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }

    private _onFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        const vscdbPath = uri.fsPath;
        // Derive a stable workspaceId from the parent directory name (same as buildIndex).
        const workspaceId = path.basename(path.dirname(vscdbPath));
        void parseWindsurfWorkspace(vscdbPath, workspaceId, undefined).then((results) => {
            for (const result of results) {
                if (result.session.messages.length > 0) {
                    index.upsert(result.session);
                }
            }
            channel.appendLine(`[live] windsurf re-indexed ${vscdbPath}`);
        }).catch((err) => {
            channel.appendLine(`[warn] windsurf live parse failed ${vscdbPath}: ${err}`);
        });
    }
}