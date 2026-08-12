// src/index/sidecarMetadataStore.ts
// Persistent sidecar metadata store — never mutates source session files.

import * as fs from 'fs';
import * as path from 'path';
import { SessionMetadata } from '../types/index';

const METADATA_FILENAME = 'chatwizard-metadata.json';

/**
 * Stores per-session metadata in a single JSON file under `storageDir`.
 * All mutations are written atomically via a temp-file + rename pattern.
 */
export class SidecarMetadataStore {
    private readonly filePath: string;
    private cache: Map<string, SessionMetadata> | null = null;

    constructor(private readonly storageDir: string) {
        this.filePath = path.join(storageDir, METADATA_FILENAME);
    }

    /** Ensures the storage directory exists before any I/O. */
    private async ensureDir(): Promise<void> {
        await fs.promises.mkdir(this.storageDir, { recursive: true });
    }

    /**
     * Reads the metadata file from disk and returns a `Map<sessionId, SessionMetadata>`.
     * Returns an empty `Map` if the file does not exist or contains invalid JSON.
     * Never throws.
     */
    async load(): Promise<Map<string, SessionMetadata>> {
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                this.cache = new Map();
                return this.cache;
            }
            const map = new Map<string, SessionMetadata>();
            for (const entry of parsed) {
                if (entry && typeof entry === 'object' && typeof (entry as SessionMetadata).sessionId === 'string') {
                    map.set((entry as SessionMetadata).sessionId, entry as SessionMetadata);
                }
            }
            this.cache = map;
            return map;
        } catch {
            // File missing, corrupt JSON, etc.
            this.cache = new Map();
            return this.cache;
        }
    }

    /**
     * Writes the full metadata map to disk atomically (temp file + rename).
     * Never throws; logs errors to stderr.
     */
    async save(map: Map<string, SessionMetadata>): Promise<void> {
        try {
            await this.ensureDir();
            const entries = Array.from(map.values());
            const json = JSON.stringify(entries, null, 2);
            const tmpPath = this.filePath + '.tmp';
            await fs.promises.writeFile(tmpPath, json, 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
            this.cache = map;
        } catch (err) {
            console.error('[chatwizard] SidecarMetadataStore.save() failed:', err);
        }
    }

    /** Returns the metadata entry for a session, or `undefined` if none exists. */
    async get(sessionId: string): Promise<SessionMetadata | undefined> {
        const map = this.cache ?? await this.load();
        return map.get(sessionId);
    }

    /** Inserts or replaces the metadata entry for a session. */
    async set(sessionId: string, meta: SessionMetadata): Promise<void> {
        const map = this.cache ?? await this.load();
        map.set(sessionId, { ...meta, sessionId });
        await this.save(map);
    }

    /**
     * Merges partial fields into the existing entry (creating it if absent).
     * Returns the updated entry.
     */
    async patch(sessionId: string, partial: Partial<SessionMetadata>): Promise<SessionMetadata> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId) ?? { sessionId };
        const updated: SessionMetadata = {
            ...existing,
            ...partial,
            sessionId,
            updatedAt: new Date().toISOString(),
        };
        if (!existing.createdAt) {
            updated.createdAt = updated.updatedAt;
        }
        map.set(sessionId, updated);
        await this.save(map);
        return updated;
    }

    /** Removes the metadata entry for a session. */
    async delete(sessionId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        if (map.delete(sessionId)) {
            await this.save(map);
        }
    }

    /** Shortcut: sets only `customTitle`, leaving other fields intact. */
    async setTitle(sessionId: string, title: string): Promise<void> {
        await this.patch(sessionId, { customTitle: title });
    }

    /** Shortcut: sets only `isPinned`, leaving other fields intact. */
    async setPin(sessionId: string, pinned: boolean): Promise<void> {
        await this.patch(sessionId, { isPinned: pinned });
    }

    /**
     * Adds a tag to a session.  Tags are stored lowercase; duplicates are silently ignored.
     * Empty or whitespace-only tags are also ignored.
     */
    async addTag(sessionId: string, tag: string): Promise<void> {
        const normalised = tag.trim().toLowerCase().replace(/^#+/, '');
        if (!normalised) { return; }
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId) ?? { sessionId };
        const tags = existing.tags ?? [];
        if (!tags.includes(normalised)) {
            await this.patch(sessionId, { tags: [...tags, normalised] });
        }
    }

    /** Removes a tag from a session.  No-op if the tag does not exist. */
    async removeTag(sessionId: string, tag: string): Promise<void> {
        const normalised = tag.trim().toLowerCase().replace(/^#+/, '');
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        if (!existing?.tags) { return; }
        const updated = existing.tags.filter(t => t !== normalised);
        if (updated.length !== existing.tags.length) {
            await this.patch(sessionId, { tags: updated });
        }
    }

    /** Removes all tags from a session.  No-op if the session has no tags. */
    async clearTags(sessionId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        if (!existing?.tags || existing.tags.length === 0) { return; }
        await this.patch(sessionId, { tags: [] });
    }

    /**
     * Returns all tags across all sessions with their usage counts,
     * sorted by count descending.
     */
    async getAllTags(): Promise<Array<{ tag: string; count: number }>> {
        const map = this.cache ?? await this.load();
        const counts = new Map<string, number>();
        for (const meta of map.values()) {
            for (const tag of meta.tags ?? []) {
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }
        return Array.from(counts.entries())
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
    }

    /** Shortcut: sets only `summary`, leaving other fields intact. */
    async setSummary(sessionId: string, summary: string): Promise<void> {
        await this.patch(sessionId, { summary });
    }

    /** Shortcut: sets session status (open/resolved/revisit) */
    async setStatus(sessionId: string, status: 'open' | 'resolved' | 'revisit' | undefined): Promise<void> {
        await this.patch(sessionId, { status });
    }

    /** Returns all bookmarks for a session, or an empty array if none exist. */
    async getBookmarks(sessionId: string): Promise<import('../types/index').SessionBookmark[]> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        return existing?.bookmarks ?? [];
    }

    /**
     * Adds a bookmark pointing to a specific message in a session.
     * Stores bookmarks as a list on the SessionMetadata.
     * If a bookmark for the same messageIndex already exists, it is replaced (toggled off → on).
     */
    async addBookmark(sessionId: string, bookmark: import('../types/index').SessionBookmark): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId) ?? { sessionId };
        const bookmarks: import('../types/index').SessionBookmark[] = existing.bookmarks ?? [];
        // Replace existing bookmark for the same messageIndex if any
        const idx = bookmarks.findIndex(b => b.messageIndex === bookmark.messageIndex);
        if (idx >= 0) {
            bookmarks[idx] = bookmark;
        } else {
            bookmarks.push(bookmark);
        }
        await this.patch(sessionId, { bookmarks } as import('../types/index').SessionMetadata);
    }

    /**
     * Toggles a bookmark for the given message index.
     * If a bookmark exists for that index, it is removed. Otherwise it is added.
     * Returns true if the bookmark was added, false if removed.
     */
    async toggleBookmark(sessionId: string, messageIndex: number, note?: string): Promise<boolean> {
        const existingBms = await this.getBookmarks(sessionId);
        const existingIdx = existingBms.findIndex(b => b.messageIndex === messageIndex);
        if (existingIdx >= 0) {
            // Remove
            await this.removeBookmark(sessionId, messageIndex);
            return false;
        } else {
            // Add
            const bookmark: import('../types/index').SessionBookmark = {
                messageIndex,
                note: note || undefined,
                createdAt: new Date().toISOString(),
            };
            await this.addBookmark(sessionId, bookmark);
            return true;
        }
    }

    /** Removes all bookmarks for a given message index. */
    async removeBookmark(sessionId: string, messageIndex: number): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        if (!existing) { return; }
        const bookmarks: import('../types/index').SessionBookmark[] = (existing.bookmarks ?? []).filter(
            (b: import('../types/index').SessionBookmark) => b.messageIndex !== messageIndex
        );
        await this.patch(sessionId, { bookmarks } as import('../types/index').SessionMetadata);
    }

    /** Returns all annotations for a session, or an empty array if none exist. */
    async getAnnotations(sessionId: string): Promise<import('../types/index').MessageAnnotation[]> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        return existing?.annotations ?? [];
    }

    /**
     * Upserts an annotation for a specific message.
     * If an annotation for the same messageIndex already exists, it is replaced (updatedAt set).
     * Otherwise a new annotation is added.
     */
    async upsertAnnotation(sessionId: string, annotation: import('../types/index').MessageAnnotation): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId) ?? { sessionId };
        const annotations: import('../types/index').MessageAnnotation[] = existing.annotations ? [...existing.annotations] : [];
        const idx = annotations.findIndex((a: import('../types/index').MessageAnnotation) => a.messageIndex === annotation.messageIndex);
        if (idx >= 0) {
            // Update existing: preserve createdAt, set updatedAt
            annotations[idx] = {
                ...annotation,
                createdAt: annotations[idx].createdAt,
                updatedAt: new Date().toISOString(),
            };
        } else {
            // Add new
            annotations.push(annotation);
        }
        await this.patch(sessionId, { annotations });
    }

    /** Removes all annotations for a given message index. */
    async removeAnnotation(sessionId: string, messageIndex: number): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        if (!existing?.annotations) { return; }
        const updated = existing.annotations.filter(a => a.messageIndex !== messageIndex);
        await this.patch(sessionId, { annotations: updated });
    }

    /** Adds a linked session ID reference. */
    async addLinkedSession(sessionId: string, linkedSessionId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId) ?? { sessionId };
        const links = existing.linkedSessionIds ?? [];
        if (!links.includes(linkedSessionId)) {
            await this.patch(sessionId, { linkedSessionIds: [...links, linkedSessionId] });
        }
    }

    /** Removes a linked session ID reference. */
    async removeLinkedSession(sessionId: string, linkedSessionId: string): Promise<void> {
        const map = this.cache ?? await this.load();
        const existing = map.get(sessionId);
        if (!existing?.linkedSessionIds) { return; }
        const updated = existing.linkedSessionIds.filter(id => id !== linkedSessionId);
        await this.patch(sessionId, { linkedSessionIds: updated });
    }

    }
