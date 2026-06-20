// src/archive/sessionArchive.ts
// Local session archive — mirrors raw session content to globalStorageUri/archive/
// so sessions remain accessible even after the source tool prunes its own storage.
//
// Design goals:
//   - Atomic writes (tmp + rename) to prevent partial files.
//   - In-memory manifest for O(1) has() checks without directory scans.
//   - Pruning by age and/or total size (oldest-first).
//   - Safe concurrent access: saveManifest() uses a per-process mutex to
//     prevent EPERM rename collisions when multiple sessions are archived
//     concurrently (e.g. via Promise.all in the batch listener).

import * as fs from 'fs';
import * as path from 'path';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ArchivedSession {
    sessionId: string;
    source: string;
    filePath: string;
    archivedAt: string; // ISO-8601
    sizeBytes: number;
}

export interface ArchiveStats {
    totalSessions: number;
    totalBytes: number;
    oldestDate: string | null;
}

export interface PruneOptions {
    maxAgeDays?: number;  // 0 = no age limit
    maxSizeMB?: number;   // 0 = no size limit
}

// ─── Manifest entry stored in archive-manifest.json ──────────────────────────

interface ManifestEntry {
    sessionId: string;
    source: string;
    relPath: string;  // relative to archiveRoot
    archivedAt: string;
    sizeBytes: number;
}

// ─── Simple per-process mutex ─────────────────────────────────────────────────
// Prevents concurrent rename() operations on the same manifest.tmp file,
// which would cause EPERM on Windows.

class Mutex {
    private _locked = false;
    private _queue: Array<() => void> = [];

    async acquire(): Promise<void> {
        if (!this._locked) {
            this._locked = true;
            return;
        }
        return new Promise<void>(resolve => {
            this._queue.push(resolve);
        });
    }

    release(): void {
        const next = this._queue.shift();
        if (next) {
            next();
        } else {
            this._locked = false;
        }
    }
}

// ─── SessionArchive ───────────────────────────────────────────────────────────

/**
 * Manages the on-disk archive of session content.
 * All methods are safe to call concurrently from a single Node.js process
 * (in-memory manifest acts as a lock-free coordination layer; saveManifest()
 * uses an internal mutex to avoid EPERM rename collisions).
 */
export class SessionArchive {
    private readonly archiveRoot: string;
    private readonly manifestPath: string;
    private manifest: Map<string, ManifestEntry> | null = null;
    private readonly _manifestMutex = new Mutex();

    constructor(storageDir: string) {
        this.archiveRoot = path.join(storageDir, 'archive');
        this.manifestPath = path.join(this.archiveRoot, 'archive-manifest.json');
    }

    // ── Initialisation ─────────────────────────────────────────────────────────

    /** Loads the manifest from disk (or creates an empty one). */
    private async ensureManifest(): Promise<Map<string, ManifestEntry>> {
        if (this.manifest !== null) { return this.manifest; }
        this.manifest = new Map();
        try {
            const raw = await fs.promises.readFile(this.manifestPath, 'utf-8');
            const arr = JSON.parse(raw) as ManifestEntry[];
            if (Array.isArray(arr)) {
                for (const entry of arr) {
                    if (entry?.sessionId) {
                        this.manifest.set(this._key(entry.sessionId, entry.source), entry);
                    }
                }
            }
        } catch { /* file missing or corrupt — start fresh */ }
        return this.manifest;
    }

    private _key(sessionId: string, source: string): string {
        return `${source}::${sessionId}`;
    }

