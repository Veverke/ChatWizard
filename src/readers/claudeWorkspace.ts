// src/readers/claudeWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import { ScopedWorkspace } from '../types/index';
import { resolveClaudeProjectsPath } from '../watcher/configPaths';

/**
 * Decodes a Claude project directory name back to a human-readable workspace path.
 *
 * Claude CLI encodes the workspace root path by replacing all path separators (/ \)
 * and colons (:) with dashes (-). The drive letter (Windows) is lowercased.
 *
 * Examples:
 *   "c--Repos-Personal-ChatWizard"  →  "C:\Repos\Personal\ChatWizard"  (Windows)
 *   "-home-user-projects-foo"       →  "/home/user/projects/foo"        (Unix)
 *
 * Returns undefined if the directory name does not match a known pattern.
 */
export function resolveClaudeWorkspacePath(dirName: string): string | undefined {
    if (!dirName || typeof dirName !== 'string') {
        return undefined;
    }

    // Windows: single lowercase letter followed by '--', e.g. "c--Repos-Personal-Foo"
    const winMatch = /^([a-z])--(.+)$/.exec(dirName);
    if (winMatch) {
        const drive = winMatch[1].toUpperCase();
        const rest = winMatch[2].replace(/-/g, '\\');
        return `${drive}:\\${rest}`;
    }

    // Unix: leading '-' represents the root '/'
    if (dirName.startsWith('-')) {
        return '/' + dirName.slice(1).replace(/-/g, '/');
    }

    return undefined;
}

/**
 * Scans the Claude projects directory and returns a `ScopedWorkspace` for each
 * project directory whose name can be decoded to a valid workspace path.
 *
 * @param override  Optional path override (used in tests); falls back to config / default.
 */
export async function discoverClaudeWorkspacesAsync(override?: string): Promise<ScopedWorkspace[]> {
    const claudeProjectsDir = resolveClaudeProjectsPath(override);

    try {
        let exists = false;
        try {
            exists = (await fs.promises.stat(claudeProjectsDir)).isDirectory();
        } catch { /* not found */ }

        if (!exists) { return []; }

        const entries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true });
        const results: ScopedWorkspace[] = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }

            const workspacePath = resolveClaudeWorkspacePath(entry.name);
            if (workspacePath === undefined) { continue; }

            results.push({
                id: entry.name,
                source: 'claude',
                workspacePath,
                storageDir: path.join(claudeProjectsDir, entry.name),
            });
        }

        return results;
    } catch {
        return [];
    }
}
