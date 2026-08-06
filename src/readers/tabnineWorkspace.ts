// src/readers/tabnineWorkspace.ts
// Feature 42 — Tabnine Chat Source Support

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ParseResult } from '../types/index';
import { parseTabnineConversation } from '../parsers/tabnine';

const TABNINE_EXTENSION_ID = 'TabNine.tabnine-vscode';

/**
 * Default Tabnine chat storage directories, in preference order.
 */
function getDefaultTabnineChatDirs(): string[] {
    const platform = process.platform;
    const home = os.homedir();

    if (platform === 'win32') {
        const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
        return [
            path.join(appData, 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
            path.join(appData, 'Code - Insiders', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
        ];
    } else if (platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
            path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
        ];
    } else {
        // Linux
        const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
        return [
            path.join(xdgConfig, 'Code', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
            path.join(xdgConfig, 'Code - Insiders', 'User', 'globalStorage', TABNINE_EXTENSION_ID, 'chat'),
        ];
    }
}

/**
 * Discover all Tabnine chat JSON files in the given directory.
 */
export async function discoverTabnineConversationsAsync(
    chatDir?: string
): Promise<string[]> {
    const dirs = chatDir ? [chatDir] : getDefaultTabnineChatDirs();
    const files: string[] = [];

    for (const dir of dirs) {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.json')) {
                    files.push(path.join(dir, entry.name));
                }
            }
        } catch {
            // Directory does not exist or not accessible — skip silently
        }
    }

    return files;
}

/**
 * Parse all discovered Tabnine conversation files.
 */
export async function loadTabnineSessionsAsync(
    chatDir?: string
): Promise<ParseResult[]> {
    const files = await discoverTabnineConversationsAsync(chatDir);
    return files.map(filePath => parseTabnineConversation(filePath));
}