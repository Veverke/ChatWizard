// src/readers/cursorWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ScopedWorkspace } from '../types/index';

/** Maximum allowed state.vscdb size (bytes) — skip oversized databases. */
const MAX_VSCDB_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Returns the path to Cursor's **global** storage database (`state.vscdb`).
 * This file contains the `cursorDiskKV` table (Cursor 0.43+) which stores full
 * conversations — including AI assistant responses — for all workspaces.
 *
 * Windows:  %APPDATA%/Cursor/User/globalStorage/state.vscdb
 * macOS:    ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * Linux:    ~/.config/Cursor/User/globalStorage/state.vscdb
 */
export function getCursorGlobalDbPath(override?: string): string {
    if (override !== undefined && override !== '') { return override; }
    const platform = process.platform;
    let base: string;
    if (platform === 'win32') {
        base = path.join(process.env['APPDATA'] || os.homedir(), 'Cursor', 'User');
    } else if (platform === 'darwin') {
        base = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
    } else {
        base = path.join(
            process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'),
            'Cursor', 'User'
        );
    }
    return path.join(base, 'globalStorage', 'state.vscdb');
}

/**
 * Resolves the Cursor workspaceStorage root directory cross-platform.
 * Windows:  %APPDATA%/Cursor/User/workspaceStorage
 * macOS:    ~/Library/Application Support/Cursor/User/workspaceStorage
 * Linux:    ~/.config/Cursor/User/workspaceStorage
 */
export function getCursorStorageRoot(): string {
    const platform = process.platform;
    if (platform === 'win32') {
        return path.join(
            process.env['APPDATA'] || os.homedir(),
            'Cursor', 'User', 'workspaceStorage'
        );
    } else if (platform === 'darwin') {
        return path.join(
            os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'
        );
    } else {
        return path.join(
            process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'),
            'Cursor', 'User', 'workspaceStorage'
        );
    }
}

/**
 * Reads workspace.json from a Cursor storage hash directory and extracts the
 * workspace folder path. Same format as VS Code's workspace.json.
 * Returns undefined if the file doesn't exist or can't be parsed.
 */
async function readWorkspaceJsonAsync(storageHashDir: string): Promise<string | undefined> {
    try {
        const workspaceJsonPath = path.join(storageHashDir, 'workspace.json');
        const raw = await fs.promises.readFile(workspaceJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const folder: string | undefined = parsed.folder;
        if (!folder) { return undefined; }
        let decoded = decodeURIComponent(folder.replace('file://', ''));
        // On Windows, strip the leading '/' from '/C:/path' → 'C:/path'
        if (process.platform === 'win32' && decoded.startsWith('/')) {
            decoded = decoded.slice(1);
        }
        return decoded;
    } catch {
        return undefined;
    }
}

/**
 * Enumerates hash directories under the Cursor workspaceStorage root and
 * returns a `ScopedWorkspace` for each that contains a valid `state.vscdb`.
 *
 * - Directories without `state.vscdb` are skipped.
 * - Symlinked directories and symlinked database files are excluded.
 * - Databases exceeding 500 MB are excluded.
 * - Workspace paths that no longer exist on disk are excluded.
 *
 * @param override  Override the root directory (for tests or user config).
 */
export async function discoverCursorWorkspacesAsync(override?: string): Promise<ScopedWorkspace[]> {
    const root = (override !== undefined && override !== '') ? override : getCursorStorageRoot();

    let entries: string[];
    try {
        entries = await fs.promises.readdir(root);
    } catch {
        // Directory does not exist or is not readable.
        return [];
    }

    const results = await Promise.all(entries.map(async (entry): Promise<ScopedWorkspace | null> => {
        const storageDir = path.join(root, entry);

        // SEC: must be a real directory (not a symlink).
        try {
            const lstat = await fs.promises.lstat(storageDir);
            if (!lstat.isDirectory() || lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        // Must contain state.vscdb (not symlinked, not oversized).
        const vscdbPath = path.join(storageDir, 'state.vscdb');
        try {
            const lstat = await fs.promises.lstat(vscdbPath);
            if (!lstat.isFile() || lstat.isSymbolicLink()) { return null; }
            if (lstat.size > MAX_VSCDB_BYTES) { return null; }
        } catch {
            return null;
        }

        const workspacePath = await readWorkspaceJsonAsync(storageDir);
        if (workspacePath === undefined) { return null; }

        // Skip workspaces whose path no longer exists on disk (deleted / renamed).
        try {
            await fs.promises.access(workspacePath);
        } catch {
            return null;
        }

        return {
            id: entry,
            source: 'cursor',
            workspacePath,
            storageDir,
        } satisfies ScopedWorkspace;
    }));

    return results.filter((r): r is ScopedWorkspace => r !== null);
}
