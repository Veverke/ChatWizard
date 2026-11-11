/**
 * src/logs/index.ts
 *
 * Watch-logs subsystem public surface:
 * Phase 1 — foundations (schema, registry, storage, facade).
 * Phase 2 — first tool adapter (GitHub Copilot), harvester and the
 *           "Executed Commands" panel.
 * Phase 3 — enriched Copilot events (file ops + diffs), the "Unified
 *           Timeline" panel, the "Diff Explorer" panel, and the
 *           Cline / Roo Code adapter + harvester feeding the same store.
 */

export * from './types';
export * from './logSourceRegistry';
export * from './logEventStore';
export * from './logService';
export * from './adapters/copilotLogAdapter';
export * from './adapters/clineLogAdapter';
export * from './copilotLogHarvester';
export * from './clineLogHarvester';
export * from './executedCommandsProvider';
export * from './unifiedTimelineProvider';
export * from './diffExplorerProvider';
export * from './diffViewer';
export * from './logEventWebview';
export * from './logsCommands';