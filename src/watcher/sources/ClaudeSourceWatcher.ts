// src/watcher/sources/ClaudeSourceWatcher.ts
// Item 2: ISourceWatcher implementation for Claude (Anthropic).

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ISourceWatcher, SourceWatcherDeps } from '../ISourceWatcher';
import { Session } from '../../types/index';
import { resolveClaudeProjectsPath } from '../configPaths';
import { parseClaudeSession } from '../../parsers/claude';
import { ParseResult } from '../../types/index';

export class ClaudeSourceWatcher implements ISourceWatcher {
    readonly sourceId = 'claude';

    private readonly _deps: SourceWatcherDeps;
    private readonly _baseDirOverride?: string;
    private _disposables: vscode.Disposable[] = [];
    private _nodeWatchers: fs.FSWatcher[] = [];
    private _debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(deps: SourceWatcherDeps, baseDirOverride?: string) {
        this._deps = deps;
        this._baseDirOverride = baseDirOverride;
    }

    async buildIndex(): Promise<Session[]> {
        const { channel, onProgress, selectedIds } = this._deps;
        const claudeProjectsDir = resolveClaudeProjectsPath(this._baseDirOverride);
        try {
            let exists = false;
            try { exists = (await fs.promises.stat(claudeProjectsDir)).isDirectory(); } catch { /* not found */ }
            if (!exists) { return []; }

            const resolvedBase = await fs.promises.realpath(claudeProjectsDir).catch(() => claudeProjectsDir);
            const projectDirEntries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true });
            const allDirEntries = projectDirEntries.filter(d => d.isDirectory());
            const dirEntries = selectedIds.length > 0
                ? allDirEntries.filter(d => selectedIds.includes(d.name))
                : allDirEntries;

            const fileLists = await Promise.all(dirEntries.map(async (d) => {
                const projectPath = path.join(claudeProjectsDir, d.name);
                try {
                    const files = await fs.promises.readdir(projectPath, { withFileTypes: true });
                    return { projectPath, files: files.filter(f => f.isFile() && f.name.endsWith('.jsonl')) };
                } catch {
                    return { projectPath, files: [] };
                }
            }));

            const total = fileLists.reduce((s, { files }) => s + files.length, 0);
            let current = 0;

            const dirResults = await Promise.all(fileLists.map(async ({ projectPath, files }) => {
                const sessions: Session[] = [];
                for (const file of files) {
                    const filePath = path.join(projectPath, file.name);
                    try {
                        const real = await fs.promises.realpath(filePath);
                        if (!real.startsWith(resolvedBase + path.sep) && real !== resolvedBase) {
                            channel.appendLine(`[security] Skipping ${filePath}: outside base`);
                            current++;
                            onProgress?.(current, total);
                            continue;
                        }
                    } catch {
                        current++;
                        onProgress?.(current, total);
                        continue;
                    }
                    try {
                        const result: ParseResult = parseClaudeSession(filePath);
                        if (result.session.messages.length > 0) { sessions.push(result.session); }
                    } catch { /* skip malformed */ }
                    current++;
                    onProgress?.(current, total);
                    if (onProgress && current % 10 === 0) {
                        await new Promise<void>(r => setImmediate(r));
                    }
                }
                return sessions;
            }));

            return dirResults.flat();
        } catch (err) {
            channel.appendLine(`[error] ClaudeSourceWatcher.buildIndex failed: ${err}`);
            return [];
        }
    }

    startWatching(): void {
        const claudeBaseDir = resolveClaudeProjectsPath(this._baseDirOverride);
        const { index, channel } = this._deps;

        const claudePattern = new vscode.RelativePattern(vscode.Uri.file(claudeBaseDir), '**/*.jsonl');
        const watcher = vscode.workspace.createFileSystemWatcher(claudePattern);

        watcher.onDidCreate((uri) => this._onFileChanged(uri.fsPath, claudeBaseDir));
        watcher.onDidChange((uri) => this._onFileChanged(uri.fsPath, claudeBaseDir));
        watcher.onDidDelete((uri) => {
            const sessionId = path.basename(uri.fsPath, '.jsonl');
            index.remove(sessionId);
            channel.appendLine(`[live] removed claude session ${sessionId}`);
        });

        this._disposables.push(watcher);

        // Supplemental native watchers for faster live updates
        try {
            const entries = fs.readdirSync(claudeBaseDir, { withFileTypes: true }).filter(e => e.isDirectory());
            const capped = entries.length > 50
                ? entries
                    .map(e => ({ e, mtime: (() => { try { return fs.statSync(path.join(claudeBaseDir, e.name)).mtimeMs; } catch { return 0; } })() }))
                    .sort((a, b) => b.mtime - a.mtime).slice(0, 50).map(x => x.e)
                : entries;
            for (const entry of capped) {
                const projDir = path.join(claudeBaseDir, entry.name);
                this._watchDirFast(projDir, '.jsonl', (fullPath) => {
                    if (!fs.existsSync(fullPath)) { return; }
                    this._onFileChanged(fullPath, claudeBaseDir);
                });
            }
        } catch { /* skip */ }
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables = [];
        for (const w of this._nodeWatchers) { try { w.close(); } catch { /* ignore */ } }
        this._nodeWatchers = [];
        for (const t of this._debounceMap.values()) { clearTimeout(t); }
        this._debounceMap.clear();
    }

    private _onFileChanged(filePath: string, baseDir: string): void {
        const { index, channel } = this._deps;
        try {
            const real = fs.realpathSync(filePath);
            if (!real.startsWith(baseDir + path.sep) && real !== baseDir) { return; }
        } catch { return; }
        try {
            const result: ParseResult = parseClaudeSession(filePath);
            if (result.session.messages.length > 0) {
                index.upsert(result.session);
                channel.appendLine(`[live] claude upserted ${result.session.id}`);
            }
        } catch (err) {
            channel.appendLine(`[warn] claude live parse failed ${filePath}: ${err}`);
        }
    }

    private _watchDirFast(dir: string, ext: string, handler: (fullPath: string) => void): void {
        if (!fs.existsSync(dir)) { return; }
        try {
            const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
                if (!filename || !filename.endsWith(ext)) { return; }
                const fullPath = path.join(dir, filename);
                const prev = this._debounceMap.get(fullPath);
                if (prev) { clearTimeout(prev); }
                this._debounceMap.set(fullPath, setTimeout(() => {
                    this._debounceMap.delete(fullPath);
                    handler(fullPath);
                }, 300));
            });
            w.on('error', () => { /* swallow */ });
            this._nodeWatchers.push(w);
        } catch { /* not supported */ }
    }
}