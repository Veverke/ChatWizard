// src/readers/zedWorkspace.ts
// Feature 41 — Zed AI Source Support

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ParseResult } from '../types/index';
import { parseZedConversation } from '../parsers/zed';

/**
 * Default Zed conversation directories, in preference order.
 * Zed stores conversations as JSON files (one per conversation).
 */
function getDefaultZedConversationDirs(): string[] {
    const platform = process.platform;
    const home = os.homedir();

    if (platform === 'win32') {
        const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
        return [path.join(appData, 'Zed', 'conversations')];
    } else if (platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'Zed', 'conversations'),
            path.join(home, '.config', 'zed', 'conversations'),
        ];
    } else {
        // Linux
        const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
        return [
            path.join(xdgData, 'zed', 'conversations'),
            path.join(home, '.config', 'zed', 'conversations'),
        ];
    }
}

/**
 * Discover all Zed conversation JSON files in the given directory.
 * Returns file paths for all `.json` files found.
 */
export async function discoverZedConversationsAsync(
    conversationDir?: string
): Promise<string[]> {
    const dirs = conversationDir ? [conversationDir] : getDefaultZedConversationDirs();
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
 * Parse all discovered Zed conversation files, returning ParseResult[] for each.
 */
export async function loadZedSessionsAsync(
    conversationDir?: string
): Promise<ParseResult[]> {
    const files = await discoverZedConversationsAsync(conversationDir);
    return files.map(filePath => parseZedConversation(filePath));
}