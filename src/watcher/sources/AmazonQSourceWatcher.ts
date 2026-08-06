// src/watcher/sources/AmazonQSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Amazon Q.

import * as vscode from 'vscode';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { discoverAmazonQSessionFilesAsync } from '../../readers/amazonQWorkspace';
import { parseAmazonQSession } from '../../parsers/amazonQ';

export class AmazonQSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'amazonq';
    private readonly _deps: SourceWatcherDeps;
    private _disposables: vscode.Disposable[] = [];

    constructor(deps: SourceWatcherDeps) {
        this._deps = deps;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress } = this._deps;
        try {
            const files = await discoverAmazonQSessionFilesAsync();
            const total = files.length;
            let current = 0;
            const results = await Promise.all(files.map(async (filePath) => {
                const result = parseAmazonQSession(filePath);
                current++;
                onProgress?.(current, total);
                if (result.errors.length > 0) {
                    channel.appendLine(`[warn] AmazonQ parse errors in ${filePath}: ${result.errors.join('; ')}`);
                }
                return result.session.messages.length > 0 ? result.session : null;
            }));
            return results.filter((s): s is Session => s !== null);
        } catch (err) {
            channel.appendLine(`[error] AmazonQSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        // Amazon Q does not have a well-known file path to watch at runtime
        // — sessions are discovered once at startup.
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
    }
}