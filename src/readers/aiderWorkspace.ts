// src/readers/aiderWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import { AiderHistoryInfo } from '../types/index';

/** Name of the Aider chat history file written into each project root. */
export const AIDER_HISTORY_FILENAME = '.aider.chat.history.md';

/** Name of the optional Aider config file. */
export const AIDER_CONFIG_FILENAME = '.aider.conf.yml';

/** Maximum file size accepted for a history file (20 MB). */
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

/** Default recursive search depth (inclusive of root). */
export const DEFAULT_AIDER_SEARCH_DEPTH = 3;

/** Hard maximum search depth cap. */
export const MAX_AIDER_SEARCH_DEPTH = 5;

/**
 * Recursively searches `rootDir` up to `maxDepth` directory levels deep for
 * `.aider.chat.history.md` files.  Returns one `AiderHistoryInfo` per file
 * found (symlinks excluded, oversized files excluded).
 *
 * @param rootDir   Directory to start searching from.
 * @param maxDepth  Maximum depth to recurse (1 = root only, 3 = default).
 */
async function searchDirAsync(
    rootDir: string,
    maxDepth: number
): Promise<AiderHistoryInfo[]> {
    const results: AiderHistoryInfo[] = [];
    await _walkAsync(rootDir, rootDir, 1, maxDepth, results);
    return results;
}

async function _walkAsync(
    currentDir: string,
    _rootDir: string,
    currentDepth: number,
    maxDepth: number,
    results: AiderHistoryInfo[]
): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
        return;
    }

    // Check for history file at this level
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) { continue; }
        if (entry.name !== AIDER_HISTORY_FILENAME) { continue; }

        const historyFile = path.join(currentDir, entry.name);

        // SEC: verify not a symlink via lstat (withFileTypes only checks d_type on some FSes)
        try {
            const lstat = await fs.promises.lstat(historyFile);
            if (!lstat.isFile() || lstat.isSymbolicLink()) { continue; }
            if (lstat.size > MAX_HISTORY_BYTES) { continue; }
        } catch {
            continue;
        }

        const workspacePath = currentDir;
        let configFile: string | undefined;
        const candidate = path.join(currentDir, AIDER_CONFIG_FILENAME);
        try {
            const cfgStat = await fs.promises.lstat(candidate);
            if (cfgStat.isFile() && !cfgStat.isSymbolicLink()) {
                configFile = candidate;
            }
        } catch {
            // Not present — fine
        }

        results.push({ historyFile, workspacePath, configFile });
    }

    // Recurse into subdirectories if depth allows
    if (currentDepth < maxDepth) {
        await Promise.all(
            entries
                .filter(e => e.isDirectory() && !e.isSymbolicLink())
                .map(e => _walkAsync(path.join(currentDir, e.name), _rootDir, currentDepth + 1, maxDepth, results))
        );
    }
}

/**
 * Discovers all Aider chat history files under the provided root directories.
 *
 * @param roots     List of absolute directory paths to search.
 * @param maxDepth  Maximum recursive depth (default: 3, max: 5).
 */
export async function discoverAiderHistoryFilesAsync(
    roots: string[],
    maxDepth: number = DEFAULT_AIDER_SEARCH_DEPTH
): Promise<AiderHistoryInfo[]> {
    const depth = Math.min(Math.max(1, maxDepth), MAX_AIDER_SEARCH_DEPTH);
    const allResults = await Promise.all(roots.map(r => searchDirAsync(r, depth)));
    // Deduplicate by historyFile path (in case roots overlap)
    const seen = new Set<string>();
    const merged: AiderHistoryInfo[] = [];
    for (const batch of allResults) {
        for (const info of batch) {
            if (!seen.has(info.historyFile)) {
                seen.add(info.historyFile);
                merged.push(info);
            }
        }
    }
    return merged;
}
