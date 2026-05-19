// src/readers/antigravityWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AntigravityConversationInfo, AntigravityJsonConversationInfo } from '../types/index';

// ─── Storage root ─────────────────────────────────────────────────────────────

/**
 * Resolves the Antigravity brain directory cross-platform.
 *
 * All platforms:  ~/.gemini/antigravity/brain
 */
export function getAntigravityBrainRoot(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Scans the Antigravity brain directory and returns an `AntigravityConversationInfo`
 * for every conversation that has a readable `overview.txt` log file.
 *
 * Storage layout:
 *   ~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/overview.txt
 *
 * @param override  Override the brain root (for tests or user config).
 */
export async function discoverAntigravityConversationsAsync(
    override?: string
): Promise<AntigravityConversationInfo[]> {
    const brainRoot = (override !== undefined && override !== '') ? override : getAntigravityBrainRoot();

    let entries: string[];
    try {
        entries = await fs.promises.readdir(brainRoot);
    } catch {
        // Directory does not exist or is not readable.
        return [];
    }

    const results = await Promise.all(entries.map(async (entry): Promise<AntigravityConversationInfo | null> => {
        const conversationDir = path.join(brainRoot, entry);

        // Must be a real directory (not a symlink) — SEC-6 symlink guard.
        try {
            const lstat = await fs.promises.lstat(conversationDir);
            if (!lstat.isDirectory() || lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        const overviewFile = path.join(
            conversationDir,
            '.system_generated',
            'logs',
            'overview.txt'
        );

        // Must have a readable overview.txt (not symlinked).
        try {
            const lstat = await fs.promises.lstat(overviewFile);
            if (!lstat.isFile() || lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        return {
            conversationId: entry,
            overviewFile,
        };
    }));

    return results.filter((r): r is AntigravityConversationInfo => r !== null);
}

// ─── JSON conversations/ discovery ────────────────────────────────────────────

const MAX_JSON_CONVERSATIONS = 10_000;

/**
 * Resolves the Antigravity conversations directory: ~/.gemini/antigravity/conversations
 */
export function getAntigravityConversationsRoot(override?: string): string {
    if (override !== undefined && override !== '') { return override; }
    return path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
}

/**
 * Scans the Antigravity conversations directory and returns an
 * `AntigravityJsonConversationInfo` for each `.json` file found.
 *
 * Storage layout:
 *   ~/.gemini/antigravity/conversations/<uuid>.json
 *
 * Applies the same symlink guard as `discoverAntigravityConversationsAsync`.
 * Caps at 10,000 files with a warning logged to stderr.
 *
 * @param override  Override the conversations root (for tests or user config).
 */
export async function discoverAntigravityJsonConversationsAsync(
    override?: string
): Promise<AntigravityJsonConversationInfo[]> {
    const conversationsRoot = getAntigravityConversationsRoot(override);

    let entries: string[];
    try {
        entries = await fs.promises.readdir(conversationsRoot);
    } catch {
        return [];
    }

    const jsonFiles = entries.filter(e => e.endsWith('.json'));
    if (jsonFiles.length > MAX_JSON_CONVERSATIONS) {
        console.warn(`[chatwizard] Antigravity conversations/ has ${jsonFiles.length} files; capping at ${MAX_JSON_CONVERSATIONS}.`);
    }
    const capped = jsonFiles.slice(0, MAX_JSON_CONVERSATIONS);

    const results = await Promise.all(capped.map(async (filename): Promise<AntigravityJsonConversationInfo | null> => {
        const jsonFile = path.join(conversationsRoot, filename);

        // SEC-6: symlink guard — must be a real file.
        try {
            const lstat = await fs.promises.lstat(jsonFile);
            if (!lstat.isFile() || lstat.isSymbolicLink()) { return null; }
        } catch {
            return null;
        }

        const conversationId = path.basename(filename, '.json');
        return { conversationId, jsonFile };
    }));

    return results.filter((r): r is AntigravityJsonConversationInfo => r !== null);
}
