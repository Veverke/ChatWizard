/**
 * src/utils/sharedCachePath.ts
 *
 * Resolves a cross-IDE shared cache path for the ChatWizard SQLite database.
 * When configured (or defaulted), all ChatWizard instances on the same machine
 * converge on one DB file, so bookmarks, tags, notes, ratings, and parse state
 * are shared across IDEs (VS Code, Cursor, Windsurf, etc.).
 *
 * Path conventions per OS:
 *   Windows: %LOCALAPPDATA%\ChatWizard\chatwizard-cache.db
 *   macOS:   ~/Library/Application Support/ChatWizard/chatwizard-cache.db
 *   Linux:   ~/.local/share/chatwizard/chatwizard-cache.db
 */

import * as path from 'path';
import * as os from 'os';

const DB_FILENAME = 'chatwizard-cache.db';
const APP_FOLDER = 'ChatWizard';

/**
 * Return the default shared cache directory for the current OS.
 * This is outside any IDE's own app-data, so every IDE with ChatWizard
 * can read/write the same database.
 */
export function getDefaultSharedCacheDir(): string {
    const platform = os.platform();
    if (platform === 'win32') {
        // %LOCALAPPDATA%\ChatWizard
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, APP_FOLDER);
    }
    if (platform === 'darwin') {
        // ~/Library/Application Support/ChatWizard
        return path.join(os.homedir(), 'Library', 'Application Support', APP_FOLDER);
    }
    // Linux / others: ~/.local/share/chatwizard (XDG_DATA_HOME)
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(xdgData, APP_FOLDER.toLowerCase());
}

/**
 * Resolve the actual cache DB path to use.
 *
 * Resolution order:
 * 1. If `configPath` is non-empty, use it directly (explicit user override).
 * 2. Otherwise, use the default shared path for the current OS.
 *
 * Returns the full path to the `.db` file (not just the directory).
 */
export function resolveCacheDbPath(configPath: string | undefined): string {
    const dir = resolveSharedCacheDir(configPath);
    return path.join(dir, DB_FILENAME);
}

/**
 * Resolve the shared cache directory to use.
 *
 * Resolution order:
 * 1. If `configDir` is non-empty, use it directly (explicit user override).
 * 2. Otherwise, use the default shared path for the current OS.
 *
 * Returns the directory path (without the `.db` filename) — intended to be
 * passed directly into `CacheManager(storageDir)` which appends the filename.
 */
export function resolveSharedCacheDir(configDir: string | undefined): string {
    return configDir && configDir.trim().length > 0
        ? configDir.trim()
        : getDefaultSharedCacheDir();
}
