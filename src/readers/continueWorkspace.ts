// src/readers/continueWorkspace.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Returns the default Continue.dev sessions directory for the current platform.
 * Continue.dev stores conversations at ~/.continue/sessions/ on all platforms.
 */
export function getContinueSessionsRoot(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('continueStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return path.join(os.homedir(), '.continue', 'sessions');
}

/**
 * Discovers Continue.dev session JSONL files.
 * Returns a list of absolute file paths.
 */
export async function discoverContinueSessionFilesAsync(override?: string): Promise<string[]> {
    const sessionsDir = getContinueSessionsRoot(override);

    try {
        let exists = false;
        try {
            exists = (await fs.promises.stat(sessionsDir)).isDirectory();
        } catch { /* not found */ }

        if (!exists) { return []; }

        const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
        const results: string[] = [];

        for (const entry of entries) {
            if (!entry.isFile()) { continue; }
            if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) { continue; }
            results.push(path.join(sessionsDir, entry.name));
        }

        return results;
    } catch {
        return [];
    }
}
