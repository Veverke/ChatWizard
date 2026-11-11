/**
 * src/logs/logSourceRegistry.ts
 *
 * Phase 1 — Basic log source registry.
 *
 * A static, declarative description of each AI tool's agent-execution log
 * source: where the logs live, what file shapes to look for, and which
 * `chatwizard.*` setting gates the source. Phase 2 adapters consume this
 * config to implement discovery + parsing; nothing in Phase 1 reads the
 * actual log files.
 *
 * Config-only design keeps the registry trivially testable and lets users
 * opt out of a source via the same settings that already gate session
 * indexing (chatwizard.indexCursor, chatwizard.indexCline, …).
 */

import * as path from 'path';
import { getAntigravityBrainRoot } from '../readers/antigravityWorkspace';
import { getCursorStorageRoot } from '../readers/cursorWorkspace';
import { getWindsurfStorageRoot } from '../readers/windsurfWorkspace';
import { getClineStorageRoot, getRooCodeStorageRoot } from '../readers/clineWorkspace';
import { getWorkspaceStorageRoots } from '../readers/copilotWorkspace';
import { LogSourceTool } from './types';

/** On-disk shape of a source's agent-execution logs. */
export type LogFileFormat = 'jsonl' | 'json' | 'text' | 'markdown' | 'sqlite';

/** Static description of one AI-tool log source. */
export interface LogSourceConfig {
    /** Tool id — matches `SessionSource` for cross-layer correlation. */
    tool: LogSourceTool;
    /** Human-readable name shown in future UI + diagnostics. */
    displayName: string;
    /** Primary on-disk format of the tool's execution logs. */
    format: LogFileFormat;
    /** Glob patterns (relative to each log root) matching agent-log files. */
    filePatterns: string[];
    /**
     * Absolute root directories to scan.
     * Empty for tools whose logs live inside arbitrary project directories
     * (e.g. Aider's `./.aider/`), resolved later by the workspace discovery
     * layer instead.
     */
    logRoots: string[];
    /** Full `chatwizard.*` setting key that enables/disables this source. */
    enabledSettingKey: string;
    /** Full `chatwizard.*` setting key that overrides the default log root. */
    pathOverrideSettingKey?: string;
    /** Free-form notes describing what the tool logs (for maintainers). */
    notes?: string;
}

/**
 * Registry of `LogSourceConfig`s keyed by tool id.
 * Plain Map-backed; also exposes VS Code-setting-aware helpers that degrade
 * gracefully when not running inside the extension host (tests, scripts).
 */
export class LogSourceRegistry {
    private readonly _sources = new Map<LogSourceTool, LogSourceConfig>();

    /** Register (or replace) a source config. Returns `this` for chaining. */
    register(source: LogSourceConfig): this {
        this._sources.set(source.tool, source);
        return this;
    }

    /** Get a config for a tool, or undefined when not registered. */
    get(tool: LogSourceTool): LogSourceConfig | undefined {
        return this._sources.get(tool);
    }

    /** All registered source configs, in registration order. */
    all(): LogSourceConfig[] {
        return [...this._sources.values()];
    }

    /** All registered tool ids. */
    tools(): LogSourceTool[] {
        return [...this._sources.keys()];
    }

    /**
     * Whether a source is enabled according to its `chatwizard.*` setting.
     * Defaults to `true` when the setting is unset or when running outside
     * the extension host (unit tests).
     */
    isEnabled(tool: LogSourceTool): boolean {
        const source = this._sources.get(tool);
        if (!source) { return false; }

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as typeof import('vscode');
            const cfg = vscode.workspace.getConfiguration('chatwizard');
            const key = source.enabledSettingKey.replace(/^chatwizard\./, '');
            return cfg.get<boolean>(key, true);
        } catch {
            // Not in the extension host — settings are at their defaults.
            return true;
        }
    }

    /** Sources whose enable setting is currently on. */
    enabled(): LogSourceConfig[] {
        return this.all().filter((s) => this.isEnabled(s.tool));
    }

    /**
     * Resolve the effective log root for a tool.
     * Honour the `chatwizard.*` path override first, then the config's first
     * default root. Returns undefined when the source has no fixed root.
     */
    resolveLogRoot(tool: LogSourceTool): string | undefined {
        const source = this._sources.get(tool);
        if (!source) { return undefined; }
        if (source.pathOverrideSettingKey) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const vscode = require('vscode') as typeof import('vscode');
                const cfg = vscode.workspace.getConfiguration('chatwizard');
                const key = source.pathOverrideSettingKey.replace(/^chatwizard\./, '');
                const override = cfg.get<string>(key, '');
                if (override && override.trim().length > 0) {
                    return override.trim();
                }
            } catch {
                // Not in the extension host — fall through to the default root.
            }
        }
        return source.logRoots.length > 0 ? source.logRoots[0] : undefined;
    }
}
/**
 * Build the Phase-1 registry with sensible defaults for the six tools the
 * plan targets. Roots are resolved at call time so platform detection and
 * user settings are current.
 */
