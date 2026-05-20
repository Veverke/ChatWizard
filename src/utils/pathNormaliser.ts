// src/utils/pathNormaliser.ts
// Normalises file paths for consistent comparison across OS and case differences.
//
// Feature 10: File-Centric History

import * as path from 'path';
import * as fs from 'fs';

/**
 * Normalises a file path for consistent comparison:
 *   - Resolves `.` and `..` segments
 *   - Converts backslashes to forward slashes
 *   - On Windows: lowercases the drive letter (e.g. `C:/` → `c:/`)
 *   - Attempts `fs.realpathSync` for symlink resolution (best-effort, no throw)
 */
export function normalisePath(p: string): string {
    if (!p || typeof p !== 'string') { return ''; }

    // Best-effort realpath (resolves symlinks and makes path absolute)
    try {
        p = fs.realpathSync(p);
    } catch {
        // File may not exist yet — fall through to heuristic normalisation
        p = path.resolve(p);
    }

    // Forward slashes
    let normalised = p.replace(/\\/g, '/');

    // Lowercase drive letter on Windows (e.g. "C:/" → "c:/")
    normalised = normalised.replace(/^([A-Z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`);

    return normalised;
}

/**
 * Returns true when two paths refer to the same file after normalisation.
 */
export function isSamePath(a: string, b: string): boolean {
    return normalisePath(a) === normalisePath(b);
}

/**
 * Checks whether a session's importantFiles (already normalised) contains the
 * given normalised query path.
 */
export function sessionTouchesFile(
    importantFiles: string[] | undefined,
    normalisedQueryPath: string,
): boolean {
    if (!importantFiles || importantFiles.length === 0) { return false; }
    return importantFiles.some(f => normalisePath(f) === normalisedQueryPath);
}

/**
 * Checks whether any entry in `filePaths` (typically entity-extracted, possibly
 * relative) refers to the same file as `normalisedQueryPath`.
 *
 * Uses suffix matching so that a short extracted path like `docs/intent.md`
 * matches an absolute query like `c:/_/chatwizard/docs/intent.md`.
 * The candidate path is normalised and then tested as an exact match first,
 * falling back to checking whether the query path ends with `/<candidate>`.
 *
 * Minimum segment requirement: the candidate must contain at least one path
 * separator to avoid spurious matches on bare filenames like `index.ts`.
 */
export function sessionMentionsFile(
    filePaths: string[] | undefined,
    normalisedQueryPath: string,
): boolean {
    if (!filePaths || filePaths.length === 0) { return false; }
    return filePaths.some(f => {
        const norm = normalisePath(f);
        if (!norm) { return false; }
        if (norm === normalisedQueryPath) { return true; }
        // Suffix match: only for paths containing a separator (avoid bare `index.ts`)
        if (!norm.includes('/')) { return false; }
        return normalisedQueryPath.endsWith('/' + norm);
    });
}
