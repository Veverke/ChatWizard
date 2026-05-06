// src/watcher/workspaceScope.ts
import * as fs from 'fs';
import * as path from 'path';
import { ScopedWorkspace, SessionSource } from '../types/index';

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
 * **Scope logic:**
 * - On activation with an open workspace folder, `initDefault()` sets the scope to
 *   the workspaces matching that folder — overwriting any previous selection.
 *   Opening workspace B after workspace A automatically switches to B.
 * - On activation with **no** open workspace folder (e.g. a debug Extension Host
 *   launched without a folder), the persisted selection is kept as-is so the user
 *   does not lose a manually configured scope.
 * - The user can expand/change the scope via "Manage Watched Workspaces"; that
 *   selection is stored and used until a different workspace folder is opened.
 * - Path changes (claudeProjectsPath etc.) call `resetToDefault()` first so that
 *   `initDefault()` re-detects from the new path on the following call.
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
     * Called on every activation. Sets the scope to the workspaces matching the
     * currently open VS Code workspace folder(s).
     *
     * - Open folder found → scope = matching IDs (overwrites any previous selection).
     * - Open folder not in `available` (no chat history yet) → scope = `[]`.
     * - **No folder open** (e.g. debug Extension Host without a workspace) → keep
     *   the existing persisted selection unchanged.
     *
     * On Windows path comparison is case-insensitive; both sides are `path.normalize()`d.
     */
    async initDefault(available: ScopedWorkspace[]): Promise<void> {
        const openFolderPaths = this._getOpenFolderPaths();

        // No folder open — preserve whatever the user previously configured.
        if (openFolderPaths.length === 0) {
            return;
        }

        const ids = available
            .filter(ws => openFolderPaths.includes(path.normalize(ws.workspacePath).toLowerCase()))
            .map(ws => ws.id);

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
 * Returns the total size in **bytes** of session data files for a workspace.
 * File selection depends on the source:
 * - **copilot**: `<storageDir>/chatSessions/*.jsonl`
 * - **claude**:  `<storageDir>/*.jsonl`
 * - **cline / roocode**: `<storageDir>/<taskId>/api_conversation_history.json` (one per task subdir)
 * - **cursor / windsurf**: `<storageDir>/state.vscdb`
 * - **aider**: `<storageDir>/.aider.chat.history.md`
 *
 * Returns `0` on any I/O error.
 */
export async function calcWorkspaceSizeBytes(
    storageDir: string,
    source: SessionSource
): Promise<number> {
    try {
        if (source === 'copilot') {
            const dir = path.join(storageDir, 'chatSessions');
            const entries = await fs.promises.readdir(dir);
            const sizes = await Promise.all(
                entries.filter(e => e.endsWith('.jsonl')).map(async f => {
                    try { return (await fs.promises.stat(path.join(dir, f))).size; } catch { return 0; }
                })
            );
            return sizes.reduce((acc, s) => acc + s, 0);
        }

        if (source === 'claude') {
            const entries = await fs.promises.readdir(storageDir);
            const sizes = await Promise.all(
                entries.filter(e => e.endsWith('.jsonl')).map(async f => {
                    try { return (await fs.promises.stat(path.join(storageDir, f))).size; } catch { return 0; }
                })
            );
            return sizes.reduce((acc, s) => acc + s, 0);
        }

        if (source === 'cline' || source === 'roocode') {
            const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
            const sizes = await Promise.all(
                entries.filter(e => e.isDirectory()).map(async entry => {
                    const convFile = path.join(storageDir, entry.name, 'api_conversation_history.json');
                    try { return (await fs.promises.stat(convFile)).size; } catch { return 0; }
                })
            );
            return sizes.reduce((acc, s) => acc + s, 0);
        }

        if (source === 'cursor' || source === 'windsurf') {
            const vscdb = path.join(storageDir, 'state.vscdb');
            try { return (await fs.promises.stat(vscdb)).size; } catch { return 0; }
        }

        if (source === 'aider') {
            const histFile = path.join(storageDir, '.aider.chat.history.md');
            try { return (await fs.promises.stat(histFile)).size; } catch { return 0; }
        }

        // Antigravity is not workspace-scoped (brain dir is global); not reachable via ScopedWorkspace.
        if (source === 'antigravity') { return 0; }

        return 0;
    } catch {
        return 0;
    }
}

/**
 * Calculates the total size in MB of session data files for a workspace.
 * Uses the same source-specific logic as `calcWorkspaceSizeBytes`.
 * Returns the result rounded to two decimal places, or `0` on any I/O error.
 */
export async function calcWorkspaceSizeMb(
    storageDir: string,
    source: SessionSource
): Promise<number> {
    const totalBytes = await calcWorkspaceSizeBytes(storageDir, source);
    return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Counts the number of session files/tasks for a workspace (from disk).
 * - **copilot**: counts `<storageDir>/chatSessions/*.jsonl`
 * - **claude**:  counts `<storageDir>/*.jsonl`
 * - **cline / roocode**: counts task subdirectories that contain `api_conversation_history.json`
 * - **cursor / windsurf**: returns 1 if `state.vscdb` exists, else 0
 * - **aider**: returns 1 if `.aider.chat.history.md` exists, else 0
 *
 * Returns 0 on any I/O error.
 */
export async function countWorkspaceSessions(
    storageDir: string,
    source: SessionSource
): Promise<number> {
    try {
        if (source === 'copilot') {
            const dir = path.join(storageDir, 'chatSessions');
            const entries = await fs.promises.readdir(dir);
            return entries.filter(e => e.endsWith('.jsonl')).length;
        }

        if (source === 'claude') {
            const entries = await fs.promises.readdir(storageDir);
            return entries.filter(e => e.endsWith('.jsonl')).length;
        }

        if (source === 'cline' || source === 'roocode') {
            const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
            const counts = await Promise.all(
                entries.filter(e => e.isDirectory()).map(async entry => {
                    const convFile = path.join(storageDir, entry.name, 'api_conversation_history.json');
                    try { await fs.promises.access(convFile); return 1 as number; } catch { return 0 as number; }
                })
            );
            return counts.reduce((acc, c) => acc + c, 0);
        }

        if (source === 'cursor' || source === 'windsurf') {
            const vscdb = path.join(storageDir, 'state.vscdb');
            try { await fs.promises.access(vscdb); return 1; } catch { return 0; }
        }

        if (source === 'aider') {
            const histFile = path.join(storageDir, '.aider.chat.history.md');
            try { await fs.promises.access(histFile); return 1; } catch { return 0; }
        }

        // Antigravity is not workspace-scoped (brain dir is global); not reachable via ScopedWorkspace.
        if (source === 'antigravity') { return 0; }

        return 0;
    } catch {
        return 0;
    }
}
