/**
 * src/cache/cacheIntegration.ts
 *
 * Feature 24 — Integration bridge between CacheManager, SessionIndex, and fileWatcher.
 *
 * Provides a clean integration point so extension.ts doesn't need to know
 * the internal details of the cache layer. Follows a Facade pattern.
 */

import { CacheManager, ICacheManager } from './cacheManager';
import { SessionIndex } from '../index/sessionIndex';
import { Session } from '../types/index';

export interface ICacheIntegration {
    readonly cacheManager: ICacheManager;
    readonly dbPath: string;
    /** Load all sessions from DB into the index (startup path). */
    loadIntoIndex(index: SessionIndex): Promise<void>;
    /** After a parse completes, write sessions to DB and index. */
    ingestSessions(index: SessionIndex, sessions: Session[]): void;
    /** After a session is removed from the index, also remove from DB. */
    removeSession(sessionId: string): void;
    /** Dispose the cache manager. */
    dispose(): void;
}

export class CacheIntegration implements ICacheIntegration {
    public readonly cacheManager: ICacheManager;

    public get dbPath(): string { return this.cacheManager.dbPath; }

    constructor(storageDir: string) {
        this.cacheManager = new CacheManager(storageDir);
        this.cacheManager.open();
    }

    async loadIntoIndex(index: SessionIndex): Promise<void> {
        await this.cacheManager.loadAll(index);
    }

    ingestSessions(index: SessionIndex, sessions: Session[]): void {
        if (sessions.length === 0) { return; }
        this.cacheManager.upsertSessions(sessions);
        // The watcher already calls index.batchUpsert() — we just need to persist to DB
    }

    removeSession(sessionId: string): void {
        this.cacheManager.removeSession(sessionId);
    }

    dispose(): void {
        this.cacheManager.close();
    }
}