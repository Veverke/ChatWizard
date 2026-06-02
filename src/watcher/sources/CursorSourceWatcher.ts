// src/watcher/sources/CursorSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Cursor.

import * as vscode from 'vscode';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveCursorStoragePath } from '../configPaths';
import { discoverCursorWorkspacesAsync, getCursorGlobalDbPath } from '../../readers/cursorWorkspace';
import { parseCursorWorkspace, parseCursorGlobalDb } from '../../parsers/cursor';

export class CursorSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'cursor';
    private readonly _deps: SourceWatcherDeps;
    private readonly _rootOverride?: string;
    private readonly _globalDbOverride?: string;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps, rootOverride?: string, globalDbOverride?: string) {
        this._deps = deps;
        this._rootOverride = rootOverride;
        this._globalDbOverride = globalDbOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        const root = this._rootOverride ?? resolveCursorStoragePath();
        try {
            const workspaces = await discoverCursorWorkspacesAsync(root);
            const total = workspaces.length;
            let current = 0;

            const composerIdToWorkspaceInfo = new Map<string, { workspaceId: string; workspacePath: string | undefined }>();
            const wsSessionsById = new Map<string, Session>();

            const wsResults = await Promise.all(workspaces.map(async (ws) => {
                const vscdbPath = path.join(ws.storageDir, 'state.vscdb');
                const parseResults = await parseCursorWorkspace(vscdbPath, ws.id, ws.workspacePath);
                current++;
                onProgress?.(current, total);

                const sessions: Session[] = [];
                for (const result of parseResults) {
                    if (result.errors.length > 0) {
                        channel.appendLine(`[warn] Cursor parse errors in ${vscdbPath}: ${result.errors.join('; ')}`);
                    }
                    const s = result.session;
                    if (s.id && !s.id.endsWith('-cursor-error')) {
                        composerIdToWorkspaceInfo.set(s.id, {
                            workspaceId: ws.id,
                            workspacePath: ws.workspacePath,
                        });
                    }
                    if (s.messages.length === 0 || s.createdAt === new Date(0).toISOString()) {
                        continue;
                    }
                    sessions.push(s);
                    wsSessionsById.set(s.id, s);
                }
                return sessions;
            }));

            // Merge global DB sessions
            const globalDbPath = this._globalDbOverride ?? getCursorGlobalDbPath();
            try {
                const globalResults = await parseCursorGlobalDb(globalDbPath);
                for (const gr of globalResults) {
                    const gs = gr.session;
                    const wsInfo = composerIdToWorkspaceInfo.get(gs.id);
                    const existing = wsSessionsById.get(gs.id);
                    if (existing) {
                        if (gs.messages.length > existing.messages.length) {
                            wsSessionsById.set(gs.id, { ...gs, workspaceId: existing.workspaceId });
                        }
                    } else {
                        const enriched: Session = wsInfo
                            ? { ...gs, workspaceId: wsInfo.workspaceId }
                            : gs;
                        if (enriched.messages.length > 0) { wsSessionsById.set(enriched.id, enriched); }
                    }
                }
            } catch (err) {
                channel.appendLine(`[warn] Cursor global DB parse failed: ${err}`);
            }

            return Array.from(wsSessionsById.values());
        } catch (err) {
            channel.appendLine(`[error] CursorSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { channel } = this._deps;
        const cursorRoot = this._rootOverride ?? resolveCursorStoragePath();
        const pattern = new vscode.RelativePattern(vscode.Uri.file(cursorRoot), '**/state.vscdb');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            channel.appendLine(`[live] cursor state.vscdb deleted: ${uri.fsPath}`);
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
        void parseCursorWorkspace(vscdbPath, '', undefined).then((results) => {
            for (const result of results) {
                if (result.session.messages.length > 0) {
                    index.upsert(result.session);
                }
            }
            channel.appendLine(`[live] cursor re-indexed ${vscdbPath}`);
        }).catch((err) => {
            channel.appendLine(`[warn] cursor live parse failed ${vscdbPath}: ${err}`);
        });
    }
}