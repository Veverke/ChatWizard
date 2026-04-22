// src/watcher/configPaths.ts
import * as path from 'path';
import * as os from 'os';
import { getClineStorageRoot, getRooCodeStorageRoot } from '../readers/clineWorkspace';
import { getCursorStorageRoot } from '../readers/cursorWorkspace';
import { getWindsurfStorageRoot } from '../readers/windsurfWorkspace';
import { getAntigravityBrainRoot } from '../readers/antigravityWorkspace';

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

/**
 * Resolve the Cline (saoudrizwan.claude-dev) tasks directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.clineStoragePath` (if non-empty)
 *   3. Default: platform-specific globalStorage path for saoudrizwan.claude-dev/tasks
 */
export function resolveClineStoragePath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('clineStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return getClineStorageRoot();
}

/**
 * Resolve the Roo Code (rooveterinaryinc.roo-cline) tasks directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.rooCodeStoragePath` (if non-empty)
 *   3. Default: platform-specific globalStorage path for rooveterinaryinc.roo-cline/tasks
 */
export function resolveRooCodeStoragePath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('rooCodeStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return getRooCodeStorageRoot();
}

/**
 * Resolve the Cursor workspaceStorage directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.cursorStoragePath` (if non-empty)
 *   3. Default: platform-specific Cursor/User/workspaceStorage path
 */
export function resolveCursorStoragePath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('cursorStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return getCursorStorageRoot();
}

/**
 * Resolve the Windsurf workspaceStorage directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.windsurfStoragePath` (if non-empty)
 *   3. Default: platform-specific Windsurf/User/workspaceStorage path
 */
export function resolveWindsurfStoragePath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('windsurfStoragePath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return getWindsurfStorageRoot();
}

/**
 * Resolve the Antigravity brain directory.
 *
 * Priority:
 *   1. `override` argument
 *   2. VS Code setting `chatwizard.antigravityBrainPath` (if non-empty)
 *   3. Default: `~/.gemini/antigravity/brain`
 */
export function resolveAntigravityBrainPath(override?: string): string {
    if (override !== undefined && override !== '') {
        return override;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const configured = cfg.get<string>('antigravityBrainPath');
        if (configured && configured !== '') {
            return configured;
        }
    } catch {
        // Not running in VS Code extension host — use default.
    }
    return getAntigravityBrainRoot();
}
