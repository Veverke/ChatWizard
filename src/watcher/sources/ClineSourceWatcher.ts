// src/watcher/sources/ClineSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Cline (saoudrizwan.claude-dev).

import * as vscode from 'vscode';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveClineStoragePath } from '../configPaths';
import { discoverClineTasksAsync } from '../../readers/clineWorkspace';
import { parseClineTask } from '../../parsers/cline';

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
            const total = tasks.length;
            let current = 0;

            const results = await Promise.all(tasks.map(async (task) => {
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

            return results.filter((s): s is Session => s !== null);
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
}