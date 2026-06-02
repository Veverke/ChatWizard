// src/watcher/sources/AiderSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Aider.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { discoverAiderHistoryFilesAsync } from '../../readers/aiderWorkspace';
import { parseAiderHistory } from '../../parsers/aider';

export class AiderSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'aider';
    private readonly _deps: SourceWatcherDeps;
    private readonly _rootsOverride?: string[];
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps, rootsOverride?: string[]) {
        this._deps = deps;
        this._rootsOverride = rootsOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        try {
            const cfg = vscode.workspace.getConfiguration('chatwizard');
            const extraRoots = cfg.get<string[]>('aiderSearchRoots', []);
            const maxDepth = cfg.get<number>('aiderSearchDepth', 3);
            const wsFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
            const roots = this._rootsOverride ?? [...wsFolders, ...extraRoots];

            const infos = await discoverAiderHistoryFilesAsync(roots, maxDepth);
            const total = infos.length;
            let current = 0;

            const results = await Promise.all(infos.map(async (info) => {
                const result = parseAiderHistory(info);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Aider parse errors in ${info.historyFile}: ${result.errors.join('; ')}`);
                }
                if (result.session.messages.length === 0 ||
                    result.session.createdAt === new Date(0).toISOString()) {
                    return null;
                }
                return result.session;
            }));

            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] AiderSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { index, channel } = this._deps;
        const watcher = vscode.workspace.createFileSystemWatcher('**/.aider.chat.history.md');
        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            const sessionId = crypto.createHash('sha1').update(uri.fsPath).digest('hex');
            index.remove(sessionId);
            channel.appendLine(`[live] removed aider session ${uri.fsPath}`);
        });
        this._disposables.push(watcher);
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }

    private _onFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        // AiderHistoryInfo needs historyFile and projectRoot
        const filePath = uri.fsPath;
        const nodePath = require('path') as typeof import('path');
        const projectRoot = nodePath.dirname(filePath);
        const info = { historyFile: filePath, projectRoot, workspacePath: projectRoot };
        try {
            const result = parseAiderHistory(info);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] aider upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] aider live parse failed ${filePath}: ${err}`);
        }
    }
}