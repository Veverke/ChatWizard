// src/readers/clineWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClineTaskInfo } from '../types/index';

/** Maximum number of task directories scanned before emitting a warning. */
const MAX_TASK_DIRS = 10_000;

/**
 * Resolves the Cline (saoudrizwan.claude-dev) tasks directory cross-platform.
 * Windows:  %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/tasks
 * macOS:    ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks
 * Linux:    ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks
 */
export function getClineStorageRoot(): string {
    return getClineCompatStorageRoot('saoudrizwan.claude-dev');
}

/**
 * Generic helper used by both Cline and future Cline-compatible extensions
 * (e.g. Roo Code). Returns the tasks/ directory path for a given extension ID.
 */
export function getClineCompatStorageRoot(extensionId: string): string {
    const platform = process.platform;
    let globalStorageBase: string;
    if (platform === 'win32') {
        const appData = process.env['APPDATA'] || os.homedir();
        // Prefer VS Code Insiders path when it exists; fall back to stable.
        const insidersBase = path.join(appData, 'Code - Insiders', 'User', 'globalStorage');
        const stableBase = path.join(appData, 'Code', 'User', 'globalStorage');
        const insidersTaskDir = path.join(insidersBase, extensionId, 'tasks');
        globalStorageBase = fs.existsSync(insidersTaskDir) ? insidersBase : stableBase;
    } else if (platform === 'darwin') {
        const home = os.homedir();
        const insidersBase = path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage');
        const stableBase = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
        const insidersTaskDir = path.join(insidersBase, extensionId, 'tasks');
        globalStorageBase = fs.existsSync(insidersTaskDir) ? insidersBase : stableBase;
    } else {
        const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
        const insidersBase = path.join(configHome, 'Code - Insiders', 'User', 'globalStorage');
        const stableBase = path.join(configHome, 'Code', 'User', 'globalStorage');
        const insidersTaskDir = path.join(insidersBase, extensionId, 'tasks');
        globalStorageBase = fs.existsSync(insidersTaskDir) ? insidersBase : stableBase;
    }
    return path.join(globalStorageBase, extensionId, 'tasks');
}

/**
 * Resolves the Roo Code (rooveterinaryinc.roo-cline) tasks directory cross-platform.
 */
export function getRooCodeStorageRoot(): string {
    return getClineCompatStorageRoot('rooveterinaryinc.roo-cline');
}

// ---------------------------------------------------------------------------
// Cline 4.x ("Cline agent") on-disk sessions
// ---------------------------------------------------------------------------
//
// Cline 4.x no longer writes into VS Code's `globalStorage`. It owns a home
// directory instead (mirroring the Cline CLI):
//
//   <CLINE_DATA_DIR>            (env override, wins when set)
//   <CLINE_DIR || ~/.cline>/data
//
// and stores every chat session as
//
//   <data>/sessions/<sessionId>/<sessionId>.json           ← metadata
//   <data>/sessions/<sessionId>/<sessionId>.messages.json  ← transcript
//
// The legacy `tasks/<taskId>/api_conversation_history.json` layout is still
// read (see `discoverClineTasksAsync`) because upgrading Cline leaves the old
// task directories behind.

/** One Cline 4.x session directory. */
export interface ClineV4SessionInfo {
    /** Session id — the directory name, e.g. `1794419386202_jotez`. */
    sessionId: string;
    /** Absolute path of the session directory. */
    storageDir: string;
    /** `<sessionId>.json` — session metadata (title, workspace, model, timing). */
    metaFile: string;
    /** `<sessionId>.messages.json` — the conversation transcript. */
    messagesFile: string;
}

/**
 * Resolves Cline 4.x's data directory (`.../.cline/data`).
 *
 * Priority:
 *   1. `CLINE_DATA_DIR` environment variable (set by Cline itself when customised)
 *   2. `<CLINE_DIR>/data`
 *   3. `~/.cline/data`
 */
export function getClineDataRoot(): string {
    const dataDir = process.env['CLINE_DATA_DIR']?.trim();
    if (dataDir) { return dataDir; }
    const clineDir = process.env['CLINE_DIR']?.trim() || path.join(os.homedir(), '.cline');
    return path.join(clineDir, 'data');
}

/** Cline 4.x sessions directory (`<data>/sessions`). */
export function getClineV4SessionsRoot(): string {
    return path.join(getClineDataRoot(), 'sessions');
}

