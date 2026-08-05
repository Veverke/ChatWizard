// src/ui/didYouKnowNudge.ts
// Feature — "Did You Know" nudge that cycles through parsed user-guide
// section headings at 5-minute intervals via the squirrel mascot.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BrandingStatusBarItem } from './brandingStatusBar';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Use-case text per feature — maps section headings to practical descriptions
 * that help users understand why they'd use each feature.
 */
const USE_CASE_MAP: Record<string, string> = {
    'Sessions Panel': 'Looking for that conversation you had with AI last week? Browse all your past sessions here.',
    'Full-Text Search': 'Remember a keyword from a past chat? Find any session instantly.',
    'Semantic Search': 'Describe what you need in your own words — find related sessions even without exact keywords.',
    'Code Blocks Panel': 'Looking for that code snippet the AI recommended recently? Browse all generated code in one place.',
    'Prompt Library': 'Save your best prompts and reuse them across sessions — stop typing the same thing twice.',
    'Knowledge Base': 'Turn your past sessions into a searchable knowledge base — learn from what you already built.',
    'Action Items': 'Never lose track of tasks the AI suggested — auto-extracted action items from every session.',
    'Analytics': 'See which models you use most, how many tokens you burn, and where your time goes.',
    'Model Usage': 'Track token consumption per model — spot cost-saving opportunities at a glance.',
    'Timeline': 'Visualize your coding sessions on a timeline — see what you worked on and when.',
    'Session Bookmarks': 'Mark important sessions so you can jump back to them instantly.',
    'Inline Annotations': 'Add notes to any session without editing the original file — context where you need it.',
    'Session Linking': 'Link related sessions together — build a web of context around your work.',
    'Session Sharing': 'Share a session with your team via a simple link — no more copy-pasting.',
    'Keyboard Navigation': 'Navigate ChatWizard entirely from the keyboard — power-user mode activated.',
    'Did You Know Tips': 'You are here! These tips help you discover features you might have missed.',
    'Session Retention': 'Auto-clean old sessions to keep your index fast and focused.',
    'Compacted Sessions': 'VS Code compacts old Copilot sessions — ChatWizard reads them seamlessly.',
    'Export': 'Export sessions to Markdown, JSON, or Obsidian — take your data anywhere.',
    'MCP Server & AI Integrations': 'Connect ChatWizard to Claude Desktop, Cline, or any MCP-compatible tool.',
    'Workspace Management': 'Working on multiple projects? Scope ChatWizard to the current workspace only.',
    'File History': 'See which files each session touched — trace the impact of every AI conversation.',
    'Session Tagging': 'Tag sessions by project, topic, or priority — filter your history in one click.',
    'Session Archive': 'Archive old sessions to keep your index lean without losing data.',
    'AI Intelligence': 'Auto-generated summaries and entity extraction — get the gist without reading everything.',
    'Settings Reference': 'Fine-tune every aspect of ChatWizard to match your workflow.',
    'Commands Reference': 'Quick reference for every ChatWizard command — bookmark this page.',
};

/**
 * Parse section headings ("## ...") from the user-guide markdown file.
 * Returns a deduplicated list of heading texts (without the "## " prefix),
 * excluding the top-level H1 and any empty or TOC-only headings.
 */
function parseUserGuideSections(filePath: string): string[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const headings = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            // Match "## Section Title" but NOT "### Sub-section" or "# H1"
            if (/^##\s+(?!##)(.+)/.test(trimmed)) {
                const text = trimmed.replace(/^##\s+/, '').trim();
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
        const useCase = USE_CASE_MAP[item];
        const msg = useCase
            ? `🐿️ Did you know? ${item} — ${useCase}`
            : `🐿️ Did you know? ${item}`;
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