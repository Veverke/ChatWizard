// src/commands/paletteCommands.ts
//
// Command-palette grouping layer.
//
// All leaf commands are hidden from the flat command palette (package.json
// commandPalette.when = false).  Instead, five top-level "category" commands
// are exposed.  Each one opens a quickPick that delegates to the underlying
// leaf command.  This keeps Ctrl+Shift+P clean while preserving every
// toolbar, context-menu, and programmatic use of the leaf commands unchanged.

import * as vscode from 'vscode';
import { PALETTE_CATEGORIES } from './paletteCommandsData';

// Re-export types and data so callers only need one import.
export { PaletteItem, PaletteCategory, PALETTE_CATEGORIES } from './paletteCommandsData';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPaletteCommands(context: vscode.ExtensionContext): void {
    for (const cat of PALETTE_CATEGORIES) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cat.commandId, async () => {
                type ItemWithId = vscode.QuickPickItem & { commandId: string };
                const items: ItemWithId[] = cat.items.map(i => ({
                    label: `${i.icon}  ${i.label}`,
                    description: i.description,
                    commandId: i.commandId,
                }));

                const pick = await vscode.window.showQuickPick(items, {
                    title: `Chat Wizard — ${cat.title}`,
                    placeHolder: 'Select an action…',
                });

                if (pick) {
                    await vscode.commands.executeCommand(pick.commandId);
                }
            })
        );
    }
}