export function createDefaultLogSourceRegistry(): LogSourceRegistry {
    const registry = new LogSourceRegistry();

    registry.register({
        tool: 'copilot',
        displayName: 'GitHub Copilot',
        format: 'jsonl',
        // VS Code persists every Copilot conversation as a snapshot+patch JSONL
        // under workspaceStorage/<hash>/chatSessions/. Response items embed the
        // agent-execution trail (toolInvocationSerialized, textEditGroup) and
        // terminal-notification turns carry command exit codes.
        filePatterns: ['**/chatSessions/*.jsonl'],
        logRoots: getWorkspaceStorageRoots(),
        enabledSettingKey: 'chatwizard.indexCopilot',
        pathOverrideSettingKey: 'chatwizard.copilotStoragePath',
        notes: 'Session JSONL includes tool invocations, inline edits and terminal notifications — the Phase 2 adapter.',
    });

    registry.register({
        tool: 'cursor',
        displayName: 'Cursor',
        format: 'sqlite',
        // Cursor stores conversation + agent-action payloads in per-workspace
        // SQLite DBs; execution logs (runCommand/applyDiff) live alongside.
        filePatterns: ['**/state.vscdb', '**/*.db'],
        logRoots: [path.join(getCursorStorageRoot(), 'User', 'workspaceStorage')],
        enabledSettingKey: 'chatwizard.indexCursor',
        pathOverrideSettingKey: 'chatwizard.cursorStoragePath',
        notes: 'Agent tool calls and command executions; full adapter in Phase 2.',
    });

    registry.register({
        tool: 'cline',
        displayName: 'Cline',
        format: 'json',
        filePatterns: ['**/api_conversation_history.json', '**/ui_messages.json'],
        logRoots: [getClineStorageRoot()],
        enabledSettingKey: 'chatwizard.indexCline',
        pathOverrideSettingKey: 'chatwizard.clineStoragePath',
        notes: 'ui_messages.json carries terminal commands, tool calls, file ops/edits and errors per task — the Phase 3 adapter (shared with Roo Code).',
    });

    registry.register({
        tool: 'roocode',
        displayName: 'Roo Code',
        format: 'json',
        filePatterns: ['**/api_conversation_history.json', '**/ui_messages.json'],
        logRoots: [getRooCodeStorageRoot()],
        enabledSettingKey: 'chatwizard.indexRooCode',
        pathOverrideSettingKey: 'chatwizard.rooCodeStoragePath',
        notes: 'Cline-compatible task layout; shares the Cline adapter shape.',
    });

    registry.register({
        tool: 'windsurf',
        displayName: 'Windsurf',
        format: 'sqlite',
        filePatterns: ['**/state.vscdb', '**/*.sqlite'],
        logRoots: [path.join(getWindsurfStorageRoot(), 'User', 'workspaceStorage')],
        enabledSettingKey: 'chatwizard.indexWindsurf',
        pathOverrideSettingKey: 'chatwizard.windsurfStoragePath',
        notes: 'Agent steps incl. command execution and planner logic.',
    });

    registry.register({
        tool: 'aider',
        displayName: 'Aider',
        format: 'markdown',
        filePatterns: ['.aider.chat.history.md'],
        logRoots: [], // project-local .aider/ dirs — resolved via workspaces in Phase 2
        enabledSettingKey: 'chatwizard.indexAider',
        notes: '.aider.chat.history.md captures commands, patches and file edits per repo.',
    });

    registry.register({
        tool: 'antigravity',
        displayName: 'Google Antigravity',
        format: 'text',
        filePatterns: ['**/.system_generated/logs/overview.txt'],
        logRoots: [getAntigravityBrainRoot()],
        enabledSettingKey: 'chatwizard.indexAntigravity',
        pathOverrideSettingKey: 'chatwizard.antigravityBrainPath',
        notes: 'PLANNER_RESPONSE + tool-only steps incl. EXECUTE_COMMAND / RUN_TOOL / APPLY_PATCH.',
    });

    return registry;
}