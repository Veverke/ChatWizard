/**
 * src/logs/copilotLogHarvester.ts
 *
 * Phase 2 — Copilot log-event harvester.
 *
 * Bridges the watch-logs store and the existing session-index pipeline.
 * Because Copilot's "agent-execution log" is embedded in the same JSONL files
 * the session watcher already parses, the harvester hooks the session index's
 * typed change events:
 *
 *   - session upserted  → re-normalize that session's file into the event store
 *   - batch upsert      → same, for every Copilot session in the batch
 *   - session removed   → drop that session's stored events
 *
 * Re-ingesting a file first removes any events previously parsed from it
 * (`removeBySourcePath`), so live rewrites of a growing JSONL do not leave
 * stale rows behind.
 */

import { SessionIndexEvent } from '../index/sessionIndex';
import { Session } from '../types/index';
import { LogService } from './logService';

export interface CopilotHarvestResult {
    /** Number of events persisted for the file. */
    ingested: number;
    /** Non-fatal parse issues (malformed lines, …). */
    errors: string[];
}

export class CopilotLogHarvester {
    /**
     * Optional callback invoked after the event store changes — used to refresh
     * UI providers that read from `LogService` (e.g. the Executed Commands panel).
     */
    public onEventsChanged?: () => void;

    constructor(private readonly logService: LogService) {}

    /**
     * Parse one Copilot session file and (re)index its normalized events.
     * Delegates to `LogService.ingestCopilotSessionFile` which removes events
     * previously parsed from the same file before inserting the fresh set.
     */
    ingestSessionFile(filePath: string, workspaceId: string, workspacePath?: string): CopilotHarvestResult {
        const result = this.logService.ingestCopilotSessionFile(filePath, workspaceId, workspacePath);
        this.onEventsChanged?.();
        return result;
    }

    /**
     * Handle a single session-index change event. Swallows per-session errors so
     * a malformed/removed file can never break the watcher pipeline.
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
        if (session.source !== 'copilot' || !session.filePath) { return; }
        try {
            this.ingestSessionFile(session.filePath, session.workspaceId ?? '', session.workspacePath);
        } catch {
            // Never let log harvesting break session indexing.
        }
    }
}