/**
 * Enumerates Cline 4.x session directories under the given root (or the
 * default `~/.cline/data/sessions`).
 *
 * A directory qualifies when it contains `<dirname>.json` (the session
 * metadata file). The transcript (`<dirname>.messages.json`) is optional — it
 * may be missing for a brand-new session.
 *
 * - Symlinked directories are excluded.
 * - More than MAX_TASK_DIRS directories triggers a console warning.
 *
 * @param override Override the sessions root (tests / user configuration).
 */
export async function discoverClineV4SessionsAsync(override?: string): Promise<ClineV4SessionInfo[]> {
    const root = (override !== undefined && override !== '') ? override : getClineV4SessionsRoot();

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        // Directory does not exist or is not readable — no sessions to return.
        return [];
    }

    if (entries.length > MAX_TASK_DIRS) {
        console.warn(
            `[Chat Wizard] Cline: found ${entries.length} session directories — ` +
            `only the first ${MAX_TASK_DIRS} will be scanned.`
        );
        entries = entries.slice(0, MAX_TASK_DIRS);
    }

    const results = await Promise.all(entries.map(async (entry): Promise<ClineV4SessionInfo | null> => {
        if (!entry.isDirectory()) { return null; }

        const storageDir = path.join(root, entry.name);

        // SEC: reject symlinked session directories.
        try {
            const lstat = await fs.promises.lstat(storageDir);
            if (lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        const metaFile = path.join(storageDir, `${entry.name}.json`);
        try {
            const stat = await fs.promises.stat(metaFile);
            if (!stat.isFile()) { return null; }
        } catch {
            // No metadata file — not a Cline 4.x session directory.
            return null;
        }

        return {
            sessionId: entry.name,
            storageDir,
            metaFile,
            messagesFile: path.join(storageDir, `${entry.name}.messages.json`),
        };
    }));

    return results.filter((r): r is ClineV4SessionInfo => r !== null);
}

/**
 * Enumerates task directories under the given root (or the default Cline root)
 * and returns a `ClineTaskInfo` for each directory that contains
 * `api_conversation_history.json`.
 *
 * - Directories without the conversation file are skipped.
 * - Symlinks are excluded via `lstat` check.
 * - More than MAX_TASK_DIRS directories triggers a console warning.
 *
 * @param override  Override the root directory (for tests or user config).
 */
export async function discoverClineTasksAsync(override?: string): Promise<ClineTaskInfo[]> {
    const root = (override !== undefined && override !== '') ? override : getClineStorageRoot();

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        // Directory does not exist or is not readable — no tasks to return.
        return [];
    }

    if (entries.length > MAX_TASK_DIRS) {
        console.warn(
            `[Chat Wizard] Cline: found ${entries.length} task directories — ` +
            `only the first ${MAX_TASK_DIRS} will be scanned.`
        );
        entries = entries.slice(0, MAX_TASK_DIRS);
    }

    const results = await Promise.all(entries.map(async (entry): Promise<ClineTaskInfo | null> => {
        // Skip non-directories and symlinks (symlink guard).
        if (!entry.isDirectory()) { return null; }

        const taskDir = path.join(root, entry.name);

        // SEC: lstat the directory itself to reject symlinked task directories.
        try {
            const lstat = await fs.promises.lstat(taskDir);
            if (lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        const conversationFile = path.join(taskDir, 'api_conversation_history.json');
        try {
            const stat = await fs.promises.stat(conversationFile);
            if (!stat.isFile()) { return null; }
        } catch {
            // api_conversation_history.json does not exist — skip this task.
            return null;
        }

        return { taskId: entry.name, storageDir: taskDir, conversationFile };
    }));

    return results.filter((r): r is ClineTaskInfo => r !== null);
}

/**
 * Enumerates task directories under the given root (or the default Roo Code root)
 * and returns a `ClineTaskInfo` for each directory that contains
 * `api_conversation_history.json`. Delegates to `discoverClineTasksAsync`.
 *
 * @param override  Override the root directory (for tests or user config).
 */
export async function discoverRooCodeTasksAsync(override?: string): Promise<ClineTaskInfo[]> {
    const root = (override !== undefined && override !== '') ? override : getRooCodeStorageRoot();
    return discoverClineTasksAsync(root);
}
