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
        globalStorageBase = path.join(
            process.env['APPDATA'] || os.homedir(),
            'Code', 'User', 'globalStorage'
        );
    } else if (platform === 'darwin') {
        globalStorageBase = path.join(
            os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'
        );
    } else {
        globalStorageBase = path.join(
            process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'),
            'Code', 'User', 'globalStorage'
        );
    }
    return path.join(globalStorageBase, extensionId, 'tasks');
}

/**
 * Resolves the Roo Code (rooveterinaryinc.roo-cline) tasks directory cross-platform.
 */
export function getRooCodeStorageRoot(): string {
    return getClineCompatStorageRoot('rooveterinaryinc.roo-cline');
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
