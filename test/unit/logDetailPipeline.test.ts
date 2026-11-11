import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerLogCommands } from '../../src/logs/logsCommands';
import { ExecCommandsLeafItem } from '../../src/logs/executedCommandsProvider';
import { CommandEvent } from '../../src/logs/types';
import { closeEventWebview } from '../../src/logs/logEventWebview';

function makeLeaf(id: string, commandText: string): ExecCommandsLeafItem {
    return new ExecCommandsLeafItem({
        type: 'command',
        id,
        timestamp: new Date().toISOString(),
        tool: 'cline',
        commandText,
        sessionId: 's1',
    } as CommandEvent);
}

suite('detail webview pipeline', () => {
    teardown(() => {
        // The detail panel is shared between events; close it so each test
        // starts from a clean slate.
        closeEventWebview();
    });

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

        const leaf = makeLeaf('it-1', 'npm run build');

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
        assert.ok((panel?.webview.html ?? '').includes('runCommandBtn'), 'run button is rendered');
        if (!alreadyRegistered) {
            assert.ok(subs.length > 0, 'expected the panel listener disposal to be pushed to subscriptions');
        }
    });

    test('every event reuses the same detail window (no window pile-up)', async () => {
        const alreadyRegistered = (await vscode.commands.getCommands(true))
            .includes('chatwizard.execCommands.showDetails');
        if (!alreadyRegistered) {
            registerLogCommands(
                { subscriptions: { push: () => undefined } } as never,
                undefined as never,
                undefined,
                undefined
            );
        }

        const first = await vscode.commands.executeCommand(
            'chatwizard.execCommands.showDetails',
            makeLeaf('it-2', 'git status')
        ) as vscode.WebviewPanel | undefined;
        const second = await vscode.commands.executeCommand(
            'chatwizard.execCommands.showDetails',
            makeLeaf('it-3', 'npm test')
        ) as vscode.WebviewPanel | undefined;

        assert.ok(first, 'first click opens the panel');
        assert.strictEqual(second, first, 'second click must retarget the very same panel');
        assert.match(second?.title ?? '', /Executed Command: npm test/, 'panel title follows the new event');
        assert.ok((second?.webview.html ?? '').includes('npm test'), 'panel contents follow the new event');
        assert.ok(!(second?.webview.html ?? '').includes('git status'), 'old contents are replaced');
    });

    test('the single Commands view is contributed and its commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('chatwizard.logs.refreshAll'), 'shared refresh command');
        assert.ok(commands.includes('chatwizard.logs.showSelectedDetails'), 'selection-aware details command');
        // Phase 4 — view-wide filters + per-agent stats.
        for (const id of [
            'chatwizard.logs.filterMenu',
            'chatwizard.logs.search',
            'chatwizard.logs.filterByAgent',
            'chatwizard.logs.toggleFailures',
            'chatwizard.logs.clearFilters',
            'chatwizard.logs.showStats',
        ]) {
            assert.ok(commands.includes(id), `${id} is registered`);
        }
        assert.ok(
            commands.includes('chatwizardCommands.focus'),
            'the contributed Commands view registers <view>.focus'
        );
        assert.ok(
            !commands.includes('chatwizardExecutedCommands.focus')
            && !commands.includes('chatwizardUnifiedTimeline.focus')
            && !commands.includes('chatwizardDiffExplorer.focus'),
            'the three per-panel views are gone'
        );
    });
});
