import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CopilotWorkspaceInfo } from '../types/index';

/**
 * Returns the VS Code workspaceStorage root directory for the stable build.
 * On Windows: %APPDATA%/Code/User/workspaceStorage
 * On macOS:   ~/Library/Application Support/Code/User/workspaceStorage
 * On Linux:   ~/.config/Code/User/workspaceStorage
 *
 * @deprecated Prefer `getWorkspaceStorageRoots()` which also covers VS Code Insiders.
 */
export function getWorkspaceStorageRoot(): string {
    const platform = process.platform;
    if (platform === 'win32') {
        return path.join(process.env['APPDATA'] || os.homedir(), 'Code', 'User', 'workspaceStorage');
    } else if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    } else {
        return path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'Code', 'User', 'workspaceStorage');
    }
}

/**
 * Returns all VS Code variant workspaceStorage roots that exist on disk.
 * Covers stable (`Code`) and Insiders (`Code - Insiders`) installs.
 *
 * If the `chatwizard.copilotStoragePath` setting is non-empty, only that
 * single path is used (custom-path override, same behaviour as before).
 */
export function getWorkspaceStorageRoots(): string[] {
    // Check for a user-configured custom path first.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const custom = cfg.get<string>('copilotStoragePath');
        if (custom && custom.trim() !== '') {
            return [custom.trim()];
        }
    } catch {
        // Not in VS Code extension host (unit tests) — fall through to defaults.
    }

    const platform = process.platform;
    const appDataBase = platform === 'win32'
        ? (process.env['APPDATA'] || os.homedir())
        : platform === 'darwin'
            ? (process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), 'Library', 'Application Support'))
            : (process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'));

    const variants = ['Code', 'Code - Insiders'];
    const candidates = variants.map(v => path.join(appDataBase, v, 'User', 'workspaceStorage'));
    return candidates.filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

/**
 * Reads workspace.json from a storage hash directory and extracts the workspace path.
 * workspace.json format: { "folder": "file:///c%3A/Users/user/projects/foo" }
 * Returns undefined if the file doesn't exist or can't be parsed.
 */
export function readWorkspaceJson(storageHashDir: string): string | undefined {
    try {
        const workspaceJsonPath = path.join(storageHashDir, 'workspace.json');
        const raw = fs.readFileSync(workspaceJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const folder: string | undefined = parsed.folder;
        if (!folder) {
            return undefined;
        }
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
 * Scans all VS Code variant workspaceStorage roots and returns info for all
 * Copilot-enabled workspaces. Covers both stable and Insiders installs.
 * A workspace is Copilot-enabled if its hash directory contains a `chatSessions` subdirectory.
 *
 * Returns an array of CopilotWorkspaceInfo, one per discovered workspace.
 */
export function discoverCopilotWorkspaces(): CopilotWorkspaceInfo[] {
    const results: CopilotWorkspaceInfo[] = [];
    for (const root of getWorkspaceStorageRoots()) {
        try {
            const entries = fs.readdirSync(root);
            for (const entry of entries) {
                const storageDir = path.join(root, entry);
                const chatSessionsDir = path.join(storageDir, 'chatSessions');

                let hasChatSessions = false;
                try {
                    hasChatSessions = fs.statSync(chatSessionsDir).isDirectory();
                } catch {
                    // chatSessions directory does not exist
                }

                if (!hasChatSessions) {
                    continue;
                }

                const workspacePath = readWorkspaceJson(storageDir);
                if (workspacePath === undefined) {
                    continue;
                }

                results.push({
                    workspaceId: entry,
                    workspacePath,
                    storageDir,
                });
            }
        } catch {
            // root doesn't exist or can't be read — skip
        }
    }
    return results;
}

/**
 * Lists all .jsonl session files for a given workspace storage hash directory.
 * Looks in <storageHashDir>/chatSessions/*.jsonl
 */
export function listSessionFiles(storageHashDir: string): string[] {
    try {
        const chatSessionsDir = path.join(storageHashDir, 'chatSessions');
        const files = fs.readdirSync(chatSessionsDir);
        return files
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(chatSessionsDir, f));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Async variants (S9 — non-blocking startup)
// ---------------------------------------------------------------------------

async function readWorkspaceJsonAsync(storageHashDir: string): Promise<string | undefined> {
    try {
        const workspaceJsonPath = path.join(storageHashDir, 'workspace.json');
        const raw = await fs.promises.readFile(workspaceJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const folder: string | undefined = parsed.folder;
        if (!folder) { return undefined; }
        let decoded = decodeURIComponent(folder.replace('file://', ''));
        if (process.platform === 'win32' && decoded.startsWith('/')) {
            decoded = decoded.slice(1);
        }
        return decoded;
    } catch {
        return undefined;
    }
}

/**
 * Async version of `discoverCopilotWorkspaces`. Scans all VS Code variant roots
 * (stable + Insiders) concurrently.
 */
export async function discoverCopilotWorkspacesAsync(): Promise<CopilotWorkspaceInfo[]> {
    const roots = getWorkspaceStorageRoots();
    const perRoot = await Promise.all(roots.map(async (root) => {
        try {
            const entries = await fs.promises.readdir(root);

            const items = await Promise.all(entries.map(async (entry) => {
                const storageDir = path.join(root, entry);
                const chatSessionsDir = path.join(storageDir, 'chatSessions');
                try {
                    const stat = await fs.promises.stat(chatSessionsDir);
                    if (!stat.isDirectory()) { return null; }
                } catch {
                    return null;
                }
                const workspacePath = await readWorkspaceJsonAsync(storageDir);
                if (workspacePath === undefined) { return null; }

                // Skip workspaces whose path no longer exists on disk (deleted / renamed folders).
                try {
                    await fs.promises.access(workspacePath);
                } catch {
                    return null;
                }

                return { workspaceId: entry, workspacePath, storageDir } satisfies CopilotWorkspaceInfo;
            }));

            return items.filter((r): r is CopilotWorkspaceInfo => r !== null);
        } catch {
            return [];
        }
    }));

    return perRoot.flat();
}

/**
 * Async version of `listSessionFiles`.
 */
export async function listSessionFilesAsync(storageHashDir: string): Promise<string[]> {
    try {
        const chatSessionsDir = path.join(storageHashDir, 'chatSessions');
        const files = await fs.promises.readdir(chatSessionsDir);
        return files
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(chatSessionsDir, f));
    } catch {
        return [];
    }
}
