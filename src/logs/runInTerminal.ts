/**
 * src/logs/runInTerminal.ts
 *
 * Opens a VS Code terminal and runs an agent-executed command in it again.
 *
 * Used from two places:
 *   - the **▶ Run in Terminal** button rendered under the command text in the
 *     log-event detail webview (`logEventWebview.ts`), and
 *   - the `chatwizard.execCommands.runInTerminal` tree command.
 *
 * The captured working directory is only used when it still exists on disk;
 * otherwise the terminal opens in the current workspace folder.
 */

import * as vscode from 'vscode';
import { firstLineOf } from './executedCommandsProvider';

/** Longest command excerpt used in the terminal tab title. */
const MAX_TERMINAL_NAME = 40;

/** Terminal tab title for a command ("Chat Wizard: npm test"). */
export function terminalNameFor(commandText: string): string {
    const first = firstLineOf(commandText, MAX_TERMINAL_NAME);
    return first ? `Chat Wizard: ${first}` : 'Chat Wizard';
}

/** Whether `dirPath` still exists and is a directory (best effort). */
async function isDirectory(dirPath: string): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dirPath));
        return stat.type === vscode.FileType.Directory;
    } catch {
        return false;
    }
}

/**
 * Create a terminal, show it and send `commandText` to it.
 * Returns the terminal, or `undefined` when there is nothing to run.
 */
export async function runCommandInTerminal(
    commandText: string | undefined,
    cwd?: string
): Promise<vscode.Terminal | undefined> {
    const command = (commandText ?? '').trim();
    if (command.length === 0) {
        void vscode.window.showWarningMessage('This log event carries no command text to run.');
        return undefined;
    }

    const workingDir = cwd && cwd.trim().length > 0 && await isDirectory(cwd) ? cwd : undefined;
    const terminal = vscode.window.createTerminal({ name: terminalNameFor(command), cwd: workingDir });
    terminal.show();
    terminal.sendText(command, true);

    return terminal;
}
