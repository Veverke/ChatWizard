import * as vscode from 'vscode';
import { SessionIndex } from './index/sessionIndex';
import { Session } from './types/index';
import { ChatWizardWatcher, startWatcher } from './watcher/fileWatcher';
import {
    SessionTreeProvider,
    SessionTreeItem,
    SortMode,
    SortKey,
    SortCriterion,
    SortStack,
    SORT_KEY_LABELS,
    SessionFilter,
} from './views/sessionTreeProvider';
import { CodeBlockTreeProvider, CodeBlockFilter, CbSortMode, CodeBlockSessionRef } from './views/codeBlockTreeProvider';
import { SessionWebviewPanel } from './views/sessionWebviewPanel';
import { FullTextSearchEngine } from './search/fullTextEngine';
import { SearchPanel } from './search/searchPanel';
import { registerExportCommands, performExport } from './export/exportCommands';
import { CodeBlockSearchEngine } from './codeblocks/codeBlockSearchEngine';
import { CodeBlocksPanel } from './codeblocks/codeBlocksPanel';
import { PromptLibraryPanel } from './prompts/promptLibraryPanel';
import { PromptLibraryViewProvider } from './prompts/promptLibraryViewProvider';
import { AnalyticsPanel } from './analytics/analyticsPanel';
import { AnalyticsViewProvider } from './analytics/analyticsViewProvider';
import { TimelineViewProvider } from './timeline/timelineViewProvider';
import { TelemetryRecorder } from './telemetry/telemetryRecorder';

