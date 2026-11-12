/**
 * src/logs/windsurfLogHarvester.ts
 *
 * Phase 3 — Windsurf log harvester.
 *
 * Windsurf keeps **every** chat of a workspace inside that workspace's single
 * `state.vscdb`, so unlike the Cline/Aider harvesters (one file per session)
 * the unit of work here is the *database*, not the session:
 *
 *   - session upserted / batch → parse the workspace's `state.vscdb` once
 *   - session removed          → drop only that session's events
 *
 * Two guards keep the (async, SQLite-backed) parse cheap:
 *   1. a `pending` set so N sessions of one batch never parse the DB N times;
 *   2. a `<mtimeMs>:<size>` stamp per database, so an unchanged DB is skipped
 *      entirely — live rewrites still re-index because the stamp changes.
 *
 * The Cascade reader is injectable so the bridge is unit-testable without
 * SQLite; production uses `readWindsurfCascadeSessionData` (better-sqlite3 →
 * sql.js fallback).
 */

import * as fs from 'fs';
import { SessionIndexEvent } from '../index/sessionIndex';
import { Session } from '../types/index';
import { LogService } from './logService';
import { readWindsurfCascadeSessionData } from './adapters/windsurfLogAdapter';

/** Reads the raw `cascade.sessionData` JSON out of one `state.vscdb`. */
export type WindsurfCascadeReader = (vscdbPath: string) => Promise<string | undefined>;

export interface WindsurfLogHarvesterOptions {
    /** Override how the Cascade payload is read (tests inject a fake). */
    readCascadeData?: WindsurfCascadeReader;
}

export interface WindsurfHarvestResult {
    /** Number of events persisted for the database. */
    ingested: number;
    /** Non-fatal parse issues. */
    errors: string[];
}

export class WindsurfLogHarvester {
    /**
     * Optional callback invoked after the event store changes — used to refresh
     * the Executed Commands / Unified Timeline / Diff Explorer providers.
     */
    public onEventsChanged?: () => void;

    private readonly _readCascadeData: WindsurfCascadeReader;
    /** `vscdbPath → <mtimeMs>:<size>` of the last successful parse. */
    private readonly _stamps = new Map<string, string>();
    /** Databases currently being parsed (deduplicates a batch's sessions). */
    private readonly _pending = new Set<string>();

    constructor(private readonly logService: LogService, options?: WindsurfLogHarvesterOptions) {
        this._readCascadeData = options?.readCascadeData ?? readWindsurfCascadeSessionData;
    }

    /**
     * Parse one workspace database and (re)index its normalized events.
     * Safe to await (tests) and honours the injected Cascade reader.
     */
    async ingestWorkspaceDb(
        vscdbPath: string,
        workspaceId: string,
        workspacePath?: string
    ): Promise<WindsurfHarvestResult> {
        const raw = await this._readCascadeData(vscdbPath);
        if (raw === undefined) {
            return { ingested: 0, errors: [`Cannot read cascade.sessionData from ${vscdbPath}`] };
        }
        const result = await this.logService.ingestWindsurfWorkspaceFile(
            vscdbPath, workspaceId, workspacePath, raw
        );
        this.onEventsChanged?.();
        return result;
    }

    /** Handle a single session-index change event (never throws). */
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
            case 'clear':
                this._stamps.clear();
                break;
            default:
                break;
        }
    }

    /** Number of databases whose parse result is currently cached. */
    get trackedDatabases(): number {
        return this._stamps.size;
    }

    private _ingestSession(session: Session): void {
        if (session.source !== 'windsurf' || !session.filePath) { return; }
        const vscdbPath = session.filePath;
        const stamp = this._stamp(vscdbPath);
        if (stamp !== undefined && this._stamps.get(vscdbPath) === stamp) { return; }
        if (this._pending.has(vscdbPath)) { return; }

        this._pending.add(vscdbPath);
        void this._ingest(vscdbPath, session.workspaceId ?? '', session.workspacePath, stamp).finally(() => {
            this._pending.delete(vscdbPath);
        });
    }

    private async _ingest(
        vscdbPath: string,
        workspaceId: string,
        workspacePath: string | undefined,
        stamp: string | undefined
    ): Promise<void> {
        try {
            const result = await this.ingestWorkspaceDb(vscdbPath, workspaceId, workspacePath);
            if (result.errors.length === 0 && stamp !== undefined) {
                this._stamps.set(vscdbPath, stamp);
            }
        } catch {
            // Never let log harvesting break session indexing.
        }
    }

    /** `<mtimeMs>:<size>` stamp for change detection, when the file is readable. */
    private _stamp(vscdbPath: string): string | undefined {
        try {
            const stat = fs.statSync(vscdbPath);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return undefined;
        }
    }
}
