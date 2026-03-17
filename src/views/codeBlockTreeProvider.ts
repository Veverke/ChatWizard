import * as vscode from 'vscode';
import { IndexedCodeBlock } from '../types/index';
import { SessionIndex } from '../index/sessionIndex';
import { CodeBlockSearchEngine } from '../codeblocks/codeBlockSearchEngine';

export type CbSortMode = 'date' | 'workspace' | 'length' | 'title' | 'language';
export type CbSortDirection = 'asc' | 'desc';

export const CB_SORT_KEY_LABELS: Record<CbSortMode, string> = {
    date:      'Date',
    workspace: 'Workspace',
    length:    'Total Length',
    title:     'Session Title',
    language:  'Language',
};

const CB_DEFAULT_DIRECTION: Record<CbSortMode, CbSortDirection> = {
    date:      'desc',
    workspace: 'asc',
    length:    'desc',
    title:     'asc',
    language:  'asc',
};

interface SessionCodeBlockGroup {
    sessionId: string;
    sessionTitle: string;
    sessionSource: 'copilot' | 'claude';
    sessionUpdatedAt: string;
    sessionWorkspacePath?: string;
    blocks: IndexedCodeBlock[];
    primaryLanguage: string;
    totalLength: number;
}

/** Argument shape passed to the openSessionFromCodeBlock command. */
export interface CodeBlockSessionRef {
    sessionId: string;
    blocks: IndexedCodeBlock[];
}

