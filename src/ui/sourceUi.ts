import { SessionSource } from '../types/index';

/** Returns a human-readable display name for a session source. */
export function friendlySourceName(source: SessionSource): string {
    switch (source) {
        case 'copilot':           return 'GitHub Copilot';
        case 'claude':            return 'Claude Code';
        case 'cline':             return 'Cline';
        case 'roocode':           return 'Roo Code';
        case 'cursor':            return 'Cursor';
        case 'windsurf':          return 'Windsurf';
        case 'aider':             return 'Aider';
        case 'antigravity':       return 'Google Antigravity';
        case 'continue':          return 'Continue.dev';
        case 'amazonq':           return 'Amazon Q';
        case 'geminiCodeAssist':  return 'Gemini Code Assist';
        case 'zed':               return 'Zed';
        case 'tabnine':           return 'Tabnine';
    }
}

/**
 * Returns the VS Code codicon id (ThemeIcon id) for a session source.
 * Used in places like QuickPick labels and as a fallback icon.
 */
export function sourceCodiconId(source: SessionSource): string {
    switch (source) {
        case 'copilot':           return 'github';
        case 'claude':            return 'hubot';
        case 'cline':             return 'plug';
        case 'roocode':           return 'circuit-board';
        case 'cursor':            return 'sparkle';
        case 'windsurf':          return 'cloud';
        case 'aider':             return 'terminal';
        case 'antigravity':       return 'rocket';
        case 'continue':          return 'play-circle';
        case 'amazonq':           return 'aws';
        case 'geminiCodeAssist':  return 'star';
        case 'zed':               return 'zap';
        case 'tabnine':           return 'symbol-keyword';
    }
}

/**
 * Maps every SessionSource (and unknown strings) to the correct CSS badge class.
 * Use `sourceBadgeClass(source)` for a safe lookup with fallback.
 */
export const SOURCE_BADGE_CLASS: Record<string, string> = {
    copilot:          'cw-badge-copilot',
    claude:           'cw-badge-claude',
    antigravity:      'cw-badge-antigravity',
    cursor:           'cw-badge-cursor',
    cline:            'cw-badge-cline',
    roocode:          'cw-badge-roocode',
    windsurf:         'cw-badge-windsurf',
    aider:            'cw-badge-aider',
    continue:         'cw-badge-continue',
    amazonq:          'cw-badge-amazonq',
    geminiCodeAssist: 'cw-badge-geminiCodeAssist',
    zed:              'cw-badge-zed',
    tabnine:          'cw-badge-tabnine',
};

/** Returns the CSS badge class for a source, falling back to cw-badge-claude for unknowns. */
export function sourceBadgeClass(source: string): string {
    return SOURCE_BADGE_CLASS[source] ?? 'cw-badge-claude';
}
