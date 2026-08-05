// src/ui/didYouKnowNudge.ts
// Feature — "Did You Know" nudge that cycles through parsed user-guide
// section headings at 5-minute intervals via the squirrel mascot.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BrandingStatusBarItem } from './brandingStatusBar';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface SectionHeading {
    text: string;
    /** GitHub-style anchor fragment (lowercased, spaces → hyphens, stripped special chars). */
    anchor: string;
}

/**
 * Convert heading text to a GitHub-style anchor fragment.
 * Matches what GitHub's markdown renderer and VS Code's markdown preview produce.
 */
function headingToAnchor(text: string): string {
    return text
        .toLowerCase()
        .replace(/[`~!@#$%^&*()=+[\]{}|;:'",.<>/?\\]/g, '')  // strip special chars
        .replace(/\s+/g, '-')                                    // spaces → hyphens
        .replace(/-+/g, '-')                                     // collapse multiple hyphens
        .replace(/^-+|-+$/g, '');                                // trim leading/trailing hyphens
}

/**
 * Parse section headings ("## ..." and "### ...") from the user-guide markdown
 * file. Returns a deduplicated list of {text, anchor} pairs,
 * excluding the top-level H1 and any empty or TOC-only headings.
 */
function parseUserGuideSections(filePath: string): SectionHeading[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const seen = new Set<string>();
        const headings: SectionHeading[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Match "## Section Title" or "### Sub-section" but NOT "# H1"
            if (/^#{2,3}\s+(?!\n)(.+)/.test(trimmed)) {
                const text = trimmed.replace(/^#{2,3}\s+/, '').trim();
                // Skip table of contents entries and empty headings
                if (text && !text.startsWith('Table of Contents') && text.length > 2 && !seen.has(text)) {
                    seen.add(text);
                    headings.push({ text, anchor: headingToAnchor(text) });
                }
            }
        }

        return headings;
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
    private _items: SectionHeading[] = [];
    private _queue: SectionHeading[] = [];
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
                { text: 'Search past sessions by keyword', anchor: 'search-past-sessions-by-keyword' },
                { text: 'Tag sessions for quick filtering', anchor: 'tag-sessions-for-quick-filtering' },
                { text: 'Export sessions to Markdown or Obsidian', anchor: 'export-sessions-to-markdown-or-obsidian' },
                { text: 'Use @chatwizard in Copilot Chat', anchor: 'use-chatwizard-in-copilot-chat' },
                { text: 'Connect Claude Desktop via MCP server', anchor: 'connect-claude-desktop-via-mcp-server' },
                { text: 'View per-model usage stats', anchor: 'view-per-model-usage-stats' },
                { text: 'Browse AI-generated code blocks', anchor: 'browse-ai-generated-code-blocks' },
                { text: 'See which files a session touched', anchor: 'see-which-files-a-session-touched' },
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
        const msg = `🐿️ Are you familiar with ${item.text} functionality? Open user guide and learn more.`;
        this._brandingBar.notify(msg, 'workbench.view.extension.chatwizard');

        // Show notification with "Open User Guide" button (opens user-guide.md)
        // and "Don't show again" dismiss option.
        // The notification also appears in VS Code's notification history (bell icon).
        void vscode.window.showInformationMessage(msg, 'Open User Guide', "Don't show again").then(selection => {
            if (selection === 'Open User Guide') {
                const userGuidePath = path.join(this._extensionPath, 'docs', 'user-guide.md');
                const uri = vscode.Uri.file(userGuidePath).with({ fragment: item.anchor });
                void vscode.commands.executeCommand('markdown.showPreview', uri);
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