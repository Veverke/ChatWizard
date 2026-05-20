// src/readers/geminiCodeAssistWorkspace.ts
// Discovers Gemini Code Assist (google.google-cloud-code / google.cloudcode) session files.
//
// Gemini Code Assist is the Google-managed VS Code extension that replaced the
// Cloud Code AI features. It stores conversations under VS Code's globalStorage.
//
// Known extension IDs (both are used in different builds):
//   - google.google-cloud-code
//   - google.cloudcode
//
// Note: This is DISTINCT from Google Antigravity (CLI tool stored under ~/.gemini/).
// We only target the VS Code extension's globalStorage, not the Antigravity CLI paths.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GEMINI_EXTENSION_IDS = [
    'google.google-cloud-code',
    'google.cloudcode',
    'google.gemini-code-assist',
    'google-cloud.cloudcode',
];

function getGeminiCandidateDirs(): string[] {
    const dirs: string[] = [];
    const home = os.homedir();

    // Windows
    const appData = process.env['APPDATA'];
    if (appData) {
        for (const vsVariant of ['Code', 'Code - Insiders']) {
            for (const extId of GEMINI_EXTENSION_IDS) {
                dirs.push(path.join(appData, vsVariant, 'User', 'globalStorage', extId));
            }
        }
    }

    // macOS
    const macBase = path.join(home, 'Library', 'Application Support');
    for (const vsVariant of ['Code', 'Code - Insiders']) {
        for (const extId of GEMINI_EXTENSION_IDS) {
            dirs.push(path.join(macBase, vsVariant, 'User', 'globalStorage', extId));
        }
    }

    // Linux
    for (const vsVariant of ['Code', 'code-insiders']) {
        for (const extId of GEMINI_EXTENSION_IDS) {
            dirs.push(path.join(home, '.config', vsVariant, 'User', 'globalStorage', extId));
        }
    }

    return dirs;
}

export function getGeminiCodeAssistStorageRoot(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('geminiCodeAssistStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch { /* not in extension host */ }

    for (const dir of getGeminiCandidateDirs()) {
        try {
            if (fs.statSync(dir).isDirectory()) {
                return dir;
            }
        } catch { /* not found */ }
    }

    // Return default even if absent
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), '.config');
    return path.join(appData, 'Code', 'User', 'globalStorage', GEMINI_EXTENSION_IDS[0]);
}

/**
 * Discovers Gemini Code Assist conversation files under the extension's globalStorage.
 * Returns absolute file paths.
 */
export async function discoverGeminiCodeAssistSessionFilesAsync(override?: string): Promise<string[]> {
    const storageRoot = getGeminiCodeAssistStorageRoot(override);
    const results: string[] = [];

    const subDirs = ['conversations', 'history', 'chat', 'sessions', ''];

    for (const sub of subDirs) {
        const dir = sub ? path.join(storageRoot, sub) : storageRoot;
        try {
            const exists = (await fs.promises.stat(dir)).isDirectory();
            if (!exists) { continue; }

            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) { continue; }
                if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) { continue; }
                results.push(path.join(dir, entry.name));
            }
        } catch { /* directory not found */ }
    }

    return results;
}
