// src/commands/paletteCommandsData.ts
//
// Pure-data layer for the command-palette category map.
// No VS Code runtime dependency — safe to import in unit tests.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaletteItem {
    /** Existing leaf command ID executed when the item is picked. */
    readonly commandId: string;
    /** Display label shown in the quickPick list. */
    readonly label: string;
    /** Codicon prefix, e.g. "$(search)". */
    readonly icon: string;
    /** Optional secondary text shown alongside the label. */
    readonly description?: string;
}

export interface PaletteCategory {
    /** New top-level command ID registered for this category entry. */
    readonly commandId: string;
    /** Human-readable title used as the quickPick heading. */
    readonly title: string;
    /** Codicon shown in the palette next to the category command. */
    readonly icon: string;
    /** All leaf commands belonging to this category. */
    readonly items: readonly PaletteItem[];
}

// ---------------------------------------------------------------------------
// Authoritative mapping
// Update this when adding or removing user-facing palette commands.
// ---------------------------------------------------------------------------

export const PALETTE_CATEGORIES: readonly PaletteCategory[] = [
    {
        commandId: 'chatwizard.views',
        title: 'View…',
        icon: '$(window)',
        items: [
            { commandId: 'chatwizard.showCodeBlocks',    label: 'Code Blocks',           icon: '$(code)'    },
            { commandId: 'chatwizard.showPromptLibrary', label: 'Prompt Library',         icon: '$(book)'    },
            { commandId: 'chatwizard.showAnalytics',     label: 'Analytics Dashboard',    icon: '$(graph)'   },
            { commandId: 'chatwizard.showTimeline',      label: 'Timeline',               icon: '$(history)' },
        ],
    },
    {
        commandId: 'chatwizard.searchMenu',
        title: 'Search…',
        icon: '$(search)',
        items: [
            { commandId: 'chatwizard.search',         label: 'Full-Text Search',                 icon: '$(search)'  },
            { commandId: 'chatwizard.semanticSearch', label: 'Find Sessions by Topic (Semantic)', icon: '$(sparkle)' },
        ],
    },
    {
        commandId: 'chatwizard.organise',
        title: 'Filter & Sort…',
        icon: '$(settings-gear)',
        items: [
            { commandId: 'chatwizard.filterSessions',     label: 'Filter Sessions…',      icon: '$(filter)'        },
            { commandId: 'chatwizard.configureSortOrder', label: 'Configure Sort Order…', icon: '$(settings-gear)' },
            { commandId: 'chatwizard.filterCodeBlocks',   label: 'Filter Code Blocks…',   icon: '$(filter)'        },
        ],
    },
    {
        commandId: 'chatwizard.export',
        title: 'Export…',
        icon: '$(export)',
        items: [
            { commandId: 'chatwizard.exportAll',      label: 'Export All Sessions…',      icon: '$(files)'     },
            { commandId: 'chatwizard.exportSelected', label: 'Export Selected Sessions…', icon: '$(checklist)' },
            { commandId: 'chatwizard.exportExcerpt',  label: 'Export Session Excerpt…',   icon: '$(export)'    },
        ],
    },
    {
        commandId: 'chatwizard.workspace',
        title: 'Settings…',
        icon: '$(folder-library)',
        items: [
            { commandId: 'chatwizard.manageWatchedWorkspaces', label: 'Manage Watched Workspaces', icon: '$(folder-library)' },
            { commandId: 'chatwizard.rescan',                  label: 'Rescan Sessions',            icon: '$(refresh)'        },
            { commandId: 'chatwizard.startMcpServer',          label: 'Start MCP Server',           icon: '$(broadcast)'     },
            { commandId: 'chatwizard.stopMcpServer',           label: 'Stop MCP Server',            icon: '$(debug-stop)'    },
            { commandId: 'chatwizard.copyMcpConfig',           label: 'Copy MCP Config to Clipboard', icon: '$(clippy)'      },
        ],
    },
];
