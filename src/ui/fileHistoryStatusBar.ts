// src/ui/fileHistoryStatusBar.ts
// Status bar item showing how many ChatWizard sessions touched the active file.
// Clicking the item runs the 'chatwizard.showFileHistory' command.
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';

export class FileHistoryStatusBarItem implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly sessionIndex: SessionIndex) {
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

        this.refresh();
    }

    refresh(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.isUntitled) {
            this.item.hide();
            return;
        }

        const normPath = normalisePath(editor.document.uri.fsPath);
        const count = this.countSessions(normPath);

        if (count === 0) {
            this.item.hide();
            return;
        }

        this.item.text = `$(history) ${count} session${count === 1 ? '' : 's'}`;
        this.item.show();
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
