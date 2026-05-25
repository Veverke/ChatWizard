// src/ui/activeSessionTagButton.ts
// Status bar button that appears when a live chat session is active.
// Clicking it fires `chatwizard.tagActiveSession`.
//
// Feature 13-H: Live session tagging entry point

import * as vscode from 'vscode';
import { LiveSessionTracker } from '../utils/liveSessionTracker';

const ICON = '$(tag)';
const COMMAND = 'chatwizard.tagActiveSession';

export class ActiveSessionTagButton implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly liveTracker: LiveSessionTracker) {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            85, // priority: just below FileHistoryStatusBarItem (90)
        );
        this.item.command = COMMAND;
        this.item.text = `${ICON} Tag session`;
        this.item.tooltip = 'ChatWizard: Tag the active chat session';
        this.disposables.push(this.item);

        this.disposables.push(
            liveTracker.onDidUpdate(() => this._refresh()),
        );

        // Ensure correct initial visibility if a session is already active.
        this._refresh();
    }

    private _refresh(): void {
        const windowMs = (
            vscode.workspace.getConfiguration('chatwizard').get<number>('activeSessionWindowMinutes') ?? 120
        ) * 60_000;
        const active = this.liveTracker.getActive(windowMs);
        if (active.length > 0) {
            this.item.show();
        } else {
            this.item.hide();
        }
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}
