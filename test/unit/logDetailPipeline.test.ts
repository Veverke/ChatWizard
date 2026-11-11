import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerLogCommands } from '../../src/logs/logsCommands';
import { ExecCommandsLeafItem } from '../../src/logs/executedCommandsProvider';
import { CommandEvent } from '../../src/logs/types';

suite('detail webview pipeline', () => {
    test('execCommands.showDetails opens a webview panel without throwing', async () => {
        const subs: { dispose(): void }[] = [];
        const context = {
            subscriptions: {
                push(item: { dispose(): void }): void { subs.push(item); },
            },
        };
        // The extension registers every watch-logs command during activation
        // (even when the SQLite store degrades to memory — that is what keeps
        // the view title buttons working). Only register the handlers locally
        // when the extension was not activated, otherwise VS Code rejects the
        // duplicate command ids.
        const alreadyRegistered = (await vscode.commands.getCommands(true))
            .includes('chatwizard.execCommands.showDetails');
        if (!alreadyRegistered) {
            // Providers are only used by refresh commands — not needed for the detail command.
            registerLogCommands(context as never, undefined as never, undefined, undefined);
        }

        const leaf = new ExecCommandsLeafItem({
            type: 'command',
            id: 'it-1',
            timestamp: new Date().toISOString(),
            tool: 'cline',
            commandText: 'npm run build',
            sessionId: 's1',
        } as CommandEvent);

        // Exactly what VS Code does when a tree item's `command` activates.
        const panel = await vscode.commands.executeCommand(
            'chatwizard.execCommands.showDetails',
            leaf
        ) as vscode.WebviewPanel | undefined;

        assert.ok(panel, 'expected the command handler to return the created webview panel');
        assert.strictEqual(panel?.viewType, 'chatwizardLogEventDetail');
        assert.ok((panel?.webview.html ?? '').length > 100, 'expected non-empty webview html');
        assert.ok(panel?.webview.options.enableScripts, 'expected scripts enabled');
        assert.match(panel?.title ?? '', /Executed Command: npm run build/);
        if (!alreadyRegistered) {
            assert.ok(subs.length > 0, 'expected the panel listener disposal to be pushed to subscriptions');
        }
    });
});