/**
 * src/logs/index.ts
 *
 * Watch-logs subsystem public surface:
 * Phase 1 — foundations (schema, registry, storage, facade).
 * Phase 2 — first tool adapter (GitHub Copilot), harvester and the
 *           "Executed Commands" panel.
 * Phase 3 — enriched Copilot events (file ops + diffs), the "Unified
 *           Timeline" panel, the "Diff Explorer" panel, and the
 *           Cline / Roo Code, Windsurf and Aider adapters + harvesters
 *           feeding the same store.
 * Phase 4 — UX pass: those three panels now live as sections of a single
 *           "Commands" sidebar view (`commandsViewProvider`); shared filters
 *           (search / agent / failures-only / event kind), per-agent statistics
 *           and a resilient query path (`logFilters`, `logStats`).
 */

export * from './types';
export * from './logSourceRegistry';
export * from './logEventStore';
export * from './logService';
export * from './logFilters';
export * from './logStats';
export * from './adapters/copilotLogAdapter';
export * from './adapters/copilotAgentLogAdapter';
export * from './adapters/clineLogAdapter';
export * from './adapters/clineV4LogAdapter';
// `agentToolMapping` is intentionally NOT re-exported: several of its helper
// names (`extractFilePath`, `extractSearchReplace`) already exist on the legacy
// adapters above. Import it directly where the shared mapping is needed.
export { classifyAgentTool, normalizeToolName, fileOperationOf } from './adapters/agentToolMapping';
export type { AgentToolKind, AgentFileOperation } from './adapters/agentToolMapping';
export * from './adapters/aiderLogAdapter';
export * from './adapters/windsurfLogAdapter';
export * from './copilotLogHarvester';
export * from './clineLogHarvester';
export * from './aiderLogHarvester';
export * from './windsurfLogHarvester';
export * from './executedCommandsProvider';
export * from './unifiedTimelineProvider';
export * from './diffExplorerProvider';
export * from './commandsViewProvider';
export * from './diffViewer';
export * from './logEventWebview';
export * from './runInTerminal';
export * from './logsCommands';