// src/telemetry/telemetryRecorder.ts
//
// Local-only, opt-in telemetry recorder.
// Events are written as JSONL to a file in the extension's global storage directory.
// No data ever leaves the machine. Gated behind the chatwizard.enableTelemetry setting.
//
// RECORDED FIELDS (SEC-8 audit):
//   • event   — event name string (e.g. 'extension.activated', 'session.opened')
//   • timestamp — ISO-8601 UTC timestamp generated locally
//   • properties — caller-supplied key/value pairs; callers MUST NOT pass:
//       - file system paths (use relative or hashed paths if needed)
//       - usernames, machine names, or any PII
//       - session IDs or workspace IDs verbatim (hash if required for correlation)
//
// ROTATION (SEC-8):
//   Rotation runs automatically in rotate() when:
//     a) The log file exceeds MAX_LOG_BYTES (1 MB), or
//     b) Any event's timestamp is older than MAX_LOG_AGE_DAYS (30) days.
//   On rotation the file is replaced with only the surviving recent entries.

import * as fs from 'fs';
import * as path from 'path';

// SEC-8: Rotation thresholds
const MAX_LOG_BYTES = 1_000_000;   // 1 MB
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

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

    /** Enable or disable telemetry recording. Rotation runs when enabling. */
    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
        // SEC-8: rotate on enable to discard entries older than MAX_LOG_AGE_DAYS and
        // trim oversized log files before any new events are written.
        if (enabled) { this.rotate(); }
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
     * Rotate the telemetry log.
     * Reads all events, discards any older than MAX_LOG_AGE_DAYS, and rewrites the file
     * when either the age limit was exceeded or the file is larger than MAX_LOG_BYTES.
     * Swallows all errors — telemetry must never crash the extension.
     *
     * SEC-8: prevents unbounded log growth and retains no data older than 30 days.
     */
    rotate(): void {
        try {
            let stat: fs.Stats;
            try { stat = fs.statSync(this.filePath); } catch { return; } // file does not exist

            const needsRotation = stat.size > MAX_LOG_BYTES;
            const cutoff = Date.now() - MAX_LOG_AGE_MS;

            const content = fs.readFileSync(this.filePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);

            let hadOld = false;
            const surviving = lines.filter(line => {
                try {
                    const entry = JSON.parse(line) as TelemetryEvent;
                    if (Date.parse(entry.timestamp) < cutoff) {
                        hadOld = true;
                        return false;
                    }
                    return true;
                } catch {
                    return false; // drop corrupt lines
                }
            });

            if (needsRotation || hadOld || surviving.length < lines.length) {
                fs.writeFileSync(this.filePath, surviving.map(l => l.trim()).join('\n') + (surviving.length > 0 ? '\n' : ''), 'utf8');
            }
        } catch {
            // Swallow — telemetry must never crash the extension.
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