    private async saveManifest(): Promise<void> {
        if (!this.manifest) { return; }
        await this._manifestMutex.acquire();
        try {
            await fs.promises.mkdir(this.archiveRoot, { recursive: true });
            const arr = Array.from(this.manifest.values());
            const json = JSON.stringify(arr, null, 2);
            const tmp = this.manifestPath + '.tmp';
            await fs.promises.writeFile(tmp, json, 'utf-8');
            await fs.promises.rename(tmp, this.manifestPath);
        } catch (err) {
            console.error('[chatwizard] SessionArchive.saveManifest() failed:', err);
        } finally {
            this._manifestMutex.release();
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Loads the manifest into memory. Call once before using has() for batch lookups. */
    async init(): Promise<void> {
        await this.ensureManifest();
    }

    /**
     * Returns true synchronously if the session is already in the in-memory manifest.
     * Requires `init()` (or any other async method) to have been called at least once beforehand.
     * Safe to call before awaiting `init()` — returns false if manifest not yet loaded.
     */
    has(sessionId: string, source: string): boolean {
        return this.manifest?.has(this._key(sessionId, source)) ?? false;
    }

    /**
     * Saves raw session content to the archive (atomic write).
     * Overwrites any previously archived version for the same session ID.
     * Safe to call concurrently from multiple async contexts.
     */
    async save(sessionId: string, source: string, rawContent: string | Buffer): Promise<void> {
        const manifest = await this.ensureManifest();
        const sourceDir = path.join(this.archiveRoot, source);
        await fs.promises.mkdir(sourceDir, { recursive: true });

        const ext = typeof rawContent === 'string' ? '.json' : '.bin';
        const fileName = `${sessionId}${ext}`;
        const filePath = path.join(sourceDir, fileName);
        const relPath = path.relative(this.archiveRoot, filePath);

        const buf = typeof rawContent === 'string'
            ? Buffer.from(rawContent, 'utf-8')
            : rawContent;

        const tmp = filePath + '.tmp';
        try {
            await fs.promises.writeFile(tmp, buf);
            await fs.promises.rename(tmp, filePath);
        } catch (err) {
            // Clean up tmp on failure
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            throw err;
        }

        const archivedAt = new Date().toISOString();
        manifest.set(this._key(sessionId, source), {
            sessionId,
            source,
            relPath,
            archivedAt,
            sizeBytes: buf.length,
        });

        await this.saveManifest();
    }

    /**
     * Reads and returns the raw content of an archived session.
     * Returns `undefined` if not found.
     */
    async loadRaw(sessionId: string, source: string): Promise<string | undefined> {
        const manifest = await this.ensureManifest();
        const entry = manifest.get(this._key(sessionId, source));
        if (!entry) { return undefined; }
        try {
            return await fs.promises.readFile(
                path.join(this.archiveRoot, entry.relPath), 'utf-8'
            );
        } catch { return undefined; }
    }

    /**
     * Returns metadata for all archived sessions for a given source.
     */
    async loadAll(source: string): Promise<ArchivedSession[]> {
        const manifest = await this.ensureManifest();
        const results: ArchivedSession[] = [];
        for (const entry of manifest.values()) {
            if (entry.source !== source) { continue; }
            results.push({
                sessionId: entry.sessionId,
                source: entry.source,
                filePath: path.join(this.archiveRoot, entry.relPath),
                archivedAt: entry.archivedAt,
                sizeBytes: entry.sizeBytes,
            });
        }
        return results;
    }

    /**
     * Returns all archived sessions across all sources.
     */
    async loadAllSources(): Promise<ArchivedSession[]> {
        const manifest = await this.ensureManifest();
        return Array.from(manifest.values()).map(e => ({
            sessionId: e.sessionId,
            source: e.source,
            filePath: path.join(this.archiveRoot, e.relPath),
            archivedAt: e.archivedAt,
            sizeBytes: e.sizeBytes,
        }));
    }

    /**
     * Returns the ArchivedSession metadata for a given sessionId, searching across all sources.
     * Returns undefined if the session is not in the archive.
     */
    async findAnySource(sessionId: string): Promise<ArchivedSession | undefined> {
        const manifest = await this.ensureManifest();
        for (const entry of manifest.values()) {
            if (entry.sessionId === sessionId) {
                return {
                    sessionId: entry.sessionId,
                    source: entry.source,
                    filePath: path.join(this.archiveRoot, entry.relPath),
                    archivedAt: entry.archivedAt,
                    sizeBytes: entry.sizeBytes,
                };
            }
        }
        return undefined;
    }

    /**
     * Returns summary statistics about the archive.
     */
    async stats(): Promise<ArchiveStats> {
        const manifest = await this.ensureManifest();
        let totalBytes = 0;
        let oldestDate: string | null = null;

        for (const entry of manifest.values()) {
            totalBytes += entry.sizeBytes;
            if (!oldestDate || entry.archivedAt < oldestDate) {
                oldestDate = entry.archivedAt;
            }
        }

        return {
            totalSessions: manifest.size,
            totalBytes,
            oldestDate,
        };
    }

    /**
     * Prunes archived sessions by age and/or total size.
     * Removes oldest sessions first.
     * Returns the number of sessions removed.
     */
    async prune(options: PruneOptions): Promise<number> {
        const { maxAgeDays = 0, maxSizeMB = 0 } = options;
        if (maxAgeDays === 0 && maxSizeMB === 0) { return 0; }

        const manifest = await this.ensureManifest();
        // Sort oldest first
        const entries = Array.from(manifest.values()).sort(
            (a, b) => a.archivedAt.localeCompare(b.archivedAt)
        );

        const cutoffDate = maxAgeDays > 0
            ? new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
            : null;

        let totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
        const maxBytes = maxSizeMB > 0 ? maxSizeMB * 1_048_576 : Infinity;

        let removed = 0;
        for (const entry of entries) {
            const tooOld = cutoffDate !== null && entry.archivedAt < cutoffDate;
            const tooBig = totalBytes > maxBytes;

            if (tooOld || tooBig) {
                try {
                    await fs.promises.unlink(path.join(this.archiveRoot, entry.relPath));
                } catch { /* file may already be gone */ }
                manifest.delete(this._key(entry.sessionId, entry.source));
                totalBytes -= entry.sizeBytes;
                removed++;
            }
        }

        if (removed > 0) {
            await this.saveManifest();
        }

        return removed;
    }

    /**
     * Permanently deletes a single archived session from disk and the manifest.
     * Returns true if the entry existed and was removed, false if it was not found.
     */
    async delete(sessionId: string, source: string): Promise<boolean> {
        const manifest = await this.ensureManifest();
        const key = this._key(sessionId, source);
        const entry = manifest.get(key);
        if (!entry) { return false; }
        try {
            await fs.promises.unlink(path.join(this.archiveRoot, entry.relPath));
        } catch { /* file may already be gone */ }
        manifest.delete(key);
        await this.saveManifest();
        return true;
    }
}