/**
 * src/logs/logsCommands.ts
 *
 * Phase 2 — Commands for the watch-logs "Executed Commands" panel.
 * All commands are registered through the extension `context` so they follow
 * the same disposal pattern as every other ChatWizard command.
 */

import * as vscode from 'vscode';
import { ExecutedCommandsProvider, ExecCommandsLeafItem } from './executedCommandsProvider';

export interface LogCommandsContext {
    subscriptions: { push(item: { dispose(): void }): void };
}

export function registerLogCommands(
    context: LogCommandsContext,
    provider: ExecutedCommandsProvider
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.showExecutedCommands', () => {
            void vscode.commands.executeCommand('chatwizardExecutedCommands.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.execCommands.copy', (item?: ExecCommandsLeafItem) => {
            if (!item) { return; }
            void vscode.env.clipboard.writeText(item.event.commandText);
            vscode.window.showInformationMessage('Copied executed command to clipboard');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.execCommands.openSession', (item?: ExecCommandsLeafItem) => {
            if (!item) { return; }
            const sessionId = item.event.sessionId;
            if (!sessionId) {
                vscode.window.showErrorMessage('This command is not attached to a session');
                return;
            }
            // Reuse the sessions panel's opener — it only needs the summary shape.
            void vscode.commands.executeCommand('chatwizard.openSession', { id: sessionId });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.execCommands.refresh', () => {
            provider.refresh();
        })
    );
}