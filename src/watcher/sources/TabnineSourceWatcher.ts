// src/watcher/sources/TabnineSourceWatcher.ts
// Feature 42 — Tabnine Chat Source Support
//
// Tabnine stores chat history in VS Code extension storage as JSON files.
// Location: %APPDATA%\Code\User\globalStorage\TabNine.tabnine-vscode\chat\ (Windows)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { discoverTabnineConversationsAsync } from '../../readers/tabnineWorkspace';
import { parseTabnineConversation } from '../../parsers/tabnine';

const TABNINE_EXTENSION_ID = 'TabNine.tabnine-vscode';

/**
 * Resolve the default Tabnine chat directory for the current platform.
 */
function getTabnineChatDir(): string | undefined {
    const platform = process.platform;
    const home = os.homedir();

    if (platform === 'win32') {
        const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat');
    } else if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat');
    } else {
        // Linux
        const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
        return path.join(xdgConfig, 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat');
    }
}

export class TabnineSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'tabnine';
    private readonly _deps: SourceWatcherDeps;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps) {
        this._deps = deps;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        try {
            const files = await discoverTabnineConversationsAsync();
            const total = files.length;
            let current = 0;
            const results = await Promise.all(files.map(async (filePath) => {
                const result = parseTabnineConversation(filePath);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Tabnine parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));
            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] TabnineSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const chatDir = getTabnineChatDir();
        if (!chatDir || !fs.existsSync(chatDir)) { return; }

        const pattern = new vscode.RelativePattern(vscode.Uri.file(chatDir), '*.json');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate((uri) => this._onFileChanged(uri));
        watcher.onDidChange((uri) => this._onFileChanged(uri));
        watcher.onDidDelete((uri) => {
            const sessionId = path.basename(uri.fsPath, '.json');
            this._deps.index.remove(sessionId);
        });

        this._disposables.push(watcher);
    }

    private async _onFileChanged(uri: vscode.Uri): Promise<void> {
        try {
            const result = parseTabnineConversation(uri.fsPath);
            if (result.session.messages.length > 0) {
                this._deps.index.upsert(result.session);
                this._deps.channel.appendLine(`[live] updated tabnine session ${result.session.id}`);
            }
        } catch (err) {
            this._deps.channel.appendLine(`[live] Failed to parse tabnine file ${uri.fsPath}: ${err}`);
        }
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }
}