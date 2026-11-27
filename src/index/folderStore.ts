// src/index/folderStore.ts
// Persistent folder tree store — provides folder organisation for sessions.
// All mutations are written atomically via a temp-file + rename pattern.
// The folder structure survives window reloads and is independent of grouping mode.

import * as fs from 'fs';
import * as path from 'path';
import { SessionFolder, FolderStats, SessionSummary, SessionFolderOrigin } from '../types/index';

const FOLDER_FILENAME = 'chatwizard-folders.json';

/**
 * Declarative description of a folder tree handed to {@link FolderStore.replaceTree}.
 * Used by the automatic chat-history classifier to rebuild its tree in one write.
 */
export interface FolderTreeSpec {
    /** Display name of the folder. */
    name: string;
    /** Session IDs that live directly in this folder. */
    sessionIds?: string[];
    /** Nested folders (the store caps nesting at {@link MAX_FOLDER_DEPTH} levels). */
    children?: FolderTreeSpec[];
}

/** Maximum nesting depth supported by the folder tree (root = level 1). */
export const MAX_FOLDER_DEPTH = 3;

/**
 * Stores the folder tree in a single JSON file under `storageDir`.
 * API surface covers CRUD for folders and session-folder mappings.
 *
 * The `filename` argument lets a caller keep a second, independent tree in the
 * same directory — the auto-classifier stores its folders in
 * `chatwizard-auto-folders.json` so its rebuilds never touch user-created folders.
 */
export class FolderStore {
    private readonly filePath: string;
    private cache: Map<string, SessionFolder> | null = null;
    private readonly changeListeners = new Set<(folders: Map<string, SessionFolder>) => void>();

    constructor(private readonly storageDir: string, filename: string = FOLDER_FILENAME) {
        this.filePath = path.join(storageDir, filename);
    }

    /** Ensures the storage directory exists before any I/O. */
    private async ensureDir(): Promise<void> {
        await fs.promises.mkdir(this.storageDir, { recursive: true });
    }

