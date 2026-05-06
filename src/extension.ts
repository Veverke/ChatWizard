import * as vscode from 'vscode';
import { SessionIndex } from './index/sessionIndex';
import { Session, ScopedWorkspace, SessionSource } from './types/index';
import { ChatWizardWatcher, startWatcher } from './watcher/fileWatcher';
import { WorkspaceScopeManager } from './watcher/workspaceScope';
import { discoverCopilotWorkspacesAsync } from './readers/copilotWorkspace';
import { discoverClaudeWorkspacesAsync } from './readers/claudeWorkspace';
import { discoverCursorWorkspacesAsync } from './readers/cursorWorkspace';
import { discoverWindsurfWorkspacesAsync } from './readers/windsurfWorkspace';
import { friendlySourceName, sourceCodiconId } from './ui/sourceUi';
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
    GroupMode,
} from './views/sessionTreeProvider';
import { CodeBlockTreeProvider, CodeBlockFilter, CbSortMode, CodeBlockSessionRef, CbGroupMode } from './views/codeBlockTreeProvider';
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
import { registerPaletteCommands } from './commands/paletteCommands';
import { SemanticIndexer } from './search/semanticIndexer';
import { EmbeddingEngine } from './search/embeddingEngine';
import { SemanticIndex } from './search/semanticIndex';
import { SemanticSearchPanel } from './search/semanticSearchPanel';
import { McpServer } from './mcp/mcpServer';
import { McpAuthManager } from './mcp/mcpAuthManager';
import { McpConfigHelper, McpConfigTarget } from './mcp/mcpConfigHelper';
import { SearchTool } from './mcp/tools/searchTool';
import { FindSimilarTool } from './mcp/tools/findSimilarTool';
import { GetSessionTool } from './mcp/tools/getSessionTool';
import { GetSessionFullTool } from './mcp/tools/getSessionFullTool';
import { ListRecentTool } from './mcp/tools/listRecentTool';
import { GetContextTool } from './mcp/tools/getContextTool';
import { ListSourcesTool } from './mcp/tools/listSourcesTool';
import { ServerInfoTool } from './mcp/tools/serverInfoTool';
import { ContextAnswerPrompt, ContinueFromHistoryPrompt, DebugWithHistoryPrompt } from './mcp/prompts/contextPrompts';
import { NullSemanticIndexer, ISemanticIndexer } from './search/semanticContracts';

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

    // ── Semantic search ──────────────────────────────────────────────────────────
    // Instantiated only when chatwizard.enableSemanticSearch is true.
    // The typed change listener below keeps it in sync with the main session index.
    const semanticEmbeddingsUri = vscode.Uri.joinPath(context.globalStorageUri, 'semantic-embeddings.bin');
    let semanticIndexer: SemanticIndexer | null = null;

    function createAndInitSemanticIndexer(): void {
        const indexer = new SemanticIndexer(
            context.globalStorageUri.fsPath,
            (cacheDir) => new EmbeddingEngine(cacheDir),
            () => new SemanticIndex(),
        );
        semanticIndexer = indexer;
        void indexer.initialize().then(() => {
            // Schedule sessions already loaded into the main index (runtime-enable case)
            for (const summary of index.getAllSummaries()) {
                const session = index.get(summary.id);
                if (session) {
                    indexer.scheduleSession(session);
                }
            }
        });
    }

    if (vscode.workspace.getConfiguration('chatwizard').get<boolean>('enableSemanticSearch') ?? false) {
        createAndInitSemanticIndexer();
    }

    // Dispose on extension deactivation (proxy follows the current semanticIndexer reference)
    context.subscriptions.push({ dispose: () => { semanticIndexer?.dispose(); } });

    // Keep the semantic index in sync with the main session index
    const semanticListener = index.addTypedChangeListener((event) => {
        if (!semanticIndexer) { return; }
        if (event.type === 'batch') {
            for (const session of event.sessions) {
                semanticIndexer.scheduleSession(session);
            }
        } else if (event.type === 'upsert') {
            semanticIndexer.scheduleSession(event.session);
        } else if (event.type === 'remove') {
            semanticIndexer.removeSession(event.sessionId);
        } else if (event.type === 'clear') {
            semanticIndexer.dispose();
            semanticIndexer = null;
            void vscode.workspace.fs.delete(semanticEmbeddingsUri).then(undefined, () => { /* ignore missing file */ });
            if (vscode.workspace.getConfiguration('chatwizard').get<boolean>('enableSemanticSearch') ?? false) {
                createAndInitSemanticIndexer();
            }
        }
    });
    context.subscriptions.push(semanticListener);

    // Proxy that delegates to the current semanticIndexer reference.
    // Passed into buildMcpTools() once so tools always see the live indexer
    // even when enableSemanticSearch is toggled at runtime without a reload.
    const _nullIndexerForProxy = new NullSemanticIndexer();
    const semanticProxy: ISemanticIndexer = {
        get isReady()      { return (semanticIndexer ?? _nullIndexerForProxy).isReady; },
        get isIndexing()   { return (semanticIndexer ?? _nullIndexerForProxy).isIndexing; },
        get indexedCount() { return (semanticIndexer ?? _nullIndexerForProxy).indexedCount; },
        initialize()       { return (semanticIndexer ?? _nullIndexerForProxy).initialize(); },
        scheduleSession(s) { return (semanticIndexer ?? _nullIndexerForProxy).scheduleSession(s); },
        removeSession(id)  { return (semanticIndexer ?? _nullIndexerForProxy).removeSession(id); },
        search(q, k, s)    { return (semanticIndexer ?? _nullIndexerForProxy).search(q, k, s); },
        dispose()          { /* proxy is not the owner; do nothing */ },
    };

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

    const provider = new SessionTreeProvider(index, context.extensionUri);

    // Restore persisted sort stack
    const savedStackJson = context.globalState.get<string>('sortStack');
    if (savedStackJson) {
        try {
            const saved = JSON.parse(savedStackJson) as SortStack;
            provider.restoreStack(saved);
        } catch { /* ignore corrupt state */ }
    }

    // Restore persisted session group mode (default: 'date' — matches provider default)
    const savedSessionGroupMode = context.globalState.get<string>('sessionGroupMode') as GroupMode | undefined;
    if (savedSessionGroupMode === 'none' || savedSessionGroupMode === 'date') {
        provider.setGroupMode(savedSessionGroupMode);
    }

    // Restore persisted code block group mode (default: 'language' — matches provider default)
    const savedCbGroupMode = context.globalState.get<string>('cbGroupMode') as CbGroupMode | undefined;
    if (savedCbGroupMode === 'none' || savedCbGroupMode === 'language') {
        codeBlockProvider.setGroupMode(savedCbGroupMode);
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
        void vscode.commands.executeCommand('setContext', 'chatwizard.sessionGrouped', provider.isGrouped());
    }
    syncContext();

    function syncCbGroupContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatwizard.cbGrouped', codeBlockProvider.isGrouped());
    }
    syncCbGroupContext();

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
                    id: 'source',
                    label: '$(extensions)  Source (AI assistant)…',
                    description: current.source ? `current: ${friendlySourceName(current.source)}` : undefined,
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

            } else if (pick.id === 'source') {
                const allSources: SessionSource[] = ['claude', 'copilot', 'cline', 'roocode', 'cursor', 'windsurf', 'aider', 'antigravity'];
                type SourceItem = vscode.QuickPickItem & { value: SessionSource | undefined };
                const sourceItems: SourceItem[] = [
                    { label: '$(close)  Show all sources', value: undefined },
                    ...allSources.map(s => ({
                        label: `$(${sourceCodiconId(s)})  ${friendlySourceName(s)}`,
                        value: s,
                        description: current.source === s ? 'current' : undefined,
                    })),
                ];
                const chosen = await vscode.window.showQuickPick(sourceItems, {
                    title: 'Filter by source (AI assistant)',
                });
                if (chosen === undefined) { return; }
                newFilter.source = chosen.value;

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
                    label: '$(symbol-class)  Source',
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
                const allSources: SessionSource[] = ['copilot', 'claude', 'cline', 'roocode', 'cursor', 'windsurf', 'aider', 'antigravity'];
                const sourceItems: (vscode.QuickPickItem & { source?: SessionSource })[] = [
                    ...allSources.map(s => ({
                        label: `$(${sourceCodiconId(s)})  ${friendlySourceName(s)}`,
                        source: s,
                    })),
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
    // Group toggle commands
    // ------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.toggleSessionGrouping', () => {
            const next: GroupMode = provider.getGroupMode() === 'date' ? 'none' : 'date';
            provider.setGroupMode(next);
            treeView.description = provider.getDescription();
            void context.globalState.update('sessionGroupMode', next);
            syncContext();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.enableSessionGrouping', () => {
            provider.setGroupMode('date');
            treeView.description = provider.getDescription();
            void context.globalState.update('sessionGroupMode', 'date');
            syncContext();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.disableSessionGrouping', () => {
            provider.setGroupMode('none');
            treeView.description = provider.getDescription();
            void context.globalState.update('sessionGroupMode', 'none');
            syncContext();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.toggleCbGrouping', () => {
            const next: CbGroupMode = codeBlockProvider.getGroupMode() === 'language' ? 'none' : 'language';
            codeBlockProvider.setGroupMode(next);
            codeBlockTreeView.description = codeBlockProvider.getDescription();
            void context.globalState.update('cbGroupMode', next);
            syncCbGroupContext();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.enableCbGrouping', () => {
            codeBlockProvider.setGroupMode('language');
            codeBlockTreeView.description = codeBlockProvider.getDescription();
            void context.globalState.update('cbGroupMode', 'language');
            syncCbGroupContext();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.disableCbGrouping', () => {
            codeBlockProvider.setGroupMode('none');
            codeBlockTreeView.description = codeBlockProvider.getDescription();
            void context.globalState.update('cbGroupMode', 'none');
            syncCbGroupContext();
        })
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
        vscode.commands.registerCommand('chatwizard.semanticSearch', () => {
            if (!semanticIndexer) {
                void vscode.window.showInformationMessage(
                    'Chat Wizard: Topic similarity search is disabled. Enable it in settings to find past sessions by topic.',
                    'Open Settings',
                ).then(action => {
                    if (action === 'Open Settings') {
                        void vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'chatwizard.enableSemanticSearch',
                        );
                    }
                });
                return;
            }
            SemanticSearchPanel.show(context, semanticIndexer, index);
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
            if (e.affectsConfiguration('chatwizard.enableSemanticSearch')) {
                const cfg = vscode.workspace.getConfiguration('chatwizard');
                const enabled = cfg.get<boolean>('enableSemanticSearch') ?? false;
                if (enabled && !semanticIndexer) {
                    createAndInitSemanticIndexer();
                } else if (!enabled && semanticIndexer) {
                    semanticIndexer.dispose();
                    semanticIndexer = null;
                }
            }
            if (
                e.affectsConfiguration('chatwizard.claudeProjectsPath') ||
                e.affectsConfiguration('chatwizard.copilotStoragePath') ||
                e.affectsConfiguration('chatwizard.cursorStoragePath')
            ) {
                const pathKeys = ['chatwizard.claudeProjectsPath','chatwizard.copilotStoragePath','chatwizard.cursorStoragePath'].filter(k => e.affectsConfiguration(k));
                channel.appendLine('[Chat Wizard] Data path setting changed (' + pathKeys.join(', ') + ') — re-discovering workspaces and restarting index...');
                void (async () => {
                    // Re-discover available workspaces under the new paths.
                    const [copilotWs, claudeWs, cursorWs, windsurfWs] = await Promise.all([
                        discoverCopilotWorkspacesAsync().then(list =>
                            list.map(ws => ({
                                id: ws.workspaceId,
                                source: 'copilot' as const,
                                workspacePath: ws.workspacePath,
                                storageDir: ws.storageDir,
                            }) satisfies ScopedWorkspace)
                        ).catch(() => [] as ScopedWorkspace[]),
                        discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
                        discoverCursorWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
                        discoverWindsurfWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
                    ]);
                    const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs, ...cursorWs, ...windsurfWs];

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
                e.affectsConfiguration('chatwizard.maxSessions') ||
                e.affectsConfiguration('chatwizard.indexCursor')
            ) {
                const filterKeys = ['chatwizard.oldestSessionDate','chatwizard.maxSessions','chatwizard.indexCursor'].filter(k => e.affectsConfiguration(k));
                channel.appendLine('[Chat Wizard] Session filter setting changed (' + filterKeys.join(', ') + ') — restarting index...');
                void watcher?.restart()
                    .then(() => channel.appendLine('[Chat Wizard] Watcher restarted after filter change.'))
                    .catch(err => channel.appendLine(`[error] Filter-change restart failed: ${err}`));
            }
        })
    );

    // ------------------------------------------------------------------
    // MCP server — Phase 4 wiring
    // ------------------------------------------------------------------
    const mcpCfg = vscode.workspace.getConfiguration('chatwizard');
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const mcpTokenPath = vscode.Uri.joinPath(context.globalStorageUri, 'mcp-token.txt').fsPath;
    const mcpAuthManager = new McpAuthManager((msg) => channel.appendLine(msg));
    const mcpConfigHelper = new McpConfigHelper();

    // Resolve the extension version once (used by ServerInfoTool).
    const extensionVersion = context.extension.packageJSON.version as string ?? '0.0.0';

    // Date the server instance was created (uptime reference).
    const mcpServerStartTime = new Date();

    // Build tools and prompts with shared instances so prompts can deterministically
    // pre-fetch context before the model composes its answer.
    function buildMcpCapabilities() {
        const searchTool = new SearchTool(engine, index);
        const findSimilarTool = new FindSimilarTool(semanticProxy, index);
        const listRecentTool = new ListRecentTool(index);
        const getContextTool = new GetContextTool(findSimilarTool, searchTool, index);

        const tools = [
            searchTool,
            findSimilarTool,
            new GetSessionTool(index),
            new GetSessionFullTool(index),
            listRecentTool,
            getContextTool,
            new ListSourcesTool(index),
            new ServerInfoTool(index, semanticProxy, extensionVersion, mcpServerStartTime),
        ];

        const prompts = [
            new ContextAnswerPrompt(getContextTool),
            new DebugWithHistoryPrompt(searchTool),
            new ContinueFromHistoryPrompt(listRecentTool, getContextTool),
        ];

        return { tools, prompts };
    }

    const mcpCapabilities = buildMcpCapabilities();

    const mcpServer = new McpServer(
        {
            enabled: mcpCfg.get<boolean>('mcpServer.enabled') ?? false,
            port: mcpCfg.get<number>('mcpServer.port') ?? 6789,
            tokenPath: mcpTokenPath,
        },
        mcpCapabilities.tools,
        mcpCapabilities.prompts,
        (msg) => channel.appendLine(msg),
        () => index.size,
    );
    context.subscriptions.push({ dispose: () => void mcpServer.stop() });

    // Ensure global instructions file exists even before MCP is started manually.
    void setupGlobalCopilotInstructions(context, channel, /* silent */ true);

    // ── Status bar item ────────────────────────────────────────────────────────
    const mcpStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    context.subscriptions.push(mcpStatusBar);

    function isCopilotConnected(port: number): boolean {
        const servers = vscode.workspace.getConfiguration('github.copilot.chat')
            .get<Record<string, unknown>>('mcpServers') ?? {};
        const entry = servers['chatwizard'] as { url?: string } | undefined;
        return typeof entry?.url === 'string' && entry.url.includes(`:${port}/`);
    }

    function updateMcpStatusBar(): void {
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const enabled = cfg.get<boolean>('mcpServer.enabled') ?? false;
        if (!enabled && !mcpServer.isRunning) {
            mcpStatusBar.hide();
            return;
        }
        const port = mcpServer.isRunning ? mcpServer.port : (cfg.get<number>('mcpServer.port') ?? 6789);
        if (mcpServer.isRunning) {
            if (isCopilotConnected(port)) {
                mcpStatusBar.text = '$(broadcast) MCP';
                mcpStatusBar.tooltip = `ChatWizard MCP server running on port ${port} — Copilot connected — click to stop`;
                mcpStatusBar.command = 'chatwizard.stopMcpServer';
            } else {
                mcpStatusBar.text = '$(broadcast) MCP $(warning)';
                mcpStatusBar.tooltip = `ChatWizard MCP server running on port ${port} — click to connect GitHub Copilot`;
                mcpStatusBar.command = 'chatwizard.connectCopilot';
            }
            mcpStatusBar.backgroundColor = undefined;
        } else {
            mcpStatusBar.text = '$(broadcast) MCP';
            mcpStatusBar.tooltip = `ChatWizard MCP server is stopped — click to start`;
            mcpStatusBar.command = 'chatwizard.startMcpServer';
            mcpStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        mcpStatusBar.show();
    }

    // ── Auto-start when enabled at activation ──────────────────────────────────
    // Only auto-start if the token file already exists (i.e. consent was given in a
    // previous session). If the token file is absent the user must run the explicit
    // "Start MCP Server" command so the first-run consent modal can be shown.
    if (mcpCfg.get<boolean>('mcpServer.enabled') ?? false) {
        void (async () => {
            const fsSync = await import('fs');
            if (!fsSync.existsSync(mcpTokenPath)) {
                channel.appendLine(
                    '[Chat Wizard] MCP auto-start skipped — no token file found. ' +
                    'Run "Chat Wizard: Start MCP Server" to initialise.'
                );
                updateMcpStatusBar(); // show the amber "stopped" indicator
                return;
            }
            try {
                await mcpServer.start();
                updateMcpStatusBar();
                // Ensure global Copilot instructions are present for plain-language prompts.
                void setupGlobalCopilotInstructions(context, channel, /* silent */ true);
            } catch (err) {
                channel.appendLine(`[Chat Wizard] MCP server auto-start failed: ${String(err)}`);
            }
        })();
    }

    // ── startMcpServer command ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.startMcpServer', async () => {
            if (mcpServer.isRunning) {
                void vscode.window.showInformationMessage(
                    `Chat Wizard MCP server is already running on port ${mcpServer.port}.`
                );
                return;
            }

            // First-run consent: show modal if no token file exists yet.
            const fs = await import('fs');
            const tokenExists = fs.existsSync(mcpTokenPath);
            if (!tokenExists) {
                const choice = await vscode.window.showWarningMessage(
                    'The MCP server will listen on localhost only. ' +
                    'A bearer token will be generated and stored in your VS Code extension storage. ' +
                    'Only tools you configure with this token can query your chat history. Continue?',
                    { modal: true },
                    'Enable',
                );
                if (choice !== 'Enable') { return; }
            }

            try {
                await mcpAuthManager.getOrCreateToken(mcpTokenPath);
                await mcpServer.start();
                updateMcpStatusBar();
                // Persist the enabled setting so the server auto-starts next session.
                await vscode.workspace.getConfiguration('chatwizard').update(
                    'mcpServer.enabled', true, vscode.ConfigurationTarget.Global
                );
                // Ensure global Copilot instructions are present for plain-language prompts.
                void setupGlobalCopilotInstructions(context, channel, /* silent */ true);
                const port = mcpServer.port;
                void vscode.window.showInformationMessage(
                    `Chat Wizard MCP server started on port ${port}. ` +
                    `Use 'Chat Wizard: Copy MCP Config to Clipboard' to set up your AI tool.`
                );
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Chat Wizard: Failed to start MCP server — ${String(err)}`
                );
            }
        })
    );

    // ── stopMcpServer command ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.stopMcpServer', async () => {
            if (!mcpServer.isRunning) {
                void vscode.window.showInformationMessage('Chat Wizard MCP server is not running.');
                return;
            }
            await mcpServer.stop();
            updateMcpStatusBar();
            void vscode.window.showInformationMessage('Chat Wizard MCP server stopped.');
        })
    );

    // ── copyMcpConfig command — quick-pick flow ────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.copyMcpConfig', async () => {
            type ToolItem = vscode.QuickPickItem & { target: McpConfigTarget };
            const toolItems: ToolItem[] = [
                { label: '$(copilot) GitHub Copilot', description: 'VS Code settings.json', target: 'copilot' },
                { label: '$(comment-discussion) Claude Desktop', description: 'claude_desktop_config.json', target: 'claude' },
                { label: '$(terminal) Cursor', description: '.cursor/mcp.json', target: 'cursor' },
                { label: '$(sync) Continue', description: '.continue/mcpServers/chatwizard.json', target: 'continue' },
                { label: '$(link) Generic (URL + token)', description: 'Any MCP-aware client', target: 'generic' },
            ];

            const picked = await vscode.window.showQuickPick(toolItems, {
                title: 'Copy MCP Config — choose your AI tool',
                placeHolder: 'Select the AI tool you want to configure',
            });
            if (!picked) { return; }

            const cfg2 = vscode.workspace.getConfiguration('chatwizard');
            const port = mcpServer.isRunning
                ? mcpServer.port
                : (cfg2.get<number>('mcpServer.port') ?? 6789);

            let token: string;
            try {
                const existing = await mcpAuthManager.readToken(mcpTokenPath);
                if (!existing) {
                    void vscode.window.showErrorMessage(
                        'Chat Wizard: No MCP token found. Run "Chat Wizard: Start MCP Server" first to initialise the server and generate a token.'
                    );
                    return;
                }
                token = existing;
            } catch {
                void vscode.window.showErrorMessage(
                    'Chat Wizard: Could not read MCP token. Start the MCP server first.'
                );
                return;
            }

            const snippet = mcpConfigHelper.getConfigSnippet(picked.target, port, token);
            await vscode.env.clipboard.writeText(snippet);

            const action = await vscode.window.showInformationMessage(
                `Config copied! Paste it into your tool's MCP configuration.`,
                'Show instructions',
            );

            if (action === 'Show instructions') {
                const instructions = mcpConfigHelper.getSetupInstructions(picked.target, port);
                const doc = await vscode.workspace.openTextDocument({
                    language: 'markdown',
                    content: instructions,
                });
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
            }
        })
    );

    // ── connectCopilot command ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.connectCopilot', async () => {
            const port = mcpServer.isRunning
                ? mcpServer.port
                : (vscode.workspace.getConfiguration('chatwizard').get<number>('mcpServer.port') ?? 6789);

            let token: string;
            try {
                const existing = await mcpAuthManager.readToken(mcpTokenPath);
                if (!existing) {
                    void vscode.window.showErrorMessage(
                        'Chat Wizard: No MCP token found. Run "Chat Wizard: Start MCP Server" first.'
                    );
                    return;
                }
                token = existing;
            } catch {
                void vscode.window.showErrorMessage(
                    'Chat Wizard: Could not read MCP token. Start the MCP server first.'
                );
                return;
            }

            const sseUrl = `http://localhost:${port}/sse`;
            // Use the root configuration with the full dotted key to avoid the
            // "not a registered configuration" error when Copilot is not installed
            // or not loaded (e.g. Extension Development Host).
            const rootCfg = vscode.workspace.getConfiguration();
            const existing = rootCfg.get<Record<string, unknown>>('github.copilot.chat.mcpServers') ?? {};
            const updated = {
                ...existing,
                chatwizard: {
                    type: 'sse',
                    url: sseUrl,
                    headers: { Authorization: `Bearer ${token}` },
                },
            };
            try {
                await rootCfg.update('github.copilot.chat.mcpServers', updated, vscode.ConfigurationTarget.Global);
                updateMcpStatusBar();
                void vscode.window.showInformationMessage(
                    `GitHub Copilot connected to ChatWizard MCP on port ${port}. No restart needed.`
                );
            } catch {
                // The VS Code config API rejects unregistered keys (e.g. when Copilot is not
                // loaded in the Extension Development Host). Use the document editing API so
                // VS Code handles JSONC parsing (comments, trailing commas) itself — no manual
                // regex stripping that breaks on control characters inside string values.
                try {
                    const pathModule = await import('path');
                    // globalStorageUri → …/User/globalStorage/<ext-id>/  →  up 2 levels → …/User/
                    const userDir = pathModule.resolve(context.globalStorageUri.fsPath, '../../');
                    const settingsPath = pathModule.join(userDir, 'settings.json');
                    const settingsUri = vscode.Uri.file(settingsPath);

                    // Open (or create) the document so VS Code owns the JSONC parsing.
                    const doc = await vscode.workspace.openTextDocument(settingsUri).then(
                        d => d,
                        async () => {
                            // File doesn't exist yet — create it empty then open.
                            await vscode.workspace.fs.writeFile(settingsUri, Buffer.from('{}', 'utf8'));
                            return vscode.workspace.openTextDocument(settingsUri);
                        }
                    );

                    // Build a targeted JSON patch: insert/replace only the key we own.
                    const newEntry = JSON.stringify(updated, null, 2);
                    const keyLine = '"github.copilot.chat.mcpServers"';
                    const fullText = doc.getText();

                    let newText: string;
                    const keyIdx = fullText.indexOf(keyLine);
                    if (keyIdx === -1) {
                        // Key absent — inject before the closing brace of the top-level object.
                        const closeIdx = fullText.lastIndexOf('}');
                        const prefix = fullText.slice(0, closeIdx).trimEnd();
                        const comma = prefix.endsWith('{') ? '' : ',';
                        newText = prefix + comma + '\n  ' + keyLine + ': ' + newEntry + '\n}';
                    } else {
                        // Key present — replace from the key through its value.
                        // Find the matching closing brace/bracket by scanning from the colon.
                        const colonIdx = fullText.indexOf(':', keyIdx + keyLine.length);
                        let depth = 0;
                        let valueEnd = colonIdx + 1;
                        let inStr = false;
                        for (let ci = colonIdx + 1; ci < fullText.length; ci++) {
                            const ch = fullText[ci];
                            if (inStr) {
                                if (ch === '\\') { ci++; continue; }
                                if (ch === '"') { inStr = false; }
                            } else {
                                if (ch === '"') { inStr = true; }
                                else if (ch === '{' || ch === '[') { depth++; }
                                else if (ch === '}' || ch === ']') {
                                    depth--;
                                    if (depth === 0) { valueEnd = ci + 1; break; }
                                }
                            }
                        }
                        newText = fullText.slice(0, keyIdx) + keyLine + ': ' + newEntry + fullText.slice(valueEnd);
                    }

                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(settingsUri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
                    await vscode.workspace.applyEdit(edit);
                    await doc.save();

                    updateMcpStatusBar();
                    void vscode.window.showInformationMessage(
                        `GitHub Copilot connected to ChatWizard MCP on port ${port}. No restart needed.`
                    );
                } catch (writeErr) {
                    void vscode.window.showErrorMessage(
                        `Chat Wizard: Could not write to settings.json — ${String(writeErr)}`
                    );
                }
            }
        })
    );

    // ── rotateMcpToken command ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.rotateMcpToken', async () => {
            const cfg3 = vscode.workspace.getConfiguration('chatwizard');
            const rotationAllowed = cfg3.get<boolean>('mcpServer.allowTokenRotation') ?? false;

            if (!rotationAllowed) {
                void vscode.window.showWarningMessage(
                    'Token rotation is disabled. Enable the "Chat Wizard: Allow Token Rotation" setting ' +
                    '(chatwizard.mcpServer.allowTokenRotation) first, then run this command again.',
                    'Open Settings',
                ).then(action => {
                    if (action === 'Open Settings') {
                        void vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'chatwizard.mcpServer.allowTokenRotation'
                        );
                    }
                });
                return;
            }

            const confirmed = await vscode.window.showWarningMessage(
                'Rotate the MCP bearer token?\n\n' +
                'This will immediately invalidate the current token. ' +
                'Every AI tool you have configured with the current token (Copilot, Claude, Cursor, Continue, etc.) ' +
                'will stop working until you copy the new config and update each tool manually. ' +
                'If the MCP server is currently running, it will restart automatically with the new token.',
                { modal: true },
                'Rotate Token',
            );
            if (confirmed !== 'Rotate Token') { return; }

            try {
                await mcpAuthManager.rotateToken(mcpTokenPath);

                // Restart the server so it loads the new token immediately.
                if (mcpServer.isRunning) {
                    await mcpServer.stop();
                    await mcpServer.start();
                    updateMcpStatusBar();
                }

                const copyAction = await vscode.window.showInformationMessage(
                    'MCP token rotated. Copy the new config and update every tool that was using the old token.',
                    'Copy New Config',
                );
                if (copyAction === 'Copy New Config') {
                    await vscode.commands.executeCommand('chatwizard.copyMcpConfig');
                }
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Chat Wizard: Failed to rotate MCP token — ${String(err)}`
                );
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
                    .filter((s): s is Session => s !== null && s !== undefined);
                await performExport(sessions);
            }
        )
    );

    // ── setupGlobalInstructions command ───────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.setupGlobalInstructions', async () => {
            await setupGlobalCopilotInstructions(context, channel);
        })
    );

    // Build the workspace scope manager (persists scope across VS Code restarts).
    const scopeManager = new WorkspaceScopeManager(context);

    // Register the manage-workspaces command (scope changes take effect via watcher.restart()).
    registerManageWorkspacesCommand(context, scopeManager, () => watcher, channel, index);
    registerPaletteCommands(context);

    // Yield for webview IPC round-trips, then start the file watcher in the background.
    // activate() returns immediately so VS Code is never blocked — the tree view is already
    // registered (empty) and will populate when batchUpsert() fires the change listeners.
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    void (async () => {
        // Discover all available workspaces to initialise the default scope.
        const [copilotWs, claudeWs, cursorWs, windsurfWs] = await Promise.all([
            discoverCopilotWorkspacesAsync().then(list =>
                list.map(ws => ({
                    id: ws.workspaceId,
                    source: 'copilot' as const,
                    workspacePath: ws.workspacePath,
                    storageDir: ws.storageDir,
                }) satisfies ScopedWorkspace)
            ).catch(() => [] as ScopedWorkspace[]),
            discoverClaudeWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
            discoverCursorWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
            discoverWindsurfWorkspacesAsync().catch(() => [] as ScopedWorkspace[]),
        ]);
        const allAvailable: ScopedWorkspace[] = [...copilotWs, ...claudeWs, ...cursorWs, ...windsurfWs];
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

/**
 * Writes a user-level ChatWizard instructions file to `~/.copilot/instructions`
 * so it is automatically applied across all workspaces.
 *
 * @param silent  When true, suppresses success/info UI popups.
 */
async function setupGlobalCopilotInstructions(
    context: vscode.ExtensionContext,
    channel: vscode.OutputChannel,
    silent = false,
): Promise<void> {
    void context; // Reserved for future migration/version tracking in globalState.

    const homeDir = process.env.USERPROFILE ?? process.env.HOME;
    if (!homeDir) {
        void vscode.window.showErrorMessage('Chat Wizard: Could not locate your home directory to set up global instructions.');
        return;
    }

    const instructionsDirUri = vscode.Uri.joinPath(vscode.Uri.file(homeDir), '.copilot', 'instructions');
    const instructionsUri = vscode.Uri.joinPath(instructionsDirUri, 'chatwizard-global.instructions.md');
    const instructionsPath = instructionsUri.fsPath;

    const instructionsContent = [
        '---',
        'name: ChatWizard Global Context Retrieval',
        'description: Always use ChatWizard MCP tools to retrieve prior decisions and debugging history.',
        'applyTo: "**"',
        '---',
        '',
        '# Copilot instructions for ChatWizard context retrieval',
        '',
        '## Context retrieval via ChatWizard MCP',
        '',
        'A ChatWizard MCP server is running with access to your full AI chat history across all projects.',
        'Use it before answering. These rules apply to every response:',
        '',
        '**On every architecture, design, or implementation question:**',
        'Call `chatwizard_get_context` with the core topic before answering.',
        'If results are found, reference them explicitly: "Based on a session on [date and time], you decided..."',
        '',
        '**On every error message or debugging question:**',
        'Call `chatwizard_search` with the exact error string or a short keyword form of it.',
        'If a matching session is found, open with: "You solved a similar issue on [date and time] - here is what worked:"',
        '',
        '**At the start of a new working session (when asked what to work on or how to continue):**',
        'Call `chatwizard_list_recent` with limit 5, then `chatwizard_get_session` on the most relevant result.',
        'Open with: "Your last session on this project was [date and time] - you were..." then summarise where the work stands and what the open question was.',
        '',
        '**Never say** "I do not have access to your previous conversations." You do - use the tools above.',
    ].join('\n');

    let alreadyConfigured = false;
    try {
        const existingBytes = await vscode.workspace.fs.readFile(instructionsUri);
        const existingContent = Buffer.from(existingBytes).toString('utf8');
        alreadyConfigured = existingContent === instructionsContent;
    } catch {
        alreadyConfigured = false;
    }

    if (alreadyConfigured) {
        channel.appendLine(`[Chat Wizard] Global instructions already present: ${instructionsPath}`);
        if (!silent) {
            void vscode.window.showInformationMessage('Chat Wizard: Global Copilot instructions are already set up.');
        }
        return;
    }

    try {
        await vscode.workspace.fs.createDirectory(instructionsDirUri);
        await vscode.workspace.fs.writeFile(instructionsUri, Buffer.from(instructionsContent, 'utf8'));
        channel.appendLine(`[Chat Wizard] Global instructions created: ${instructionsPath}`);

        const instructionLocations = vscode.workspace.getConfiguration().get<Record<string, boolean>>('chat.instructionsFilesLocations');
        if (instructionLocations && instructionLocations['~/.copilot/instructions'] === false) {
            if (!silent) {
                void vscode.window.showWarningMessage(
                    'Chat Wizard: ~/.copilot/instructions is disabled in chat.instructionsFilesLocations. Enable it so global instructions are applied.',
                    'Open Setting',
                ).then(choice => {
                    if (choice === 'Open Setting') {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'chat.instructionsFilesLocations');
                    }
                });
            }
        } else {
            if (!silent) {
                void vscode.window.showInformationMessage(
                    'Chat Wizard: Global Copilot instructions set up via ~/.copilot/instructions.',
                    'Open Instructions',
                ).then(choice => {
                    if (choice === 'Open Instructions') {
                        void vscode.window.showTextDocument(instructionsUri);
                    }
                });
            }
        }
    } catch (err) {
        channel.appendLine(`[Chat Wizard] Failed to write global instructions file: ${String(err)}`);
        void vscode.window.showErrorMessage(`Chat Wizard: Could not write global instructions file - ${String(err)}`);
    }
}
