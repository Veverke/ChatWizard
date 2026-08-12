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
            { commandId: 'chatwizard.searchAnnotations', label: 'Search Annotations',             icon: '$(comment)' },
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
        commandId: 'chatwizard.session',
        title: 'Session…',
        icon: '$(comment-discussion)',
        items: [
            { commandId: 'chatwizard.setSessionStatus',  label: 'Set Session Status…',  icon: '$(symbol-misc)'       },
            { commandId: 'chatwizard.filterByStatus',    label: 'Filter by Status…',    icon: '$(filter)'            },
            { commandId: 'chatwizard.addBookmark',       label: 'Add Bookmark…',        icon: '$(bookmark)'          },
            { commandId: 'chatwizard.removeBookmark',    label: 'Remove Bookmark…',     icon: '$(bookmark)'          },
            { commandId: 'chatwizard.addTag',            label: 'Add Tag…',             icon: '$(tag)'               },
            { commandId: 'chatwizard.removeTag',         label: 'Remove Tag…',          icon: '$(tag)'               },
            { commandId: 'chatwizard.clearTags',       label: 'Clear All Tags…',      icon: '$(tag)'               },
            { commandId: 'chatwizard.tagActiveSession',  label: 'Tag Active Session',   icon: '$(tag)'               },
            { commandId: 'chatwizard.regenerateTitle',   label: 'Regenerate Title',     icon: '$(edit)'              },
            { commandId: 'chatwizard.regenerateAllTitles', label: 'Regenerate All Titles', icon: '$(refresh)'        },
            { commandId: 'chatwizard.regenerateSummary', label: 'Regenerate Summary',   icon: '$(edit)'              },
            { commandId: 'chatwizard.pinSession',        label: 'Pin Session',          icon: '$(pin)'               },
            { commandId: 'chatwizard.unpinSession',      label: 'Unpin Session',        icon: '$(pinned)'            },
            { commandId: 'chatwizard.groupSessions',     label: 'Group Sessions…',      icon: '$(list-tree)'         },
            { commandId: 'chatwizard.injectAsContext',   label: 'Inject as Context…',   icon: '$(comment-discussion)'},
            { commandId: 'chatwizard.revealSessionInExplorer', label: 'Reveal in Explorer', icon: '$(folder-opened)' },
            { commandId: 'chatwizard.addAnnotation',    label: 'Add Annotation…',      icon: '$(comment)'           },
            { commandId: 'chatwizard.generateDigest',     label: 'Generate Digest…',     icon: '$(note)'       },
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
            { commandId: 'chatwizard.exportSession',  label: 'Export Session to Markdown', icon: '$(export)'  },
            { commandId: 'chatwizard.exportFromTreeSelection', label: 'Export Selected from Tree…', icon: '$(checklist)' },
            { commandId: 'chatwizard.exportToObsidian', label: 'Export to Obsidian',      icon: '$(database)'  },
            { commandId: 'chatwizard.exportToNotion',  label: 'Export to Notion',         icon: '$(database)'  },
            { commandId: 'chatwizard.forgetNotionApiKey', label: 'Forget Notion API Key', icon: '$(key)'       },
        ],
    },
    {
        commandId: 'chatwizard.folder',
        title: 'Folder & Archive…',
        icon: '$(archive)',
        items: [
            { commandId: 'chatwizard.createFolder',       label: 'Create Folder',              icon: '$(new-folder)'  },
            { commandId: 'chatwizard.createSubfolder',    label: 'Create Subfolder',           icon: '$(new-folder)'  },
            { commandId: 'chatwizard.renameFolder',       label: 'Rename Folder',              icon: '$(edit)'        },
            { commandId: 'chatwizard.deleteFolder',       label: 'Delete Folder',              icon: '$(trash)'       },
            { commandId: 'chatwizard.moveSessionToFolder', label: 'Move Session to Folder…',   icon: '$(folder-opened)' },
            { commandId: 'chatwizard.archiveSession',     label: 'Archive Session',            icon: '$(archive)'     },
            { commandId: 'chatwizard.deleteArchivedSession', label: 'Delete Archived Session', icon: '$(trash)'       },
            { commandId: 'chatwizard.showArchiveStats',   label: 'Show Archive Statistics',    icon: '$(graph)'       },
        ],
    },
    {
        commandId: 'chatwizard.workspace',
        title: 'Settings…',
        icon: '$(folder-library)',
        items: [
            { commandId: 'chatwizard.manageWatchedWorkspaces', label: 'Manage Watched Workspaces',     icon: '$(folder-library)' },
            { commandId: 'chatwizard.rescan',                  label: 'Rescan Sessions',                icon: '$(refresh)'        },
            { commandId: 'chatwizard.startMcpServer',          label: 'Start MCP Server',               icon: '$(broadcast)'     },
            { commandId: 'chatwizard.stopMcpServer',           label: 'Stop MCP Server',                icon: '$(debug-stop)'    },
            { commandId: 'chatwizard.copyMcpConfig',           label: 'Copy MCP Config to Clipboard',   icon: '$(clippy)'        },
            { commandId: 'chatwizard.rotateMcpToken',          label: 'Rotate MCP Token',               icon: '$(sync)'          },
            { commandId: 'chatwizard.setupGlobalInstructions', label: 'Set Up Global Copilot Instructions', icon: '$(book)'       },
            { commandId: 'chatwizard.connectCopilot',          label: 'Connect GitHub Copilot',          icon: '$(broadcast)'     },
            { commandId: 'chatwizard.showFileHistory',         label: 'Show File Session History',       icon: '$(history)'       },
        ],
    },
];
