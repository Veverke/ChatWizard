import * as vscode from 'vscode';
import { SessionSource } from '../types/index';

/**
 * Returns a brand icon `{ light, dark }` URI pair for sources that have bundled SVGs.
 * For sources that use codicons (copilot/claude), returns null.
 */
export function sourceBrandIconUris(
    source: SessionSource,
    extensionUri: vscode.Uri
): { light: vscode.Uri; dark: vscode.Uri } | null {
    switch (source) {
        case 'cline':
        case 'roocode':
        case 'cursor':
        case 'windsurf':
        case 'aider':
            return {
                light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', `${source}_light.svg`),
                dark:  vscode.Uri.joinPath(extensionUri, 'resources', 'icons', `${source}_dark.svg`),
            };
        default:
            return null;
    }
}

