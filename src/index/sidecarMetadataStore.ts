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
}
