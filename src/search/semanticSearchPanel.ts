// src/search/semanticSearchPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SessionSummary, SessionSource } from '../types/index';
import { ISemanticIndexer, SEMANTIC_MIN_SCORE } from './semanticContracts';
import { SemanticSearchResult } from './types';
import { sourceCodiconId } from '../ui/sourceUi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticResultItem extends vscode.QuickPickItem {
    summary: SessionSummary;
    score: number;
}

type SourceFilterState = 'all' | 'copilot' | 'claude' | 'antigravity';

// ---------------------------------------------------------------------------
// Source filter helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function nextSourceState(current: SourceFilterState): SourceFilterState {
    if (current === 'all')       { return 'copilot'; }
    if (current === 'copilot')   { return 'claude'; }
    if (current === 'claude')    { return 'antigravity'; }
    return 'all';
}

export function sourceButtonTooltip(state: SourceFilterState): string {
    if (state === 'all')        { return 'Source: All — click for Copilot only'; }
    if (state === 'copilot')    { return 'Source: Copilot — click for Claude only'; }
    if (state === 'claude')     { return 'Source: Claude — click for Antigravity only'; }
    return 'Source: Antigravity — click for All';
}

function sourceButtonIcon(state: SourceFilterState): vscode.ThemeIcon {
    if (state === 'copilot')    { return new vscode.ThemeIcon('github'); }
    if (state === 'claude')     { return new vscode.ThemeIcon('hubot'); }
    if (state === 'antigravity') { return new vscode.ThemeIcon('rocket'); }
    return new vscode.ThemeIcon('list-filter');
}

// ---------------------------------------------------------------------------
// Result mapping (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Maps raw semantic search results to QuickPick items.
 * Pure function — no VS Code API calls.
 */
export function buildItems(
    results: SemanticSearchResult[],
    summaryMap: Map<string, SessionSummary>
): SemanticResultItem[] {
    const items: SemanticResultItem[] = [];

    for (const result of results) {
        const summary = summaryMap.get(result.sessionId);
        if (!summary) { continue; }

        const srcIcon = `$(${sourceCodiconId(summary.source)})`;
        const label = `${srcIcon}  ${summary.title}`;

        const workspace = summary.workspacePath ?? summary.workspaceId;
        const score = Math.round(result.score * 100);
        const description = `${workspace} · ${summary.updatedAt.slice(0, 10)} · Score: ${score}%`;

        items.push({ label, description, summary, score, alwaysShow: true });
    }

    return items;
}

// ---------------------------------------------------------------------------
// SemanticSearchPanel
// ---------------------------------------------------------------------------

export class SemanticSearchPanel {
    static show(
        _context: vscode.ExtensionContext,
        indexer: ISemanticIndexer,
        sessionIndex: SessionIndex
    ): void {
        // Build summary lookup map once
        const summaryMap = new Map<string, SessionSummary>();
        for (const summary of sessionIndex.getAllSummaries()) {
            summaryMap.set(summary.id, summary);
        }

        const totalSessions = summaryMap.size;

        // Filter state
        let sourceFilter: SourceFilterState = 'all';

        type MutableButton = { iconPath: vscode.ThemeIcon; tooltip: string };

        const sourceButton = {
            iconPath: sourceButtonIcon(sourceFilter),
            tooltip: sourceButtonTooltip(sourceFilter),
        } as MutableButton;

        const quickPick = vscode.window.createQuickPick<SemanticResultItem>();
        quickPick.placeholder = 'Semantic search — describe a topic or question…';
        quickPick.matchOnDescription = false;
        quickPick.matchOnDetail = false;
        quickPick.buttons = [sourceButton as vscode.QuickInputButton];

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        let lastRawResults: SemanticSearchResult[] = [];

        // Apply the current source filter to the last raw result set client-side
        function applyFilter(): void {
            const allItems = buildItems(lastRawResults, summaryMap);
            const filtered = sourceFilter === 'all'
                ? allItems
                : allItems.filter(item => item.summary.source === (sourceFilter as SessionSource));
            filtered.sort((a, b) => b.score - a.score);
            quickPick.items = filtered;
        }

        quickPick.onDidChangeValue((value) => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }

            debounceTimer = setTimeout(async () => {
                debounceTimer = undefined;

                if (!value) {
                    lastRawResults = [];
                    quickPick.items = [];
                    return;
                }

                if (!indexer.isReady) {
                    quickPick.items = [{
                        label: `$(loading~spin) Semantic index still loading model… please wait`,
                        summary: undefined as unknown as SessionSummary,
                        score: 0,
                        alwaysShow: true,
                    }];
                    return;
                }

                const minScore = vscode.workspace.getConfiguration('chatwizard')
                    .get<number>('semanticMinScore') ?? SEMANTIC_MIN_SCORE;

                quickPick.busy = true;
                try {
                    lastRawResults = await indexer.search(value, 10, minScore);
                } catch (err) {
                    quickPick.busy = false;
                    quickPick.items = [{
                        label: `$(error) Search failed: ${err instanceof Error ? err.message : String(err)}`,
                        summary: undefined as unknown as SessionSummary,
                        score: 0,
                        alwaysShow: true,
                    }];
                    return;
                }
                quickPick.busy = false;

                if (indexer.isIndexing && lastRawResults.length === 0) {
                    quickPick.items = [{
                        label: `$(loading~spin) Still indexing sessions (${indexer.indexedCount}/${totalSessions}) — try again shortly`,
                        summary: undefined as unknown as SessionSummary,
                        score: 0,
                        alwaysShow: true,
                    }];
                    return;
                }

                applyFilter();

                if (quickPick.items.length === 0) {
                    quickPick.items = [{
                        label: `$(info) No semantic matches found`,
                        description: indexer.indexedCount === 0 ? 'Index is empty — indexing may not have started yet' : undefined,
                        summary: undefined as unknown as SessionSummary,
                        score: 0,
                        alwaysShow: true,
                    }];
                }
            }, 400);
        });

        quickPick.onDidTriggerButton((button) => {
            if (button === sourceButton) {
                sourceFilter = nextSourceState(sourceFilter);
                sourceButton.iconPath = sourceButtonIcon(sourceFilter);
                sourceButton.tooltip = sourceButtonTooltip(sourceFilter);
                quickPick.buttons = [sourceButton as vscode.QuickInputButton];
                applyFilter();
            }
        });

        quickPick.onDidAccept(() => {
            const active = quickPick.activeItems[0];
            if (active && active.summary) {
                vscode.commands.executeCommand('chatwizard.openSession', active.summary);
            }
        });

        quickPick.onDidHide(() => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            quickPick.dispose();
        });

        quickPick.show();
    }
}