// Filter types for code blocks
export interface CodeBlockFilter {
    language?: string;
    content?: string;
    sessionSource?: 'copilot' | 'claude';
    messageRole?: 'user' | 'assistant';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function langToExtension(language: string): string {
    const map: Record<string, string> = {
        // Web
        typescript: 'ts', tsx: 'tsx',
        javascript: 'js', jsx: 'jsx',
        html: 'html', css: 'css', scss: 'scss', less: 'less',
        vue: 'vue', svelte: 'svelte',
        // Systems
        rust: 'rs', go: 'go', 'c++': 'cpp', cpp: 'cpp', c: 'c',
        csharp: 'cs', 'c#': 'cs', cs: 'cs',
        java: 'java', kotlin: 'kt', swift: 'swift', dart: 'dart',
        scala: 'scala', haskell: 'hs', 'f#': 'fs', fsharp: 'fs',
        // Scripting
        python: 'py', py: 'py',
        ruby: 'rb', perl: 'pl', lua: 'lua', r: 'r',
        php: 'php', elixir: 'ex', erlang: 'erl', clojure: 'clj',
        // Shell
        bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', fish: 'fish',
        powershell: 'ps1', ps1: 'ps1', ps: 'ps1',
        batch: 'bat', bat: 'bat', cmd: 'bat',
        // Data / config
        json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
        xml: 'xml', ini: 'ini', env: 'env',
        csv: 'csv', sql: 'sql',
        // Docs / markup
        markdown: 'md', md: 'md',
        // Infrastructure
        dockerfile: 'dockerfile', makefile: 'makefile',
        terraform: 'tf', tf: 'tf',
        proto: 'proto', graphql: 'graphql',
        // Misc
        matlab: 'm', objc: 'm', 'objective-c': 'm',
        groovy: 'groovy', gradle: 'gradle',
        solidity: 'sol', verilog: 'v', vhdl: 'vhd',
    };
    const key = language.toLowerCase().trim();
    return map[key] ?? 'txt';
}

function getPrimaryLanguage(blocks: IndexedCodeBlock[]): string {
    const counts = new Map<string, number>();
    for (const b of blocks) {
        const lang = b.language || '';
        if (lang) { counts.set(lang, (counts.get(lang) ?? 0) + 1); }
    }
    let best = '';
    let bestCount = 0;
    for (const [lang, count] of counts) {
        if (count > bestCount) { best = lang; bestCount = count; }
    }
    return best;
}

function groupBySession(blocks: IndexedCodeBlock[]): SessionCodeBlockGroup[] {
    const map = new Map<string, SessionCodeBlockGroup>();
    for (const block of blocks) {
        let group = map.get(block.sessionId);
        if (!group) {
            group = {
                sessionId: block.sessionId,
                sessionTitle: block.sessionTitle,
                sessionSource: block.sessionSource,
                sessionUpdatedAt: block.sessionUpdatedAt,
                sessionWorkspacePath: block.sessionWorkspacePath,
                blocks: [],
                primaryLanguage: '',
                totalLength: 0,
            };
            map.set(block.sessionId, group);
        }
        group.blocks.push(block);
        group.totalLength += block.content.length;
    }
    for (const group of map.values()) {
        group.primaryLanguage = getPrimaryLanguage(group.blocks);
    }
    return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

export class CodeBlockGroupItem extends vscode.TreeItem {
    readonly sessionRef: CodeBlockSessionRef;

    constructor(group: SessionCodeBlockGroup) {
        super(group.sessionTitle, vscode.TreeItemCollapsibleState.Collapsed);

        this.sessionRef = { sessionId: group.sessionId, blocks: group.blocks };

        // Description: date · snippet count · source
        const dateStr = group.sessionUpdatedAt ? group.sessionUpdatedAt.slice(0, 10) : '';
        const blockCount = group.blocks.length;
        const sourceLabel = group.sessionSource === 'copilot' ? 'Copilot' : 'Claude';
        this.description = [
            dateStr,
            `${blockCount} snippet${blockCount === 1 ? '' : 's'}`,
            sourceLabel,
        ].filter(Boolean).join(' · ');

        // Icon: explicit handling for common languages, falling back to resourceUri
        const lang = group.primaryLanguage.toLowerCase().trim();
        if (lang === 'css') {
            // CSS uses curly braces {} as the universally recognized symbol
            this.iconPath = new vscode.ThemeIcon('symbol-misc');
        } else {
            // For other languages, derive from extension via resourceUri so file icon themes kick in
            // Falling back to 'txt' gives a generic file icon for plain/unknown
            const ext = langToExtension(group.primaryLanguage);
            this.resourceUri = vscode.Uri.file(`file.${ext}`);
        }

        // Tooltip: metadata + up to 3 snippet previews
        const workspaceName = group.sessionWorkspacePath
            ? group.sessionWorkspacePath.replace(/\\/g, '/').split('/').pop() ?? ''
            : '';
        const shownBlocks = group.blocks.slice(0, 3);
        const blockPreviews = shownBlocks.map((b, i) => {
            const lang = b.language || 'plain';
            const preview = b.content.length > 120
                ? b.content.slice(0, 120) + '\u2026'
                : b.content;
            return `**Snippet ${i + 1}** (${lang})\n\`\`\`${lang}\n${preview}\n\`\`\``;
        });
        if (group.blocks.length > 3) {
            blockPreviews.push(`_\u2026 and ${group.blocks.length - 3} more snippet(s)_`);
        }

        const langLabel = group.primaryLanguage || 'plain';
        const meta = [
            `**Language:** ${langLabel}  |  **Source:** ${sourceLabel}  |  **Snippets:** ${blockCount}${dateStr ? `  |  **Date:** ${dateStr}` : ''}`,
            workspaceName ? `**Workspace:** ${workspaceName}` : '',
        ].filter(Boolean).join('\n\n');

        this.tooltip = new vscode.MarkdownString(
            [`**${group.sessionTitle}**`, meta, '', ...blockPreviews].join('\n\n')
        );

        this.contextValue = 'codeblock';

        this.command = {
            command: 'chatwizard.openSessionFromCodeBlock',
            title: 'Open Session',
            arguments: [this.sessionRef],
        };
    }
}

export class CodeBlockLeafItem extends vscode.TreeItem {
    readonly block: IndexedCodeBlock;
    readonly sessionRef: CodeBlockSessionRef;

    constructor(block: IndexedCodeBlock) {
        const langLabel = block.language || 'plain';
        const preview = block.content.length > 60
            ? block.content.slice(0, 60).replace(/\n/g, ' ') + '\u2026'
            : block.content.replace(/\n/g, ' ');
        super(`${langLabel}: ${preview}`, vscode.TreeItemCollapsibleState.None);

        this.block = block;
        this.sessionRef = { sessionId: block.sessionId, blocks: [block] };

        const ext = langToExtension(block.language || '');
        this.resourceUri = vscode.Uri.file(`file.${ext}`);

        const fullPreview = block.content.length > 300
            ? block.content.slice(0, 300) + '\u2026'
            : block.content;
        this.tooltip = new vscode.MarkdownString(
            `**${langLabel}** · ${block.messageRole}\n\n\`\`\`${langLabel}\n${fullPreview}\n\`\`\``
        );

        this.contextValue = 'codeblockLeaf';

        this.command = {
            command: 'chatwizard.openSessionFromCodeBlock',
            title: 'Open Session',
            arguments: [this.sessionRef],
        };
    }
}

export class CodeBlockLoadMoreItem extends vscode.TreeItem {
    readonly remaining: number;
    constructor(remaining: number) {
        super(`⋯ Load more (${remaining} remaining)`, vscode.TreeItemCollapsibleState.None);
        this.remaining = remaining;
        this.contextValue = 'cbLoadMore';
        this.command = {
            command: 'chatwizard.loadMoreCodeBlocks',
            title: 'Load More Code Blocks',
            arguments: [],
        };
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CodeBlockTreeProvider implements vscode.TreeDataProvider<CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _filter: CodeBlockFilter = {};
    private _sortMode: CbSortMode = 'date';
    private _sortDir: CbSortDirection = 'desc';
    private _groupCache: SessionCodeBlockGroup[] | null = null;
    private _visibleGroupCount = 200;

    constructor(
        private readonly index: SessionIndex,
        private readonly engine: CodeBlockSearchEngine
    ) {
        index.addChangeListener(() => {
            this._groupCache = null;
            this.refresh();
        });
    }

    // ------------------------------------------------------------------
    // Filter
    // ------------------------------------------------------------------
    setFilter(filter: CodeBlockFilter): void {
        this._filter = filter;
        this._groupCache = null;
        this._visibleGroupCount = 200;
    }

    clearFilter(): void {
        this._filter = {};
        this._groupCache = null;
        this._visibleGroupCount = 200;
    }

    getFilter(): CodeBlockFilter { return { ...this._filter }; }

    hasActiveFilter(): boolean {
        const f = this._filter;
        return !!(f.language || f.content || f.sessionSource || f.messageRole);
    }

    private _blockMatchesFilter(block: IndexedCodeBlock): boolean {
        const f = this._filter;
        if (f.language && !block.language.toLowerCase().includes(f.language.toLowerCase())) { return false; }
        if (f.content && !block.content.toLowerCase().includes(f.content.toLowerCase())) { return false; }
        if (f.sessionSource && block.sessionSource !== f.sessionSource) { return false; }
        if (f.messageRole && block.messageRole !== f.messageRole) { return false; }
        return true;
    }

    private _groupMatchesFilter(group: SessionCodeBlockGroup): boolean {
        if (!this.hasActiveFilter()) { return true; }
        return group.blocks.some(b => this._blockMatchesFilter(b));
    }

    private _filterDescription(): string {
        const f = this._filter;
        const parts: string[] = [];
        if (f.language) { parts.push(`lang:"${f.language}"`); }
        if (f.content) { parts.push(`content:"${f.content}"`); }
        if (f.sessionSource) { parts.push(`source:${f.sessionSource}`); }
        if (f.messageRole) { parts.push(`role:${f.messageRole}`); }
        return parts.length > 0 ? `\u2298 ${parts.join(' \u00b7 ')}` : '';
    }

    // ------------------------------------------------------------------
    // Sort
    // ------------------------------------------------------------------
    setSortMode(mode: CbSortMode): void {
        this._groupCache = null;
        this._visibleGroupCount = 200;
        if (this._sortMode === mode) {
            this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._sortMode = mode;
            this._sortDir = CB_DEFAULT_DIRECTION[mode];
        }
    }

    getSortMode(): CbSortMode { return this._sortMode; }
    getSortDir(): CbSortDirection { return this._sortDir; }

    // ------------------------------------------------------------------
    // Load more
    // ------------------------------------------------------------------
    loadMore(): void {
        this._visibleGroupCount += 200;
        this._onDidChangeTreeData.fire();
    }

    // ------------------------------------------------------------------
    // Description (shown below view title)
    // ------------------------------------------------------------------
    private _nonEmptyBlocks(): IndexedCodeBlock[] {
        return this.index.getAllCodeBlocks().filter(b => {
            if (b.content.trim().length === 0) { return false; }
            // Exclude empty-language blocks whose every non-empty line looks like a markdown list
            // (e.g. a bullet list accidentally wrapped in backtick fences).
            if (b.language === '') {
                const lines = b.content.trim().split('\n').filter(l => l.trim().length > 0);
                if (lines.length > 0 && lines.every(l => /^\s*(?:[-*+]|\d+\.)\s+/.test(l))) {
                    return false;
                }
            }
            return true;
        });
    }

    private _buildSortedGroups(): SessionCodeBlockGroup[] {
        if (this._groupCache !== null) {
            return this._groupCache;
        }
        const groups = groupBySession(this._nonEmptyBlocks());
        const filtered = groups.filter(g => this._groupMatchesFilter(g));
        const dir = this._sortDir === 'asc' ? 1 : -1;

        filtered.sort((a, b) => {
            let cmp = 0;
            switch (this._sortMode) {
                case 'date':
                    cmp = (a.sessionUpdatedAt ?? '').localeCompare(b.sessionUpdatedAt ?? '');
                    break;
                case 'workspace':
                    cmp = (a.sessionWorkspacePath ?? '').localeCompare(b.sessionWorkspacePath ?? '');
                    break;
                case 'length':
                    cmp = a.totalLength - b.totalLength;
                    break;
                case 'title':
                    cmp = a.sessionTitle.localeCompare(b.sessionTitle);
                    break;
                case 'language': {
                    const langKey = (lang: string) =>
                        lang && langToExtension(lang) !== 'txt' ? lang.toLowerCase() : '\uffff';
                    cmp = langKey(a.primaryLanguage).localeCompare(langKey(b.primaryLanguage));
                    break;
                }
            }
            return cmp * dir;
        });

        this._groupCache = filtered;
        return this._groupCache;
    }

    getDescription(): string {
        const filtered = this._buildSortedGroups();
        const countPart = `${filtered.length} session${filtered.length === 1 ? '' : 's'}`;
        const dirArrow = this._sortDir === 'asc' ? '\u2191' : '\u2193';
        const sortPart = `${CB_SORT_KEY_LABELS[this._sortMode]} ${dirArrow}`;
        const filterPart = this._filterDescription();
        return filterPart
            ? `${countPart}  \u00b7  ${sortPart}  \u00b7  ${filterPart}`
            : `${countPart}  \u00b7  ${sortPart}`;
    }

    // ------------------------------------------------------------------
    // TreeDataProvider
    // ------------------------------------------------------------------
    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem): vscode.TreeItem { return element; }

    getChildren(element?: CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem): (CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem)[] {
        if (element instanceof CodeBlockGroupItem) {
            // Lazy children: compute code block leaf items only when session is expanded
            return element.sessionRef.blocks.map(b => new CodeBlockLeafItem(b));
        }

        // Top-level: return paginated session groups
        const allGroups = this._buildSortedGroups();
        const visible = allGroups.slice(0, this._visibleGroupCount);
        const items: (CodeBlockGroupItem | CodeBlockLeafItem | CodeBlockLoadMoreItem)[] = visible.map(g => new CodeBlockGroupItem(g));
        const remaining = allGroups.length - visible.length;
        if (remaining > 0) {
            items.push(new CodeBlockLoadMoreItem(remaining));
        }
        return items;
    }
}
