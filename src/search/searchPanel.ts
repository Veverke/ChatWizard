// src/search/searchPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SessionSummary, SessionSource } from '../types/index';
import { FullTextSearchEngine } from './fullTextEngine';
import { SearchResult, SearchFilter, SearchResponse } from './types';
import { friendlySourceName, sourceCodiconId } from '../ui/sourceUi';

export interface SearchResultItem extends vscode.QuickPickItem {
    result: SearchResult;
    summary: SessionSummary;
}

type SourceFilterState = 'all' | SessionSource;
type MessageTypeState = 'all' | 'prompts' | 'responses';

/** Options accepted by {@link SearchPanel.show}. */
export interface SearchPanelOptions {
    /** Text prefilled into the search box when the panel opens. */
    initialValue?: string;
    /**
     * Run the panel in **filter mode**. When set, the result list is a read-only
     * preview — selecting a row does nothing — and the ✓ OK button in the search
     * box reports the query plus the distinct IDs of the sessions it matched.
     */
    onApplyFilter?: (query: string, matchedSessionIds: string[]) => void;
}

// ---------------------------------------------------------------------------
// Result mapping (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Maps a raw search response to QuickPick items — at most one item per session
 * (results arrive score-descending, so the first hit per session is the best).
 * Pure function: no VS Code API calls.
 */
export function buildSearchItems(
    response: SearchResponse,
    summaryMap: Map<string, SessionSummary>,
): SearchResultItem[] {
    const items: SearchResultItem[] = [];

    if (response.totalCount > response.results.length) {
        items.push({
            label: `$(info) Showing top ${response.results.length} of ${response.totalCount} results — refine your query`,
            result: undefined as unknown as SearchResult,
            summary: undefined as unknown as SessionSummary,
            alwaysShow: true,
        });
    }

    const seenSessions = new Set<string>();
    for (const result of response.results) {
        // results are sorted score-descending; first hit per session is the best
        if (seenSessions.has(result.sessionId)) { continue; }
        seenSessions.add(result.sessionId);

        const summary = summaryMap.get(result.sessionId);
        if (!summary) { continue; }

        // Source icon in label so source is instantly recognisable
        const srcIcon = `$(${sourceCodiconId(summary.source)})`;
        const label = `${srcIcon}  ${summary.title}`;

        const workspace = summary.workspacePath ?? summary.workspaceId;
        const description = `${workspace}  ·  ${summary.updatedAt.slice(0, 10)}`;

        // Prefix snippet with which side of the conversation matched
        const assistantName = friendlySourceName(summary.source);
        const rolePrefix = result.messageRole === 'user' ? 'You' : assistantName;
        const detail = `${rolePrefix}:  ${result.snippet}`;

        // Explicitly highlight the match range inside the detail string
        const prefixLen = rolePrefix.length + 3; // ":  "
        const item = { label, description, detail, result, summary } as SearchResultItem;
        // VS Code QuickPickItem supports 'highlights' for explicit range highlighting
        (item as unknown as Record<string, unknown>).highlights = {
            detail: [[prefixLen + result.matchStart, prefixLen + result.matchEnd]],
        };
        items.push(item);
    }

    return items;
}

/**
 * Distinct session IDs in a search response, in result order.
 * Used to build a content filter ("Session contains…") from a search.
 */
