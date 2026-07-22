import * as vscode from 'vscode';
import { SessionIndex } from './index/sessionIndex';
import { Session, ScopedWorkspace, SessionSource, ChronicleData } from './types/index';
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
    DateGroupTreeItem,
    ContextGroupTreeItem,
    FolderGroupTreeItem,
    LoadMoreTreeItem,
    SortMode,
    SortKey,
    SortCriterion,
    SortStack,
    SORT_KEY_LABELS,
    SessionFilter,
    SessionParseWarningDecorationProvider,
    GroupMode,
    getDateBucket,
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
import { KbViewProvider } from './analytics/kbViewProvider';
import { TelemetryRecorder } from './telemetry/telemetryRecorder';
import { registerManageWorkspacesCommand } from './commands/manageWorkspaces';
import { registerPaletteCommands } from './commands/paletteCommands';
import { registerSessionLifecycleCommands } from './commands/sessionLifecycleCommands';
import { SemanticIndexer, defaultVsCodeApi } from './search/semanticIndexer';
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
import { QueryHistoryPrompt, ContinueFromHistoryPrompt, GetPromptsPrompt } from './mcp/prompts/contextPrompts';
import { isNewerVersion } from './utils/semver';
import { createLogger, type BoundLogger } from './utils/logger';
import { loadUiState, saveUiState } from './utils/persistedUiState';
import { registerChatParticipant } from './mcp/chatParticipant';
import { NullSemanticIndexer, ISemanticIndexer } from './search/semanticContracts';
import { SidecarMetadataStore } from './index/sidecarMetadataStore';
import { FolderStore } from './index/folderStore';
import { SessionArchive } from './archive/sessionArchive';
import { SummaryGenerator, runSummaryBackgroundJob } from './analytics/summaryGenerator';
import { runEntityExtractionJob } from './analytics/entityExtractor';
import { ObsidianExporter } from './export/obsidianExporter';
import { NotionExporter } from './export/notionExporter';
import { SessionsForFileTool } from './mcp/tools/sessionsForFileTool';
import { SessionsForBranchTool } from './mcp/tools/sessionsForBranchTool';
import { SessionsForWorkItemTool } from './mcp/tools/sessionsForWorkItemTool';
import { FileHistoryStatusBarItem } from './ui/fileHistoryStatusBar';
import { BrandingStatusBarItem } from './ui/brandingStatusBar';
import { FileHistoryCodeLensProvider } from './ui/fileHistoryCodeLens';
import { FileHistoryPanel } from './views/fileHistoryPanel';
import { discoverChronicleDbsAsync } from './readers/chronicleWorkspace';
import { ActiveSessionTagButton } from './ui/activeSessionTagButton';
import { LiveSessionTracker } from './utils/liveSessionTracker';
import { PromptAnalyzer } from './analytics/promptAnalyzer';
import { readChronicleCheckpoints, readChronicleSessions } from './parsers/chronicle';
import { CacheIntegration } from './cache/cacheIntegration';
import { resolveSharedCacheDir } from './utils/sharedCachePath';
import { RestApiServer } from './api/restApiServer';
import { CloudSyncManager } from './cloud/cloudSyncManager';

