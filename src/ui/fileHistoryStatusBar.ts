// src/ui/fileHistoryStatusBar.ts
// Status bar item showing how many ChatWizard sessions touched the active file.
// Clicking the item runs the 'chatwizard.showFileHistory' command.
//
// Feature 10: File-Centric History

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';

const ICON       = '$(references)';
// $(sync) is a circular-arrow icon — even a quarter-turn is clearly visible as a jolt.
// At codicon-spin speed (1.5 s / 30 steps), 400 ms ≈ 8 steps ≈ 96° then snaps back.
const ICON_PULSE        = '$(sync~spin)';
const PULSE_DURATION_MS = 400;
const PULSE_INTERVAL_MS = 10_000;

export class FileHistoryStatusBarItem implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private _count        = 0;
    private _lastNormPath = '';
    private _animInterval: ReturnType<typeof setInterval> | undefined;
    private _animTimeout:  ReturnType<typeof setTimeout>  | undefined;

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

        // Also refresh when sessions or Chronicle/sidecar data arrives after activation
        this.disposables.push(
            sessionIndex.addChangeListener(() => this.refresh()),
        );

        // Pulse animation every 60 s to catch the user's attention
        this._animInterval = setInterval(() => this._pulse(), PULSE_INTERVAL_MS);

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

        this._setText(ICON);
        this.item.show();

        // Tilt-animate when the user first opens a file that has sessions
        if (isNewFile) {
            this._pulse();
        }
    }

    private _setText(icon: string): void {
        this.item.text = `${icon} ${this._count} session${this._count === 1 ? '' : 's'}`;
    }

    private _pulse(): void {
        if (this._count <= 0) { return; }
        if (this._animTimeout) { clearTimeout(this._animTimeout); }
        this._setText(ICON_PULSE);
        this._animTimeout = setTimeout(() => {
            if (this._count > 0) { this._setText(ICON); }
        }, PULSE_DURATION_MS);
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
        if (this._animInterval) { clearInterval(this._animInterval); }
        if (this._animTimeout)  { clearTimeout(this._animTimeout); }
        for (const d of this.disposables) { d.dispose(); }
    }
}
