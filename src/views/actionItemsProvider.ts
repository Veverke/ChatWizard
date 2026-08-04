// src/views/actionItemsProvider.ts
// Feature 34 — Action Items tree view (sidebar tab)

import * as vscode from 'vscode';
import { type ActionItem } from '../types/index';
import { SessionIndex } from '../index/sessionIndex';

// ── Tree node types ─────────────────────────────────────────────────────────

export type ActionItemTreeNode = ActionItemRootItem | ActionItemLeafItem;

export class ActionItemRootItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly children: ActionItemLeafItem[],
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'actionItemGroup';
        this.description = `${children.length} item${children.length === 1 ? '' : 's'}`;
        this.iconPath = new vscode.ThemeIcon('checklist');
    }
}

export class ActionItemLeafItem extends vscode.TreeItem {
    constructor(
        public readonly actionItem: ActionItem,
        public readonly sessionTitle: string,
        public readonly sessionId: string,
    ) {
        super(actionItem.text, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'actionItem';
        this.tooltip = actionItem.text;
        this.description = sessionTitle;
        this.iconPath = actionItem.done
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))
            : new vscode.ThemeIcon('circle-outline');

        // Strikethrough styling for done items
        if (actionItem.done) {
            this.label = `✓ ${actionItem.text}`;
        }

        this.command = {
            command: 'chatwizard.openSession',
            title: 'Open Session',
            arguments: [{ id: sessionId }],
        };
    }
}

// ── Tree data provider ──────────────────────────────────────────────────────

export class ActionItemsProvider implements vscode.TreeDataProvider<ActionItemTreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActionItemTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly index: SessionIndex,
    ) {
        index.addChangeListener(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ActionItemTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ActionItemTreeNode): ActionItemTreeNode[] {
        if (!element) {
            return this._buildGroups();
        }
        if (element instanceof ActionItemRootItem) {
            return element.children;
        }
        return [];
    }

    private _buildGroups(): ActionItemRootItem[] {
        const summaries = this.index.getAllSummaries();
        const openItems: ActionItemLeafItem[] = [];
        const doneItems: ActionItemLeafItem[] = [];

        for (const summary of summaries) {
            const meta = this.index.getSidecarMeta(summary.id);
            if (!meta?.actionItems || meta.actionItems.length === 0) { continue; }
            for (const item of meta.actionItems) {
                const leaf = new ActionItemLeafItem(item, summary.title || summary.id.slice(0, 8) + '…', summary.id);
                if (item.done) {
                    doneItems.push(leaf);
                } else {
                    openItems.push(leaf);
                }
            }
        }

        const groups: ActionItemRootItem[] = [];
        if (openItems.length > 0) {
            groups.push(new ActionItemRootItem('Open', openItems));
        }
        if (doneItems.length > 0) {
            groups.push(new ActionItemRootItem('Done', doneItems));
        }
        if (groups.length === 0) {
            // No items — still show a single group with empty message via tree view message
            return [];
        }
        return groups;
    }
}