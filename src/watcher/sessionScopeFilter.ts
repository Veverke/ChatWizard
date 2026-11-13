/**
 * src/watcher/sessionScopeFilter.ts
 *
 * Workspace-scope filtering for indexed sessions (pure, unit-testable).
 *
 * Lives in its own leaf module because two callers need it:
 *   - `fileWatcher` — filters a freshly collected batch before indexing;
 *   - `CacheManager.loadAll` — must apply the exact same rule when restoring
 *     sessions from the SQLite cache, otherwise cached restores and fresh
 *     parses disagree about which sessions belong to the current workspace.
 */

import * as path from 'path';
import { Session, SessionSource } from '../types/index';

/**
 * Sources that are scoped by the persisted selected workspace IDs upstream
 * (in the collector methods). They are NOT re-filtered by path here.
 */
export const ID_SCOPED_SOURCES = new Set<SessionSource>(['copilot', 'claude', 'cursor', 'windsurf']);

/**
 * Sources whose sessions carry a real `workspacePath` (extracted during parse)
 * and therefore can be scoped by the VS Code open-folder paths.
 */
export const PATH_SCOPED_SOURCES = new Set<SessionSource>(['cline', 'roocode', 'aider']);

/** True when `workspacePath` is (under) one of the normalized open folders. */
export function isPathInScope(
    workspacePath: string | undefined,
    openFolderPaths: string[]
): boolean {
    if (openFolderPaths.length === 0) { return true; }
    if (!workspacePath) { return false; }
    const norm = path.normalize(workspacePath).toLowerCase();
    return openFolderPaths.some(p => norm === p || norm.startsWith(p + path.sep));
}

/**
 * Apply workspace-scope filtering to a batch of sessions.
 *
 * - ID-scoped sources (Copilot/Claude/Cursor/Windsurf) are already filtered in
 *   their collectors via `selectedIds`, so they pass through unchanged here.
 * - Path-scoped sources (Cline/Roo Code/Aider) are filtered to sessions whose
 *   `workspacePath` falls under one of the open VS Code folders.
 * - Sources that surface no workspace path (Antigravity, Continue, Amazon Q,
 *   Gemini, Tabnine) cannot be scoped by path and are kept as-is.
 *
 * When both `selectedIds` and `openFolderPaths` are empty, no filtering is
 * applied and `all` is returned unchanged.
 */
export function filterSessionsByWorkspaceScope(
    all: Session[],
    selectedIds: string[],
    openFolderPaths: string[],
): Session[] {
    if (selectedIds.length === 0 && openFolderPaths.length === 0) {
        return all;
    }

    if (openFolderPaths.length === 0) {
        return all;
    }

    const normalizedOpen = openFolderPaths.map(p => path.normalize(p).toLowerCase());

    return all.filter(s => {
        if (!PATH_SCOPED_SOURCES.has(s.source)) {
            // ID-scoped sources are already filtered upstream; non-scoped sources
            // (no workspace path available) pass through.
            return true;
        }
        if (!s.workspacePath) {
            return false;
        }
        const norm = path.normalize(s.workspacePath).toLowerCase();
        return normalizedOpen.some(p => norm === p || norm.startsWith(p + path.sep));
    });
}
