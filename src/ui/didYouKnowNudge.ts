// src/ui/didYouKnowNudge.ts
// Feature — "Did You Know" nudge that cycles through parsed user-guide
// section headings at 5-minute intervals via the squirrel mascot.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BrandingStatusBarItem } from './brandingStatusBar';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse section headings ("## ..." and "### ...") from the user-guide markdown
 * file. Returns a deduplicated list of heading texts (without the prefix),
 * excluding the top-level H1 and any empty or TOC-only headings.
 */
function parseUserGuideSections(filePath: string): string[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const headings = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            // Match "## Section Title" or "### Sub-section" but NOT "# H1"
            if (/^#{2,3}\s+(?!\n)(.+)/.test(trimmed)) {
                const text = trimmed.replace(/^#{2,3}\s+/, '').trim();
                // Skip table of contents entries and empty headings
                if (text && !text.startsWith('Table of Contents') && text.length > 2) {
                    headings.add(text);
                }
            }
        }

        return Array.from(headings);
    } catch {
        return [];
    }
}

/**
 * Fisher-Yates shuffle — returns a new shuffled array.
 */
function shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

export class DidYouKnowNudge implements vscode.Disposable {
    private _items: string[] = [];
    private _queue: string[] = [];
    private _intervalTimer: ReturnType<typeof setInterval> | undefined;
    private _disposables: vscode.Disposable[] = [];
    private readonly _extensionPath: string;

    constructor(
        private readonly _brandingBar: BrandingStatusBarItem,
        userGuidePath: string,
        extensionPath?: string,
    ) {
        this._extensionPath = extensionPath ?? path.dirname(path.dirname(userGuidePath));
        this._items = parseUserGuideSections(userGuidePath);
        if (this._items.length === 0) {
            // Fallback: a few built-in items if parsing fails
            this._items = [
                'Search past sessions by keyword',
                'Tag sessions for quick filtering',
                'Export sessions to Markdown or Obsidian',
                'Use @chatwizard in Copilot Chat',
                'Connect Claude Desktop via MCP server',
                'View per-model usage stats',
                'Browse AI-generated code blocks',
                'See which files a session touched',
            ];
        }
        this._queue = shuffle(this._items);
        this._start();
    }

    private _start(): void {
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const intervalSec = cfg.get<number>('didYouKnowInterval', 300);
        if (intervalSec <= 0) {
            return; // disabled via setting
        }
        const intervalMs = intervalSec * 1000;
        this._intervalTimer = setInterval(() => this._showNext(), intervalMs);
    }

    private _showNext(): void {
        if (this._queue.length === 0) {
            // All items shown — reshuffle and start over
            this._queue = shuffle(this._items);
        }

        const item = this._queue.pop()!;
        const msg = `🐿️ Did you know? ${item}`;
        this._brandingBar.notify(msg, 'workbench.view.extension.chatwizard');

        // Show notification with "Open User Guide" button (opens user-guide.md)
        // and "Don't show again" dismiss option.
        // The notification also appears in VS Code's notification history (bell icon).
        void vscode.window.showInformationMessage(msg, 'Open User Guide', "Don't show again").then(selection => {
            if (selection === 'Open User Guide') {
                const userGuidePath = path.join(this._extensionPath, 'docs', 'user-guide.md');
                void vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(userGuidePath));
            } else if (selection === "Don't show again") {
                this.dispose();
            }
        });
    }

    /** Exposed for testing: immediately show the next nudge. */
    triggerNow(): void {
        this._showNext();
    }

    dispose(): void {
        if (this._intervalTimer) {
            clearInterval(this._intervalTimer);
            this._intervalTimer = undefined;
        }
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
    }
}