// src/utils/persistedUiState.ts
// Item 10: Consolidated globalState persistence.
// Replaces 5 separate globalState.update() calls per user action with a single write.

import * as vscode from 'vscode';
import { SortStack } from '../views/sessionTreeProvider';
import { GroupMode } from '../views/sessionTreeProvider';
import { CbGroupMode } from '../views/codeBlockTreeProvider';

export interface PersistedUiState {
    sortStack: SortStack;
    pinnedIds: string[];
    manualOrder: string[];
    sessionGroupMode: GroupMode;
    cbGroupMode: CbGroupMode;
}

const STORAGE_KEY = 'chatwizard.uiState';

const DEFAULTS: PersistedUiState = {
    sortStack: [{ key: 'date', direction: 'desc' }],
    pinnedIds: [],
    manualOrder: [],
    sessionGroupMode: 'date',
    cbGroupMode: 'language',
};

/**
 * Load the consolidated UI state from globalState.
 * Gracefully handles missing or corrupt data by returning defaults.
 */
export function loadUiState(context: vscode.ExtensionContext): PersistedUiState {
    const VALID_GROUP_MODES: GroupMode[] = ['none', 'date', 'branch', 'workItem', 'tag', 'folder'];
    const VALID_CB_GROUP_MODES: CbGroupMode[] = ['none', 'language'];
    try {
        const raw = context.globalState.get<string>(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
            const sessionGroupMode: GroupMode = VALID_GROUP_MODES.includes(parsed.sessionGroupMode as GroupMode)
                ? parsed.sessionGroupMode as GroupMode
                : DEFAULTS.sessionGroupMode;
            const cbGroupMode: CbGroupMode = VALID_CB_GROUP_MODES.includes(parsed.cbGroupMode as CbGroupMode)
                ? parsed.cbGroupMode as CbGroupMode
                : DEFAULTS.cbGroupMode;
            return {
                // Spread-copy the sortStack so callers can't mutate DEFAULTS.
                sortStack: parsed.sortStack?.length ? [...parsed.sortStack] : [...DEFAULTS.sortStack],
                pinnedIds: Array.isArray(parsed.pinnedIds) ? parsed.pinnedIds : [],
                manualOrder: Array.isArray(parsed.manualOrder) ? parsed.manualOrder : [],
                sessionGroupMode,
                cbGroupMode,
            };
        }
    } catch {
        // Fall through to defaults
    }
    return { ...DEFAULTS, sortStack: [...DEFAULTS.sortStack] };
}

/**
 * Persist the consolidated UI state.
 * Single globalState.update() call regardless of which field changed (Item 10).
 */
export function saveUiState(context: vscode.ExtensionContext, state: PersistedUiState): void {
    void context.globalState.update(STORAGE_KEY, JSON.stringify(state));
}