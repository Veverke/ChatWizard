/**
 * test/helpers/fsCleanup.ts
 *
 * Best-effort temp-folder cleanup for the VS Code test runner.
 *
 * On Windows a folder that a just-finished test wrote to can still be locked
 * when the teardown runs — the antivirus scanner, the Search indexer or a file
 * watcher that has not released its handle yet. `fs.rmSync` then throws
 * `ENOTEMPTY` / `EPERM` / `EBUSY`, and an otherwise green test fails in its
 * "after each" hook (this is what made CI red on the e2e job).
 *
 * Every directory passed here is disposable and lives under the OS temp dir, so
 * cleanup is best effort: retry a few times, then let the OS reclaim the folder
 * instead of failing the run.
 */

import * as fs from 'fs';

/**
 * Delete `dir` recursively, tolerating transient Windows file locks.
 *
 * @param dir Folder to remove. `undefined` / empty values are ignored so callers
 *            can pass an optional field without a guard.
 */
export function removeTempDir(dir: string | undefined): void {
    if (!dir) { return; }
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch { /* temp folder — safe to leave behind */ }
}
