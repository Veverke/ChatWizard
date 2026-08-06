// src/watcher/sources/AntigravitySourceWatcher.ts
// Item 2: ISourceWatcher implementation for Antigravity.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveAntigravityBrainPath } from '../configPaths';
import {
    discoverAntigravityConversationsAsync,
    discoverAntigravityJsonConversationsAsync,
    getAntigravityConversationsRoot,
} from '../../readers/antigravityWorkspace';
import { parseAntigravityConversation, parseAntigravityJsonConversation } from '../../parsers/antigravity';

export class AntigravitySourceWatcher implements ISourceWatcher {
    readonly sourceId = 'antigravity';
    private readonly _deps: SourceWatcherDeps;
    private readonly _brainRootOverride?: string;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps, brainRootOverride?: string) {
        this._deps = deps;
        this._brainRootOverride = brainRootOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        const root = this._brainRootOverride ?? resolveAntigravityBrainPath();
        try {
            const [brainInfos, jsonInfos] = await Promise.all([
                discoverAntigravityConversationsAsync(root),
                discoverAntigravityJsonConversationsAsync(),
            ]);

            const total = brainInfos.length + jsonInfos.length;
            let current = 0;

            const brainResults = await Promise.all(brainInfos.map(async (info) => {
                const result = parseAntigravityConversation(info);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Antigravity parse errors: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));

            const brainIds = new Set(brainResults.filter((s): s is Session => s !== null).map(s => s.id));

            const jsonResults = await Promise.all(jsonInfos.map(async (info) => {
                if (brainIds.has(info.conversationId)) { current++; onProgress?.(current, total); return null; }
                const result = parseAntigravityJsonConversation(info);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Antigravity JSON parse errors: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));

            return [
                ...brainResults.filter((s): s is Session => s !== null),
                ...jsonResults.filter((s): s is Session => s !== null),
            ];
        } catch (err) {
            channel.appendLine(`[error] AntigravitySourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const { index, channel } = this._deps;
        const antigravityRoot = this._brainRootOverride ?? resolveAntigravityBrainPath();

        // Watch brain/ overview.txt files
        const brainPattern = new vscode.RelativePattern(
            vscode.Uri.file(antigravityRoot),
            '**/.system_generated/logs/overview.txt'
        );
        const brainWatcher = vscode.workspace.createFileSystemWatcher(brainPattern);
        brainWatcher.onDidCreate((uri) => this._onBrainFileChanged(uri));
        brainWatcher.onDidChange((uri) => this._onBrainFileChanged(uri));
        brainWatcher.onDidDelete((uri) => {
            const conversationId = path.basename(path.dirname(path.dirname(path.dirname(uri.fsPath))));
            index.remove(conversationId);
            channel.appendLine(`[live] removed antigravity session ${conversationId}`);
        });
        this._disposables.push(brainWatcher);

        // Watch conversations/*.json files
        const conversationsRoot = getAntigravityConversationsRoot();
        let conversationsRootExists = false;
        try { conversationsRootExists = fs.statSync(conversationsRoot).isDirectory(); } catch { /* not found */ }
        if (conversationsRootExists) {
            const jsonPattern = new vscode.RelativePattern(vscode.Uri.file(conversationsRoot), '*.json');
            const jsonWatcher = vscode.workspace.createFileSystemWatcher(jsonPattern);
            jsonWatcher.onDidCreate((uri) => this._onJsonFileChanged(uri));
            jsonWatcher.onDidChange((uri) => this._onJsonFileChanged(uri));
            jsonWatcher.onDidDelete((uri) => {
                const sessionId = path.basename(uri.fsPath, '.json');
                index.remove(sessionId);
                channel.appendLine(`[live] removed antigravity-json session ${sessionId}`);
            });
            this._disposables.push(jsonWatcher);
        }
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }

    private _onBrainFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        const overviewFile = uri.fsPath;
        // conversationDir is 3 levels above overview.txt
        const conversationDir = path.dirname(path.dirname(path.dirname(overviewFile)));
        const conversationId = path.basename(conversationDir);
        const info = { conversationId, conversationDir, overviewFile };
        try {
            const result = parseAntigravityConversation(info);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] antigravity upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] antigravity live parse failed ${overviewFile}: ${err}`);
        }
    }

    private _onJsonFileChanged(uri: vscode.Uri): void {
        const { index, channel } = this._deps;
        const conversationId = path.basename(uri.fsPath, '.json');
        const info = { conversationId, jsonFile: uri.fsPath };
        try {
            const result = parseAntigravityJsonConversation(info);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] antigravity-json upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] antigravity-json live parse failed ${uri.fsPath}: ${err}`);
        }
    }
}