let watcher: ChatWizardWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const channel = vscode.window.createOutputChannel('ChatWizard');
    context.subscriptions.push(channel);

    // Local telemetry recorder (opt-in, no external calls)
    const telemetry = new TelemetryRecorder(context.globalStorageUri.fsPath);
    const telemetryCfg = vscode.workspace.getConfiguration('chatwizard');
    telemetry.setEnabled(telemetryCfg.get<boolean>('enableTelemetry') ?? false);

    const index = new SessionIndex();
    watcher = await startWatcher(index, channel);
    context.subscriptions.push(watcher);

    const copilotCount = index.getSummariesBySource('copilot').length;
    const claudeCount = index.getSummariesBySource('claude').length;
    channel.appendLine(
        `ChatWizard activated — ${index.size} sessions indexed (${copilotCount} Copilot, ${claudeCount} Claude)`
    );

    // Build full-text search index (initial pass — index already populated by watcher)
    const engine = new FullTextSearchEngine();
    for (const summary of index.getAllSummaries()) {
        const session = index.get(summary.id);
        if (session) { engine.index(session); }
    }
    // Incremental updates: only re-index the changed session instead of full rebuild
    const searchIndexListener = index.addTypedChangeListener((event) => {
        if (event.type === 'upsert') {
            engine.index(event.session);
        } else if (event.type === 'remove') {
            engine.remove(event.sessionId);
        } else if (event.type === 'batch') {
            for (const session of event.sessions) { engine.index(session); }
        }
    });
    context.subscriptions.push(searchIndexListener);

    // Build code block index
    const codeBlockEngine = new CodeBlockSearchEngine();
    codeBlockEngine.index(index.getAllCodeBlocks());

    // Create code blocks tree provider (before the listener so it can reference both)
    const codeBlockProvider = new CodeBlockTreeProvider(index, codeBlockEngine);

    const codeBlockListener = index.addChangeListener(() => {
        codeBlockEngine.index(index.getAllCodeBlocks());
        CodeBlocksPanel.refresh(index, codeBlockEngine);
        codeBlockTreeView.description = codeBlockProvider.getDescription();
    });
    context.subscriptions.push(codeBlockListener);

    // Sidebar view providers (Prompt Library and Analytics as WebviewView tabs)
    const promptLibraryViewProvider = new PromptLibraryViewProvider(index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PromptLibraryViewProvider.viewType, promptLibraryViewProvider)
    );

    const analyticsViewProvider = new AnalyticsViewProvider(index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AnalyticsViewProvider.viewType, analyticsViewProvider)
    );

    const timelineViewProvider = new TimelineViewProvider(index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TimelineViewProvider.viewType, timelineViewProvider)
    );

    // Refresh Prompt Library panel (editor tab) and sidebar view when index changes
    const promptLibraryListener = index.addChangeListener(() => {
        PromptLibraryPanel.refresh(index);
        promptLibraryViewProvider.refresh();
    });
    context.subscriptions.push(promptLibraryListener);

    // Refresh Analytics panel (editor tab) and sidebar view when index changes
    const analyticsListener = index.addChangeListener(() => {
        AnalyticsPanel.refresh(index);
        analyticsViewProvider.refresh();
    });
    context.subscriptions.push(analyticsListener);

    const timelineListener = index.addChangeListener(() => {
        timelineViewProvider.refresh();
    });
    context.subscriptions.push(timelineListener);

    const provider = new SessionTreeProvider(index);

    // Restore persisted sort stack
    const savedStackJson = context.globalState.get<string>('sortStack');
    if (savedStackJson) {
        try {
            const saved = JSON.parse(savedStackJson) as SortStack;
            provider.restoreStack(saved);
        } catch { /* ignore corrupt state */ }
    }

    // Restore persisted pinned IDs
    const savedPinnedJson = context.globalState.get<string>('pinnedIds');
    if (savedPinnedJson) {
        try {
            provider.setPinnedIds(JSON.parse(savedPinnedJson) as string[]);
        } catch { /* ignore corrupt state */ }
    }

    // Restore persisted manual order (from drag-and-drop)
    const savedManualOrderJson = context.globalState.get<string>('manualOrder');
    if (savedManualOrderJson) {
        try {
            provider.setManualOrder(JSON.parse(savedManualOrderJson) as string[]);
        } catch { /* ignore corrupt state */ }
    }

    // Push current sort state to VS Code context (drives toolbar icon when clauses)
    function syncContext(): void {
        const primary = provider.getPrimary();
        void vscode.commands.executeCommand('setContext', 'chatwizard.sortKey', primary.key);
        void vscode.commands.executeCommand('setContext', 'chatwizard.sortDir', primary.direction);
        void vscode.commands.executeCommand('setContext', 'chatwizard.hasFilter', provider.hasActiveFilter());
    }
    syncContext();

    function savePins(): void {
        void context.globalState.update('pinnedIds', JSON.stringify(provider.getPinnedIds()));
        void context.globalState.update('manualOrder', JSON.stringify(provider.getManualOrder()));
    }

    // Drag-and-drop controller for reordering tree items
    const dragDropController: vscode.TreeDragAndDropController<SessionTreeItem> = {
        dragMimeTypes: ['application/vnd.chatwizard.session'],
        dropMimeTypes: ['application/vnd.chatwizard.session'],
        handleDrag(items, dataTransfer) {
            dataTransfer.set(
                'application/vnd.chatwizard.session',
                new vscode.DataTransferItem(items.map(i => i.summary.id))
            );
        },
        async handleDrop(target, dataTransfer) {
            const dragged = dataTransfer.get('application/vnd.chatwizard.session');
            if (!dragged) { return; }
            const ids = dragged.value as string[];
            provider.reorder(ids, target?.summary.id);
            treeView.description = provider.getDescription();
            provider.refresh();
            savePins();
        },
    };

    const treeView = vscode.window.createTreeView('chatwizardSessions', {
        treeDataProvider: provider,
        dragAndDropController: dragDropController,
        canSelectMany: true,
    });
    treeView.description = provider.getDescription();
    context.subscriptions.push(treeView);

    const codeBlockTreeView = vscode.window.createTreeView('chatwizardCodeBlocks', {
        treeDataProvider: codeBlockProvider,
        canSelectMany: false,
    });
    codeBlockTreeView.description = codeBlockProvider.getDescription();
    context.subscriptions.push(codeBlockTreeView);

    /** Apply a single-key primary sort (toolbar buttons). */
    function applySort(mode: SortMode): void {
        provider.setSortMode(mode);
        treeView.description = provider.getDescription();
        provider.refresh();
        syncContext();
        void context.globalState.update('sortStack', JSON.stringify(provider.getSortStack()));
    }

    /** Apply a full sort stack (from the sort builder). */
    function applyStack(stack: SortStack): void {
        provider.setSortStack(stack);
        treeView.description = provider.getDescription();
        provider.refresh();
        syncContext();
        void context.globalState.update('sortStack', JSON.stringify(provider.getSortStack()));
    }

    /** Push current code block sort state to VS Code context (drives Code Blocks toolbar). */
    function syncCbContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatwizard.cbSortKey', codeBlockProvider.getSortMode());
        void vscode.commands.executeCommand('setContext', 'chatwizard.cbSortDir', codeBlockProvider.getSortDir());
    }
    syncCbContext();

    /** Apply a sort mode to the Code Blocks view. */
    function applyCbSort(mode: CbSortMode): void {
        codeBlockProvider.setSortMode(mode);
        codeBlockTreeView.description = codeBlockProvider.getDescription();
        codeBlockProvider.refresh();
        syncCbContext();
    }

    // ------------------------------------------------------------------
    // Register all sort commands (base + direction variants)
    // Each toolbar mode has three command IDs; the package.json when-clauses
    // show exactly one at a time based on chatwizard.sortKey/sortDir context.
    // ------------------------------------------------------------------
    const sortModes: SortMode[] = ['date', 'workspace', 'length', 'title', 'model'];
    for (const mode of sortModes) {
        // Base command (shown when this mode is NOT the primary sort)
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}`, () => applySort(mode))
        );
        // Direction variants (shown when this mode IS primary; clicking toggles)
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}.asc`, () => applySort(mode))
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}.desc`, () => applySort(mode))
        );
    }

    // ------------------------------------------------------------------
    // Code Blocks sort commands (base + direction variants)
    // ------------------------------------------------------------------
    const cbSortModes: CbSortMode[] = ['date', 'workspace', 'length', 'title', 'language'];
    for (const mode of cbSortModes) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}`, () => applyCbSort(mode))
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}.asc`, () => applyCbSort(mode))
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}.desc`, () => applyCbSort(mode))
        );
    }

    // ------------------------------------------------------------------
    // Composite sort builder
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.configureSortOrder', async () => {
            const allKeys: SortKey[] = ['date', 'workspace', 'length', 'title', 'model', 'source'];
            const newStack: SortCriterion[] = [];

            for (let round = 0; round < 3; round++) {
                const remaining = allKeys.filter(k => !newStack.some(c => c.key === k));
                const ordinal = ['1st (primary)', '2nd', '3rd'][round];

                type KeyItem = vscode.QuickPickItem & { key: SortKey | '_done' };
                const items: KeyItem[] = remaining.map(k => ({
                    label: SORT_KEY_LABELS[k],
                    key: k,
                }));
                if (round > 0) {
                    items.push({ label: '$(check)  Done — apply current sort', key: '_done', alwaysShow: true });
                }

                const keyPick = await vscode.window.showQuickPick(items, {
                    title: `Sort order — ${ordinal} criterion`,
                    placeHolder: round === 0
                        ? 'Pick the primary sort key'
                        : 'Pick an additional key, or Done to finish',
                });
                if (!keyPick || keyPick.key === '_done') { break; }

                type DirItem = vscode.QuickPickItem & { dir: 'asc' | 'desc' };
                const dirItems: DirItem[] = [
                    { label: '$(arrow-down)  Descending', description: 'Newest · Largest · Z→A', dir: 'desc' },
                    { label: '$(arrow-up)  Ascending', description: 'Oldest · Smallest · A→Z', dir: 'asc' },
                ];
                const dirPick = await vscode.window.showQuickPick(dirItems, {
                    title: `Direction for "${SORT_KEY_LABELS[keyPick.key]}"`,
                });
                if (!dirPick) { break; }

                newStack.push({ key: keyPick.key, direction: dirPick.dir });
            }

            if (newStack.length > 0) { applyStack(newStack); }
        })
    );

    // ------------------------------------------------------------------
    // Filter command
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.filterSessions', async () => {
            const current = provider.getFilter();

            type FilterItem = vscode.QuickPickItem & { id: string };
            const items: FilterItem[] = [
                {
                    id: 'title',
                    label: '$(symbol-text)  Title contains…',
                    description: current.title ? `current: "${current.title}"` : undefined,
                },
                {
                    id: 'dateFrom',
                    label: '$(calendar)  Updated from… (YYYY-MM-DD)',
                    description: current.dateFrom ? `current: ${current.dateFrom}` : undefined,
                },
                {
                    id: 'dateTo',
                    label: '$(calendar)  Updated until… (YYYY-MM-DD)',
                    description: current.dateTo ? `current: ${current.dateTo}` : undefined,
                },
                {
                    id: 'model',
                    label: '$(symbol-event)  Model contains…',
                    description: current.model ? `current: "${current.model}"` : undefined,
                },
                {
                    id: 'minMessages',
                    label: '$(list-ordered)  Minimum messages',
                    description: current.minMessages !== undefined ? `current: ${current.minMessages}` : undefined,
                },
                {
                    id: 'maxMessages',
                    label: '$(list-ordered)  Maximum messages',
                    description: current.maxMessages !== undefined ? `current: ${current.maxMessages}` : undefined,
                },
                {
                    id: '_clear',
                    label: '$(close)  Clear all filters',
                    alwaysShow: true,
                },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Filter Sessions',
                placeHolder: 'Choose a filter criterion to set (or clear all)',
            });
            if (!pick) { return; }

            if (pick.id === '_clear') {
                provider.clearFilter();
                treeView.description = provider.getDescription();
                provider.refresh();
                void vscode.commands.executeCommand('setContext', 'chatwizard.hasFilter', false);
                return;
            }

            const newFilter: SessionFilter = { ...current };

            if (pick.id === 'title') {
                const val = await vscode.window.showInputBox({
                    title: 'Filter by title (case-insensitive substring)',
                    value: current.title ?? '',
                    placeHolder: 'Leave blank to remove this filter',
                });
                if (val === undefined) { return; }
                newFilter.title = val.trim() || undefined;

            } else if (pick.id === 'dateFrom') {
                const val = await vscode.window.showInputBox({
                    title: 'Updated from (YYYY-MM-DD, inclusive)',
                    value: current.dateFrom ?? '',
                    placeHolder: 'e.g. 2024-01-01  —  blank to remove',
                    validateInput: v => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) ? undefined : 'Use YYYY-MM-DD format',
                });
                if (val === undefined) { return; }
                newFilter.dateFrom = val.trim() || undefined;

            } else if (pick.id === 'dateTo') {
                const val = await vscode.window.showInputBox({
                    title: 'Updated until (YYYY-MM-DD, inclusive)',
                    value: current.dateTo ?? '',
                    placeHolder: 'e.g. 2024-12-31  —  blank to remove',
                    validateInput: v => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) ? undefined : 'Use YYYY-MM-DD format',
                });
                if (val === undefined) { return; }
                newFilter.dateTo = val.trim() || undefined;

            } else if (pick.id === 'model') {
                const val = await vscode.window.showInputBox({
                    title: 'Filter by model (case-insensitive substring)',
                    value: current.model ?? '',
                    placeHolder: 'e.g. gpt-4  —  blank to remove',
                });
                if (val === undefined) { return; }
                newFilter.model = val.trim() || undefined;

            } else if (pick.id === 'minMessages') {
                const val = await vscode.window.showInputBox({
                    title: 'Minimum message count (inclusive)',
                    value: current.minMessages !== undefined ? String(current.minMessages) : '',
                    placeHolder: 'e.g. 10  —  blank to remove',
                    validateInput: v => (!v || /^\d+$/.test(v)) ? undefined : 'Enter a whole number',
                });
                if (val === undefined) { return; }
                newFilter.minMessages = val.trim() ? parseInt(val.trim(), 10) : undefined;

            } else if (pick.id === 'maxMessages') {
                const val = await vscode.window.showInputBox({
                    title: 'Maximum message count (inclusive)',
                    value: current.maxMessages !== undefined ? String(current.maxMessages) : '',
                    placeHolder: 'e.g. 100  —  blank to remove',
                    validateInput: v => (!v || /^\d+$/.test(v)) ? undefined : 'Enter a whole number',
                });
                if (val === undefined) { return; }
                newFilter.maxMessages = val.trim() ? parseInt(val.trim(), 10) : undefined;
            }

            provider.setFilter(newFilter);
            treeView.description = provider.getDescription();
            provider.refresh();
            void vscode.commands.executeCommand('setContext', 'chatwizard.hasFilter', provider.hasActiveFilter());
        })
    );

    // ------------------------------------------------------------------
    // Code blocks filter command
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.filterCodeBlocks', async () => {
            const current = codeBlockProvider.getFilter();

            type FilterItem = vscode.QuickPickItem & { id: string };
            const items: FilterItem[] = [
                {
                    id: 'language',
                    label: '$(symbol-event)  Language contains…',
                    description: current.language ? `current: "${current.language}"` : undefined,
                },
                {
                    id: 'content',
                    label: '$(symbol-text)  Content contains…',
                    description: current.content ? `current: content:"${current.content}"` : undefined,
                },
                {
                    id: 'sessionSource',
                    label: '$(github)  Source (Copilot/Claude)',
                    description: current.sessionSource ? `current: ${current.sessionSource}` : undefined,
                },
                {
                    id: 'messageRole',
                    label: '$(person)  Role (User/AI)',
                    description: current.messageRole ? `current: ${current.messageRole}` : undefined,
                },
                {
                    id: '_clear',
                    label: '$(close)  Clear all filters',
                    alwaysShow: true,
                },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Filter Code Blocks',
                placeHolder: 'Choose a filter criterion to set (or clear all)',
            });
            if (!pick) { return; }

            if (pick.id === '_clear') {
                codeBlockProvider.clearFilter();
                codeBlockTreeView.description = codeBlockProvider.getDescription();
                codeBlockProvider.refresh();
                return;
            }

            const newFilter: CodeBlockFilter = { ...current };

            if (pick.id === 'language') {
                const val = await vscode.window.showInputBox({
                    title: 'Filter by language (case-insensitive substring)',
                    value: current.language ?? '',
                    placeHolder: 'e.g. typescript, python, javascript',
                });
                if (val === undefined) { return; }
                newFilter.language = val.trim() || undefined;

            } else if (pick.id === 'content') {
                const val = await vscode.window.showInputBox({
                    title: 'Filter by content (case-insensitive substring)',
                    value: current.content ?? '',
                    placeHolder: 'Search within code block content',
                });
                if (val === undefined) { return; }
                newFilter.content = val.trim() || undefined;

            } else if (pick.id === 'sessionSource') {
                const sourceItems: (vscode.QuickPickItem & { source?: 'copilot' | 'claude' })[] = [
                    { label: '$(github)  GitHub Copilot', source: 'copilot' },
                    { label: '$(hubot)  Claude Code', source: 'claude' },
                    { label: '$(close)  Clear filter', source: undefined },
                ];
                const sourcePick = await vscode.window.showQuickPick(sourceItems, {
                    title: 'Filter by source',
                });
                if (!sourcePick) { return; }
                newFilter.sessionSource = sourcePick.source;

            } else if (pick.id === 'messageRole') {
                const roleItems: (vscode.QuickPickItem & { role?: 'user' | 'assistant' })[] = [
                    { label: '$(person)  User', role: 'user' },
                    { label: '$(hubot)  AI Assistant', role: 'assistant' },
                    { label: '$(close)  Clear filter', role: undefined },
                ];
                const rolePick = await vscode.window.showQuickPick(roleItems, {
                    title: 'Filter by message role',
                });
                if (!rolePick) { return; }
                newFilter.messageRole = rolePick.role;
            }

            codeBlockProvider.setFilter(newFilter);
            codeBlockTreeView.description = codeBlockProvider.getDescription();
            codeBlockProvider.refresh();
        })
    );

    // ------------------------------------------------------------------
    // Pin / unpin commands
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.pinSession', (item: SessionTreeItem) => {
            provider.pin(item.summary.id);
            provider.refresh();
            savePins();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.unpinSession', (item: SessionTreeItem) => {
            provider.unpin(item.summary.id);
            provider.refresh();
            savePins();
        })
    );

    // ------------------------------------------------------------------
    // Other commands
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.openSession', (summary, searchTerm?: string) => {
            const session = index.get(summary.id);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${summary.id}`);
                return;
            }
            telemetry.record('session.opened', { source: session.source });
            SessionWebviewPanel.show(context, session, searchTerm);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.openSessionFromCodeBlock', (ref: CodeBlockSessionRef) => {
            const session = index.get(ref.sessionId);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${ref.sessionId}`);
                return;
            }

            // Reveal the session in the sessions tree view (best-effort)
            const sessionTreeItems = provider.getChildren();
            const sessionItem = sessionTreeItems.find(item => item.summary.id === ref.sessionId);
            if (sessionItem) {
                treeView.reveal(sessionItem, { select: true, focus: false });
            }

            // Open the session and scroll to / highlight code blocks
            SessionWebviewPanel.show(context, session, undefined, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.search', () => {
            telemetry.record('search.opened');
            SearchPanel.show(context, index, engine);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.showCodeBlocks', () => {
            CodeBlocksPanel.show(context, index, codeBlockEngine);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.showPromptLibrary', () => {
            PromptLibraryPanel.show(context, index);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.showAnalytics', () => {
            AnalyticsPanel.show(context, index);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.showTimeline', () => {
            void vscode.commands.executeCommand('chatwizardTimeline.focus');
        })
    );

    // React to configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('chatwizard.enableTelemetry')) {
                const cfg = vscode.workspace.getConfiguration('chatwizard');
                telemetry.setEnabled(cfg.get<boolean>('enableTelemetry') ?? false);
            }
            if (
                e.affectsConfiguration('chatwizard.claudeProjectsPath') ||
                e.affectsConfiguration('chatwizard.copilotStoragePath')
            ) {
                void vscode.window.showInformationMessage(
                    'ChatWizard: data source path changed — reload the window to apply.',
                    'Reload Window'
                ).then(action => {
                    if (action === 'Reload Window') {
                        void vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        })
    );

    telemetry.record('extension.activated', { sessionCount: index.size });

    registerExportCommands(context, index, () => provider.getSortedSummaries());

    // Export sessions selected via Ctrl+Click in the tree view.
    // VS Code passes (primaryItem, allSelectedItems) when canSelectMany is true.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'chatwizard.exportFromTreeSelection',
            async (item: SessionTreeItem, allSelected: SessionTreeItem[]) => {
                const items = (allSelected && allSelected.length > 0) ? allSelected : (item ? [item] : []);
                const sessions = items
                    .map(i => index.get(i.summary.id))
                    .filter((s): s is Session => s != null);
                await performExport(sessions);
            }
        )
    );
}

export function deactivate(): void {
    watcher?.dispose();
    watcher = undefined;
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
