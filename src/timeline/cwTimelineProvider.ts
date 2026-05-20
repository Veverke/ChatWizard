// src/timeline/cwTimelineProvider.ts
//
// Registers ChatWizard chat-session entries in VS Code's built-in Timeline panel
// (Explorer → Timeline section) alongside git commits and Local History.
//
// Register with: vscode.window.registerTimelineProvider('file', provider)
// 'file' matches all local files (file:// URIs). The git extension uses the same scheme.

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { normalisePath, sessionTouchesFile, sessionMentionsFile } from '../utils/pathNormaliser';
import { friendlySourceName } from '../ui/sourceUi';

export class CwTimelineProvider implements vscode.TimelineProvider, vscode.Disposable {
    readonly id = 'chatWizard';
    readonly label = 'ChatWizard Sessions';

    private readonly _onDidChange = new vscode.EventEmitter<vscode.TimelineChangeEvent>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly index: SessionIndex) {}

    provideTimeline(
        uri: vscode.Uri,
        _options: vscode.TimelineOptions,
        _token: vscode.CancellationToken,
    ): vscode.Timeline {
        const normPath = normalisePath(uri.fsPath);
        const items: vscode.TimelineItem[] = [];

        for (const summary of this.index.getAllSummaries()) {
            const session = this.index.get(summary.id);
            if (!session) { continue; }

            const sidecarEntities = this.index.getSidecarMeta(summary.id)?.entities?.filePaths;
            if (
                sessionTouchesFile(session.importantFiles, normPath) ||
                sessionTouchesFile(session.chronicleData?.importantFiles, normPath) ||
                sessionMentionsFile(sidecarEntities, normPath)
            ) {
                items.push({
                    id: summary.id,
                    label: summary.title,
                    timestamp: new Date(session.updatedAt).getTime(),
                    description: friendlySourceName(session.source),
                    command: {
                        command: 'chatwizard.openSession',
                        title: 'Open session',
                        arguments: [{ id: summary.id }],
                    },
                });
            }
        }

        // Newest first — consistent with VS Code's other timeline sources.
        items.sort((a, b) => b.timestamp - a.timestamp);

        return { items };
    }

    /** Fire when the index changes so VS Code re-queries this provider for the active file. */
    refresh(): void {
        this._onDidChange.fire({ reset: true });
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