    /**
     * Reads the folder file from disk and returns a `Map<folderId, SessionFolder>`.
     * Returns an empty `Map` if the file does not exist or contains invalid JSON.
     * Never throws.
     */
    async load(): Promise<Map<string, SessionFolder>> {
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                this.cache = new Map();
                return this.cache;
            }
            const map = new Map<string, SessionFolder>();
            for (const entry of parsed) {
                if (entry && typeof entry === 'object' && typeof (entry as SessionFolder).id === 'string') {
                    map.set((entry as SessionFolder).id, entry as SessionFolder);
                }
            }
            this.cache = map;
            return map;
        } catch {
            this.cache = new Map();
            return this.cache;
        }
    }

    /**
     * Writes the full folder map to disk atomically (temp file + rename).
     * Never throws; logs errors to stderr.
     */
    async save(map: Map<string, SessionFolder>): Promise<void> {
        try {
            await this.ensureDir();
            const entries = Array.from(map.values());
            const json = JSON.stringify(entries, null, 2);
            // Write directly to the target file. On Windows, rename + copyFile can hang
            // when the destination is being scanned by antivirus/Defender, so we avoid
            // the temp-file + rename pattern.
            await fs.promises.writeFile(this.filePath, json, 'utf-8');
            this.cache = map;
            this.emitChange(map);
        } catch (err) {
            console.error('[chatwizard] FolderStore.save() failed:', err);
        }
    }

    // ------------------------------------------------------------------
    // Change notifications
    // ------------------------------------------------------------------

    /**
     * Subscribes to tree changes (any create/rename/move/delete/whole-tree
     * replacement). Used by the views that render this tree — the Sessions view
     * and the Knowledge Base — so a manual reorganisation shows up in both.
     *
     * Only fired after a successful write; returns a disposable subscription.
     */
    onDidChange(listener: (folders: Map<string, SessionFolder>) => void): { dispose: () => void } {
        this.changeListeners.add(listener);
        return { dispose: () => { this.changeListeners.delete(listener); } };
    }

    private emitChange(folders: Map<string, SessionFolder>): void {
        for (const listener of [...this.changeListeners]) {
            try { listener(folders); } catch { /* listeners must not break the store */ }
        }
    }

    // ------------------------------------------------------------------
    // Read operations
    // ------------------------------------------------------------------

    /**
     * Returns all folders as a Map<folderId, SessionFolder>.
     * Convenience wrapper around load() that uses the in-memory cache if available.
     */
    async getAll(): Promise<Map<string, SessionFolder>> {
        return this.cache ?? await this.load();
    }

    /** Returns a single folder by ID, or undefined if not found. */
    async get(folderId: string): Promise<SessionFolder | undefined> {
        const map = this.cache ?? await this.load();
        return map.get(folderId);
    }

    /**
     * Returns root-level folders (parentId === null), sorted by name.
     */
    async getRootFolders(): Promise<SessionFolder[]> {
        const map = this.cache ?? await this.load();
        return Array.from(map.values())
            .filter(f => f.parentId === null)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Returns child folders of a given parent, sorted by name.
     */
    async getChildFolders(parentId: string): Promise<SessionFolder[]> {
        const map = this.cache ?? await this.load();
        const parent = map.get(parentId);
        if (!parent) { return []; }
        return parent.childFolderIds
            .map(id => map.get(id))
            .filter((f): f is SessionFolder => f !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Returns the folder ID that a session is assigned to, or undefined.
     */
    async getSessionFolderId(sessionId: string): Promise<string | undefined> {
        const map = this.cache ?? await this.load();
        for (const folder of map.values()) {
            if (folder.sessionIds.includes(sessionId)) {
                return folder.id;
            }
        }
        return undefined;
    }

    /**
     * Recursively collects all descendant session IDs for a folder (all nesting levels).
     */
    private _collectDescendantSessionIds(
        folderId: string,
        map: Map<string, SessionFolder>,
        visited: Set<string> = new Set()
    ): string[] {
        if (visited.has(folderId)) { return []; } // circular reference guard
        visited.add(folderId);
        const folder = map.get(folderId);
        if (!folder) { return []; }
        const result = [...folder.sessionIds];
        for (const childId of folder.childFolderIds) {
            result.push(...this._collectDescendantSessionIds(childId, map, visited));
        }
        return result;
    }

    /**
     * Computes aggregate stats for a folder (total chats, size, sources, models).
     * Scans all descendant sessions at all nesting levels.
     */
    async getStats(
        folderId: string,
        allSummaries: SessionSummary[]
    ): Promise<FolderStats> {
        const map = this.cache ?? await this.load();
        const descendantIds = this._collectDescendantSessionIds(folderId, map);
        const idSet = new Set(descendantIds);
        const relevant = allSummaries.filter(s => idSet.has(s.id));

        let totalSizeBytes = 0;
        const sources = new Set<string>();
        const models = new Set<string>();

        for (const s of relevant) {
            if (s.fileSizeBytes !== undefined) {
                totalSizeBytes += s.fileSizeBytes;
            }
            sources.add(s.source);
            if (s.model) { models.add(s.model); }
        }

        return {
            totalChats: relevant.length,
            totalSizeBytes,
            totalSizeFormatted: formatBytes(totalSizeBytes),
            sources: Array.from(sources).sort(),
            models: Array.from(models).sort(),
        };
    }

    // ------------------------------------------------------------------
    // Write operations
    // ------------------------------------------------------------------

    /**
     * Creates a new folder with the given name and optional parent.
     * Returns the created folder.
     * Throws if a sibling with the same name already exists (case-insensitive).
     *
     * `options.origin` marks the folder as belonging to the automatic classifier's
     * tree, and `options.manual` marks user-made amendments inside that tree
     * (preserved by re-classification).
     */
    async createFolder(
        name: string,
        parentId?: string,
        options: { origin?: SessionFolderOrigin; manual?: boolean } = {},
    ): Promise<SessionFolder> {
        const map = this.cache ?? await this.load();
        // Folder names double as path segments (auto-classified tree bookkeeping),
        // so separators are normalised away here as well.
        const trimmed = normalizeFolderName(name);
        if (!trimmed) { throw new Error('Folder name must not be empty.'); }

        // Check uniqueness among siblings
        const siblings = parentId
            ? (map.get(parentId)?.childFolderIds ?? []).map(id => map.get(id)).filter(Boolean) as SessionFolder[]
            : Array.from(map.values()).filter(f => f.parentId === null);
        if (siblings.some(f => f.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error(`A folder named "${trimmed}" already exists at this level.`);
        }

        const now = new Date().toISOString();
        const folder: SessionFolder = {
            id: generateFolderId(),
            name: trimmed,
            parentId: parentId ?? null,
            sessionIds: [],
            childFolderIds: [],
            createdAt: now,
            updatedAt: now,
            origin: options.origin ?? 'user',
            ...(options.manual ? { manual: true } : {}),
        };

        map.set(folder.id, folder);

        // Link to parent
        if (parentId) {
            const parent = map.get(parentId);
            if (parent) {
                parent.childFolderIds.push(folder.id);
                parent.updatedAt = now;
                map.set(parentId, parent);
            }
        }

        await this.save(map);
        return folder;
    }

    /**
     * Renames a folder. Throws if the new name conflicts with a sibling.
     */
    async renameFolder(folderId: string, newName: string): Promise<SessionFolder> {
        const map = this.cache ?? await this.load();
        const folder = map.get(folderId);
        if (!folder) { throw new Error(`Folder not found: ${folderId}`); }

        const trimmed = normalizeFolderName(newName);
        if (!trimmed) { throw new Error('Folder name must not be empty.'); }

        // Check uniqueness among siblings
        const siblings = folder.parentId
            ? (map.get(folder.parentId)?.childFolderIds ?? []).map(id => map.get(id)).filter(Boolean) as SessionFolder[]
            : Array.from(map.values()).filter(f => f.parentId === null && f.id !== folderId);
        if (siblings.some(f => f.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error(`A folder named "${trimmed}" already exists at this level.`);
        }

        folder.name = trimmed;
        folder.updatedAt = new Date().toISOString();
        map.set(folderId, folder);
        await this.save(map);
        return folder;
    }

    /**
     * Deletes a folder and removes it from its parent's childFolderIds list.
     * Sessions inside the folder are NOT deleted — they become uncategorized.
     * Subfolders are recursively removed (their sessions also become uncategorized).
     */
    async deleteFolder(folderId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        const folder = map.get(folderId);
        if (!folder) { return; }

        // Collect all descendant folder IDs recursively
        const toRemove = new Set<string>();
        this._collectDescendantFolderIds(folderId, map, toRemove);
        toRemove.add(folderId);

        // Remove from parent's childFolderIds
        if (folder.parentId) {
            const parent = map.get(folder.parentId);
            if (parent) {
                parent.childFolderIds = parent.childFolderIds.filter(id => !toRemove.has(id));
                parent.updatedAt = new Date().toISOString();
                map.set(folder.parentId, parent);
            }
        }

        // Remove all folders in the set
        for (const id of toRemove) {
            map.delete(id);
        }

        await this.save(map);
    }

    /**
     * Moves a session into a folder. If the session is already in another folder,
     * it is removed from the old one first. Pass undefined for folderId to uncategorize.
     */
    async moveSessionToFolder(sessionId: string, targetFolderId: string | undefined): Promise<void> {
        const map = this.cache ?? await this.load();
        const now = new Date().toISOString();

        // Remove from current folder
        for (const folder of map.values()) {
            const idx = folder.sessionIds.indexOf(sessionId);
            if (idx >= 0) {
                folder.sessionIds.splice(idx, 1);
                folder.updatedAt = now;
                map.set(folder.id, folder);
                break;
            }
        }

        // Add to target folder
        if (targetFolderId) {
            const target = map.get(targetFolderId);
            if (target) {
                if (!target.sessionIds.includes(sessionId)) {
                    target.sessionIds.push(sessionId);
                    target.updatedAt = now;
                    map.set(targetFolderId, target);
                }
            }
        }

        await this.save(map);
    }

    /**
     * Moves a folder to become a subfolder of another folder (or root).
     * Pass undefined for newParentId to move to root level.
     * Throws if the move would create a circular reference.
     */
    async moveFolder(folderId: string, newParentId: string | undefined): Promise<void> {
        const map = this.cache ?? await this.load();
        const folder = map.get(folderId);
        if (!folder) { throw new Error(`Folder not found: ${folderId}`); }

        if (newParentId) {
            const newParent = map.get(newParentId);
            if (!newParent) { throw new Error(`Target folder not found: ${newParentId}`); }

            // Circular reference check
            const ancestors = new Set<string>();
            let current: string | null = newParentId;
            while (current) {
                if (current === folderId) {
                    throw new Error('Cannot move a folder into its own descendant.');
                }
                ancestors.add(current);
                const p = map.get(current);
                current = p?.parentId ?? null;
            }

            // Check name uniqueness among new siblings
            const siblings = newParent.childFolderIds
                .map(id => map.get(id))
                .filter((f): f is SessionFolder => f !== undefined && f.id !== folderId);
            if (siblings.some(f => f.name.toLowerCase() === folder.name.toLowerCase())) {
                throw new Error(`A folder named "${folder.name}" already exists in the target.`);
            }
        }

        const now = new Date().toISOString();

        // Remove from old parent
        if (folder.parentId) {
            const oldParent = map.get(folder.parentId);
            if (oldParent) {
                oldParent.childFolderIds = oldParent.childFolderIds.filter(id => id !== folderId);
                oldParent.updatedAt = now;
                map.set(oldParent.id, oldParent);
            }
        }

        // Add to new parent
        folder.parentId = newParentId ?? null;
        folder.updatedAt = now;
        map.set(folderId, folder);

        if (newParentId) {
            const newParent = map.get(newParentId)!;
            if (!newParent.childFolderIds.includes(folderId)) {
                newParent.childFolderIds.push(folderId);
                newParent.updatedAt = now;
                map.set(newParentId, newParent);
            }
        }

        await this.save(map);
    }

    /**
     * Returns the cached folder map without I/O.
     * Useful for synchronous access after load() has been called.
     */
    getCached(): Map<string, SessionFolder> | null {
        return this.cache;
    }

    // ------------------------------------------------------------------
    // Auto-tree amendments
    // ------------------------------------------------------------------

    /**
     * Marks a folder as user-amended (created/renamed/moved by hand inside the
     * auto-classified tree). Re-classification keeps such folders.
     */
    async markManual(folderId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        const folder = map.get(folderId);
        if (!folder || folder.manual) { return; }
        folder.manual = true;
        folder.updatedAt = new Date().toISOString();
        map.set(folderId, folder);
        await this.save(map);
    }

    /**
     * Returns the full name path of a folder (`"Git/Branching/Merge Conflicts"`),
     * or `''` when the folder is unknown.
     */
    getPath(folderId: string): string {
        const map = this.cache;
        if (!map) { return ''; }
        const names: string[] = [];
        const visited = new Set<string>();
        let current: string | null = folderId;
        while (current) {
            if (visited.has(current)) { break; } // circular guard
            visited.add(current);
            const folder: SessionFolder | undefined = map.get(current);
            if (!folder) { break; }
            names.unshift(folder.name);
            current = folder.parentId;
        }
        return names.join('/');
    }

    /** Returns the IDs of every folder below `folderId` (excluding itself). */
    getDescendantFolderIds(folderId: string): string[] {
        const map = this.cache;
        if (!map) { return []; }
        const out = new Set<string>();
        this._collectDescendantFolderIds(folderId, map, out);
        return [...out];
    }

    // ------------------------------------------------------------------
    // Whole-tree replacement (automatic classification)
    // ------------------------------------------------------------------

    /**
     * Replaces the entire tree held by this store with `specs` and writes it once.
     *
     * Used by the automatic classifier to materialise its folder tree. Folders
     * whose name path still exists keep their ID and `createdAt`, so tree
     * expansion state survives a re-classification; folders that disappeared are
     * dropped. Nesting deeper than {@link MAX_FOLDER_DEPTH} is flattened into the
     * deepest folder.
     *
     * @returns The new `Map<folderId, SessionFolder>`.
     */
    async replaceTree(
        specs: FolderTreeSpec[],
        origin: SessionFolderOrigin = 'auto',
    ): Promise<Map<string, SessionFolder>> {
        const previous = this.cache ?? await this.load();
        const now = new Date().toISOString();
        const next = new Map<string, SessionFolder>();

        // Index the previous tree by its full name path so IDs can be reused.
        const reusable = new Map<string, SessionFolder>();
        const indexPath = (folder: SessionFolder, parentKey: string): void => {
            const key = `${parentKey}\u0000${folder.name}`;
            if (!reusable.has(key)) { reusable.set(key, folder); }
            for (const childId of folder.childFolderIds) {
                const child = previous.get(childId);
                if (child) { indexPath(child, key); }
            }
        };
        for (const folder of previous.values()) {
            if (folder.parentId === null) { indexPath(folder, ''); }
        }

        const build = (nodes: FolderTreeSpec[], parentId: string | null, parentKey: string, depth: number): void => {
            for (const node of nodes) {
                const name = normalizeFolderName(node.name);
                if (!name) { continue; }

                const key = `${parentKey}\u0000${name}`;
                const existing = reusable.get(key);
                const folder: SessionFolder = {
                    id: existing?.id ?? generateFolderId(),
                    name,
                    parentId,
                    sessionIds: Array.from(new Set(node.sessionIds ?? [])),
                    childFolderIds: [],
                    createdAt: existing?.createdAt ?? now,
                    updatedAt: now,
                    origin,
                };
                next.set(folder.id, folder);

                if (parentId !== null) {
                    const parent = next.get(parentId);
                    if (parent && !parent.childFolderIds.includes(folder.id)) {
                        parent.childFolderIds.push(folder.id);
                    }
                }

                if (depth < MAX_FOLDER_DEPTH && node.children && node.children.length > 0) {
                    build(node.children, folder.id, key, depth + 1);
                }
            }
        };

        build(specs, null, '', 1);
        await this.save(next);
        return next;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    private _collectDescendantFolderIds(
        folderId: string,
        map: Map<string, SessionFolder>,
        out: Set<string>,
        visited: Set<string> = new Set()
    ): void {
        if (visited.has(folderId)) { return; }
        visited.add(folderId);
        const folder = map.get(folderId);
        if (!folder) { return; }
        for (const childId of folder.childFolderIds) {
            out.add(childId);
            this._collectDescendantFolderIds(childId, map, out, visited);
        }
    }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Sanitises a classifier label for use as a folder name.
 * Collapses whitespace and separators (a `/` or `|` in a name would make the
 * tree ambiguous) and trims surrounding punctuation. Returns `''` when nothing
 * usable remains — callers skip such folders.
 */
export function normalizeFolderName(raw: string): string {
    const cleaned = (raw ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[|/\\]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s"'`*_#-]+/, '')
        .replace(/[\s"'`*_#.:;,-]+$/, '')
        .trim();
    return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

/** Generates a short, unique folder ID. */
let _counter = 0;
export function generateFolderId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    _counter = (_counter + 1) % 10000;
    return `f_${ts}_${rand}_${_counter}`;
}

/** Formats a byte count into a human-readable string. */
function formatBytes(bytes: number): string {
    if (bytes === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}