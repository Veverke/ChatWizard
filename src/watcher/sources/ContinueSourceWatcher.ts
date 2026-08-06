// src/watcher/sources/ContinueSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Continue.dev.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { discoverContinueSessionFilesAsync } from '../../readers/continueWorkspace';
import { parseContinueSession } from '../../parsers/continueDev';

export class ContinueSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'continue';
    private readonly _deps: SourceWatcherDeps;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps) {
        this._deps = deps;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        try {
            const files = await discoverContinueSessionFilesAsync();
            const total = files.length;
            let current = 0;
            const results = await Promise.all(files.map(async (filePath) => {
                const result = parseContinueSession(filePath);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Continue parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));
            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] ContinueSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { index, channel } = this._deps;
        const continueRoot = path.join(os.homedir(), '.continue', 'sessions');
        if (!fs.existsSync(continueRoot)) { return; }

        const pattern = new vscode.RelativePattern(vscode.Uri.file(continueRoot), '**/*.{json,jsonl}');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            const sessionId = path.basename(uri.fsPath).replace(/\.[^.]+$/, '');
            index.remove(sessionId);
        });
        this._disposables.push(watcher);
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }

    private _onFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        try {
            const result = parseContinueSession(uri.fsPath);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] continue upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] continue live parse failed ${uri.fsPath}: ${err}`);
        }
    }
}