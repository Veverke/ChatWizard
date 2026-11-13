// src/watcher/sources/ClineSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Cline (saoudrizwan.claude-dev).

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveClineStoragePath } from '../configPaths';
import {
    discoverClineTasksAsync,
    discoverClineV4SessionsAsync,
    getClineV4SessionsRoot,
} from '../../readers/clineWorkspace';
import { parseClineTask, parseClineV4Session } from '../../parsers/cline';

export class ClineSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'cline';

    private readonly _deps: SourceWatcherDeps;
    private readonly _rootOverride?: string;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps, rootOverride?: string) {
        this._deps = deps;
        this._rootOverride = rootOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        const root = this._rootOverride ?? resolveClineStoragePath();
        try {
            const tasks = await discoverClineTasksAsync(root);
            const v4Sessions = await discoverClineV4SessionsAsync();
            const total = tasks.length + v4Sessions.length;
            let current = 0;

            const legacyResults = await Promise.all(tasks.map(async (task) => {
                const result = await parseClineTask(task.storageDir);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Cline parse errors in ${task.storageDir}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 ||
                    result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            }));

            // Cline 4.x stores its sessions in `~/.cline/data/sessions/<id>/`.
            const v4Results = await Promise.all(v4Sessions.map(async (info) => {
                const result = await parseClineV4Session(info.storageDir);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Cline 4.x parse errors in ${info.storageDir}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 ||
                    result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            }));

            return [...legacyResults, ...v4Results].filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] ClineSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { index, channel } = this._deps;
        const clineRoot = this._rootOverride ?? resolveClineStoragePath();
        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(clineRoot),
            '**/api_conversation_history.json'
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            const taskId = path.basename(path.dirname(uri.fsPath));
            index.remove(taskId);
            channel.appendLine(`[live] removed cline session ${taskId}`);
        });

        this._disposables.push(watcher);

        // Cline 4.x: `~/.cline/data/sessions/<id>/<id>{,.messages}.json`.
        const v4Root = getClineV4SessionsRoot();
        try {
            if (fs.existsSync(v4Root)) {
                const v4Pattern = new vscode.RelativePattern(vscode.Uri.file(v4Root), '*/*.json');
                const v4Watcher = vscode.workspace.createFileSystemWatcher(v4Pattern);
                v4Watcher.onDidCreate((uri) => this._onV4FileChanged(uri));
                v4Watcher.onDidChange((uri) => this._onV4FileChanged(uri));
                v4Watcher.onDidDelete((uri) => {
                    if (uri.fsPath.endsWith('.messages.json')) { return; }
                    const sessionId = path.basename(path.dirname(uri.fsPath));
                    index.remove(sessionId);
                    channel.appendLine(`[live] removed cline 4.x session ${sessionId}`);
                });
                this._disposables.push(v4Watcher);
            }
        } catch {
            // The Cline 4.x directory is optional — never break the legacy watcher.
        }
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }

    private _onFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        const taskDir = path.dirname(uri.fsPath);
        void parseClineTask(taskDir).then((result) => {
            if (result.errors.length > 0) {
                channel.appendLine(`[warn] Cline live parse errors in ${taskDir}: ${result.errors.join('; ')}`);
            }
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] cline upserted ${result.session.id}`);
            }
        }).catch((err) => {
            channel.appendLine(`[error] Cline live parse failed for ${taskDir}: ${err}`);
        });
    }

    /** Live update for a Cline 4.x session directory (`~/.cline/data/sessions/<id>`). */
    private _onV4FileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        const sessionDir = path.dirname(uri.fsPath);
        void parseClineV4Session(sessionDir).then((result) => {
            if (result.errors.length > 0) {
                channel.appendLine(`[warn] Cline 4.x live parse errors in ${sessionDir}: ${result.errors.join('; ')}`);
            }
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] cline 4.x upserted ${result.session.id}`);
            }
        }).catch((err) => {
            channel.appendLine(`[error] Cline 4.x live parse failed for ${sessionDir}: ${err}`);
        });
    }
}