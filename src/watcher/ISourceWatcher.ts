// src/watcher/ISourceWatcher.ts
// Item 2: ISourceWatcher strategy interface.
// Each AI source (Copilot, Claude, Cline, …) implements this interface.
// ChatWizardWatcher becomes a thin orchestrator that runs buildIndex() calls
// in parallel (Promise.all) and calls startWatching() on each.

import * as vscode from 'vscode';
import { Session } from '../types/index';
import { SessionIndex } from '../index/sessionIndex';

/**
 * Dependencies injected into every ISourceWatcher implementation.
 * Keeps constructors testable — no direct vscode.workspace calls needed.
 */
export interface SourceWatcherDeps {
    index: SessionIndex;
    channel: vscode.OutputChannel;
    /** Workspace IDs currently in scope (empty = index nothing). */
    selectedIds: string[];
    /** Optional progress callback: (current, total). */
    onProgress?: (current: number, total: number) => void;
}

/**
 * Strategy interface for a single AI-source watcher.
 *
 * Implementations are responsible for:
 *  - Discovering and parsing all sessions for their source (`buildIndex`).
 *  - Registering VS Code / Node.js file-system watchers (`startWatching`).
 *  - Cleaning up all resources on `dispose`.
 */
export interface ISourceWatcher extends vscode.Disposable {
    /** Human-readable source identifier (e.g. 'copilot', 'cline'). */
    readonly sourceId: string;

    /**
     * Discover and parse all existing sessions for this source.
     * Called once during extension activation, in parallel with other sources.
     * Returns the sessions found (already upserted into the index by the caller).
     */
    buildIndex(): Promise<Session[]>;

    /**
     * Register file-system watchers so that live changes are reflected
     * in the session index without a full restart.
     * Called after buildIndex() completes.
     */
    startWatching(): void;
}