let watcher: ChatWizardWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const startedAt = Date.now();

    const channel = vscode.window.createOutputChannel('Chat Wizard');
    context.subscriptions.push(channel);
    channel.appendLine('[Chat Wizard] activate() started.');

    const log = createLogger(channel).withContext('Activate');
    log.info('Extension activation started');

    // Log all chatwizard.* config settings at startup
    const cfg = vscode.workspace.getConfiguration('chatwizard');
    const allCfg = cfg.inspect<unknown>('');
    log.info('Configuration: enableSemanticSearch=%s logLevel=%s enableTelemetry=%s',
        cfg.get('enableSemanticSearch', true),
        cfg.get('logLevel', 'INFO'),
        cfg.get('enableTelemetry', false));

    // Local telemetry recorder (opt-in, no external calls)
    const telemetry = new TelemetryRecorder(context.globalStorageUri.fsPath);
    const telemetryCfg = vscode.workspace.getConfiguration('chatwizard');
    telemetry.setEnabled(telemetryCfg.get<boolean>('enableTelemetry') ?? false);

    // Non-blocking update check — rate-limited to once per day via globalState
    void checkForExtensionUpdate(context, channel);

    const index = new SessionIndex();

    // Feature 43: Apply session retention days from config (0 = no limit)
    const retentionDays = vscode.workspace.getConfiguration('chatwizard').get<number>('sessionRetentionDays', 0);
    if (retentionDays > 0) {
        index.setRetentionDays(retentionDays);
    }

    // ── Feature 24: SQLite Persistent Cache ──────────────────────────────────
    // Wrap in try/catch so a corrupt/unreadable DB does not block the entire
    // extension startup — the extension can still function without the cache.
    const enableCache = vscode.workspace.getConfiguration('chatwizard').get<boolean>('enablePersistentCache', true);
    let cacheIntegration: CacheIntegration | undefined;
    if (enableCache) {
        channel.appendLine('[Chat Wizard] Initialising SQLite persistent cache…');
        try {
            // Feature 24b (shared cache): resolve the cache directory from the
            // `chatwizard.sharedCacheDir` setting — empty string defaults to a
            // cross-IDE location outside any IDE's own app-data.
            const sharedDir = vscode.workspace.getConfiguration('chatwizard').get<string>('sharedCacheDir', '');
            const cacheDir = resolveSharedCacheDir(sharedDir);
            channel.appendLine(`[Chat Wizard] Cache directory: ${cacheDir}`);
            cacheIntegration = new CacheIntegration(cacheDir);
            channel.appendLine('[Chat Wizard] SQLite persistent cache initialised.');
        } catch (err) {
            channel.appendLine(`[Chat Wizard] SQLite cache init failed (continuing without cache): ${err}`);
        }
    }

    // Branding status-bar item — created early so all listeners below can call brandingBar.notify()
    const version = String(context.extension.packageJSON.version ?? '0.0.0');
    const brandingBar = new BrandingStatusBarItem(version);
    context.subscriptions.push(brandingBar);

    // Sidecar metadata store — persists pins, custom titles, tags etc. outside source files.
    const sidecarStore = new SidecarMetadataStore(context.globalStorageUri.fsPath);
    const liveTracker = new LiveSessionTracker();
    // Best-effort load so the store's in-memory cache is warm before tree renders.
    void sidecarStore.load().then(cache => {
        index.setSidecarStore(sidecarStore, cache);
    });
    // Wire the sidecar store into SessionWebviewPanel so bookmark/annotation toggles work.
    SessionWebviewPanel._sidecarStore = sidecarStore;
    // Refresh the index sidecar cache after bookmark/annotation changes so re-opened sessions see the latest data.
    SessionWebviewPanel._onSidecarChanged = async (sessionId: string) => {
        await index.refreshSidecarMeta(sessionId);
    };

    // Migrate legacy pin state from globalState → sidecarStore (run once, version-gated).
    if (context.globalState.get<string>('chatwizard.sidecarMigrationVersion') !== '1') {
        void (async () => {
            try {
                const pinnedJson = context.globalState.get<string>('pinnedIds');
                if (pinnedJson) {
                    const ids = JSON.parse(pinnedJson) as string[];
                    if (Array.isArray(ids)) {
                        for (const id of ids) {
                            await sidecarStore.setPin(id, true);
                        }
                        // Note: 'pinnedIds' is intentionally kept in globalState until
                        // pinning is fully migrated to the sidecar store in the tree provider.
                        channel.appendLine(`[sidecar] Migrated ${ids.length} pinned session(s) to sidecar store.`);
                    }
                }
            } catch (err) {
                channel.appendLine(`[sidecar] Migration failed: ${err}`);
            } finally {
                await context.globalState.update('chatwizard.sidecarMigrationVersion', '1');
            }
        })();
    }

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

    const kbViewProvider = new KbViewProvider(index, sidecarStore, context.globalState);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(KbViewProvider.viewType, kbViewProvider)
    );

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(new SessionParseWarningDecorationProvider())
    );

    // Build full-text search engine — populated lazily via the typed change listener.
    // The batch event fired by batchUpsert() (inside startWatcher) will index all sessions.
    const engine = new FullTextSearchEngine();
    engine.setMetadataGetter(id => index.getSidecarMeta(id));
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

    // Branding status-bar: notify on session batch load and live upserts
    const _cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
    let _brandingUpsertDebounce: ReturnType<typeof setTimeout> | undefined;
    let _brandingUpsertSources: string[] = [];
    const brandingSessionListener = index.addTypedChangeListener((event) => {
        if (event.type === 'batch' && event.sessions.length > 0) {
            const bySource = new Map<string, number>();
            for (const s of event.sessions) { bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1); }
            const detail = [...bySource.entries()].map(([src, n]) => `${_cap(src)}: ${n}`).join(', ');
            brandingBar.notify(`${event.sessions.length} sessions loaded (${detail})`);
        } else if (event.type === 'upsert') {
            _brandingUpsertSources.push(event.session.source ?? 'unknown');
            if (_brandingUpsertDebounce) { clearTimeout(_brandingUpsertDebounce); }
            _brandingUpsertDebounce = setTimeout(() => {
                const src = _cap(_brandingUpsertSources[0] ?? 'unknown');
                const n = _brandingUpsertSources.length;
                _brandingUpsertSources = [];
                brandingBar.notify(n === 1 ? `New ${src} session indexed` : `${n} sessions updated`);
            }, 3_000);
        }
    });
    context.subscriptions.push(brandingSessionListener);

    // ── Semantic search ──────────────────────────────────────────────────────────
    // Instantiated only when chatwizard.enableSemanticSearch is true (default).
    // The typed change listener below keeps it in sync with the main session index.
    const semanticEmbeddingsUri = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'semantic-embeddings.bin');
    let semanticIndexer: SemanticIndexer | null = null;

    function createAndInitSemanticIndexer(): void {
        try {
            const semanticLog = createLogger(channel).withContext('Semantic');
            const indexer = new SemanticIndexer(
                context.globalStorageUri.fsPath, // model cache dir (shared across workspaces)
                (cacheDir) => new EmbeddingEngine(cacheDir, undefined, semanticLog),
                () => new SemanticIndex(),
                defaultVsCodeApi(context.globalState),
                undefined, /* queueStartDebounceMs */
                semanticLog,
                semanticEmbeddingsUri.fsPath, // embeddings file (per-workspace)
            );
            channel.appendLine('[Chat Wizard] SemanticIndexer constructed.');
            // Feature 43: Apply semantic index max age from config
            const maxAgeDays = vscode.workspace.getConfiguration('chatwizard').get<number>('semanticIndexMaxAgeDays', 365);
            if (maxAgeDays > 0) {
                indexer.setMaxAgeDays(maxAgeDays);
                channel.appendLine(`[Chat Wizard] Semantic index max age set to ${maxAgeDays} days.`);
            }
            semanticIndexer = indexer;
            void indexer.initialize().then(() => {
                // Schedule sessions already loaded into the main index (runtime-enable case)
                const summaries = index.getAllSummaries();
                channel.appendLine(`[Chat Wizard] Semantic indexer ready — scheduling ${summaries.length} existing session(s).`);
                let cachedCount = 0;
                for (const summary of summaries) {
                    const session = index.get(summary.id);
                    if (session) {
                        indexer.scheduleSession(session);
                    }
                }
                // Notify user about cached embeddings (counted per-workspace)
                cachedCount = indexer.indexedCount;
                if (cachedCount > 0) {
                    channel.appendLine(`[Chat Wizard] ${cachedCount} session(s) restored from cache for this workspace.`);
                }
            }).catch((err: unknown) => {
                channel.appendLine(`[Chat Wizard] Semantic indexer init failed: ${err}`);
                void vscode.window.showErrorMessage(
                    `Chat Wizard: Failed to initialize semantic search — ${String(err)}. Reload VS Code to retry.`
                );
            });
        } catch (err) {
            channel.appendLine(`[Chat Wizard] Failed to construct SemanticIndexer: ${err}`);
            // Don't throw — the extension can still function without semantic search.
        }
    }

    if (vscode.workspace.getConfiguration('chatwizard').get<boolean>('enableSemanticSearch') ?? true) {
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
            if (vscode.workspace.getConfiguration('chatwizard').get<boolean>('enableSemanticSearch') ?? true) {
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

    // NOTE: codeBlockListener is registered AFTER codeBlockTreeView is declared (below)
    // to avoid a temporal dead zone ReferenceError when the listener fires during init.

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

    const kbListener = index.addChangeListener(() => {
        kbViewProvider.refresh();
    });
    context.subscriptions.push(kbListener);

    // ── Feature 12: Session archive ──────────────────────────────────────────
    // Registered here (before startWatcher) so it receives the initial batch event.
    const archive = new SessionArchive(context.globalStorageUri.fsPath);
    const archiveListener = index.addTypedChangeListener((event) => {
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const maxAgeDays = cfg.get<number>('archive.maxAgeDays', 0);
        const maxSizeMB  = cfg.get<number>('archive.maxSizeMB',  0);

        const archiveSession = async (session: import('./types').Session) => {
            if (archive.has(session.id, session.source)) { return; }
            await archive.save(session.id, session.source, JSON.stringify(session));
        };

        if (event.type === 'batch') {
            // Skip restoring archive-only sessions on the second (archive-restore) batch
            // to avoid an infinite loop: only act when the batch contains non-archived sessions.
            if (event.sessions.some(s => !s.archived)) {
                void (async () => {
                    await archive.init();
                    await Promise.all(event.sessions.filter(s => !s.archived).map(archiveSession));
                    const pruned = await archive.prune({ maxAgeDays, maxSizeMB });

                    // 12-D: restore sessions that exist in the archive but not in the live index
                    const allArchived = await archive.loadAllSources();
                    const archivedOnly: import('./types').Session[] = [];
                    for (const entry of allArchived) {
                        if (!index.get(entry.sessionId)) {
                            const raw = await archive.loadRaw(entry.sessionId, entry.source);
                            if (raw) {
                                try {
                                    const session = { ...JSON.parse(raw) as import('./types').Session, archived: true as const };
                                    archivedOnly.push(session);
                                } catch { /* ignore corrupt archive entries */ }
                            }
                        }
                    }

                    const stats = await archive.stats();
                    channel.appendLine(
                        `[Archive] ${stats.totalSessions} session(s) archived ` +
                        `(${(stats.totalBytes / 1024).toFixed(1)} KB)` +
                        (pruned > 0 ? `, pruned ${pruned}` : '') +
                        (archivedOnly.length > 0 ? `, restored ${archivedOnly.length} from archive` : '')
                    );

                    if (archivedOnly.length > 0) {
                        index.batchUpsert(archivedOnly);
                    }
                })();
            }
        } else if (event.type === 'upsert') {
            void archiveSession(event.session);
        } else if (event.type === 'remove') {
            // Source file was deleted — re-surface the archived copy in the live index
            void (async () => {
                const entry = await archive.findAnySource(event.sessionId);
                if (!entry) { return; }
                const raw = await archive.loadRaw(entry.sessionId, entry.source);
                if (!raw) { return; }
                try {
                    const restored = { ...JSON.parse(raw) as import('./types').Session, archived: true as const };
                    index.upsert(restored);
                } catch { /* ignore corrupt archive entry */ }
            })();
        }
    });
    context.subscriptions.push(archiveListener);

    // ── Feature 24: Cache listener — persist sessions to SQLite ──────────────
    if (cacheIntegration) {
        const cacheListener = index.addTypedChangeListener((event) => {
            if (event.type === 'batch') {
                cacheIntegration.ingestSessions(index, event.sessions);
            } else if (event.type === 'upsert') {
                cacheIntegration.ingestSessions(index, [event.session]);
            } else if (event.type === 'remove') {
                cacheIntegration.removeSession(event.sessionId);
            } else if (event.type === 'clear') {
                channel.appendLine('[Chat Wizard] Cache cleared due to index clear.');
            }
        });
        context.subscriptions.push(cacheListener);

        // Register dispose for cache on deactivation
        context.subscriptions.push({ dispose: () => cacheIntegration.dispose() });
    }

    const provider = new SessionTreeProvider(index, context.extensionUri);

    // Restore consolidated UI state (Item 10) — single globalState read instead of 5.
    const uiState = loadUiState(context);
    if (uiState.sortStack.length > 0) { provider.restoreStack(uiState.sortStack); }
    if (uiState.pinnedIds.length > 0) { provider.setPinnedIds(uiState.pinnedIds); }
    if (uiState.manualOrder.length > 0) { provider.setManualOrder(uiState.manualOrder); }
    provider.setGroupMode(uiState.sessionGroupMode);
    codeBlockProvider.setGroupMode(uiState.cbGroupMode);

    // ── Feature: Folder store ────────────────────────────────────────────
    const folderStore = new FolderStore(context.globalStorageUri.fsPath);
    // Best-effort load so the in-memory cache is warm before folder tree render.
    void folderStore.load().then(() => {
        provider.setFolderStore(folderStore);
    });
    // If the store was already loaded (cache warm), attach immediately.
    if (folderStore.getCached()) {
        provider.setFolderStore(folderStore);
    }

    // Push current sort state to VS Code context (drives toolbar icon when clauses)
    function syncContext(): void {
        const primary = provider.getPrimary();
        void vscode.commands.executeCommand('setContext', 'chatwizard.sortKey', primary.key);
        void vscode.commands.executeCommand('setContext', 'chatwizard.sortDir', primary.direction);
        void vscode.commands.executeCommand('setContext', 'chatwizard.hasFilter', provider.hasActiveFilter());
        void vscode.commands.executeCommand('setContext', 'chatwizard.sessionGrouped', provider.isGrouped());
        void vscode.commands.executeCommand('setContext', 'chatwizard.sessionGroupMode', provider.getGroupMode());
    }
    syncContext();

    function syncCbGroupContext(): void {
        void vscode.commands.executeCommand('setContext', 'chatwizard.cbGrouped', codeBlockProvider.isGrouped());
    }
    syncCbGroupContext();

    /** Persist all UI state in a single globalState write (Item 10). */
    function saveUiStateNow(): void {
        saveUiState(context, {
            sortStack: provider.getSortStack(),
            pinnedIds: provider.getPinnedIds(),
            manualOrder: provider.getManualOrder(),
            sessionGroupMode: provider.getGroupMode(),
            cbGroupMode: codeBlockProvider.getGroupMode(),
        });
    }
    function savePins(): void { saveUiStateNow(); }

    // Drag-and-drop controller for reordering tree items and folder assignment
    const dragDropController: vscode.TreeDragAndDropController<SessionTreeItem | FolderGroupTreeItem> = {
        dragMimeTypes: ['application/vnd.chatwizard.session', 'application/vnd.chatwizard.folder'],
        dropMimeTypes: ['application/vnd.chatwizard.session', 'application/vnd.chatwizard.folder'],
        handleDrag(items, dataTransfer) {
            const sessionIds: string[] = [];
            const folderIds: string[] = [];
            for (const item of items) {
                if (item instanceof FolderGroupTreeItem) {
                    folderIds.push(item.folder.id);
                } else {
                    sessionIds.push(item.summary.id);
                }
            }
            if (sessionIds.length > 0) {
                dataTransfer.set(
                    'application/vnd.chatwizard.session',
                    new vscode.DataTransferItem(sessionIds)
                );
            }
            if (folderIds.length > 0) {
                dataTransfer.set(
                    'application/vnd.chatwizard.folder',
                    new vscode.DataTransferItem(folderIds)
                );
            }
        },
        async handleDrop(target, dataTransfer) {
            // Dropping session(s) onto a folder → move to folder
            const draggedSessions = dataTransfer.get('application/vnd.chatwizard.session');
            if (draggedSessions && target instanceof FolderGroupTreeItem) {
                const ids = draggedSessions.value as string[];
                for (const id of ids) {
                    await folderStore.moveSessionToFolder(id, target.folder.id);
                }
                provider.refresh();
                treeView.description = provider.getDescription();
                return;
            }

            // Dropping session(s) onto (uncategorized) → remove from any folder
            if (draggedSessions && target instanceof vscode.TreeItem && (target as vscode.TreeItem).id === 'folder:__uncategorized__') {
                const ids = draggedSessions.value as string[];
                for (const id of ids) {
                    await folderStore.moveSessionToFolder(id, undefined);
                }
                provider.refresh();
                treeView.description = provider.getDescription();
                return;
            }

            // Dropping folder(s) onto a folder → make subfolder
            const draggedFolders = dataTransfer.get('application/vnd.chatwizard.folder');
            if (draggedFolders && target instanceof FolderGroupTreeItem) {
                const ids = draggedFolders.value as string[];
                for (const id of ids) {
                    try {
                        await folderStore.moveFolder(id, target.folder.id);
                    } catch (err) {
                        void vscode.window.showErrorMessage(`Failed to move folder: ${err}`);
                    }
                }
                provider.refresh();
                treeView.description = provider.getDescription();
                return;
            }

            // Default: reorder sessions in flat/grouped list
            const dragged = dataTransfer.get('application/vnd.chatwizard.session');
            if (!dragged) { return; }
            const ids = dragged.value as string[];
            if (target && 'summary' in target) {
                provider.reorder(ids, (target as SessionTreeItem).summary.id);
            }
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

    // ── Register session lifecycle commands (Features 28-32, 35) ──────────
    registerSessionLifecycleCommands(context, sidecarStore, index, provider, treeView as vscode.TreeView<SessionTreeItem>);

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

    // Register codeBlockListener here (after codeBlockTreeView is initialised)
    // to avoid accessing the const before its declaration (TDZ ReferenceError).
    let _prevCodeBlockCount = 0;
    const codeBlockListener = index.addChangeListener(() => {
        const blocks = index.getAllCodeBlocks(); // single allocation per event
        codeBlockEngine.index(blocks);
        CodeBlocksPanel.refresh(index, codeBlockEngine);
        codeBlockTreeView.description = codeBlockProvider.getDescription();
        codeBlockTreeView.message = blocks.length === 0 ? makeEmptyStateMsg('code blocks') : undefined;
        if (blocks.length > _prevCodeBlockCount) {
            const added = blocks.length - _prevCodeBlockCount;
            brandingBar.notify(`${added} new code block${added === 1 ? '' : 's'} extracted`, 'chatwizard.showCodeBlocks');
        }
        _prevCodeBlockCount = blocks.length;
    });
    context.subscriptions.push(codeBlockListener);

    /** Apply a single-key primary sort (toolbar buttons). */
    function applySort(mode: SortMode): void {
        provider.setSortMode(mode);
        treeView.description = provider.getDescription();
        provider.refresh();
        syncContext();
        saveUiStateNow();
    }

    /** Apply a full sort stack (from the sort builder). */
    function applyStack(stack: SortStack): void {
        provider.setSortStack(stack);
        treeView.description = provider.getDescription();
        provider.refresh();
        syncContext();
        saveUiStateNow();
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
                    id: 'status',
                    label: '$(symbol-misc)  Session Status…',
                    description: current.status
                        ? `current: ${current.status}`
                        : undefined,
                },
                {
                    id: 'tags',
                    label: '$(tag)  Tags…',
                    description: current.tags && current.tags.length > 0
                        ? `current: ${current.tags.map(t => `#${t}`).join(', ')}`
                        : undefined,
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

            } else if (pick.id === 'status') {
                type StatusItem = vscode.QuickPickItem & { value: 'open' | 'resolved' | 'revisit' | undefined };
                const statusItems: StatusItem[] = [
                    { label: '$(circle)  Open', value: 'open', description: current.status === 'open' ? 'current' : undefined },
                    { label: '$(check)  Resolved', value: 'resolved', description: current.status === 'resolved' ? 'current' : undefined },
                    { label: '$(refresh)  Revisit', value: 'revisit', description: current.status === 'revisit' ? 'current' : undefined },
                    { label: '$(close)  Clear filter', value: undefined },
                ];
                const chosen = await vscode.window.showQuickPick(statusItems, {
                    title: 'Filter by Session Status',
                    placeHolder: 'Choose a status',
                });
                if (chosen === undefined) { return; }
                newFilter.status = chosen.value;

            } else if (pick.id === 'tags') {
                const allTags = await sidecarStore.getAllTags();
                if (allTags.length === 0) { void vscode.window.showInformationMessage('No tags defined yet.'); return; }
                const tagItems = allTags.map(t => ({
                    label: `#${t.tag}`,
                    description: `${t.count} session${t.count === 1 ? '' : 's'}`,
                    picked: current.tags?.includes(t.tag) ?? false,
                }));
                const chosen = await vscode.window.showQuickPick(tagItems, {
                    title: 'Filter by tags — sessions matching any selected tag',
                    canPickMany: true,
                });
                if (chosen === undefined) { return; }
                newFilter.tags = chosen.length > 0 ? chosen.map(c => c.label.slice(1)) : undefined;
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
                    label: '$(symbol-event)  Language',
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
                const langs = codeBlockProvider.getLanguages();
                type LangItem = vscode.QuickPickItem & { lang: string | undefined };
                const langItems: LangItem[] = [
                    ...langs.map(l => ({
                        label: l || '[No Language]',
                        lang: l,
                        description: current.language === l ? 'current' : undefined,
                    })),
                    { label: '$(close)  Clear filter', lang: undefined },
                ];
                const langPick = await vscode.window.showQuickPick(langItems, {
                    title: 'Filter by language',
                    placeHolder: 'Select a language',
                });
                if (!langPick) { return; }
                newFilter.language = langPick.lang;

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
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.revealSessionInExplorer', async (item: SessionTreeItem) => {
            if (item.summary.archived) {
                // Original source file has been deleted — reveal the JSON copy in the ChatWizard archive.
                const entry = await archive.findAnySource(item.summary.id);
                if (!entry) {
                    vscode.window.showErrorMessage('Archived file not found in the ChatWizard archive.');
                    return;
                }
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.filePath));
            } else {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.summary.filePath));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.archiveSession', async (item: SessionTreeItem) => {
            const summary = item.summary;
            if (summary.archived) { return; }

            // Cursor (and similar) use a shared .vscdb SQLite file — deleting it would
            // remove all sessions stored in that database, not just this one.
            if (summary.filePath.endsWith('.vscdb') || summary.filePath.endsWith('.db')) {
                vscode.window.showErrorMessage(
                    `Cannot archive ${friendlySourceName(summary.source)} sessions: ` +
                    `the source file is a shared database and cannot be safely deleted.`
                );
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Archive "${summary.title}"?\n\n` +
                `The original source file will be permanently deleted — only the ChatWizard copy will remain.`,
                { modal: true },
                'Archive'
            );
            if (confirm !== 'Archive') { return; }

            // Ensure the session is saved to the archive before the source is removed
            const session = index.get(summary.id);
            if (!session) {
                vscode.window.showErrorMessage('Session not found in index — cannot archive.');
                return;
            }
            try {
                // Mark as userArchived in the stored copy so the flag survives restore.
                await archive.save(session.id, session.source, JSON.stringify({ ...session, userArchived: true }));
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to write to archive: ${err}`);
                return;
            }

            // Delete the source file. The file watcher fires onDidDelete → index.remove
            // → archive listener re-surfaces the session with archived: true.
            try {
                const { promises: fsPromises } = await import('fs');
                await fsPromises.unlink(summary.filePath);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to delete source file: ${err}`);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.deleteArchivedSession', async (item: SessionTreeItem) => {
            const summary = item.summary;
            if (!summary.archived) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete "${summary.title}"?\n\n` +
                `The ChatWizard archive copy will be deleted. This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }

            // Remove from archive on disk
            const session = index.get(summary.id);
            const source = session?.source ?? summary.source;
            await archive.delete(summary.id, source);

            // Remove from the live index — no restore will happen because the archive
            // entry is now gone
            index.remove(summary.id);
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
        vscode.commands.registerCommand('chatwizard.groupSessions', async () => {
            const hasBranch = provider.hasBranchData();
            const hasWorkItems = provider.hasWorkItems();
            const hasTags = provider.hasTags();
            const hasFolders = folderStore.getCached() !== null && folderStore.getCached()!.size > 0;
            const current = provider.getGroupMode();
            const workItemPattern = vscode.workspace.getConfiguration('chatwizard').get<string>('workItemPattern', '');

            const items: Array<{ label: string; description?: string; mode: GroupMode }> = [
                { label: '$(list-flat) No grouping',    mode: 'none' },
                { label: '$(calendar) Group by Date',   mode: 'date' },
                { label: `$(git-branch) Group by Branch${!hasBranch ? '  \u2014 open chats to populate' : ''}`, mode: 'branch' },
                { label: `$(bookmark) Group by Tag${!hasTags ? '  \u2014 tag sessions to populate' : ''}`, mode: 'tag' },
                ...(workItemPattern ? [{ label: '$(tag) Group by Work Item', mode: 'workItem' as GroupMode,
                  description: hasWorkItems ? undefined : 'No work items found in sessions' }] : []),
                { label: `$(folder) Group by Folder${!hasFolders ? '  \u2014 create folders to organize' : ''}`, mode: 'folder' as GroupMode },
            ];

            const activeLabel = {
                none: '$(list-flat) No grouping',
                date: '$(calendar) Group by Date',
                branch: `$(git-branch) Group by Branch${!hasBranch ? '  \u2014 open chats to populate' : ''}`,
                tag: `$(bookmark) Group by Tag${!hasTags ? '  \u2014 tag sessions to populate' : ''}`,
                workItem: workItemPattern ? '$(tag) Group by Work Item' : undefined,
                folder: `$(folder) Group by Folder${!hasFolders ? '  \u2014 create folders to organize' : ''}`,
            }[current];

            const picked = await vscode.window.showQuickPick(
                items.map(i => ({ ...i, picked: i.label === activeLabel })),
                { placeHolder: 'Choose how to group sessions\u2026', title: 'Group Sessions' },
            );
            if (!picked) { return; }

            if (picked.mode === 'workItem' && !hasWorkItems) {
                void vscode.window.showInformationMessage(
                    'No work items found. Add ticket references (e.g. prefix-12345) to session titles, or set chatwizard.workItemPattern in settings.',
                    'Open Settings',
                ).then(choice => {
                    if (choice === 'Open Settings') {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'chatwizard.workItemPattern');
                    }
                });
                return;
            }

            provider.setGroupMode(picked.mode);
            treeView.description = provider.getDescription();
            void context.globalState.update('sessionGroupMode', picked.mode);
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

    // ------------------------------------------------------------------
    // Folder management commands
    // ------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.createFolder', async () => {
            const name = await vscode.window.showInputBox({
                title: 'Create New Folder',
                placeHolder: 'Folder name',
                prompt: 'Enter a name for the new folder',
                validateInput: v => v && v.trim().length > 0 ? undefined : 'Name is required',
            });
            if (!name) { return; }
            try {
                const folder = await folderStore.createFolder(name);
                // If folder store wasn't attached yet, attach it
                if (!provider.getFolderStore()) {
                    provider.setFolderStore(folderStore);
                }
                // Auto-switch to folder group mode
                if (provider.getGroupMode() !== 'folder') {
                    provider.setGroupMode('folder');
                    void context.globalState.update('sessionGroupMode', 'folder');
                    syncContext();
                }
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to create folder: ${err}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.createSubfolder', async (item: FolderGroupTreeItem) => {
            const name = await vscode.window.showInputBox({
                title: 'Create Subfolder',
                placeHolder: 'Subfolder name',
                prompt: `Enter a name for the new subfolder under "${item.folder.name}"`,
                validateInput: v => v && v.trim().length > 0 ? undefined : 'Name is required',
            });
            if (!name || !item.folder) { return; }
            try {
                const folder = await folderStore.createFolder(name, item.folder.id);
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to create subfolder: ${err}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.renameFolder', async (item: FolderGroupTreeItem) => {
            if (!item.folder) { return; }
            const name = await vscode.window.showInputBox({
                title: 'Rename Folder',
                placeHolder: 'New folder name',
                value: item.folder.name,
                validateInput: v => v && v.trim().length > 0 ? undefined : 'Name is required',
            });
            if (!name) { return; }
            try {
                await folderStore.renameFolder(item.folder.id, name);
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to rename folder: ${err}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.deleteFolder', async (item: FolderGroupTreeItem) => {
            if (!item.folder) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `Delete folder "${item.folder.name}"?\n\n` +
                `Sessions inside the folder will be moved to (uncategorized). ` +
                `Subfolders will also be removed. This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }
            try {
                await folderStore.deleteFolder(item.folder.id);
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to delete folder: ${err}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.moveSessionToFolder', async (item: SessionTreeItem) => {
            const allFolders = await folderStore.getAll();
            if (allFolders.size === 0) {
                void vscode.window.showInformationMessage('No folders exist. Create one first.');
                return;
            }
            const currentFolderId = await folderStore.getSessionFolderId(item.summary.id);
            const picks = Array.from(allFolders.values())
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(f => ({
                    label: `${f.parentId ? '  ' : ''}📁 ${f.name}`,
                    description: currentFolderId === f.id ? 'current' : undefined,
                    folderId: f.id,
                }));
            picks.unshift({ label: '$(close) Remove from folder', description: currentFolderId ? undefined : 'current', folderId: '__none__' });

            const chosen = await vscode.window.showQuickPick(picks, {
                title: `Move "${item.summary.title}" to folder`,
                placeHolder: 'Choose a folder',
            });
            if (!chosen) { return; }
            try {
                await folderStore.moveSessionToFolder(item.summary.id, chosen.folderId === '__none__' ? undefined : chosen.folderId);
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to move session: ${err}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.addSessionToFolder', async (item: SessionTreeItem, folderId?: string) => {
            if (!folderId) { return; }
            try {
                await folderStore.moveSessionToFolder(item.summary.id, folderId);
                provider.refresh();
                treeView.description = provider.getDescription();
            } catch (err) {
                void vscode.window.showErrorMessage(`Failed to add session to folder: ${err}`);
            }
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
            const meta = index.getSidecarMeta(session.id);
            SessionWebviewPanel.show(context, session, searchTerm, false, undefined, undefined, undefined, highlightContainer, meta?.tags, meta?.entities, meta?.summary, meta?.status, meta?.bookmarks, meta?.annotations);
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
            const meta2 = index.getSidecarMeta(session.id);
            SessionWebviewPanel.show(context, session, undefined, isLeaf, targetMsgIdx, undefined, targetBlockIdx, undefined, meta2?.tags, meta2?.entities, meta2?.summary, meta2?.status, meta2?.bookmarks, meta2?.annotations);
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
        vscode.commands.registerCommand('chatwizard.revealInSessionsTree', async (sessionId: string) => {
            const summary = index.getAllSummaries().find(s => s.id === sessionId);
            if (!summary) { return; }
            const item = new SessionTreeItem(summary, provider.isPinned(sessionId), context.extensionUri);
            await vscode.commands.executeCommand('chatwizardSessions.focus');
            // focus:false keeps the webview focused; select:true highlights the row
            await treeView.reveal(item, { select: true, focus: false });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'chatwizard.regenerateTitle',
            // VS Code passes (primaryItem, allSelected) when canSelectMany is true.
            async (treeItemOrSessionId?: unknown, allSelected?: unknown) => {
                const { resolveSessionTitle } = await import('./utils/titleNormalizer.js');

                // ── Multi-select path ────────────────────────────────────────
                const selectedItems = Array.isArray(allSelected) && allSelected.length > 1 ? allSelected : null;
                if (selectedItems) {
                    const sessions = (selectedItems as unknown[])
                        .map(item => {
                            if (item && 'summary' in (item as object)) {
                                return index.get((item as { summary: { id: string } }).summary.id);
                            }
                            return null;
                        })
                        .filter((s): s is Session => s !== null && s !== undefined);

                    if (sessions.length === 0) { return; }
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `Regenerating titles for ${sessions.length} sessions…`, cancellable: false },
                        async (progress) => {
                            let done = 0;
                            for (const session of sessions) {
                                const title = await resolveSessionTitle(session, { useLmApi: true });
                                if (sidecarStore) { await sidecarStore.setTitle(session.id, title); }
                                done++;
                                progress.report({ message: `${done}/${sessions.length}`, increment: 100 / sessions.length });
                            }
                            if (sidecarStore) {
                                const cache = await sidecarStore.load();
                                index.setSidecarStore(sidecarStore, cache);
                            }
                        }
                    );
                    void vscode.window.showInformationMessage(`Updated ${sessions.length} session titles.`);
                    return;
                }

                // ── Single-session path ──────────────────────────────────────
                let sessionId: string | undefined;
                if (typeof treeItemOrSessionId === 'string') {
                    sessionId = treeItemOrSessionId;
                } else if (treeItemOrSessionId && 'summary' in (treeItemOrSessionId as object)) {
                    sessionId = (treeItemOrSessionId as { summary: { id: string } }).summary.id;
                } else if (treeItemOrSessionId && typeof (treeItemOrSessionId as { sessionId?: string }).sessionId === 'string') {
                    sessionId = (treeItemOrSessionId as { sessionId: string }).sessionId;
                }
                if (!sessionId) {
                    const picked = await vscode.window.showInputBox({ prompt: 'Enter session ID to regenerate title for' });
                    sessionId = picked?.trim();
                }
                if (!sessionId) { return; }
                const session = index.get(sessionId);
                if (!session) {
                    void vscode.window.showWarningMessage(`Session "${sessionId}" not found in index.`);
                    return;
                }
                const title = await resolveSessionTitle(session, { useLmApi: true });
                if (sidecarStore) {
                    await sidecarStore.setTitle(sessionId, title);
                    const cache = await sidecarStore.load();
                    index.setSidecarStore(sidecarStore, cache);
                }
                void vscode.window.showInformationMessage(`Title updated: "${title}"`);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.regenerateAllTitles', async () => {
            const { resolveSessionTitle } = await import('./utils/titleNormalizer.js');
            // Use the tree view's sorted/filtered list so that active filters are respected.
            const summaries = provider.getSortedSummaries();
            const total = summaries.length;
            if (total === 0) {
                void vscode.window.showInformationMessage('No sessions to update.');
                return;
            }
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Regenerating titles for ${total} sessions…`, cancellable: false },
                async (progress) => {
                    let done = 0;
                    for (const summary of summaries) {
                        const session = index.get(summary.id);
                        if (!session) { done++; continue; }
                        const title = await resolveSessionTitle(session, { useLmApi: false });
                        if (sidecarStore) {
                            await sidecarStore.setTitle(summary.id, title);
                        }
                        done++;
                        progress.report({ message: `${done}/${total}`, increment: 100 / total });
                    }
                    if (sidecarStore) {
                        const cache = await sidecarStore.load();
                        index.setSidecarStore(sidecarStore, cache);
                    }
                }
            );
            void vscode.window.showInformationMessage(`Updated ${total} session titles.`);
        })
    );

    // Regenerate titles for all sessions under a date-group header (e.g. "This Week").
    context.subscriptions.push(
        vscode.commands.registerCommand('chatwizard.regenerateTitlesInGroup', async (groupItem: DateGroupTreeItem) => {
            if (!groupItem?.bucketLabel) { return; }
            const { resolveSessionTitle } = await import('./utils/titleNormalizer.js');
            const summaries = provider.getSortedSummaries()
                .filter(s => getDateBucket(s.updatedAt) === groupItem.bucketLabel);
            if (summaries.length === 0) {
                void vscode.window.showInformationMessage('No sessions found in this group.');
                return;
            }
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Regenerating titles for "${groupItem.bucketLabel}" (${summaries.length} sessions)…`, cancellable: false },
                async (progress) => {
                    let done = 0;
                    for (const summary of summaries) {
                        const session = index.get(summary.id);
                        if (!session) { done++; continue; }
                        const title = await resolveSessionTitle(session, { useLmApi: true });
                        if (sidecarStore) { await sidecarStore.setTitle(summary.id, title); }
                        done++;
                        progress.report({ message: `${done}/${summaries.length}`, increment: 100 / summaries.length });
                    }
                    if (sidecarStore) {
                        const cache = await sidecarStore.load();
                        index.setSidecarStore(sidecarStore, cache);
                    }
                }
            );
            void vscode.window.showInformationMessage(`Updated ${summaries.length} session titles in "${groupItem.bucketLabel}".`);
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
                    channel.appendLine('[Chat Wizard] Re-discovering workspaces after path change…');
                    const [copilotWs, claudeWs, cursorWs, windsurfWs] = await Promise.all([
                        withTimeout(
                            discoverCopilotWorkspacesAsync().then(list =>
                                list.map(ws => ({
                                    id: ws.workspaceId,
                                    source: 'copilot' as const,
                                    workspacePath: ws.workspacePath,
                                    storageDir: ws.storageDir,
                                }) satisfies ScopedWorkspace)
                            ),
                            15_000
                        ).catch(() => [] as ScopedWorkspace[]),
                        withTimeout(discoverClaudeWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
                        withTimeout(discoverCursorWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
                        withTimeout(discoverWindsurfWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
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
            new SessionsForFileTool(index),
            new SessionsForBranchTool(index),
            new SessionsForWorkItemTool(index),
        ];

        const getSessionFullTool = new GetSessionFullTool(index);
        const prompts = [
            new QueryHistoryPrompt(getContextTool, getSessionFullTool),
            new ContinueFromHistoryPrompt(listRecentTool, getContextTool, index),
            new GetPromptsPrompt(getContextTool, listRecentTool, getSessionFullTool),
        ];

        return { tools, prompts };
    }

    const mcpCapabilities = buildMcpCapabilities();

    // Register VS Code chat participant (@chatwizard) — same prompts as MCP, no server needed.
    const watcherRef = { current: watcher };
    registerChatParticipant(context, mcpCapabilities.prompts, index, watcherRef, sidecarStore, liveTracker);

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
                brandingBar.notify(`MCP server running on :${port}`, 'chatwizard.startMcpServer');
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
        channel.appendLine('[Chat Wizard] Starting workspace discovery…');
        // Discover all available workspaces to initialise the default scope.
        const [copilotWs, claudeWs, cursorWs, windsurfWs] = await Promise.all([
            withTimeout(
                discoverCopilotWorkspacesAsync().then(list =>
                    list.map(ws => ({
                        id: ws.workspaceId,
                        source: 'copilot' as const,
                        workspacePath: ws.workspacePath,
                        storageDir: ws.storageDir,
                    }) satisfies ScopedWorkspace)
                ),
                15_000
            ).catch(() => [] as ScopedWorkspace[]),
            withTimeout(discoverClaudeWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
            withTimeout(discoverCursorWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
            withTimeout(discoverWindsurfWorkspacesAsync(), 15_000).catch(() => [] as ScopedWorkspace[]),
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

        // ── Feature 24: Try to load sessions from SQLite cache first ────────
        if (cacheIntegration) {
            const cachedCount = cacheIntegration.cacheManager.getSessionCount();
            if (cachedCount > 0) {
                channel.appendLine(`[Chat Wizard] Loading ${cachedCount} sessions from SQLite cache…`);
                await cacheIntegration.loadIntoIndex(index);
                channel.appendLine(`[Chat Wizard] Loaded ${cachedCount} cached sessions — only changed files will be re-parsed.`);
            } else {
                channel.appendLine('[Chat Wizard] Empty cache — will re-parse all source files.');
            }
        }

        const w = await startWatcher(index, channel, scopeManager, cacheIntegration?.cacheManager);
        watcher = w;
        watcherRef.current = w;
        context.subscriptions.push(w);

        // ── Feature 23-H: Auto-classify KB on startup ─────────────────────────
        // After the initial session batch is loaded, pre-compute KB entries so new
        // sessions get automatically classified into existing categories.
        // Use a one-shot batch listener so we run exactly once after the initial load.
        {
            let done = false;
            const autoClassifyListener = index.addTypedChangeListener((event) => {
                if (done) { return; }
                if (event.type === 'batch') {
                    done = true;
                    autoClassifyListener.dispose();
                    void kbViewProvider.preload();
                }
            });
            context.subscriptions.push(autoClassifyListener);
        }

        // ── Feature 13-H: Active session tag button ───────────────────────────
        w.setLiveTracker(liveTracker);
        const activeSessionTagBtn = new ActiveSessionTagButton(liveTracker);
        context.subscriptions.push(activeSessionTagBtn);

        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.tagActiveSession', async () => {
                const windowMs = (vscode.workspace.getConfiguration('chatwizard').get<number>('activeSessionWindowMinutes') ?? 120) * 60_000;
                const active = liveTracker.getActive(windowMs);
                const entry = active[0] ?? liveTracker.getMostRecent();
                if (!entry) {
                    void vscode.window.showInformationMessage('No active session found.');
                    return;
                }
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter tag(s) for the active session, comma-separated',
                    placeHolder: 'e.g. refactor, auth, bugfix',
                });
                const tags = input?.split(',').map(t => t.trim()).filter(Boolean) ?? [];
                if (tags.length === 0) { return; }
                for (const t of tags) { await sidecarStore.addTag(entry.sessionId, t); }
                const reloadedCache = await sidecarStore.load();
                index.setSidecarStore(sidecarStore, reloadedCache);
                void vscode.window.showInformationMessage(`Tagged active session: ${tags.map(t => `"${t}"`).join(', ')}`);
            })
        );

        const copilotCount = index.getSummariesBySource('copilot').length;
        const claudeCount = index.getSummariesBySource('claude').length;
        channel.appendLine(
            `Chat Wizard activated — ${index.size} sessions indexed (${copilotCount} Copilot, ${claudeCount} Claude)`
        );
        log.info('Activation complete — %d sessions in %dms', index.size, Date.now() - startedAt);
        telemetry.record('extension.activated', { sessionCount: index.size });

        // ── Feature 18: AI summaries background job ───────────────────────────
        void runSummaryBackgroundJob(
            () => index.getAllSummaries().map(s => s.id),
            (id) => index.get(id),
            sidecarStore,
            channel,
            new SummaryGenerator(),
        );

        // ── Feature 19: Entity extraction background job ──────────────────────
        void runEntityExtractionJob(
            () => index.getAllSummaries().map(s => s.id),
            (id) => index.get(id),
            sidecarStore,
            channel,
        );

        // ── Branding status-bar item ────────────────────────────────────────────
        // ── Feature 10: File history UI ────────────────────────────────────────
        const fileHistoryStatusBar = new FileHistoryStatusBarItem(index, (count, normPath) => {
            const fileName = normPath.split(/[\\/]/).pop() ?? normPath;
            brandingBar.notify(
                `${count} session${count === 1 ? '' : 's'} touched ${fileName}`,
                'chatwizard.showFileHistory',
            );
        });
        context.subscriptions.push(fileHistoryStatusBar);

        const fileHistoryCodeLens = new FileHistoryCodeLensProvider(index);
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider({ scheme: 'file' }, fileHistoryCodeLens),
            fileHistoryCodeLens,
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.showFileHistory', (arg?: vscode.Uri | string) => {
                const filePath = arg instanceof vscode.Uri ? arg.fsPath : arg;
                FileHistoryPanel.show(context.extensionUri, index, filePath);
            }),
        );

        // ── Chronicle integration (branch + checkpoint data for branch grouping) ──
        // 1. Optionally enable Copilot's local index so sessions.branch gets populated.
        //    Gracefully skip if the config key is not registered (e.g. Copilot not installed).
        const cwCfg = vscode.workspace.getConfiguration('chatwizard');
        if (cwCfg.get<boolean>('chronicle.enableLocalIndex', true)) {
            const currentValue = vscode.workspace.getConfiguration().get<boolean>('chat.localIndex.enabled');
            if (currentValue !== true) {
                vscode.workspace.getConfiguration().update(
                    'chat.localIndex.enabled',
                    true,
                    vscode.ConfigurationTarget.Global,
                ).then(undefined, () => {
                    // Setting may not be registered (e.g. Copilot not installed) — non-fatal.
                });
            }
        }

        // 2. Read Chronicle DBs and merge branch + checkpoint data into the index.
        const globalStorageDir = require('path').dirname(context.globalStorageUri.fsPath) as string;
        const globalChronicleDbPath = require('path').join(globalStorageDir, 'GitHub.copilot-chat', 'session-store.db') as string;

        let chronicleMergeActive = false; // prevents the debounce from firing during our own merge

        async function loadChronicleData(): Promise<void> {
            try {
                const perWorkspaceDbs = await discoverChronicleDbsAsync();
                const dbPaths = new Set<string>([
                    globalChronicleDbPath,
                    ...perWorkspaceDbs.map(d => d.dbPath),
                ]);

                const bySessionId = new Map<string, ChronicleData>();

                for (const dbPath of dbPaths) {
                    for (const s of readChronicleSessions(dbPath)) {
                        const existing = bySessionId.get(s.sessionId);
                        bySessionId.set(s.sessionId, {
                            overview:         existing?.overview         ?? null,
                            workDone:         existing?.workDone         ?? null,
                            technicalDetails: existing?.technicalDetails ?? null,
                            nextSteps:        existing?.nextSteps        ?? null,
                            createdAt:        existing?.createdAt        ?? null,
                            importantFiles:   existing?.importantFiles,
                            branch:           s.branch     ?? existing?.branch     ?? null,
                            repository:       s.repository ?? existing?.repository ?? null,
                        });
                    }
                    for (const cp of readChronicleCheckpoints(dbPath)) {
                        const existing = bySessionId.get(cp.sessionId);
                        bySessionId.set(cp.sessionId, {
                            overview:         cp.overview         ?? existing?.overview         ?? null,
                            workDone:         cp.workDone         ?? existing?.workDone         ?? null,
                            technicalDetails: cp.technicalDetails ?? existing?.technicalDetails ?? null,
                            nextSteps:        cp.nextSteps        ?? existing?.nextSteps        ?? null,
                            createdAt:        cp.createdAt        ?? existing?.createdAt        ?? null,
                            importantFiles:   cp.importantFiles   ?? existing?.importantFiles,
                            branch:           existing?.branch     ?? null,
                            repository:       existing?.repository ?? null,
                        });
                    }
                }

                chronicleMergeActive = true;
                try {
                    if (bySessionId.size > 0) {
                        index.mergeChronicleData(
                            Array.from(bySessionId.entries()).map(([sessionId, data]) => ({ sessionId, data })),
                        );
                        const withFiles = Array.from(bySessionId.values()).filter(d => d.importantFiles && d.importantFiles.length > 0).length;
                        channel.appendLine(`[Chronicle] Merged ${bySessionId.size} session(s) from Chronicle (${withFiles} with importantFiles)`);
                        brandingBar.notify(`Branch context merged for ${bySessionId.size} session${bySessionId.size === 1 ? '' : 's'}`);
                    } else {
                        channel.appendLine('[Chronicle] Connected to Chronicle DB — no checkpoints yet');
                    }
                } finally {
                    chronicleMergeActive = false;
                }
            } catch (err) {
                chronicleMergeActive = false;
                channel.appendLine(`[Chronicle] Failed to load: ${err}`);
            }
        }

        // Load on activation
        void loadChronicleData();

        // Re-read after genuinely new sessions appear (debounced 4 s).
        // Guarded by chronicleMergeActive so Chronicle's own mergeChronicleData()
        // notification doesn't trigger a redundant re-read.
        let chronicleDebounce: ReturnType<typeof setTimeout> | undefined;
        context.subscriptions.push(index.addChangeListener(() => {
            if (chronicleMergeActive) { return; }
            if (chronicleDebounce) { clearTimeout(chronicleDebounce); }
            chronicleDebounce = setTimeout(() => { void loadChronicleData(); }, 4000);
        }));

        // ── Feature 13: Tagging commands ──────────────────────────────────────
        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.addTag', async (sessionId?: string) => {
                const id = sessionId ?? await pickSessionId(index);
                if (!id) { return; }
                const input = await vscode.window.showInputBox({ prompt: 'Enter tag(s), comma-separated', placeHolder: 'e.g. refactor, auth, bugfix' });
                const tags = input?.split(',').map(t => t.trim()).filter(Boolean) ?? [];
                if (tags.length === 0) { return; }
                for (const t of tags) { await sidecarStore.addTag(id, t); }
                const reloadedCache = await sidecarStore.load();
                index.setSidecarStore(sidecarStore, reloadedCache);
                void vscode.window.showInformationMessage(`Added: ${tags.map(t => `"${t}"`).join(', ')}`);
            }),
            vscode.commands.registerCommand('chatwizard.removeTag', async (sessionId?: string) => {
                const id = sessionId ?? await pickSessionId(index);
                if (!id) { return; }
                const existing = (await sidecarStore.get(id))?.tags ?? [];
                if (existing.length === 0) { void vscode.window.showInformationMessage('No tags to remove.'); return; }
                const tag = await vscode.window.showQuickPick(existing, { placeHolder: 'Select tag to remove' });
                if (tag) {
                    await sidecarStore.removeTag(id, tag);
                    const reloadedCache = await sidecarStore.load();
                    index.setSidecarStore(sidecarStore, reloadedCache);
                    void vscode.window.showInformationMessage(`Tag "${tag}" removed.`);
                }
            }),
            vscode.commands.registerCommand('chatwizard.addTagFromTree', async (item: SessionTreeItem) => {
                const input = await vscode.window.showInputBox({ prompt: 'Enter tag(s), comma-separated', placeHolder: 'e.g. refactor, auth, bugfix' });
                const tags = input?.split(',').map(t => t.trim()).filter(Boolean) ?? [];
                if (tags.length === 0) { return; }
                for (const t of tags) { await sidecarStore.addTag(item.summary.id, t); }
                const reloadedCache = await sidecarStore.load();
                index.setSidecarStore(sidecarStore, reloadedCache);
                void vscode.window.showInformationMessage(`Added: ${tags.map(t => `"${t}"`).join(', ')}`);
            }),
            vscode.commands.registerCommand('chatwizard.removeTagFromTree', async (item: SessionTreeItem) => {
                const existing = (await sidecarStore.get(item.summary.id))?.tags ?? [];
                if (existing.length === 0) {
                    void vscode.window.showInformationMessage('This session has no tags.');
                    return;
                }
                const picks = await vscode.window.showQuickPick(
                    existing.map(t => ({ label: t })),
                    { placeHolder: 'Select tags to remove', canPickMany: true }
                );
                if (!picks || picks.length === 0) { return; }
                for (const pick of picks) { await sidecarStore.removeTag(item.summary.id, pick.label); }
                const reloadedCache = await sidecarStore.load();
                index.setSidecarStore(sidecarStore, reloadedCache);
            }),
        );

        // ── Feature 18-E: Regenerate summary command ──────────────────────────
        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.regenerateSummary', async (item: SessionTreeItem) => {
                const id = item?.summary?.id;
                if (!id) { return; }
                await sidecarStore.patch(id, { summary: undefined });
                const session = index.get(id);
                if (!session) { return; }
                void vscode.window.showInformationMessage('Regenerating summary…');
                const generator = new SummaryGenerator();
                const newSummary = await generator.generate(session);
                await sidecarStore.patch(id, { summary: newSummary });
                const reloadedCache = await sidecarStore.load();
                index.setSidecarStore(sidecarStore, reloadedCache);
                provider.refresh();
            }),
        );

        // ── Feature 20-D: Analyze Selected Prompt command (disabled for 1.5.0 — testing deferred to P3) ──
        // context.subscriptions.push(
        //     vscode.commands.registerCommand('chatwizard.analyzeSelectedPrompt', async () => {
        //         const editor = vscode.window.activeTextEditor;
        //         const selection = editor?.selection;
        //         const text = editor?.document.getText(selection);
        //         if (!text?.trim()) {
        //             void vscode.window.showInformationMessage('Select some text first to analyze as a prompt.');
        //             return;
        //         }
        //         const analyzer = new PromptAnalyzer();
        //         const analysis = await analyzer.analyze(text);
        //         const detail = [
        //             `Tokens: ~${analysis.tokenCount.toLocaleString()}`,
        //             analysis.costEstimates.length > 0
        //                 ? `Est. cost: ${analysis.costEstimates.map(c => `${c.model}: $${c.estimate.totalUsd.toFixed(4)}`).join(' | ')}`
        //                 : '',
        //             analysis.verbosityFlags.length > 0
        //                 ? `Flags: ${analysis.verbosityFlags.map(f => f.description).join('; ')}`
        //                 : 'No verbosity issues.',
        //         ].filter(Boolean).join('\n');
        //         const choice = await vscode.window.showInformationMessage(analysis.summary, 'View Details');
        //         if (choice === 'View Details') {
        //             const panel = vscode.window.createWebviewPanel(
        //                 'chatwizard.promptAnalysis',
        //                 'Prompt Analysis',
        //                 vscode.ViewColumn.Beside,
        //                 {},
        //             );
        //             panel.webview.html = `<!DOCTYPE html><html><body><pre style="font-family:monospace;padding:16px;">${detail.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body></html>`;
        //         }
        //     }),
        // );

        // ── Feature 22: Export commands ───────────────────────────────────────
        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.exportToObsidian', async () => {
                const uri = await vscode.window.showOpenDialog({
                    canSelectFolders: true, canSelectFiles: false, openLabel: 'Select Obsidian vault folder',
                });
                if (!uri?.[0]) { return; }
                const sessions = index.getAllSummaries().map(s => index.get(s.id)).filter((s): s is NonNullable<typeof s> => s !== null);
                const exporter = new ObsidianExporter();
                const result = await exporter.export(sessions, { targetDir: uri[0].fsPath, overwrite: false }, async (id) => {
                    return await sidecarStore.get(id) ?? undefined;
                });
                void vscode.window.showInformationMessage(`Obsidian export: ${result.written} written, ${result.skipped} skipped, ${result.errors.length} errors.`);
            }),
            vscode.commands.registerCommand('chatwizard.exportToNotion', async () => {
                const secretStorage = context.secrets;
                let apiKey = await secretStorage.get('chatwizard.notionApiKey');
                if (!apiKey) {
                    apiKey = await vscode.window.showInputBox({
                        prompt: 'Enter your Notion integration API key (stored in VS Code SecretStorage)',
                        password: true,
                    });
                    if (!apiKey) { return; }
                    await secretStorage.store('chatwizard.notionApiKey', apiKey);
                }
                const databaseId = await vscode.window.showInputBox({ prompt: 'Enter Notion database ID' });
                if (!databaseId) { return; }
                const sessions = index.getAllSummaries().map(s => index.get(s.id)).filter((s): s is NonNullable<typeof s> => s !== null);
                const exporter = new NotionExporter();
                void vscode.window.showInformationMessage(`Exporting ${sessions.length} sessions to Notion…`);
                const result = await exporter.export(sessions, { databaseId, apiKey });
                void vscode.window.showInformationMessage(`Notion export: ${result.written} written, ${result.errors.length} errors.`);
            }),
            vscode.commands.registerCommand('chatwizard.forgetNotionApiKey', async () => {
                await context.secrets.delete('chatwizard.notionApiKey');
                void vscode.window.showInformationMessage('Notion API key removed from SecretStorage.');
            }),
            // ── Feature 23: Generate Knowledge Base ─────────────────────────
            vscode.commands.registerCommand('chatwizard.generateKnowledgeBase', async () => {
                // Load all sessions + sidecar metadata
                const summaries = index.getAllSummaries();
                const sessions = summaries
                    .map(s => index.get(s.id))
                    .filter((s): s is NonNullable<typeof s> => s !== null);

                if (sessions.length === 0) {
                    void vscode.window.showInformationMessage('No sessions found to generate knowledge base.');
                    return;
                }

                // Reveal the sidebar Knowledge Base view — it already computes
                // and displays the dashboard on visibility change.
                void vscode.commands.executeCommand('workbench.view.extension.chatwizard');
                // Focus the KB view specifically
                void vscode.commands.executeCommand('chatwizardKnowledgeBase.focus');
            }),
        );

        // ── Feature 12: Archive stats command ─────────────────────────────────
        context.subscriptions.push(
            vscode.commands.registerCommand('chatwizard.showArchiveStats', async () => {
                const stats = await archive.stats();
                void vscode.window.showInformationMessage(
                    `Archive: ${stats.totalSessions} session(s), ${(stats.totalBytes / 1024).toFixed(1)} KB` +
                    (stats.oldestDate ? `, oldest: ${stats.oldestDate.slice(0, 10)}` : '')
                );
            }),
        );

        // ── Feature 44: REST API Server ───────────────────────────────────────
        const restCfg = vscode.workspace.getConfiguration('chatwizard');
        const restApiEnabled = restCfg.get<boolean>('restApi.enabled', false);
        let restApiServer: RestApiServer | undefined;
        if (restApiEnabled) {
            const restApiPort = restCfg.get<number>('restApi.port', 6790);
            const restApiDocs = restCfg.get<boolean>('restApi.enableDocs', true);
            restApiServer = new RestApiServer(
                {
                    enabled: true,
                    port: restApiPort,
                    tokenPath: mcpTokenPath,
                    enableApiDocs: restApiDocs,
                },
                index,
                extensionVersion,
                (msg) => channel.appendLine(msg),
            );
            void restApiServer.start().catch((err: unknown) => {
                channel.appendLine(`[Chat Wizard] REST API server failed to start: ${String(err)}`);
            });
            context.subscriptions.push({ dispose: () => void restApiServer?.stop() });
            channel.appendLine(`[Chat Wizard] REST API server configured on port ${restApiPort}`);
        }

        // ── Feature 27: Cloud Sync (opt-in) ───────────────────────────────────
        const cloudCfg = vscode.workspace.getConfiguration('chatwizard');
        const cloudSyncEnabled = cloudCfg.get<boolean>('cloudSync.enabled', false);
        let cloudSync: CloudSyncManager | undefined;
        if (cloudSyncEnabled && cacheIntegration) {
            const cloudSyncType = cloudCfg.get<string>('cloudSync.type', 'gist');
            cloudSync = new CloudSyncManager(
                index,
                context.globalStorageUri.fsPath,
                cloudSyncType,
                (msg) => channel.appendLine(msg),
            );
            void cloudSync.initialize().catch((err: unknown) => {
                channel.appendLine(`[Chat Wizard] Cloud sync init failed: ${String(err)}`);
            });
            context.subscriptions.push({ dispose: () => cloudSync?.dispose() });
            channel.appendLine(`[Chat Wizard] Cloud sync (${cloudSyncType}) initialised.`);
        }
    })().catch(err => {
        channel.appendLine(`[error] Watcher init failed: ${err}`);
        // Fire an empty batch to clear the loading spinner in the tree view.
        index.batchUpsert([]);
    });
}

