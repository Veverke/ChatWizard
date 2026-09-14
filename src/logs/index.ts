/**
 * src/logs/index.ts
 *
 * Watch-logs subsystem public surface:
 * Phase 1 — foundations (schema, registry, storage, facade).
 * Phase 2 — first tool adapter (GitHub Copilot), harvester and the
 *           "Executed Commands" panel.
 */

export * from './types';
export * from './logSourceRegistry';
export * from './logEventStore';
export * from './logService';
export * from './adapters/copilotLogAdapter';
export * from './copilotLogHarvester';
export * from './executedCommandsProvider';
export * from './logsCommands';