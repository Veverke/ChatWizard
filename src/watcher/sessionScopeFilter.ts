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
 * Workspace ids that are not VS Code workspace hashes and must therefore not be
 * matched against the persisted workspace scope by id:
 *   - `cursor-global` / `windsurf-global` — AI-tool global storage DBs;
 *   - `copilot-agent` — Copilot chats kept in `~/.copilot/session-state`.
 *
 * These ids are still *queried* from the SQLite cache (`CacheManager.loadAll`)
 * so their rows come back; whether a row survives the scope filter is decided
 * separately:
 *   - cursor/windsurf global DBs carry no workspace path → cannot be scoped;
 *   - `copilot-agent` carries its `cwd` in `workspacePath` → scoped by path
 *     (see `PATH_SCOPED_GLOBAL_IDS`).
 *
 * Kept here (and re-used by `CacheManager.loadAll`) so the batch collectors,
 * the incremental live watchers and the cache restore agree on the rule.
 */
export const GLOBAL_WORKSPACE_IDS: readonly string[] = ['cursor-global', 'windsurf-global', 'copilot-agent'];

/**
 * Global workspace ids whose sessions still carry a real `workspacePath` and
 * are therefore scoped by path instead of by id.
 *
 * `~/.copilot/session-state` is machine-global: every Copilot agent-host chat
 * of every repository shares the `copilot-agent` id. Treating that id as
 * "always in scope" made chats opened in another folder (e.g. `C:\src\selling`)
 * show up in the Sessions view of the current one. Each chat records its own
 * `cwd` (`workspacePath`), so the same open-folder rule as Cline/Roo/Aider
 * applies.
 */
export const PATH_SCOPED_GLOBAL_IDS: readonly string[] = ['copilot-agent'];

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
 * True when a session must be scoped by its `workspacePath` rather than by its
 * workspace id.
 *
 * That is the case for the path-scoped sources (Cline / Roo Code / Aider) and
 * for the machine-global Copilot agent-host chats, which all share the
 * `copilot-agent` id but each record their own `cwd`.
 *
 * Shared by the batch filter and the single-session predicate so a fresh parse,
 * a live update and a cache restore cannot disagree.
 */
export function isPathScopedSession(
    session: Pick<Session, 'source' | 'workspaceId'>
): boolean {
    if (PATH_SCOPED_SOURCES.has(session.source)) { return true; }
    return session.source === 'copilot'
        && PATH_SCOPED_GLOBAL_IDS.includes(session.workspaceId);
}

/**
 * Apply workspace-scope filtering to a batch of sessions.
 *
 * - Path-scoped sessions (Cline/Roo Code/Aider and Copilot agent-host chats)
 *   are filtered to sessions whose `workspacePath` falls under one of the open
 *   VS Code folders; no path → out of scope.
 * - ID-scoped sources (Copilot/Claude/Cursor/Windsurf) are already filtered in
 *   their collectors via `selectedIds`, so they pass through unchanged here.
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
        if (!isPathScopedSession(s)) {
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
 * - Path-scoped sessions — Cline / Roo Code / Aider **and** the machine-global
 *   Copilot agent-host chats (`workspaceId === 'copilot-agent'`) — must have a
 *   `workspacePath` under one of the open VS Code folders; no path → out of
 *   scope. When no folder is open the path rule cannot be applied and
 *   everything passes.
 * - ID-scoped sources (Copilot / Claude / Cursor / Windsurf) → the scoped id
 *   must be in `selectedIds` (Claude: its project directory name).
 *   `GLOBAL_WORKSPACE_IDS` without a path (cursor/windsurf global DBs) always
 *   pass.
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

    // Path-scoped first: Copilot agent-host chats share the global
    // `copilot-agent` id, so the id rule below would let every workspace's
    // chats through.
    if (isPathScopedSession(session)) {
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
