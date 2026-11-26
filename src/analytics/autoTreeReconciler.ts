// src/analytics/autoTreeReconciler.ts
//
// Merges a fresh classification with the user's amendments on the auto-classified
// tree.
//
// The background classifier rebuilds the topic tree on every run. Anything the
// user did by hand inside that tree must survive the rebuild:
//
//   • a folder the user created inside the tree          → SessionFolder.manual
//   • a folder the user renamed                          → SessionFolder.manual (name kept)
//   • a folder the user moved elsewhere                  → SessionFolder.manual (parent kept)
//   • a session the user moved into a folder             → amendments.sessionFolders
//   • a folder the user deleted                          → amendments.suppressedPaths
//
// The merged tree is *the* classification both views render — the Sessions view
// directly, the knowledge base through `classificationStructure`. That is why the
// amendments belong here (in the classification) rather than in a view: there is
// no view-specific variant of the structure.
//
// Folder IDs are carried over (learned `pathToFolderId`), which is what makes
// renamed/moved folders resolvable on the next run.

import type { SessionFolder, SessionFolderOrigin } from '../types/index';
import type { FolderTreeSpec } from '../index/folderStore';
import { normalizeFolderName, generateFolderId } from '../index/folderStore';

/** Maximum retained deletion suppressions — ancient entries are dropped. */
const MAX_SUPPRESSED_PATHS = 200;

/**
 * User amendments layered on top of the classification.
 * Persisted next to the run state so they survive reloads.
 */
export interface AutoTreeAmendments {
    /** Desired folder path → folder ID, learned on each run (keeps renames/moves routable). */
    pathToFolderId: Record<string, string>;
    /** sessionId → auto-folder ID the user placed it in (wins over the classification). */
    sessionFolders: Record<string, string>;
    /** sessionId → folder ID the classifier assigned last run (used to "release" an override). */
    classifiedFolders: Record<string, string>;
    /** Desired folder paths the user deleted; never recreated until the folder is re-added by hand. */
    suppressedPaths: string[];
}

/** A fresh, empty amendment set. */
export function emptyAmendments(): AutoTreeAmendments {
    return { pathToFolderId: {}, sessionFolders: {}, classifiedFolders: {}, suppressedPaths: [] };
}

/** Where the classifier placed one session. */
export interface ClassificationPlacement {
    sessionId: string;
    /** Full name path of the target folder ('' = the classifier placed it nowhere). */
    path: string;
}

export interface ReconcileTreeInput {
    /** The classifier's desired tree. */
    specs: FolderTreeSpec[];
    /** Per-session desired placement (paths as produced by the spec builder). */
    placements: ClassificationPlacement[];
    /** Current folders in the auto store. */
    existing: Map<string, SessionFolder>;
    /** Amendments from the previous run (or the user's most recent edits). */
    amendments?: AutoTreeAmendments;
    /** Sessions that still exist; overrides for others are dropped. */
    knownSessionIds?: Set<string>;
    /** Folder origin written on created folders. Default: 'auto'. */
    origin?: SessionFolderOrigin;
    /** Timestamp for created/updated folders. Default: now. */
    now?: string;
}

export interface ReconcileTreeResult {
    folders: Map<string, SessionFolder>;
    amendments: AutoTreeAmendments;
}

/**
 * Computes the next auto-classified folder tree: the classifier's structure plus
 * the user's amendments, with stable folder IDs.
 */
