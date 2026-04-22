import { SessionSource } from '../types/index';

/** Returns a human-readable display name for a session source. */
export function friendlySourceName(source: SessionSource): string {
    switch (source) {
        case 'copilot':      return 'GitHub Copilot';
        case 'claude':       return 'Claude Code';
        case 'cline':        return 'Cline';
        case 'roocode':      return 'Roo Code';
        case 'cursor':       return 'Cursor';
        case 'windsurf':     return 'Windsurf';
        case 'aider':        return 'Aider';
        case 'antigravity':  return 'Google Antigravity';
    }
}

/**
 * Returns the VS Code codicon id (ThemeIcon id) for a session source.
 * Used in places like QuickPick labels and as a fallback icon.
 */
export function sourceCodiconId(source: SessionSource): string {
    switch (source) {
        case 'copilot':      return 'github';
        case 'claude':       return 'hubot';
        case 'cline':        return 'plug';
        case 'roocode':      return 'circuit-board';
        case 'cursor':       return 'sparkle';
        case 'windsurf':     return 'cloud';
        case 'aider':        return 'terminal';
        case 'antigravity':  return 'rocket';
    }
}
