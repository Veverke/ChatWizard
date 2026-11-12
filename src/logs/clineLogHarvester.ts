/**
 * src/logs/clineLogHarvester.ts
 *
 * Phase 3 — Cline / Roo Code log-event harvester.
 *
 * Bridges the watch-logs store and the existing session-index pipeline for
 * Cline (and Roo Code, which shares its task layout). The "agent-execution
 * log" is Cline's `ui_messages.json`, written next to the
 * `api_conversation_history.json` the session watcher already parses — so the
 * harvester hooks the session index's typed change events:
 *
 *   - session upserted  → re-normalize that task's ui_messages.json
 *   - batch upsert      → same, for every Cline/Roo Code session in the batch
 *   - session removed   → drop that task's stored events
 *
 * Re-ingesting a task dir first removes any events previously parsed from its
 * `ui_messages.json` (`removeBySourcePath`), so live rewrites of a growing
 * file never leave stale rows behind.
 */

import { SessionIndexEvent } from '../index/sessionIndex';
import { Session } from '../types/index';
import { LogService } from './logService';

export interface ClineHarvestResult {
    /** Number of events persisted for the task dir. */
    ingested: number;
    /** Non-fatal parse issues (malformed messages, …). */
    errors: string[];
}

export class ClineLogHarvester {
    /**
     * Optional callback invoked after the event store changes — used to refresh
     * UI providers that read from `LogService` (Executed Commands, Unified
     * Timeline, Diff Explorer).
     */
    public onEventsChanged?: () => void;

    constructor(private readonly logService: LogService) {}

    /**
     * Parse one Cline/Roo Code task dir and (re)index its normalized events.
     * Delegates to `LogService.ingestClineTaskFile` which removes events
     * previously parsed from the same ui_messages.json before inserting.
     */
    ingestTaskDir(taskDir: string, source: 'cline' | 'roocode'): ClineHarvestResult {
        const result = this.logService.ingestClineTaskFile(taskDir, source);
        this.onEventsChanged?.();
        return result;
    }

    /**
     * Handle a single session-index change event. Swallows per-session errors so
     * a malformed/removed task can never break the watcher pipeline.
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
        if (session.source !== 'cline' && session.source !== 'roocode') { return; }
        if (!session.filePath) { return; }
        try {
            this.ingestTaskDir(session.filePath, session.source);
        } catch {
            // Never let log harvesting break session indexing.
        }
    }
}