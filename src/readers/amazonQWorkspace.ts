// src/readers/amazonQWorkspace.ts
// Discovers Amazon Q Developer chat session files.
//
// Amazon Q Developer (formerly CodeWhisperer) stores conversations in VS Code's
// globalStorage for the extension ID 'amazonwebservices.amazon-q-vscode'.
// Location: <vscode-storage>/globalStorage/amazonwebservices.amazon-q-vscode/
//
// Conversation files are JSON files under a 'history/' or 'conversations/' subdirectory.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Returns the Amazon Q Developer VS Code extension globalStorage root.
 * The extension ID changed over time; we check all known IDs.
 */
const AMAZON_Q_EXTENSION_IDS = [
    'amazonwebservices.amazon-q-vscode',
    'amazonwebservices.codewhisperer',
    'amazonwebservices.aws-toolkit-vscode',
];

/**
 * Returns candidate Amazon Q storage directories for all known VS Code variants.
 */
function getAmazonQCandidateDirs(): string[] {
    const dirs: string[] = [];

    // Windows
    const appData = process.env['APPDATA'];
    if (appData) {
        for (const vsVariant of ['Code', 'Code - Insiders']) {
            for (const extId of AMAZON_Q_EXTENSION_IDS) {
                dirs.push(path.join(appData, vsVariant, 'User', 'globalStorage', extId));
            }
        }
    }

    // macOS
    const home = os.homedir();
    const macBase = path.join(home, 'Library', 'Application Support');
    for (const vsVariant of ['Code', 'Code - Insiders']) {
        for (const extId of AMAZON_Q_EXTENSION_IDS) {
            dirs.push(path.join(macBase, vsVariant, 'User', 'globalStorage', extId));
        }
    }

    // Linux / WSL
    for (const vsVariant of ['Code', 'code-insiders']) {
        for (const extId of AMAZON_Q_EXTENSION_IDS) {
            dirs.push(path.join(home, '.config', vsVariant, 'User', 'globalStorage', extId));
        }
    }

    return dirs;
}

export function getAmazonQStorageRoot(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('amazonQStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch { /* not in extension host */ }

    // Return first candidate that actually exists
    for (const dir of getAmazonQCandidateDirs()) {
        try {
            if (fs.statSync(dir).isDirectory()) {
                return dir;
            }
        } catch { /* not found */ }
    }

    // Return default even if not found (caller checks existence)
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), '.config');
    return path.join(appData, 'Code', 'User', 'globalStorage', AMAZON_Q_EXTENSION_IDS[0]);
}

/**
 * Scans known subdirectories under the Amazon Q storage root for conversation files.
 * Returns absolute file paths of JSON conversation files.
 */
export async function discoverAmazonQSessionFilesAsync(override?: string): Promise<string[]> {
    const storageRoot = getAmazonQStorageRoot(override);
    const results: string[] = [];

    // Check these subdirectory candidates for conversation files
    const subDirs = ['history', 'conversations', 'chat-history', 'sessions', ''];

    for (const sub of subDirs) {
        const dir = sub ? path.join(storageRoot, sub) : storageRoot;
        try {
            const exists = (await fs.promises.stat(dir)).isDirectory();
            if (!exists) { continue; }

            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) { continue; }
                if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) { continue; }
                results.push(path.join(dir, entry.name));
            }
        } catch { /* directory not found */ }
    }

    return results;
}
