// src/analytics/kbCategoryConfigurator.ts
// Feature 23 — KB Category Configuration (heuristic fallback only).
// With the AI-first approach, categories emerge freely from LLM analysis.
// This configurator is only relevant for the heuristic fallback path
// (when the free AI model is unavailable).

import * as vscode from 'vscode';

/**
 * Prompt the user to optionally configure custom fallback categories.
 *
 * Since the LLM now generates categories freely from session content,
 * pre-configured categories are only used when the AI model is unavailable
 * and the heuristic fallback kicks in.
 *
 * Shows a QuickPick with two options:
 * 1. Use built-in heuristic fallback categories automatically
 * 2. Specify custom fallback categories
 *
 * @returns An array of category names, or `undefined` if the user cancelled.
 */
export async function configureFallbackCategories(): Promise<string[] | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: '$(check) Use auto-detected categories (recommended)',
                description: 'LLM will generate categories from session content; built-in fallback if unavailable',
            },
            {
                label: '$(settings) Configure custom fallback categories…',
                description: 'Specify categories used only when the AI model is unavailable',
            },
        ],
        {
            placeHolder: 'Categories are automatically generated from session content by AI.',
            matchOnDescription: true,
            title: 'Knowledge Base — Category Strategy',
        },
    );

    if (!choice) { return undefined; }

    // "Auto-detect" (default) — no predefined categories needed
    if (choice.label.includes('auto-detected') || choice.label.includes('Auto-detect')) {
        return undefined;
    }

    // Custom fallback categories
    const input = await vscode.window.showInputBox({
        prompt: 'Enter fallback categories (comma-separated) — only used when AI model is unavailable',
        placeHolder: 'e.g. architecture, decision, gotcha, learning, pattern',
        validateInput: (value: string) => {
            const items = value.split(',').map(s => s.trim()).filter(Boolean);
            return items.length >= 2 ? null : 'Enter at least 2 comma-separated categories';
        },
    });

    if (!input) { return undefined; }

    return input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}