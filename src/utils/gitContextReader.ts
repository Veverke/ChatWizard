// src/utils/gitContextReader.ts
// Feature 25 — Git/Branch Linkage

import { execFile } from 'child_process';
import type { GitContext } from '../types/index';

const GIT_TIMEOUT_MS = 2000;

/**
 * Execute a git command in the given working directory.
 * Resolves with stdout (trimmed), or rejects on error / timeout.
 */
function runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout.trim());
        });
        // Additional safety: reject if the process hangs
        proc.on('error', reject);
    });
}

/**
 * Read the current git branch and HEAD commit for the given workspace path.
 *
 * - Executes `git rev-parse --abbrev-ref HEAD` for the branch name.
 * - Executes `git rev-parse --short HEAD` for the short commit SHA.
 * - Returns `undefined` gracefully when:
 *     - The path is not a git repository.
 *     - The git binary is not installed.
 *     - The subprocess times out (> 2 seconds).
 *
 * Never throws — all errors are caught and result in `undefined`.
 */
export async function readGitContextAsync(workspacePath: string): Promise<GitContext | undefined> {
    if (!workspacePath) { return undefined; }

    try {
        const [branch, headCommit] = await Promise.all([
            runGit(['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'], workspacePath),
            runGit(['-C', workspacePath, 'rev-parse', '--short', 'HEAD'], workspacePath).catch(() => undefined),
        ]);

        if (!branch || branch === 'HEAD') {
            // Detached HEAD — no branch name available
            return headCommit ? { branch: '(detached HEAD)', headCommit, repoRoot: workspacePath } : undefined;
        }

        return {
            branch,
            headCommit: headCommit ?? undefined,
            repoRoot: workspacePath,
        };
    } catch {
        // Not a git repo, git not installed, or timed out — return undefined gracefully
        return undefined;
    }
}

/**
 * Simple in-memory cache for git context results.
 * Caches results per workspace path for a configurable TTL (default: 5 minutes).
 * Avoids repeated subprocess calls when multiple sessions share the same workspace.
 */
export class GitContextCache {
    private readonly _cache = new Map<string, { context: GitContext | undefined; expiresAt: number }>();
    private readonly _ttlMs: number;

    constructor(ttlMs = 5 * 60_000) {
        this._ttlMs = ttlMs;
    }

    async getOrFetch(workspacePath: string): Promise<GitContext | undefined> {
        const now = Date.now();
        const cached = this._cache.get(workspacePath);
        if (cached && now < cached.expiresAt) {
            return cached.context;
        }
        const context = await readGitContextAsync(workspacePath);
        this._cache.set(workspacePath, { context, expiresAt: now + this._ttlMs });
        return context;
    }

    /** Remove a specific entry (e.g. after a git operation). */
    invalidate(workspacePath: string): void {
        this._cache.delete(workspacePath);
    }

    /** Clear all cached entries. */
    clear(): void {
        this._cache.clear();
    }
}