export function deactivate(): void {
    watcher?.dispose();
    watcher = undefined;
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Returns a promise that resolves with the given promise's value, or rejects
 * with a TimeoutError after `ms` milliseconds — whichever comes first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/** Quick-pick helper for tag/session commands that need a session ID. */
async function pickSessionId(index: SessionIndex): Promise<string | undefined> {
    const summaries = index.getAllSummaries().slice(0, 50);
    const pick = await vscode.window.showQuickPick(
        summaries.map(s => ({ label: s.title, description: s.id, id: s.id })),
        { placeHolder: 'Select a session' },
    );
    return pick?.id;
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
        'Each result includes a Passage — the most relevant excerpt from that session.',
        'Use the session Title and Passage to judge whether the session is relevant to the topic.',
        'Vouch for EVERY session whose Title or Passage contains the topic — reference it by its exact Title as shown in the [Session: ...] header.',
        'Reference each confirmed match: "Based on a session on [date and time], you decided..."',
        'Do NOT vouch for sessions whose Title and Passage do not mention the topic.',
        'Do NOT invent session names from text within a passage.',
        '',
        '**On every error message or debugging question:**',
        'Call `chatwizard_search` with the exact error string or a short keyword form of it.',
        'Each result includes a Passage — the most relevant excerpt from that session.',
        'Vouch for EVERY session whose Title or Passage mentions the error or topic.',
        'Reference each confirmed match: "You solved a similar issue on [date and time] - here is what worked:"',
        'Do NOT vouch for sessions whose Title and Passage do not mention the topic.',
        'Do NOT invent session names from text within a passage.',
        '',
        '**At the start of a new working session (when asked what to work on or how to continue):**',
        'Call `chatwizard_list_recent` with limit 5, then `chatwizard_get_session` on the most relevant result.',
        'Open with: "Your last session on this project was [date and time] - you were..." then summarise where the work stands and what the open question was.',
        '',
        '**CRITICAL — vouching rules:**',
        '- Always vouch using the exact session Title from the [Session: ...] header in the tool output.',
        '- Never derive a session name from text inside a Passage — that is message content, not a session title.',
        '- Sessions whose Title and Passage do not mention the topic must be omitted entirely.',
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

// ── Extension update notifier ─────────────────────────────────────────────────

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const EXTENSION_MARKETPLACE_ID = 'Veverke.chatwizard';

/**
 * Checks the VS Code Marketplace for a newer version of this extension.
 * Rate-limited to once per day using globalState. Errors are suppressed silently.
 */
async function checkForExtensionUpdate(
    context: vscode.ExtensionContext,
    channel: vscode.OutputChannel,
): Promise<void> {
    const now = Date.now();
    const lastCheck = context.globalState.get<number>('lastUpdateCheckMs', 0);
    if (now - lastCheck < UPDATE_CHECK_INTERVAL_MS) { return; }

    // Record the check time upfront so a network failure doesn't cause a retry
    // on every subsequent activation within the same day.
    await context.globalState.update('lastUpdateCheckMs', now);

    try {
        const latestVersion = await fetchLatestMarketplaceVersion(EXTENSION_MARKETPLACE_ID);
        if (!latestVersion) { return; }

        const installed = (context.extension.packageJSON.version as string) || '0.0.0';
        if (!isNewerVersion(latestVersion, installed)) { return; }

        channel.appendLine(`[Chat Wizard] Update available: v${latestVersion} (installed: v${installed})`);

        const action = await vscode.window.showInformationMessage(
            `Chat Wizard v${latestVersion} is available (you have v${installed}).`,
            'Open Marketplace',
            'Dismiss',
        );
        if (action === 'Open Marketplace') {
            void vscode.env.openExternal(
                vscode.Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${EXTENSION_MARKETPLACE_ID}`)
            );
        }
    } catch (err) {
        // Never surface network or parse errors to the user
        channel.appendLine(`[Chat Wizard] Update check failed: ${String(err)}`);
    }
}

/** Queries the VS Code Marketplace REST API and returns the latest published version string. */
async function fetchLatestMarketplaceVersion(extensionId: string): Promise<string | undefined> {
    const https = await import('https');
    const body = JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: extensionId }] }],
        flags: 512,
    });

    return new Promise<string | undefined>((resolve) => {
        const req = https.request(
            {
                hostname: 'marketplace.visualstudio.com',
                path: '/_apis/public/gallery/extensionquery',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json;api-version=3.0-preview.1',
                    'User-Agent': 'vscode-chatwizard-update-check',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data) as {
                            results?: Array<{
                                extensions?: Array<{
                                    versions?: Array<{ version: string }>;
                                }>;
                            }>;
                        };
                        const version = json.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
                        resolve(typeof version === 'string' ? version : undefined);
                    } catch {
                        resolve(undefined);
                    }
                });
            }
        );
        req.on('error', () => resolve(undefined));
        req.setTimeout(8000, () => { req.destroy(); resolve(undefined); });
        req.write(body);
        req.end();
    });
}


