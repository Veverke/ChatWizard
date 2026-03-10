// src/search/searchPanel.ts

import * as vscode from 'vscode';
import { SessionIndex } from '../index/sessionIndex';
import { SessionSummary, SessionSource } from '../types/index';
import { FullTextSearchEngine } from './fullTextEngine';
import { SearchResult, SearchFilter } from './types';

interface SearchResultItem extends vscode.QuickPickItem {
    result: SearchResult;
    summary: SessionSummary;
}

type SourceFilterState = 'all' | 'copilot' | 'claude';
type MessageTypeState = 'all' | 'prompts' | 'responses';

// ---------------------------------------------------------------------------
// Source filter button
// ---------------------------------------------------------------------------

function nextSourceState(current: SourceFilterState): SourceFilterState {
    if (current === 'all') { return 'copilot'; }
    if (current === 'copilot') { return 'claude'; }
    return 'all';
}

function sourceButtonIcon(state: SourceFilterState): vscode.ThemeIcon {
    if (state === 'copilot') { return new vscode.ThemeIcon('github'); }
    if (state === 'claude') { return new vscode.ThemeIcon('hubot'); }
    return new vscode.ThemeIcon('list-filter');
}

function sourceButtonTooltip(state: SourceFilterState): string {
    if (state === 'all') { return 'Source: All — click for Copilot only'; }
    if (state === 'copilot') { return 'Source: Copilot — click for Claude only'; }
    return 'Source: Claude — click for All';
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
    static show(
        context: vscode.ExtensionContext,
        index: SessionIndex,
        engine: FullTextSearchEngine
    ): void {
        // Build summary lookup map once
        const summaryMap = new Map<string, SessionSummary>();
        for (const summary of index.getAllSummaries()) {
            summaryMap.set(summary.id, summary);
        }

        // Filter state
        let sourceFilter: SourceFilterState = 'all';
        let msgTypeFilter: MessageTypeState = 'all';

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

        const quickPick = vscode.window.createQuickPick<SearchResultItem>();
        quickPick.placeholder = 'Search chat history… (prefix with / for regex)';
        // matchOnDetail lets VS Code highlight the query text inside the snippet
        quickPick.matchOnDescription = false;
        quickPick.matchOnDetail = true;
        quickPick.buttons = [sourceButton as vscode.QuickInputButton, msgTypeButton as vscode.QuickInputButton];

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        function runSearch(value: string): void {
            const isRegex = value.startsWith('/');
            const text = isRegex ? value.slice(1) : value;

            if (!text) {
                quickPick.items = [];
                return;
            }

            const filter: SearchFilter = {};
            if (sourceFilter !== 'all') {
                filter.source = sourceFilter as SessionSource;
            }
            filter.searchPrompts = msgTypeFilter !== 'responses';
            filter.searchResponses = msgTypeFilter !== 'prompts';

            let results: SearchResult[];
            try {
                results = engine.search({ text, isRegex, filter });
            } catch {
                quickPick.items = [];
                return;
            }

            const items: SearchResultItem[] = [];
            for (const result of results) {
                const summary = summaryMap.get(result.sessionId);
                if (!summary) { continue; }

                // Source icon in label so Copilot vs Claude is instantly recognisable
                const srcIcon = summary.source === 'copilot' ? '$(github)' : '$(hubot)';
                const label = `${srcIcon}  ${summary.title}`;

                const workspace = summary.workspacePath ?? summary.workspaceId;
                const description = `${workspace}  ·  ${summary.updatedAt.slice(0, 10)}`;

                // Prefix snippet with which side of the conversation matched
                const assistantName = summary.source === 'copilot' ? 'Copilot' : 'Claude';
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

            quickPick.items = items;
        }

        quickPick.onDidChangeValue((value) => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                runSearch(value);
            }, 300);
        });

        quickPick.onDidTriggerButton((button) => {
            if (button === sourceButton) {
                sourceFilter = nextSourceState(sourceFilter);
                sourceButton.iconPath = sourceButtonIcon(sourceFilter);
                sourceButton.tooltip = sourceButtonTooltip(sourceFilter);
            } else if (button === msgTypeButton) {
                msgTypeFilter = nextMsgTypeState(msgTypeFilter);
                msgTypeButton.iconPath = msgTypeIcon(msgTypeFilter);
                msgTypeButton.tooltip = msgTypeTooltip(msgTypeFilter);
            }
            quickPick.buttons = [sourceButton as vscode.QuickInputButton, msgTypeButton as vscode.QuickInputButton];
            runSearch(quickPick.value);
        });

        quickPick.onDidAccept(() => {
            const active = quickPick.activeItems[0];
            if (active) {
                const raw = quickPick.value;
                const term = raw.startsWith('/') ? raw.slice(1) : raw;
                vscode.commands.executeCommand('chatwizard.openSession', active.summary, term);
            }
        });

        quickPick.onDidHide(() => {
            if (debounceTimer !== undefined) { clearTimeout(debounceTimer); }
            quickPick.dispose();
        });

        quickPick.show();
    }
}
