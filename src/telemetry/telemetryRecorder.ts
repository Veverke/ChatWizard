// src/telemetry/telemetryRecorder.ts
//
// Local-only, opt-in telemetry recorder.
// Events are written as JSONL to a file in the extension's global storage directory.
// No data ever leaves the machine. Gated behind the chatwizard.enableTelemetry setting.

import * as fs from 'fs';
import * as path from 'path';

/** A single recorded telemetry event. */
export interface TelemetryEvent {
    event: string;
    timestamp: string;
    properties?: Record<string, string | number | boolean>;
}

/**
 * Records telemetry events to a local JSONL file.
 * All writes are synchronous and swallow errors silently
 * (telemetry must never crash the extension).
 */
export class TelemetryRecorder {
    private readonly filePath: string;
    private _enabled = false;

    /**
     * @param storagePath  The directory where the telemetry JSONL file will be written.
     *                     Typically `context.globalStoragePath` from the VS Code extension context.
     */
    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'telemetry.jsonl');
    }

    /** Whether telemetry recording is currently enabled. */
    get enabled(): boolean {
        return this._enabled;
    }

    /** Enable or disable telemetry recording. */
    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
    }

    /**
     * Record a telemetry event.
     * Does nothing if telemetry is disabled.
     * Swallows any filesystem errors silently.
     *
     * @param event       Event name (e.g. 'extension.activated', 'session.opened').
     * @param properties  Optional key/value properties to attach.
     */
    record(event: string, properties?: Record<string, string | number | boolean>): void {
        if (!this._enabled) {
            return;
        }
        const entry: TelemetryEvent = {
            event,
            timestamp: new Date().toISOString(),
            ...(properties !== undefined ? { properties } : {}),
        };
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
        } catch {
            // Swallow silently — telemetry must never crash the extension.
        }
    }

    /**
     * Read all previously recorded events from the local JSONL file.
     * Returns an empty array if the file does not exist or cannot be read.
     * Lines that fail to parse as JSON are silently skipped.
     */
    getEvents(): TelemetryEvent[] {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            return content
                .split('\n')
                .filter(line => line.trim().length > 0)
                .flatMap(line => {
                    try {
                        return [JSON.parse(line) as TelemetryEvent];
                    } catch {
                        return [];
                    }
                });
        } catch {
            return [];
        }
    }

    /**
     * Delete the telemetry file, clearing all recorded events.
     * Silently ignores errors (e.g. file not found).
     */
    clear(): void {
        try {
            fs.unlinkSync(this.filePath);
        } catch {
            // File may not exist — ignore.
        }
    }

    /** The full path to the telemetry JSONL file. Exposed for testing. */
    get logFilePath(): string {
        return this.filePath;
    }
}
