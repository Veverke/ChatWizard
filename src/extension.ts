import * as vscode from 'vscode';
import { SessionIndex } from './index/sessionIndex';
import { Session, ScopedWorkspace } from './types/index';
import { ChatWizardWatcher, startWatcher } from './watcher/fileWatcher';
import { WorkspaceScopeManager } from './watcher/workspaceScope';
import { discoverCopilotWorkspacesAsync } from './readers/copilotWorkspace';
import { discoverClaudeWorkspacesAsync } from './readers/claudeWorkspace';
import {
    SessionTreeProvider,
    SessionTreeItem,
    LoadMoreTreeItem,
    SortMode,
    SortKey,
    SortCriterion,
    SortStack,
    SORT_KEY_LABELS,
    SessionFilter,
    SessionParseWarningDecorationProvider,
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
import { ModelUsageViewProvider } from './analytics/modelUsageViewProvider';
import { TimelineViewProvider } from './timeline/timelineViewProvider';
import { TelemetryRecorder } from './telemetry/telemetryRecorder';
import { registerManageWorkspacesCommand } from './commands/manageWorkspaces';

let watcher: ChatWizardWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const channel = vscode.window.createOutputChannel('Chat Wizard');
    context.subscriptions.push(channel);

    // Local telemetry recorder (opt-in, no external calls)
    const telemetry = new TelemetryRecorder(context.globalStorageUri.fsPath);
    const telemetryCfg = vscode.workspace.getConfiguration('chatwizard');
    telemetry.setEnabled(telemetryCfg.get<boolean>('enableTelemetry') ?? false);

    const index = new SessionIndex();

    // Register sidebar WebviewView providers BEFORE the slow file-indexing await so
    // VS Code can call resolveWebviewView() immediately with fresh shell HTML instead
    // of falling back to stale cached content (which can contain non-ASCII and break
    // document.write() with a SyntaxError before the providers are even registered).
    const promptLibraryViewProvider = new PromptLibraryViewProvider(index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PromptLibraryViewProvider.viewType, promptLibraryViewProvider)
    );

    const analyticsViewProvider = new AnalyticsViewProvider(index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AnalyticsViewProvider.viewType, analyticsViewProvider)
    );

    const modelUsageViewProvider = new ModelUsageViewProvider(context, index);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ModelUsageViewProvider.viewType, modelUsageViewProvider)
    );

    const timelineViewProvider = new TimelineViewProvider(index, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TimelineViewProvider.viewType, timelineViewProvider)
    );

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(new SessionParseWarningDecorationProvider())
    );

    // Build full-text search engine — populated lazily via the typed change listener.
    // The batch event fired by batchUpsert() (inside startWatcher) will index all sessions.
    const engine = new FullTextSearchEngine();
    // Incremental updates: only re-index the changed session instead of full rebuild
    const searchIndexListener = index.addTypedChangeListener((event) => {
        if (event.type === 'upsert') {
            engine.index(event.session);
        } else if (event.type === 'remove') {
            engine.remove(event.sessionId);
        } else if (event.type === 'batch') {
            for (const session of event.sessions) { engine.index(session); }
            const stats = engine.indexStats();
            channel.appendLine(
                `[Chat Wizard] Search index ready — ` +
                `indexed tokens: ${stats.indexedTokenCount.toLocaleString()}, ` +
                `hapax (single-session): ${stats.hapaxTokenCount.toLocaleString()}, ` +
                `postings: ${stats.postingCount.toLocaleString()}, ` +
                `~${stats.memoryEstimateKB} KB`
            );
        } else if (event.type === 'clear') {
            engine.clear();
        }
    });
    context.subscriptions.push(searchIndexListener);

    // Build code block engine — populated by the codeBlockListener when batchUpsert fires.
    const codeBlockEngine = new CodeBlockSearchEngine();

    // Register WebviewPanel serializers so VS Code calls our code (with clean getShellHtml())
    // instead of restoring stale cached panel HTML that may contain non-ASCII characters,
    // which causes a SyntaxError in VS Code's document.write() on restart.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('chatwizardAnalytics', {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                webviewPanel.webview.options = { enableScripts: true };
                webviewPanel.webview.html = AnalyticsPanel.getShellHtml();
                webviewPanel.onDidDispose(() => { /* VS Code handles cleanup */ }, null, context.subscriptions);
                webviewPanel.webview.onDidReceiveMessage((msg: { type: string }) => {
                    if (msg.type === 'ready') {
                        void webviewPanel.webview.postMessage({ type: 'update', data: AnalyticsPanel.build(index) });
                    }
                }, undefined, context.subscriptions);
                void webviewPanel.webview.postMessage({ type: 'update', data: AnalyticsPanel.build(index) });
            }
        })
    );
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('chatwizardCodeBlocks', {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                webviewPanel.webview.options = { enableScripts: true };
                webviewPanel.webview.html = CodeBlocksPanel.getShellHtml();
                webviewPanel.onDidDispose(() => { /* VS Code handles cleanup */ }, null, context.subscriptions);
                const blocks = index.getAllCodeBlocks();
                webviewPanel.webview.onDidReceiveMessage((msg: { type?: string; command?: string; text?: string }) => {
                    if (msg.command === 'copy') {
                        void vscode.env.clipboard.writeText(msg.text ?? '');
                    } else if (msg.type === 'ready') {
                        void webviewPanel.webview.postMessage({ type: 'update', data: CodeBlocksPanel.buildPayload(blocks, codeBlockEngine) });
                    }
                }, undefined, context.subscriptions);
                void webviewPanel.webview.postMessage({ type: 'update', data: CodeBlocksPanel.buildPayload(blocks, codeBlockEngine) });
            }
        })
    );
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('chatwizardPromptLibrary', {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                webviewPanel.dispose();
            }
        })
    );
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('chatwizardSession3', {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
                // Session panels need the session data; dispose gracefully.
                // The user can reopen from the Chat Sessions tree view.
                webviewPanel.dispose();
            }
        })
    );

    // Create code blocks tree provider (before the listener so it can reference both)
    const codeBlockProvider = new CodeBlockTreeProvider(index, codeBlockEngine);

    /** Build the standard tree-view empty-state message (matches the webview panels' empty-state UI). */
    function makeEmptyStateMsg(noun: string): string {
        return (
            `No ${noun} indexed yet.\n\n` +
            `Chat Wizard reads your Claude Code and GitHub Copilot chat history. ` +
            `Make sure the data paths are configured correctly.`
        );
    }

    const codeBlockListener = index.addChangeListener(() => {
        codeBlockEngine.index(index.getAllCodeBlocks());
        CodeBlocksPanel.refresh(index, codeBlockEngine);
        codeBlockTreeView.description = codeBlockProvider.getDescription();
        codeBlockTreeView.message = index.getAllCodeBlocks().length === 0 ? makeEmptyStateMsg('code blocks') : undefined;
    });
    context.subscriptions.push(codeBlockListener);

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

    // Keep treeView description (session count + sort) fresh when index changes
    const sessionDescListener = index.addChangeListener(() => {
        treeView.description = provider.getDescription();
        treeView.message = index.size === 0 ? makeEmptyStateMsg('sessions') : undefined;
    });
    context.subscriptions.push(sessionDescListener);

    const codeBlockTreeView = vscode.window.createTreeView('chatwizardCodeBlocks', {
        treeDataProvider: codeBlockProvider,
        canSelectMany: false,
    });
    codeBlockTreeView.description = codeBlockProvider.getDescription();
    // Show rich empty-state message initially (no data yet); cleared once code blocks are indexed.
    codeBlockTreeView.message = makeEmptyStateMsg('code blocks');
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
                    id: 'hideInterrupted',
                    label: current.hideInterrupted
                        ? '$(eye)  Show interrupted sessions'
                        : '$(eye-closed)  Hide interrupted sessions',
                    description: current.hideInterrupted ? 'currently hidden' : undefined,
                },
                {
                    id: 'onlyWithWarnings',
                    label: current.onlyWithWarnings
                        ? '$(warning)  Show all sessions'
                        : '$(warning)  Show only sessions with warnings',
                    description: current.onlyWithWarnings ? 'currently active' : undefined,
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

            } else if (pick.id === 'hideInterrupted') {
                newFilter.hideInterrupted = !current.hideInterrupted || undefined;

            } else if (pick.id === 'onlyWithWarnings') {
                newFilter.onlyWithWarnings = !current.onlyWithWarnings || undefined;
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
    // Load more commands (pagination)
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.loadMoreSessions', () => provider.loadMore())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.loadMoreCodeBlocks', () => codeBlockProvider.loadMore())
    );

    // ------------------------------------------------------------------
    // Other commands
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.openSession', (summary, searchTerm?: string, highlightContainer?: boolean) => {
            const session = index.get(summary.id);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${summary.id}`);
                return;
            }
            telemetry.record('session.opened', { source: session.source });
            SessionWebviewPanel.show(context, session, searchTerm, false, undefined, undefined, undefined, highlightContainer);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.openSessionFromCodeBlock', (ref: CodeBlockSessionRef) => {
            const session = index.get(ref.sessionId);
            if (!session) {
                vscode.window.showErrorMessage(`Session not found: ${ref.sessionId}`);
                return;
            }

            // Open the session and scroll to / highlight code blocks.
            // Parent (group) click: just open, no scroll. Leaf click: scroll to specific block.
            const isLeaf = ref.blocks.length === 1;
            const targetMsgIdx = isLeaf ? ref.blocks[0].messageIndex : undefined;
            const targetBlockIdx = isLeaf ? (ref.blocks[0].blockIndexInMessage ?? 0) : undefined;
            SessionWebviewPanel.show(context, session, undefined, isLeaf, targetMsgIdx, undefined, targetBlockIdx);
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

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.rescan', () => {
            void vscode.window.showInformationMessage(
                'Chat Wizard indexes sessions automatically via file system events. ' +
                'If sessions are missing, reload the window to trigger a fresh scan.',
                'Reload Window'
            ).then(action => {
                if (action === 'Reload Window') {
                    void vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
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
                channel.appendLine('[Chat Wizard] Data path setting changed — re-discovering workspaces and restarting index...');
                void (async () => {
                    // Re-discover available workspaces under the new paths.
                    const [copilotWs, claudeWs] = await Promise.all([
                        discoverCopilotWorkspacesAsync().then(list =>
                            list.map(ws => ({
                                id: ws.workspaceId,
                                source: 'copilot' as const,
                                workspacePath: ws.workspacePath,
                                storageDir: ws.storageDir,
                            }) satisfies ScopedWorkspace)
                        ).catch(() => [] as ScopedWorkspace[]),
                        discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
                    ]);
                    const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs];

                    // Reset to default so initDefault() re-detects from the new path.
                    scopeManager.resetToDefault();
                    await scopeManager.initDefault(allAvailable);

                    const selectedIds = scopeManager.getSelectedIds();
                    channel.appendLine(
                        `[Chat Wizard] Scope reset after path change — ${selectedIds.length} workspace(s): ${selectedIds.join(', ')}`
                    );

                    if (watcher) {
                        await watcher.restart();
                        channel.appendLine('[Chat Wizard] Watcher restarted after path change.');
                    }
                })().catch(err => channel.appendLine(`[error] Path-change restart failed: ${err}`));
            }
            if (
                e.affectsConfiguration('chatwizard.oldestSessionDate') ||
                e.affectsConfiguration('chatwizard.maxSessions')
            ) {
                channel.appendLine('[Chat Wizard] Session filter setting changed — restarting index...');
                void watcher?.restart()
                    .then(() => channel.appendLine('[Chat Wizard] Watcher restarted after filter change.'))
                    .catch(err => channel.appendLine(`[error] Filter-change restart failed: ${err}`));
            }
        })
    );

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

    // Build the workspace scope manager (persists scope across VS Code restarts).
    const scopeManager = new WorkspaceScopeManager(context);

    // Register the manage-workspaces command (scope changes take effect via watcher.restart()).
    registerManageWorkspacesCommand(context, scopeManager, () => watcher, channel, index);

    // Yield for webview IPC round-trips, then start the file watcher in the background.
    // activate() returns immediately so VS Code is never blocked — the tree view is already
    // registered (empty) and will populate when batchUpsert() fires the change listeners.
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    void (async () => {
        // Discover all available workspaces to initialise the default scope.
        const [copilotWs, claudeWs] = await Promise.all([
            discoverCopilotWorkspacesAsync().then(list =>
                list.map(ws => ({
                    id: ws.workspaceId,
                    source: 'copilot' as const,
                    workspacePath: ws.workspacePath,
                    storageDir: ws.storageDir,
                }) satisfies ScopedWorkspace)
            ).catch(() => [] as ScopedWorkspace[]),
            discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
        ]);
        const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs];
        channel.appendLine(
            `[Chat Wizard] Discovered ${allAvailable.length} workspace(s) for scope detection: ` +
            allAvailable.map(ws => `${ws.source}:${ws.id} (${ws.workspacePath})`).join(', ')
        );
        await scopeManager.initDefault(allAvailable);

        const selectedIds = scopeManager.getSelectedIds();
        channel.appendLine(
            `[Chat Wizard] Workspace scope initialised — ${selectedIds.length} workspace(s) selected: ${selectedIds.join(', ')}`
        );

        const w = await startWatcher(index, channel, scopeManager);
        watcher = w;
        context.subscriptions.push(w);
        const copilotCount = index.getSummariesBySource('copilot').length;
        const claudeCount = index.getSummariesBySource('claude').length;
        channel.appendLine(
            `Chat Wizard activated — ${index.size} sessions indexed (${copilotCount} Copilot, ${claudeCount} Claude)`
        );
        telemetry.record('extension.activated', { sessionCount: index.size });
    })().catch(err => channel.appendLine(`[error] Watcher init failed: ${err}`));
}

export function deactivate(): void {
    watcher?.dispose();
    watcher = undefined;
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
