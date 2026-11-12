/**
 * src/logs/aiderLogHarvester.ts
 *
 * Phase 3 — Aider log harvester.
 *
 * Bridges the watch-logs store and the session-index pipeline for Aider. Aider
 * sessions are discovered by `discoverAiderHistoryFilesAsync` (one session per
 * `<repo>/.aider.chat.history.md`), so the harvester hooks the same typed
 * session-index events the Copilot / Cline harvesters use:
 *
 *   - session upserted → re-normalize that history file
 *   - batch upsert     → same, for every Aider session in the batch
 *   - session removed  → drop that session's stored events
 *
 * Re-ingesting a file first removes the rows previously parsed from it
 * (`removeBySourcePath`), so a growing transcript never leaves stale rows.
 */

import { SessionIndexEvent } from '../index/sessionIndex';
import { Session } from '../types/index';
import { LogService } from './logService';

export interface AiderHarvestResult {
    /** Number of events persisted for the history file. */
    ingested: number;
    /** Non-fatal parse issues (malformed fences, unreadable files, …). */
    errors: string[];
}

export class AiderLogHarvester {
    /**
     * Optional callback invoked after the event store changes — used to refresh
     * the Executed Commands / Unified Timeline / Diff Explorer providers.
     */
    public onEventsChanged?: () => void;

    constructor(private readonly logService: LogService) {}

    /**
     * Parse one `.aider.chat.history.md` and (re)index its normalized events.
     * The session id the index uses is forwarded so the stored events line up
     * with the chat session exactly (both are sha1 of the history path).
     */
    ingestHistoryFile(historyFile: string, workspacePath?: string, sessionId?: string): AiderHarvestResult {
        const result = this.logService.ingestAiderHistoryFile(historyFile, workspacePath, sessionId);
        this.onEventsChanged?.();
        return result;
    }

    /**
     * Handle a single session-index change event. Swallows per-session errors so
     * an unreadable transcript can never break the watcher pipeline.
     */
    handleIndexEvent(event: SessionIndexEvent): void {
        switch (event.type) {
            case 'upsert':
                this._ingestSession(event.session);
                break;
            case 'batch':
                for (const session of event.sessions) {
                    this._ingestSession(session);
                }
                break;
            case 'remove':
                this.logService.removeEventsForSession(event.sessionId);
                this.onEventsChanged?.();
                break;
            default:
                break;
        }
    }

    private _ingestSession(session: Session): void {
        if (session.source !== 'aider') { return; }
        if (!session.filePath) { return; }
        try {
            this.ingestHistoryFile(session.filePath, session.workspacePath, session.id);
        } catch {
            // Never let log harvesting break session indexing.
        }
    }
}
