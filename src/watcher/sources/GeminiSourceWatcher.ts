// src/watcher/sources/GeminiSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Gemini Code Assist.

import * as vscode from 'vscode';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { discoverGeminiCodeAssistSessionFilesAsync } from '../../readers/geminiCodeAssistWorkspace';
import { parseGeminiCodeAssistSession } from '../../parsers/geminiCodeAssist';

export class GeminiSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'gemini';
    private readonly _deps: SourceWatcherDeps;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps) {
        this._deps = deps;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        try {
            const files = await discoverGeminiCodeAssistSessionFilesAsync();
            const total = files.length;
            let current = 0;
            const results = await Promise.all(files.map(async (filePath) => {
                const result = parseGeminiCodeAssistSession(filePath);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] Gemini parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));
            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] GeminiSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        // Gemini Code Assist sessions are file-based but paths vary by user config.
        // Startup discovery is the primary mechanism.
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }
}