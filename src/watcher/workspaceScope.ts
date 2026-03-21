// src/watcher/workspaceScope.ts
import * as fs from 'fs';
import * as path from 'path';
import { ScopedWorkspace } from '../types/index';

const STORAGE_KEY = 'chatwizard.selectedWorkspaceIds';
/** Legacy key — cleared on first run of resetToDefault() to avoid confusion. */
const LEGACY_MANUAL_KEY = 'chatwizard.workspaceScopeManuallySet';

// Minimal interface so that the class is testable without a full vscode.ExtensionContext.
interface GlobalState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export interface ExtensionContextLike {
    globalState: GlobalState;
}

/**
 * Owns the persisted workspace scope selection.
 *
 * **Scope logic** (simple):
 * - Every time the extension activates, `initDefault()` sets the scope to the
 *   currently open VS Code workspace folder(s) — overwriting whatever was stored.
 *   This means opening a workspace always makes it the active scope.
 * - If no workspace folder is open, the scope is set to empty (`[]`).
 * - The user can expand the scope via "Manage Watched Workspaces"; that selection
 *   is then stored and used until the next time a workspace is opened.
 */
export class WorkspaceScopeManager {
    private readonly _context: ExtensionContextLike;

    constructor(context: ExtensionContextLike) {
        this._context = context;
    }

    /** Returns the normalised, lowercase paths of currently open VS Code workspace folders. */
    private _getOpenFolderPaths(): string[] {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as typeof import('vscode');
            return (vscode.workspace.workspaceFolders ?? []).map(f =>
                path.normalize(f.uri.fsPath).toLowerCase()
            );
        } catch {
            // Not running in a VS Code extension host (e.g. unit tests).
            return [];
        }
    }

    /**
     * Called on every activation. Always overwrites the persisted scope with the
     * currently open VS Code workspace folder(s).
     *
     * - Open workspace found in `available` → scope = those IDs only.
     * - Open workspace not yet in `available` (no chat history) → scope = `[]`.
     * - No workspace open → scope = `[]`.
     *
     * On Windows path comparison is case-insensitive; both sides are `path.normalize()`d.
     */
    async initDefault(available: ScopedWorkspace[]): Promise<void> {
        const openFolderPaths = this._getOpenFolderPaths();

        let ids: string[];
        if (openFolderPaths.length === 0) {
            ids = [];
        } else {
            ids = available
                .filter(ws => openFolderPaths.includes(path.normalize(ws.workspacePath).toLowerCase()))
                .map(ws => ws.id);
        }

        await this._context.globalState.update(STORAGE_KEY, ids);
    }

    /** Returns the currently persisted list of selected workspace IDs. */
    getSelectedIds(): string[] {
        return this._context.globalState.get<string[]>(STORAGE_KEY) ?? [];
    }

    /** Persists a new selection of workspace IDs. */
    setSelectedIds(ids: string[]): void {
        void this._context.globalState.update(STORAGE_KEY, ids);
    }

    /**
     * Clears the persisted scope so `initDefault()` re-detects on next activation.
     * Also clears any legacy manual-mode flag from earlier versions.
     */
    resetToDefault(): void {
        void this._context.globalState.update(STORAGE_KEY, undefined);
        void this._context.globalState.update(LEGACY_MANUAL_KEY, undefined);
    }
}

/**
 * Returns the total size in **bytes** of all `.jsonl` session files for a workspace.
 * Same scanning rules as `calcWorkspaceSizeMb`. Returns `0` on any I/O error.
 */
export async function calcWorkspaceSizeBytes(
    storageDir: string,
    source: 'copilot' | 'claude'
): Promise<number> {
    try {
        const dir =
            source === 'copilot' ? path.join(storageDir, 'chatSessions') : storageDir;

        const entries = await fs.promises.readdir(dir);
        const jsonlFiles = entries.filter(e => e.endsWith('.jsonl'));

        const sizes = await Promise.all(
            jsonlFiles.map(async f => {
                try {
                    const stat = await fs.promises.stat(path.join(dir, f));
                    return stat.size;
                } catch {
                    return 0;
                }
            })
        );

        return sizes.reduce((acc, s) => acc + s, 0);
    } catch {
        return 0;
    }
}

/**
 * Calculates the total size in MB of all `.jsonl` session files for a workspace.
 *
 * - **Copilot**: scans `<storageDir>/chatSessions/*.jsonl`
 * - **Claude**:  scans `<storageDir>/*.jsonl`
 *
 * Returns the result rounded to two decimal places, or `0` on any I/O error.
 */
export async function calcWorkspaceSizeMb(
    storageDir: string,
    source: 'copilot' | 'claude'
): Promise<number> {
    try {
        const dir =
            source === 'copilot' ? path.join(storageDir, 'chatSessions') : storageDir;

        const entries = await fs.promises.readdir(dir);
        const jsonlFiles = entries.filter(e => e.endsWith('.jsonl'));

        const sizes = await Promise.all(
            jsonlFiles.map(async f => {
                try {
                    const stat = await fs.promises.stat(path.join(dir, f));
                    return stat.size;
                } catch {
                    return 0;
                }
            })
        );

        const totalBytes = sizes.reduce((acc, s) => acc + s, 0);
        return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
    } catch {
        return 0;
    }
}

/**
 * Counts the number of `.jsonl` session files for a workspace (from disk).
 *
 * - **Copilot**: counts `<storageDir>/chatSessions/*.jsonl`
 * - **Claude**:  counts `<storageDir>/*.jsonl`
 *
 * Returns 0 on any I/O error.
 */
export async function countWorkspaceSessions(
    storageDir: string,
    source: 'copilot' | 'claude'
): Promise<number> {
    try {
        const dir =
            source === 'copilot' ? path.join(storageDir, 'chatSessions') : storageDir;
        const entries = await fs.promises.readdir(dir);
        return entries.filter(e => e.endsWith('.jsonl')).length;
    } catch {
        return 0;
    }
}
