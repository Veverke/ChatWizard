// src/ui/fileHistoryCodeLens.ts
// CodeLens provider that shows a "N sessions" lens at line 0 of each file
// that has associated ChatWizard sessions.
//
// The lens runs 'chatwizard.showFileHistory' for the current file.
// Enabled via 'chatwizard.codeLens.enabled' (default: true).
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';

export class FileHistoryCodeLensProvider
    implements vscode.CodeLensProvider, vscode.Disposable
{
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeEmitter.event;

    private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter];

    constructor(private readonly sessionIndex: SessionIndex) {
        // Refresh lenses when the index changes
        this.disposables.push(
            sessionIndex.addChangeListener(() => this.onDidChangeEmitter.fire()),
        );
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration('chatwizard').get<boolean>('codeLens.enabled', true)) {
            return [];
        }
        if (document.isUntitled) { return []; }

        const normPath = normalisePath(document.uri.fsPath);
        const sessions: Array<{ id: string; title: string }> = [];

        for (const summary of this.sessionIndex.getAllSummaries()) {
            const session = this.sessionIndex.get(summary.id);
            if (!session) { continue; }
            const sidecarEntities = this.sessionIndex.getSidecarMeta(summary.id)?.entities?.filePaths;
            if (
                sessionTouchesFile(session.importantFiles, normPath) ||
                sessionTouchesFile(session.chronicleData?.importantFiles, normPath) ||
                sessionMentionsFile(sidecarEntities, normPath)
            ) {
                sessions.push({ id: summary.id, title: summary.title });
            }
        }

        if (sessions.length === 0) { return []; }

        const range = new vscode.Range(0, 0, 0, 0);
        const label = `$(history) ChatWizard: ${sessions.length} session${sessions.length === 1 ? '' : 's'} touched this file`;

        return [
            new vscode.CodeLens(range, {
                title: label,
                command: 'chatwizard.showFileHistory',
                arguments: [document.uri.fsPath],
            }),
        ];
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
