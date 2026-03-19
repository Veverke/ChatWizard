// src/watcher/workspaceScope.ts
import * as fs from 'fs';
import * as path from 'path';
import { ScopedWorkspace } from '../types/index';

const STORAGE_KEY = 'chatwizard.selectedWorkspaceIds';

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
 * - **First activation** (no persisted state): auto-detects from the currently
 *   open VS Code workspace folder(s) and persists the result.
 * - **Subsequent activations**: restores the persisted selection, but also
 *   normalises it on every call to `initDefault()`:
 *     1. Stale IDs (no longer in the discovered list) are silently dropped.
 *     2. If the currently open VS Code workspace is NOT covered by the remaining
 *        IDs, the scope is re-detected from the current workspace. This prevents
 *        the extension from showing an empty view when VS Code is opened in a
 *        workspace that was never explicitly added to the scope.
 */
export class WorkspaceScopeManager {
    private readonly _context: ExtensionContextLike;
    private _isDefault: boolean;

    constructor(context: ExtensionContextLike) {
        this._context = context;
        this._isDefault = this._context.globalState.get<string[]>(STORAGE_KEY) === undefined;
    }

    /** `true` when no scope has been explicitly persisted yet. */
    isDefault(): boolean {
        return this._isDefault;
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
     * Called during every activation with the full list of discovered workspaces.
     *
     * **First run** (`isDefault() === true`):
     * - Match open VS Code folder(s) against `available`.
     * - Persist matched IDs, or all IDs when no match is found.
     *
     * **Subsequent runs** (`isDefault() === false`):
     * - Remove stale IDs (work-plan edge-case: "stale IDs silently dropped").
     * - If the currently open workspace is NOT covered by the cleaned scope,
     *   re-run the default detection so the user always sees their current
     *   workspace's sessions (rather than a permanently blank view).
     *
     * On Windows the path comparison is case-insensitive; both sides are
     * `path.normalize()`d before comparing.
     */
    async initDefault(available: ScopedWorkspace[]): Promise<void> {
        const openFolderPaths = this._getOpenFolderPaths();

        if (!this._isDefault) {
            // --- Validate & normalise the stored scope ---
            const storedIds = this._context.globalState.get<string[]>(STORAGE_KEY) ?? [];
            const availableIds = new Set(available.map(ws => ws.id));

            // 1. Drop stale IDs that no longer appear in the discovered list.
            const validIds = storedIds.filter(id => availableIds.has(id));

            if (validIds.length > 0) {
                // 2. Determine whether the current workspace is covered by the valid scope.
                const coveredPaths = new Set(
                    available
                        .filter(ws => validIds.includes(ws.id))
                        .map(ws => path.normalize(ws.workspacePath).toLowerCase())
                );
                // An untitled/no-workspace window counts as "covered" — keep existing scope.
                const currentCovered =
                    openFolderPaths.length === 0 ||
                    openFolderPaths.some(p => coveredPaths.has(p));

                if (currentCovered) {
                    if (validIds.length < storedIds.length) {
                        // Prune the stale IDs and persist the cleaned-up list.
                        await this._context.globalState.update(STORAGE_KEY, validIds);
                    }
                    return; // Current workspace is covered — no re-detection needed.
                }
                // Current workspace is NOT in scope — fall through to re-detect.
            }
            // validIds.length === 0 (all stale) OR current workspace not covered:
            // fall through to the default-detection block below.
        }

        // --- Default detection ---
        let ids: string[];
        if (openFolderPaths.length === 0) {
            ids = available.map(ws => ws.id);
        } else {
            const matched = available.filter(ws =>
                openFolderPaths.includes(path.normalize(ws.workspacePath).toLowerCase())
            );
            ids = matched.length > 0 ? matched.map(ws => ws.id) : available.map(ws => ws.id);
        }

        await this._context.globalState.update(STORAGE_KEY, ids);
        this._isDefault = false;
    }

    /** Returns the currently persisted list of selected workspace IDs. */
    getSelectedIds(): string[] {
        return this._context.globalState.get<string[]>(STORAGE_KEY) ?? [];
    }

    /** Persists a new selection of workspace IDs. Must contain at least one entry. */
    setSelectedIds(ids: string[]): void {
        this._context.globalState.update(STORAGE_KEY, ids);
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
