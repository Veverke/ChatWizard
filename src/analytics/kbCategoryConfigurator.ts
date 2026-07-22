// src/analytics/kbCategoryConfigurator.ts
// Feature 23 — KB Category Configuration: prompts the user for custom categories.
// The user sees recommended (default) categories and can add their own.

import * as vscode from 'vscode';
import { DEFAULT_KB_TYPES } from '../types/kb';

const DEFAULT_DESCRIPTIONS: Record<string, string> = {
    decision:     'Key decisions and trade-offs',
    learning:     'New knowledge or insights',
    pattern:      'Reusable patterns and conventions',
    gotcha:       'Gotchas, pitfalls, and footguns',
    architecture: 'System architecture and design',
};

/**
 * Prompt the user to configure KB categories.
 *
 * Shows a QuickPick with two options:
 * 1. Use default categories only (architecture, decision, gotcha, learning, pattern)
 * 2. Add custom categories alongside the defaults
 *
 * If the user chooses custom categories, an input box collects comma-separated values.
 * Returns the merged list, or `undefined` if the user cancelled.
 */
export async function configureCategories(): Promise<string[] | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: '$(check) Use default categories only',
                description: 'Architecture, Decision, Gotcha, Learning, Pattern',
            },
            {
                label: '$(plus) Add custom categories...',
                description: 'Add your own categories alongside the defaults',
            },
        ],
        {
            placeHolder: 'How would you like to categorize your knowledge base?',
            matchOnDescription: true,
            title: 'Knowledge Base Categories',
        },
    );

    if (!choice) { return undefined; }

    let customCategories: string[] = [];

    if (choice.label.includes('Add custom categories')) {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter custom categories (comma-separated)',
            placeHolder: 'e.g., Bugs, Versioning, Performance, Security',
            validateInput: (value: string) => {
                if (!value.trim()) { return 'Please enter at least one category'; }
                return null;
            },
            title: 'Custom Knowledge Base Categories',
        });

        if (input === undefined) { return undefined; } // cancelled

        if (input.trim()) {
            customCategories = input
                .split(',')
                .map(s => s.trim().toLowerCase())
                .filter(s => s.length > 0)
                .filter((s, i, a) => a.indexOf(s) === i); // deduplicate
        }
    }

    // Merge defaults + custom (deduplicated against defaults)
    const customSet = new Set(customCategories);
    const merged = [...DEFAULT_KB_TYPES];
    for (const c of customCategories) {
        if (!DEFAULT_KB_TYPES.includes(c)) {
            merged.push(c);
        }
    }

    // Build a preview message
    const defaultLines = DEFAULT_KB_TYPES.map(t => {
        const desc = DEFAULT_DESCRIPTIONS[t] ?? '';
        return `  • ${t} — ${desc}`;
    });
    const customLines = customCategories.length > 0
        ? ['', 'Custom:', ...customCategories.map(c => `  • ${c}`)]
        : [];

    const preview = [
        `KB will use ${merged.length} categories:`,
        '',
        'Default:',
        ...defaultLines,
        ...customLines,
    ].join('\n');

    const confirm = await vscode.window.showInformationMessage(
        `KB will use ${merged.length} categories (${customCategories.length} custom).`,
        { modal: false, detail: preview },
        'Confirm',
    );

    if (!confirm) { return undefined; }

    return merged;
}