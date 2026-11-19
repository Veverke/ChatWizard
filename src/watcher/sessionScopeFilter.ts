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

/**
 * Workspace ids that are not VS Code workspace hashes and must always be
 * accepted regardless of the persisted workspace scope:
 *   - `cursor-global` / `windsurf-global` — AI-tool global storage DBs;
 *   - `copilot-agent` — Copilot chats kept in `~/.copilot/session-state`.
 *
 * Kept here (and re-used by `CacheManager.loadAll`) so the batch collectors,
 * the incremental live watchers and the cache restore agree on the rule.
 */
export const GLOBAL_WORKSPACE_IDS: readonly string[] = ['cursor-global', 'windsurf-global', 'copilot-agent'];

/** True when `workspacePath` is (under) one of the open folders. */
export function isPathInScope(
    workspacePath: string | undefined,
    openFolderPaths: readonly string[]
): boolean {
    if (openFolderPaths.length === 0) { return true; }
    if (!workspacePath) { return false; }
    const norm = path.normalize(workspacePath).toLowerCase();
    return openFolderPaths.some(p => {
        // Normalise the folder too: callers used to be required to pass
        // pre-normalised lowercase paths, which made the helper easy to misuse.
        const open = path.normalize(p).toLowerCase();
        const openWithSep = open.endsWith(path.sep) ? open : open + path.sep;
        return norm === open || norm.startsWith(openWithSep);
    });
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
        // Single source of truth for the path rule (also used by the live watchers).
        return isPathInScope(s.workspacePath, normalizedOpen);
    });
}

/**
 * Claude Code scopes its transcripts by project directory
 * (`~/.claude/projects/<projectDirName>/*.jsonl`), which is the id the batch
 * collector matches against `selectedIds`. The parser puts the *session* id in
 * `session.workspaceId`, so the directory name has to be derived from the path.
 */
export function claudeProjectDirId(
    session: Pick<Session, 'workspaceId' | 'filePath'>
): string {
    return session.filePath ? path.basename(path.dirname(session.filePath)) : session.workspaceId;
}

/** Minimal shape needed to decide whether one session belongs to the scope. */
export type ScopableSession = Pick<Session, 'source' | 'workspaceId' | 'workspacePath' | 'filePath'>;

/**
 * Single-session counterpart of `filterSessionsByWorkspaceScope`.
 *
 * Exists because some ingestion paths bypass the batch collector and write
 * straight into `SessionIndex` — the live file watchers and the archive
 * restore. Without this predicate those paths happily index sessions of
 * *other* workspaces (e.g. any Cline 4.x chat that is being written right now
 * under the machine-global `~/.cline/data/sessions`).
 *
 * Rules (identical to the batch filter):
 * - Path-scoped sources (Cline / Roo Code / Aider) → `workspacePath` must be
 *   under one of the open VS Code folders; no path → out of scope. When no
 *   folder is open the path rule cannot be applied and everything passes.
 * - ID-scoped sources (Copilot / Claude / Cursor / Windsurf) → the scoped id
 *   must be in `selectedIds` (Claude: its project directory name).
 *   `GLOBAL_WORKSPACE_IDS` always pass.
 * - Sources with no scoped identity (Antigravity, Continue, Amazon Q, Gemini,
 *   Tabnine, Zed) → always pass, since they cannot be scoped.
 * - No selected ids *and* no open folders → nothing can be filtered; all pass.
 */
export function isSessionInScope(
    session: ScopableSession,
    selectedIds: readonly string[],
    openFolderPaths: readonly string[]
): boolean {
    if (selectedIds.length === 0 && openFolderPaths.length === 0) {
        return true;
    }

    if (PATH_SCOPED_SOURCES.has(session.source)) {
        return isPathInScope(session.workspacePath, openFolderPaths);
    }

    if (ID_SCOPED_SOURCES.has(session.source)) {
        const scopedId = session.source === 'claude'
            ? claudeProjectDirId(session)
            : session.workspaceId;
        if (GLOBAL_WORKSPACE_IDS.includes(scopedId)) { return true; }
        return selectedIds.includes(scopedId);
    }

    return true;
}
