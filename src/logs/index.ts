/**
 * src/logs/index.ts
 *
 * Phase 1 — Watch logs foundations.
 *
 * Public surface of the logs subsystem:
 *   - unified event schema   (./types)
 *   - log source registry    (./logSourceRegistry)
 *   - storage/indexing       (./logEventStore)
 *   - facade with getEvents  (./logService)
 */

export * from './types';
export * from './logSourceRegistry';
export * from './logEventStore';
export * from './logService';