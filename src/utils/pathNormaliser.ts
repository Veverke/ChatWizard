// src/utils/pathNormaliser.ts
// Normalises file paths for consistent comparison across OS and case differences.
//
// Feature 10: File-Centric History

import * as path from 'path';
import * as fs from 'fs';

/**
 * Cheap normalisation — resolves `.`/`..` via `path.resolve`, converts
 * backslashes to forward slashes, and lowercases the drive letter.
 * Does NOT perform synchronous disk I/O (no `fs.realpathSync`).
 * Suitable for bulk comparisons inside loops over many sessions/paths.
 */
export function cheapNormalisePath(p: string): string {
    if (!p || typeof p !== 'string') { return ''; }
    let normalised = path.resolve(p).replace(/\\/g, '/');
    normalised = normalised.replace(/^([A-Z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`);
    return normalised;
}

/**
 * Normalises a file path for consistent comparison:
 *   - Resolves `.` and `..` segments
 *   - Converts backslashes to forward slashes
 *   - On Windows: lowercases the drive letter (e.g. `C:/` → `c:/`)
 *   - Attempts `fs.realpathSync` for symlink resolution (best-effort, no throw)
 *
 * Prefer `cheapNormalisePath` for bulk comparisons inside loops;
 * use this only when symlink resolution is explicitly required.
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
 * Uses cheapNormalisePath for per-entry normalisation to avoid repeated disk I/O.
 */
export function sessionTouchesFile(
    importantFiles: string[] | undefined,
    normalisedQueryPath: string,
): boolean {
    if (!importantFiles || importantFiles.length === 0) { return false; }
    return importantFiles.some(f => cheapNormalisePath(f) === normalisedQueryPath);
}

/**
 * Checks whether any entry in `filePaths` (typically entity-extracted, possibly
 * relative) refers to the same file as `normalisedQueryPath`.
 *
 * Three tiers of matching (in order):
 *  1. Exact match after full normalisation (handles absolute Chronicle paths).
 *  2. Suffix match for multi-segment relative paths (e.g. `docs/intent.md`
 *     matches the end of `c:/_/chatwizard/docs/intent.md`).
 *  3. Basename match for bare filenames (e.g. `intent.md` matches the filename
 *     of `c:/_/chatwizard/docs/intent.md`). This tier is intentionally fuzzy
 *     and may produce false positives for generic names like `index.ts`.
 */
export function sessionMentionsFile(
    filePaths: string[] | undefined,
    normalisedQueryPath: string,
): boolean {
    if (!filePaths || filePaths.length === 0) { return false; }
    const queryBasename = normalisedQueryPath.split('/').pop() ?? '';
    return filePaths.some(f => {
        if (!f) { return false; }
        // Normalise separators without calling full realpathSync on relative paths
        const candidate = f.replace(/\\/g, '/').toLowerCase();
        // 1. Exact match
        if (normalisePath(f) === normalisedQueryPath) { return true; }
        // 2. Suffix match for multi-segment paths like 'docs/intent.md'
        if (candidate.includes('/') && normalisedQueryPath.endsWith('/' + candidate)) { return true; }
        // 3. Basename match for bare filenames like 'intent.md'
        const candidateBasename = candidate.split('/').pop() ?? '';
        return candidateBasename === queryBasename.toLowerCase();
    });
}
