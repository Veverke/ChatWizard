// src/utils/fileAnchorResolver.ts
// Resolves relative or basename-only file references to absolute paths
// that VS Code can open with stream.anchor().
//
// Feature 14: Clickable File Links in Chat Participant responses

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Attempts to resolve `ref` to an absolute file path that exists on disk.
 *
 * Resolution order:
 *  1. If `ref` is already absolute and exists → return it
 *  2. Join with each workspace folder root
 *  3. Join with `repoRoot` if provided
 *  4. Use VS Code workspace `findFiles` glob for basename match (async)
 *
 * Returns `undefined` if no existing file is found.
 */
export async function resolveAnchorPath(
    ref: string,
    repoRoot?: string,
): Promise<string | undefined> {
    if (!ref || typeof ref !== 'string') { return undefined; }

    // 1. Already absolute
    if (path.isAbsolute(ref)) {
        if (safeExists(ref)) { return ref; }
        return undefined;
    }

    // 2. Workspace folder roots
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const candidate = path.join(folder.uri.fsPath, ref);
        if (safeExists(candidate)) { return candidate; }
    }

    // 3. Repo root
    if (repoRoot) {
        const candidate = path.join(repoRoot, ref);
        if (safeExists(candidate)) { return candidate; }
    }

    // 4. Basename glob search (only if ref looks like a file, not a directory)
    if (path.extname(ref)) {
        const basename = path.basename(ref);
        try {
            const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 3);
            if (found.length === 1) { return found[0].fsPath; }
        } catch { /* workspace may not be open */ }
    }

    return undefined;
}

function safeExists(p: string): boolean {
    try { return fs.existsSync(p); } catch { return false; }
}

/**
 * Resolves an array of file references concurrently.
 * Returns only those that were successfully resolved.
 */
export async function resolveAnchorPaths(
    refs: string[],
    repoRoot?: string,
): Promise<Array<{ ref: string; absPath: string }>> {
    const results = await Promise.all(
        refs.map(async ref => {
            const absPath = await resolveAnchorPath(ref, repoRoot);
            return absPath ? { ref, absPath } : null;
        }),
    );
    return results.filter((r): r is { ref: string; absPath: string } => r !== null);
}
