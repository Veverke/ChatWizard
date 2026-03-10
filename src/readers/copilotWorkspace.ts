import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CopilotWorkspaceInfo } from '../types/index';

/**
 * Returns the VS Code workspaceStorage root directory.
 * On Windows: %APPDATA%/Code/User/workspaceStorage
 * On macOS:   ~/Library/Application Support/Code/User/workspaceStorage
 * On Linux:   ~/.config/Code/User/workspaceStorage
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
 * Scans the workspaceStorage root and returns info for all Copilot-enabled workspaces.
 * A workspace is Copilot-enabled if its hash directory contains a `chatSessions` subdirectory.
 *
 * Returns an array of CopilotWorkspaceInfo, one per discovered workspace.
 */
export function discoverCopilotWorkspaces(): CopilotWorkspaceInfo[] {
    try {
        const root = getWorkspaceStorageRoot();
        const entries = fs.readdirSync(root);
        const results: CopilotWorkspaceInfo[] = [];

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

        return results;
    } catch {
        return [];
    }
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
