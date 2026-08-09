// src/analytics/kbStore.ts
// Feature 23 — Persists KbEngineResult to disk so KB survives VS Code reloads.
// Stored per-workspace in context.storageUri.

import * as fs from 'fs';
import * as path from 'path';
import type { KbEntry, KbEntryType } from '../types/kb';
import type { KbEngineResult } from './kbEngine';

const KB_FILENAME = 'chatwizard-kb.json';

interface KbStoreData {
    entries: KbEntry[];
    grouped: Record<string, KbEntry[]>;
    total: number;
    usedLlm: boolean;
    topLevelGrouping: Record<string, string[]> | null;
}

export class KbStore {
    private readonly filePath: string;

    constructor(storageDir: string) {
        this.filePath = path.join(storageDir, KB_FILENAME);
    }

    /**
     * Load a persisted KbEngineResult from disk.
     * Returns null if no persisted data exists or it cannot be read.
     */
    async load(): Promise<KbEngineResult | null> {
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const data: KbStoreData = JSON.parse(raw);

            // Reconstruct Map types
            const grouped = new Map<KbEntryType, KbEntry[]>();
            for (const [key, entries] of Object.entries(data.grouped)) {
                grouped.set(key, entries);
            }

            let topLevelGrouping: Map<string, string[]> | null = null;
            if (data.topLevelGrouping) {
                topLevelGrouping = new Map(Object.entries(data.topLevelGrouping));
            }

            return {
                entries: data.entries,
                grouped,
                total: data.total,
                usedLlm: data.usedLlm,
                topLevelGrouping,
            };
        } catch {
            return null;
        }
    }

    /**
     * Persist a KbEngineResult to disk (atomic write via temp file + rename).
     */
    async save(result: KbEngineResult): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

            // Convert Map types to plain objects for JSON serialization
            const grouped: Record<string, KbEntry[]> = {};
            for (const [key, entries] of result.grouped) {
                grouped[key] = entries;
            }

            let topLevelGrouping: Record<string, string[]> | null = null;
            if (result.topLevelGrouping) {
                topLevelGrouping = Object.fromEntries(result.topLevelGrouping);
            }

            const data: KbStoreData = {
                entries: result.entries,
                grouped,
                total: result.total,
                usedLlm: result.usedLlm,
                topLevelGrouping,
            };

            const tmpPath = this.filePath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (err) {
            console.error('[chatwizard] KbStore.save() failed:', err);
        }
    }

    /**
     * Delete the persisted KB file.
     */
    async clear(): Promise<void> {
        try {
            await fs.promises.unlink(this.filePath);
        } catch {
            // Ignore if file doesn't exist
        }
    }
}