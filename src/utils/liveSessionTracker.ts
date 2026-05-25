// src/utils/liveSessionTracker.ts
// Tracks which session was most recently updated by a live file-watcher event.
// One slot per source — updated every time the watcher calls record().
// Used by `chatwizard.tagActiveSession` and the `/tag` chat participant command
// to identify the session the user is currently working in without relying on
// timestamp heuristics over the full session index.

import { SessionSource } from '../types/index';

export interface LiveSessionEntry {
    sessionId: string;
    source: SessionSource;
    updatedAt: Date;
}

export class LiveSessionTracker {
    private readonly _map = new Map<SessionSource, LiveSessionEntry & { _seq: number }>();
    private readonly _listeners = new Set<() => void>();
    private _seq = 0;

    /**
     * Records a live update for the given source/session.
     * Replaces any previous entry for that source.
     * Fires `onDidUpdate` listeners synchronously.
     */
    record(source: SessionSource, sessionId: string): void {
        this._map.set(source, { sessionId, source, updatedAt: new Date(), _seq: ++this._seq });
        for (const l of this._listeners) { l(); }
    }

    /**
     * Returns all entries updated within `windowMs` milliseconds, sorted most-recent first.
     * Default window: 2 hours (matching `chatwizard.activeSessionWindowMinutes` default of 120).
     */
    getActive(windowMs = 2 * 60 * 60 * 1000): LiveSessionEntry[] {
        const cutoff = Date.now() - windowMs;
        return [...this._map.values()]
            .filter(e => e.updatedAt.getTime() >= cutoff)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b._seq - a._seq);
    }

    /**
     * Returns the single most recently recorded entry regardless of window age.
     * Used as a last-resort fallback when the window has expired but the user
     * still wants to tag the last known session.
     */
    getMostRecent(): LiveSessionEntry | undefined {
        if (this._map.size === 0) { return undefined; }
        return [...this._map.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b._seq - a._seq)[0];
    }

    /**
     * Registers a listener that fires whenever `record()` is called.
     * Returns a disposable to unregister.
     */
    onDidUpdate(listener: () => void): { dispose(): void } {
        this._listeners.add(listener);
        return { dispose: () => { this._listeners.delete(listener); } };
    }
}