export function reconcileAutoTree(input: ReconcileTreeInput): ReconcileTreeResult {
    const origin = input.origin ?? 'auto';
    const now = input.now ?? new Date().toISOString();
    const previous = input.amendments ?? emptyAmendments();
    const suppressed = new Set(previous.suppressedPaths.map(p => p.toLowerCase()));

    const next = new Map<string, SessionFolder>();
    const idByPath = new Map<string, string>();
    const usedIds = new Set<string>();

    // Existing folders by their current name path — the fallback when nothing was
    // learned for a path yet (first run after an upgrade, or a brand-new topic).
    const existingIdByPath = new Map<string, string>();
    for (const folder of input.existing.values()) {
        const path = currentPath(folder, input.existing);
        if (path && !existingIdByPath.has(path)) { existingIdByPath.set(path, folder.id); }
    }

    /** Finds the existing folder that satisfied `path` last time (or by name path). */
    const resolve = (path: string): SessionFolder | undefined => {
        const learnedId = previous.pathToFolderId[path];
        const learned = learnedId ? input.existing.get(learnedId) : undefined;
        if (learned) { return learned; }
        const byPath = existingIdByPath.get(path);
        return byPath ? input.existing.get(byPath) : undefined;
    };

    // ── Pass 1: the classifier's folders ────────────────────────────────────
    const addDesired = (nodes: FolderTreeSpec[], parentId: string | null, prefix: string): void => {
        for (const node of nodes) {
            const name = normalizeFolderName(node.name);
            if (!name) { continue; }

            const path = prefix ? `${prefix}/${name}` : name;
            // A deleted folder suppresses its whole subtree.
            if (isSuppressed(path, suppressed)) { continue; }

            const prior = resolve(path);
            const folder: SessionFolder = {
                id: prior?.id ?? generateFolderId(),
                // A renamed folder keeps its user-chosen name.
                name: prior?.manual ? prior.name : name,
                parentId,
                sessionIds: [],
                childFolderIds: [],
                createdAt: prior?.createdAt ?? now,
                updatedAt: now,
                origin,
                ...(prior?.manual ? { manual: true } : {}),
            };

            next.set(folder.id, folder);
            usedIds.add(folder.id);
            idByPath.set(path, folder.id);
            addDesired(node.children ?? [], folder.id, path);
        }
    };
    addDesired(input.specs, null, '');

    // ── Pass 2: manual folders the classifier does not produce ──────────────
    // Shallowest first so parents exist before their children are attached.
    const orphans = [...input.existing.values()]
        .filter(f => f.manual && !usedIds.has(f.id))
        .sort((a, b) => depthOf(a, input.existing) - depthOf(b, input.existing));
    for (const folder of orphans) {
        const parentId = folder.parentId && next.has(folder.parentId) ? folder.parentId : null;
        next.set(folder.id, {
            ...folder,
            parentId,
            sessionIds: [],
            childFolderIds: [],
            updatedAt: now,
            origin: folder.origin ?? origin,
            manual: true,
        });
        usedIds.add(folder.id);
    }

    // ── Pass 3: honour folder moves the user made ───────────────────────────
    // All candidate parents exist now, so a folder the user dragged elsewhere
    // can be re-attached to its chosen parent (the classifier never moves it back).
    for (const folder of next.values()) {
        const before = input.existing.get(folder.id);
        if (!before?.manual) { continue; }
        if (before.parentId && next.has(before.parentId) && folder.parentId !== before.parentId) {
            folder.parentId = before.parentId;
        }
    }


    // ── Pass 4: sessions ────────────────────────────────────────────────────
    const assignments = new Map<string, string[]>();
    const amendments: AutoTreeAmendments = {
        pathToFolderId: Object.fromEntries(idByPath),
        sessionFolders: {},
        classifiedFolders: {},
        suppressedPaths: [...new Set(previous.suppressedPaths)].slice(-MAX_SUPPRESSED_PATHS),
    };

    for (const placement of input.placements) {
        if (input.knownSessionIds && !input.knownSessionIds.has(placement.sessionId)) { continue; }

        const classifiedId = placement.path ? idByPath.get(placement.path) : undefined;
        if (classifiedId) {
            amendments.classifiedFolders[placement.sessionId] = classifiedId;
        }

        const overrideId = previous.sessionFolders[placement.sessionId];
        const targetId = overrideId && next.has(overrideId) ? overrideId : classifiedId;
        if (!targetId) { continue; }

        const list = assignments.get(targetId);
        if (list) { list.push(placement.sessionId); } else { assignments.set(targetId, [placement.sessionId]); }

        if (overrideId && overrideId === targetId) {
            amendments.sessionFolders[placement.sessionId] = overrideId;
        }
    }

    for (const folder of next.values()) {
        folder.sessionIds = assignments.get(folder.id) ?? [];
    }

    // ── Pass 5: derived links ───────────────────────────────────────────────
    for (const folder of next.values()) {
        folder.childFolderIds = [];
        folder.parentId = folder.parentId && next.has(folder.parentId) ? folder.parentId : null;
    }
    for (const folder of next.values()) {
        if (folder.parentId) { next.get(folder.parentId)!.childFolderIds.push(folder.id); }
    }

    return { folders: next, amendments };
}

/** True when `path` (or one of its ancestors) is in the suppressed set. */
function isSuppressed(path: string, suppressed: Set<string>): boolean {
    const lower = path.toLowerCase();
    if (suppressed.has(lower)) { return true; }
    let idx = lower.indexOf('/');
    while (idx > 0) {
        if (suppressed.has(lower.slice(0, idx))) { return true; }
        idx = lower.indexOf('/', idx + 1);
    }
    return false;
}

/** Current full name path of an existing folder. */
function currentPath(folder: SessionFolder, map: Map<string, SessionFolder>): string {
    const names: string[] = [];
    const visited = new Set<string>();
    let current: SessionFolder | undefined = folder;
    while (current) {
        if (visited.has(current.id)) { return ''; } // circular guard
        visited.add(current.id);
        names.unshift(current.name);
        current = current.parentId ? map.get(current.parentId) : undefined;
    }
    return names.join('/');
}

/** Nesting depth of an existing folder (root = 1). */
function depthOf(folder: SessionFolder, map: Map<string, SessionFolder>): number {
    let depth = 1;
    const visited = new Set<string>();
    let current: SessionFolder | undefined = folder;
    while (current?.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        current = map.get(current.parentId);
        if (current) { depth++; }
    }
    return depth;
}

