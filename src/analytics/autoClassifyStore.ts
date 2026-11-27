// src/analytics/autoClassifyStore.ts
// Persists the automatic chat-history classifier's run state.
//
// The classified tree itself lives in its own FolderStore file
// (`chatwizard-auto-folders.json`); this file only records what the last run
// saw, so later runs can skip work when the chat history has not meaningfully
// changed.

import * as fs from 'fs';
import * as path from 'path';
import type { AutoTreeAmendments } from './autoTreeReconciler';

const STATE_FILENAME = 'chatwizard-auto-classify.json';

/** Per-root-folder summary shown by the Sessions view tooltip. */
export interface AutoClassifyCategorySummary {
    /** Root folder name. */
    name: string;
    /** Sessions placed in this root folder (including its subfolders). */
    sessionCount: number;
    /** Number of second-level folders created under this root. */
    subcategoryCount: number;
}

/** Everything the arranger needs to decide whether to re-run. */
export interface AutoClassifyState {
    /** Schema version — bump when the shape changes. */
    version: number;
    /** ISO-8601 timestamp of the last completed run. */
    lastRunAt: string;
    /** Fingerprint of the chat history the last run classified. */
    fingerprint: string;
    /** Number of sessions the last run classified. */
    sessionCount: number;
    /** Category cap used by the last run. */
    categoryCount: number;
    /** Label depth used by the last run. */
    maxDepth: number;
    /** Whether the free model produced at least one label in the last run. */
    usedLlm: boolean;
    /** Root folders produced by the last run. */
    categories: AutoClassifyCategorySummary[];
    /**
     * User amendments layered on top of the classification (manually created /
     * renamed / moved folders, manually placed sessions, deleted folders).
     */
    amendments?: AutoTreeAmendments;
    /** Revision of the shared classification the last run rendered. */
    classificationRevision?: number;
}

/** Current state schema version. */
export const AUTO_CLASSIFY_STATE_VERSION = 1;

/**
 * Small JSON store for the arranger's run state, kept next to the folder file
 * in the extension's global storage directory.
 */
export class AutoClassifyStore {
    private readonly filePath: string;

    constructor(storageDir: string) {
        this.filePath = path.join(storageDir, STATE_FILENAME);
    }

    /** Loads the persisted state, or `null` when absent/corrupt. Never throws. */
    async load(): Promise<AutoClassifyState | null> {
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as AutoClassifyState;
            if (!parsed || typeof parsed !== 'object' || parsed.version !== AUTO_CLASSIFY_STATE_VERSION) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    /** Writes the state atomically (temp file + rename). Never throws. */
    async save(state: AutoClassifyState): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            const tmpPath = this.filePath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (err) {
            console.error('[chatwizard] AutoClassifyStore.save() failed:', err);
        }
    }

    /** Deletes the persisted state. Never throws. */
    async clear(): Promise<void> {
        try {
            await fs.promises.unlink(this.filePath);
        } catch {
            // Ignore — nothing to clear
        }
    }
}
