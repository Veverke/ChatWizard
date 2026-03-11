// src/watcher/configPaths.ts
import * as path from 'path';
import * as os from 'os';

/**
 * Resolve the Claude Code projects directory.
 *
 * Priority:
 *   1. `override` argument (used in tests and when the caller already has the value)
 *   2. VS Code setting `chatwizard.claudeProjectsPath` (if non-empty)
 *   3. Default: `~/.claude/projects`
 */
export function resolveClaudeProjectsPath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('claudeProjectsPath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host (e.g. unit tests) — use default.
    }
    return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Resolve the Copilot Chat workspace storage directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.copilotStoragePath` (if non-empty)
 *   3. Default: `%APPDATA%/Code/User/workspaceStorage` (Windows) or `~/.config/Code/User/workspaceStorage`
 */
export function resolveCopilotStoragePath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('copilotStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), '.config');
    return path.join(appData, 'Code', 'User', 'workspaceStorage');
}
