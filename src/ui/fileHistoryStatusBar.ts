// src/ui/fileHistoryStatusBar.ts
// Status bar item showing how many ChatWizard sessions touched the active file.
// Clicking the item runs the 'chatwizard.showFileHistory' command.
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';

const ICON = '$(references)';

export class FileHistoryStatusBarItem implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private _count        = 0;
    private _lastNormPath = '';

    constructor(
        private readonly sessionIndex: SessionIndex,
        private readonly onFileHistory?: (count: number, normPath: string) => void,
    ) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            90, // priority (after language mode)
        );
        this.item.command = 'chatwizard.showFileHistory';
        this.item.tooltip = 'ChatWizard: Show sessions for this file';
        this.disposables.push(this.item);

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
        );

        // Also refresh when sessions or Chronicle/sidecar data arrives after activation
        this.disposables.push(
            sessionIndex.addChangeListener(() => this.refresh()),
        );

        this.refresh();
    }

    refresh(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.isUntitled) {
            this._count = 0;
            this._lastNormPath = '';
            this.item.hide();
            return;
        }

        const normPath  = normalisePath(editor.document.uri.fsPath);
        const isNewFile = normPath !== this._lastNormPath;
        this._lastNormPath = normPath;
        this._count = this.countSessions(normPath);

        if (this._count === 0) {
            this.item.hide();
            return;
        }

        this.item.text = `${ICON} ${this._count} session${this._count === 1 ? '' : 's'}`;
        this.item.show();

        if (isNewFile) {
            this.onFileHistory?.(this._count, normPath);
        }
    }

    private countSessions(normPath: string): number {
        let count = 0;
        for (const summary of this.sessionIndex.getAllSummaries()) {
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }
            const sidecarEntities = this.sessionIndex.getSidecarMeta(summary.id)?.entities?.filePaths;
            if (
                sessionTouchesFile(session.importantFiles, normPath) ||
                sessionTouchesFile(session.chronicleData?.importantFiles, normPath) ||
                sessionMentionsFile(sidecarEntities, normPath)
            ) {
                count++;
            }
        }
        return count;
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