export function collectMatchedSessionIds(response: SearchResponse): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const result of response.results) {
        if (seen.has(result.sessionId)) { continue; }
        seen.add(result.sessionId);
        ids.push(result.sessionId);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// Source filter button
// ---------------------------------------------------------------------------

const SOURCE_CYCLE_ORDER: SourceFilterState[] = [
    'all', 'copilot', 'claude', 'antigravity', 'cursor', 'cline', 'roocode', 'windsurf', 'aider',
];

function nextSourceState(current: SourceFilterState): SourceFilterState {
    const idx = SOURCE_CYCLE_ORDER.indexOf(current);
    return SOURCE_CYCLE_ORDER[(idx + 1) % SOURCE_CYCLE_ORDER.length];
}

function sourceButtonIcon(state: SourceFilterState): vscode.ThemeIcon {
    if (state === 'all') { return new vscode.ThemeIcon('list-filter'); }
    return new vscode.ThemeIcon(sourceCodiconId(state as SessionSource));
}

function sourceButtonTooltip(state: SourceFilterState): string {
    if (state === 'all') { return 'Source: All — click to filter by source'; }
    return `Source: ${friendlySourceName(state as SessionSource)} — click to cycle`;
}

// ---------------------------------------------------------------------------
// Message-type filter button  (all / prompts-only / responses-only)
// ---------------------------------------------------------------------------

function nextMsgTypeState(current: MessageTypeState): MessageTypeState {
    if (current === 'all') { return 'prompts'; }
    if (current === 'prompts') { return 'responses'; }
    return 'all';
}

function msgTypeIcon(state: MessageTypeState): vscode.ThemeIcon {
    if (state === 'prompts') { return new vscode.ThemeIcon('person'); }
    if (state === 'responses') { return new vscode.ThemeIcon('hubot'); }
    return new vscode.ThemeIcon('comment-discussion');
}

function msgTypeTooltip(state: MessageTypeState): string {
    if (state === 'all') { return 'Messages: All — click for prompts only'; }
    if (state === 'prompts') { return 'Messages: Prompts only — click for responses only'; }
    return 'Messages: Responses only — click for All';
}

// ---------------------------------------------------------------------------
// SearchPanel
// ---------------------------------------------------------------------------

export class SearchPanel {
    /**
     * Open the search QuickPick.
     *
     * Without `options.onApplyFilter` this is the regular *Chat Wizard: Search*
     * behaviour: results are clickable and open the matched session. With it, the
     * panel runs in **filter mode** — a read-only preview plus a ✓ OK button that
     * hands the query and its matching session IDs back to the caller.
     */
    static show(
        context: vscode.ExtensionContext,
        index: SessionIndex,
        engine: FullTextSearchEngine,
        options: SearchPanelOptions = {}
    ): void {
        const onApplyFilter = options.onApplyFilter;
        const filterMode = onApplyFilter !== undefined;

        // Build summary lookup map once
        const summaryMap = new Map<string, SessionSummary>();
        for (const summary of index.getAllSummaries()) {
            summaryMap.set(summary.id, summary);
        }

        // Filter state
        let sourceFilter: SourceFilterState = 'all';
        let msgTypeFilter: MessageTypeState = 'all';
        /** Session IDs matched by the most recent search (filter mode → applied on OK). */
        let lastMatchedSessionIds: string[] = [];

        // Buttons — cast to mutable so we can update iconPath/tooltip in place
        type MutableButton = { iconPath: vscode.ThemeIcon; tooltip: string };

        const sourceButton = {
            iconPath: sourceButtonIcon(sourceFilter),
            tooltip: sourceButtonTooltip(sourceFilter),
        } as MutableButton;

        const msgTypeButton = {
            iconPath: msgTypeIcon(msgTypeFilter),
            tooltip: msgTypeTooltip(msgTypeFilter),
        } as MutableButton;

        const semanticButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('sparkle'),
            tooltip: 'Switch to topic similarity search',
        };

        // Filter mode: the ✓ OK button lives in the search box and applies the
        // current result set to the Sessions view instead of opening a result.
        const okButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('check'),
            tooltip: 'OK — filter the Sessions view by this search',
        };

        const buildButtons = (): vscode.QuickInputButton[] => filterMode
            ? [okButton, sourceButton as vscode.QuickInputButton, msgTypeButton as vscode.QuickInputButton]
            : [sourceButton as vscode.QuickInputButton, msgTypeButton as vscode.QuickInputButton, semanticButton];

        const quickPick = vscode.window.createQuickPick<SearchResultItem>();
        quickPick.placeholder = filterMode
            ? 'Session contains… (preview only — click OK to filter the Sessions view)'
            : 'Search chat history… (prefix with / for regex)';
        if (filterMode) {
            quickPick.title = 'Session contains… — results are a preview; click ✓ OK to apply the filter';
        }
        // matchOnDetail lets VS Code highlight the query text inside the snippet
        quickPick.matchOnDescription = false;
        quickPick.matchOnDetail = true;
        quickPick.buttons = buildButtons();

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        function runSearch(value: string): void {
            const isRegex = value.startsWith('/');
            const text = isRegex ? value.slice(1) : value;

            if (!text) {
                lastMatchedSessionIds = [];
                quickPick.items = [];
                return;
            }

            const filter: SearchFilter = {};
            if (sourceFilter !== 'all') {
                filter.source = sourceFilter as SessionSource;
            }
            filter.searchPrompts = msgTypeFilter !== 'responses';
            filter.searchResponses = msgTypeFilter !== 'prompts';

            let response: SearchResponse;
            try {
                response = engine.search({ text, isRegex, filter });
            } catch {
                lastMatchedSessionIds = [];
                quickPick.items = [];
                return;
            }

            lastMatchedSessionIds = collectMatchedSessionIds(response);
            quickPick.items = buildSearchItems(response, summaryMap);
        }

        quickPick.onDidChangeValue((value) => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                runSearch(value);
            }, 300);
        });

        quickPick.onDidTriggerButton((button) => {
            if (button === okButton && onApplyFilter) {
                // Cancel a pending debounce so the applied set matches what is on
                // screen, then hand the query + its sessions to the caller.
                if (debounceTimer !== undefined) {
                    clearTimeout(debounceTimer);
                    debounceTimer = undefined;
                }
                const query = quickPick.value.trim();
                runSearch(quickPick.value);
                onApplyFilter(query, query ? lastMatchedSessionIds : []);
                quickPick.hide();
                return;
            }
            if (button === semanticButton) {
                vscode.commands.executeCommand('chatwizard.semanticSearch');
                quickPick.hide();
                return;
            }
            if (button === sourceButton) {
                sourceFilter = nextSourceState(sourceFilter);
                sourceButton.iconPath = sourceButtonIcon(sourceFilter);
                sourceButton.tooltip = sourceButtonTooltip(sourceFilter);
            } else if (button === msgTypeButton) {
                msgTypeFilter = nextMsgTypeState(msgTypeFilter);
                msgTypeButton.iconPath = msgTypeIcon(msgTypeFilter);
                msgTypeButton.tooltip = msgTypeTooltip(msgTypeFilter);
            }
            quickPick.buttons = buildButtons();
            runSearch(quickPick.value);
        });

        quickPick.onDidAccept(() => {
            // Filter mode: rows are a read-only preview. Only the ✓ OK button
            // accepts — clicking a result must never open (or navigate to) it.
            if (filterMode) { return; }

            const active = quickPick.activeItems[0];
            if (active && active.result) {
                const raw = quickPick.value;
                const term = raw.startsWith('/') ? raw.slice(1) : raw;
                vscode.commands.executeCommand('chatwizard.openSession', active.summary, term);
            }
        });

        quickPick.onDidHide(() => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            quickPick.dispose();
        });

        if (options.initialValue) {
            quickPick.value = options.initialValue;
            runSearch(options.initialValue);
        }

        quickPick.show();
    }

    /**
     * Open the search QuickPick in **filter mode** — the "Session contains…"
     * entry of `Chat Wizard: Filter Sessions…`.
     *
     * Differences from {@link SearchPanel.show}:
     * - result rows are previews only; accepting one does nothing,
     * - a ✓ OK button in the search box applies the query, reporting the query
     *   text plus the distinct IDs of every session it matched.
     */
    static showFilter(
        context: vscode.ExtensionContext,
        index: SessionIndex,
        engine: FullTextSearchEngine,
        onApplyFilter: (query: string, matchedSessionIds: string[]) => void,
        initialValue?: string
    ): void {
        SearchPanel.show(context, index, engine, { initialValue, onApplyFilter });
    }
}
