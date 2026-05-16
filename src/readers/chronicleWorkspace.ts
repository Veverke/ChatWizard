// src/readers/chronicleWorkspace.ts
// Discovers all Copilot Chronicle session-store.db files under workspaceStorage.

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceStorageRoots } from './copilotWorkspace';

export interface ChronicleDbInfo {
    /** Absolute path to session-store.db */
    dbPath: string;
    /** The workspace hash directory name under workspaceStorage */
    workspaceHash: string;
}

const CHRONICLE_RELATIVE_PATH = path.join('GitHub.copilot-chat', 'debug-logs', 'session-store.db');

/**
 * Discovers all Chronicle session-store.db files under workspaceStorage.
 * Applies a symlink guard to prevent traversal outside the storage root.
 *
 * @param storageRootOverride  Test-only: override the workspaceStorage root(s).
 */
export async function discoverChronicleDbsAsync(
    storageRootOverride?: string,
): Promise<ChronicleDbInfo[]> {
    const roots = storageRootOverride ? [storageRootOverride] : getWorkspaceStorageRoots();
    const results: ChronicleDbInfo[] = [];

    for (const root of roots) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
            continue; // root doesn't exist or can't be read
        }

        const resolvedRoot = await fs.promises.realpath(root).catch(() => root);

        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }
            const dbPath = path.join(root, entry.name, CHRONICLE_RELATIVE_PATH);
            try {
                const stat = await fs.promises.stat(dbPath);
                if (!stat.isFile()) { continue; }
                // Symlink guard: ensure the db is inside the storage root
                const realDbPath = await fs.promises.realpath(dbPath).catch(() => null);
                if (!realDbPath) { continue; }
                if (!realDbPath.startsWith(resolvedRoot + path.sep) && realDbPath !== resolvedRoot) {
                    continue; // symlink escape — skip
                }
                results.push({ dbPath: realDbPath, workspaceHash: entry.name });
            } catch {
                // DB doesn't exist for this workspace — skip
            }
        }
    }

    return results;
}
