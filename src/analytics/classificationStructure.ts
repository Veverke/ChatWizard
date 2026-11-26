// src/analytics/classificationStructure.ts
//
// One classification, two views — and no exceptions.
//
// The classification a chat belongs to has two layers:
//
//   • what the model *proposed* (a topic + sub-topic per chat, kept in
//     `ClassificationStore` so nothing is ever classified twice), and
//   • the **structure** — the folder tree the user sees and may edit.
//
// The structure is the auto-classified folder tree (a `FolderStore`): the
// reconciler builds it from the proposals plus the user's amendments, so a
// folder they create, rename, move or delete, and a chat they re-place, are
// part of the classification itself — not a per-view projection.
//
// Both left-panel views render that one tree:
//
//   • the Sessions view's "Group by Context" renders the folders themselves, and
//   • the Knowledge Base derives each entry's *type* / *subtype* from the folder
//     the chat sits in (this module), so its pie chart, legend, drill-down and
//     export describe exactly the same structure.
//
// Consequence (intended): re-organising the tree edits the classification the KB
// shows, and re-classification never undoes the user's structure.

import type { SessionFolder } from '../types/index';
import type { SessionClassification } from './chatSessionClassifier';

/**
 * Label used for chats that are in no folder of the shared tree.
 *
 * Deliberately the same word the Sessions view shows for its `(unclassified)`
 * bucket, so the two views never describe the same state differently.
 */
export const UNCLASSIFIED_CATEGORY = 'Unclassified';

/** Flattened view of the shared structure (the auto-classified folder tree). */
export interface FolderStructure {
    /** Root folder names, in the order the Sessions view lists them. */
    roots: string[];
    /** sessionId → folder names, root first. */
    paths: Map<string, string[]>;
}

/** The neutral value, for callers that would otherwise pass `null` around. */
export function emptyFolderStructure(): FolderStructure {
    return { roots: [], paths: new Map() };
}

/**
 * Flattens a folder tree into `sessionId → folder name path`.
 *
 * Chats never appear twice (a move removes them from the previous folder), but
 * if a corrupt file says otherwise the *shallowest* folder wins, which keeps the
 * result stable and matches what the tree renders.
 */
export function indexFolderStructure(
    folders?: Map<string, SessionFolder> | null,
): FolderStructure {
    const structure = emptyFolderStructure();
    if (!folders || folders.size === 0) { return structure; }

    /** Full name path of a folder, root first (cycle-safe). */
    const pathById = new Map<string, string[]>();
    const pathOf = (folderId: string): string[] => {
        const cached = pathById.get(folderId);
        if (cached) { return cached; }
        const names: string[] = [];
        const visited = new Set<string>();
        let current = folders.get(folderId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            names.unshift(current.name);
            current = current.parentId ? folders.get(current.parentId) : undefined;
        }
        pathById.set(folderId, names);
        return names;
    };

    // A folder whose parent is missing (e.g. a hand-edited file) is a root.
    for (const folder of folders.values()) {
        if (!folder.parentId || !folders.has(folder.parentId)) {
            structure.roots.push(folder.name);
        }
    }
    structure.roots.sort((a, b) => a.localeCompare(b));

    const byDepth = [...folders.values()].sort((a, b) =>
        pathOf(a.id).length - pathOf(b.id).length || a.id.localeCompare(b.id));
    for (const folder of byDepth) {
        const names = pathOf(folder.id);
        for (const sessionId of folder.sessionIds ?? []) {
            if (!structure.paths.has(sessionId)) { structure.paths.set(sessionId, names); }
        }
    }

    return structure;
}

export interface StructureAppliedClassifications {
    /** Classifications with `category` / `subcategory` resolved from the tree. */
    classifications: SessionClassification[];
    /**
     * Root categories in the structure's display order — including folders that
     * hold no chats yet, so a folder the user just created is visible in both
     * views. `undefined` when no tree exists (labels are the structure then).
     */
    categoryOrder: string[] | undefined;
}

/**
 * Rewrites classifications so their labels describe the *shared structure*
 * instead of the raw model output.
 *
 * - an empty tree means nothing was built yet → the labels are returned
 *   untouched (so the Knowledge Base keeps working with auto-classification off);
 * - a chat inside the tree takes its folder path: `category` = root folder,
 *   `subcategory` = the remaining levels (joined with `/` when the user nested
 *   deeper than the two levels a classification provides);
 * - a chat outside the tree becomes {@link UNCLASSIFIED_CATEGORY}, exactly like
 *   the Sessions view's `(unclassified)` bucket.
 */
export function applyFolderStructure(
    classifications: SessionClassification[],
    folders?: Map<string, SessionFolder> | null,
): StructureAppliedClassifications {
    const structure = indexFolderStructure(folders);
    if (structure.roots.length === 0) {
        return { classifications, categoryOrder: undefined };
    }

    let hasUnclassified = false;
    const applied = classifications.map(classification => {
        const path = structure.paths.get(classification.sessionId);
        if (!path || path.length === 0) {
            hasUnclassified = true;
            return { ...classification, category: UNCLASSIFIED_CATEGORY, subcategory: undefined };
        }
        return {
            ...classification,
            category: path[0],
            subcategory: path.length > 1 ? path.slice(1).join(' / ') : undefined,
        };
    });

    return {
        classifications: applied,
        categoryOrder: hasUnclassified
            ? [...structure.roots, UNCLASSIFIED_CATEGORY]
            : structure.roots,
    };
}

/** True when a structure-resolved classification sits in a real folder. */
export function isPlacedInStructure(classification: SessionClassification): boolean {
    return classification.category !== UNCLASSIFIED_CATEGORY;
}

