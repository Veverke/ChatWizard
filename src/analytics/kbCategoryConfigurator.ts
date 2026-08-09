// src/analytics/kbCategoryConfigurator.ts
// Feature 23 — KB Category Configuration (heuristic fallback only).
// With the AI-first approach, categories emerge freely from LLM analysis.
// This configurator is only relevant for the heuristic fallback path
// (when the free AI model is unavailable).

import * as vscode from 'vscode';

const DEFAULT_HEURISTIC_CATEGORIES = ['decision', 'learning', 'pattern', 'gotcha', 'architecture'];

/**
 * Prompt the user to define heuristic categories to be used.
 *
 * Shows an input box pre-filled with the current hardcoded categories.
 * The user can add, remove, or edit categories as needed.
 *
 * @returns An array of category names, or `undefined` if the user cancelled.
 */
export async function configureFallbackCategories(): Promise<string[] | undefined> {
    const input = await vscode.window.showInputBox({
        prompt: 'Define fallback heuristic mode categories to be used (comma-separated)',
        value: DEFAULT_HEURISTIC_CATEGORIES.join(', '),
        placeHolder: DEFAULT_HEURISTIC_CATEGORIES.join(', '),
        validateInput: (value: string) => {
            const items = value.split(',').map(s => s.trim()).filter(Boolean);
            return items.length >= 2 ? null : 'Enter at least 2 comma-separated categories';
        },
    });

    if (!input) { return undefined; }

    return input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}