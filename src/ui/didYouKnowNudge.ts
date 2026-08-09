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
    /** 0-based line number in the source markdown file. */
    lineNumber: number;
    /** Anchor fragment for navigating in markdown preview, e.g. "19-did-you-know-tips". */
    anchor: string;
}

function toAnchor(heading: string): string {
    // GitHub-style anchor: lowercase, remove non-alnum/non-space/non-hyphen,
    // replace spaces with hyphens, collapse consecutive hyphens.
    return heading
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

/**
 * Parse section headings ("## ..." and "### ...") from the user-guide markdown
 * file. Returns a deduplicated list of {text, lineNumber} pairs,
 * excluding the top-level H1 and any empty or TOC-only headings.
 * For H3 headings, the parent H2 section name is prepended so the
 * nudge message includes context (e.g. "MCP Server & AI Integrations Quick Start").
 */
function parseUserGuideSections(filePath: string): SectionHeading[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const seen = new Set<string>();
        const headings: SectionHeading[] = [];
        let currentH2 = '';

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (/^##\s+(?!\n)(.+)/.test(trimmed)) {
                const text = trimmed.replace(/^##\s+/, '').trim();
                if (text && !text.startsWith('Table of Contents') && text.length > 2) {
                    currentH2 = text;
                    const displayText = text.replace(/^\d+\.\s+/, '');
                    if (!seen.has(displayText)) {
                        seen.add(displayText);
                        headings.push({ text: displayText, lineNumber: i, anchor: toAnchor(text) });
                    }
                }
            } else if (/^###\s+(?!\n)(.+)/.test(trimmed)) {
                const text = trimmed.replace(/^###\s+/, '').trim();
                if (text && text.length > 2 && !seen.has(text)) {
                    seen.add(text);
                    // Prepend parent H2 for context — strip numbering prefix from both
                    const parentLabel = currentH2.replace(/^\d+\.\s+/, '');
                    const displayText = parentLabel ? `${parentLabel} ${text}` : text;
                    headings.push({ text: displayText, lineNumber: i, anchor: toAnchor(text) });
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
                { text: 'Search past sessions by keyword', lineNumber: 0, anchor: 'search' },
                { text: 'Tag sessions for quick filtering', lineNumber: 0, anchor: 'tag' },
                { text: 'Export sessions to Markdown or Obsidian', lineNumber: 0, anchor: 'export' },
                { text: 'Use @chatwizard in Copilot Chat', lineNumber: 0, anchor: 'chatwizard' },
                { text: 'Connect Claude Desktop via MCP server', lineNumber: 0, anchor: 'mcp' },
                { text: 'View per-model usage stats', lineNumber: 0, anchor: 'usage' },
                { text: 'Browse AI-generated code blocks', lineNumber: 0, anchor: 'codeblocks' },
                { text: 'See which files a session touched', lineNumber: 0, anchor: 'files' },
            ];
        }
        this._queue = shuffle(this._items);
        this._start();
    }

    private _start(): void {
        const cfg = vscode.workspace.getConfiguration('chatwizard');
        const intervalSec = cfg.get<number>('didYouKnowInterval', 600);
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
        const msg = `🐿️ Want to learn about ${item.text}? Go ahead and look at it in user guide!`;
        this._brandingBar.notify(msg, 'workbench.view.extension.chatwizard');

        // Show notification with "Open User Guide" button (opens user-guide.md)
        // and "Don't show again" dismiss option.
        // The notification also appears in VS Code's notification history (bell icon).
        void vscode.window.showInformationMessage(msg, 'Open User Guide', "Don't show again").then(selection => {
            if (selection === 'Open User Guide') {
                const userGuidePath = path.join(this._extensionPath, 'docs', 'user-guide.md');
                const uri = vscode.Uri.file(userGuidePath);
                // Open source file, reveal the heading line, then open preview —
                // VS Code syncs the preview to the cursor position in the source.
                void vscode.workspace.openTextDocument(uri).then(doc => {
                    void vscode.window.showTextDocument(doc).then(editor => {
                        const pos = new vscode.Position(item.lineNumber, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
                        void vscode.commands.executeCommand('markdown.showPreview', uri);
                    });
                });
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