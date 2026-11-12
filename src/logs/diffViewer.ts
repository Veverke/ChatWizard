/**
 * src/logs/diffViewer.ts
 *
 * Phase 4 — visual (side-by-side) diff viewer for the Diff Explorer.
 *
 * The watch-logs store keeps the *patch text* an agent produced
 * (`DiffEvent.diffText`), not whole-file snapshots. To show that change the way
 * GUI Git clients do — two panes, coloured rows, word-level highlighting,
 * "collapse unchanged regions", inline/side-by-side toggle — this module
 * reconstructs the two sides of the patch and hands them to VS Code's built-in
 * diff editor (`vscode.diff`) through a read-only virtual document provider:
 *
 *   - context (`" "`) and removed (`-`) lines → "before" document
 *   - context (`" "`) and added (`+`) lines   → "after" document
 *
 * Because a log entry only carries the hunks (never the whole file), the two
 * documents are the *changed regions* — line numbers in the diff editor are
 * relative to the captured region, not to the file on disk. Patches that log
 * additions only (GitHub Copilot's summarized `textEditGroup` patches — the
 * pre-image is not persisted by the tool) therefore render with an empty left
 * pane, which is the honest reading of the data.
 *
 * The pure helpers (`diffHeaderPath`, `reconstructDiffSides`,
 * `buildVisualDiffTitle`, `diffSideUris`) are unit-tested without a VS Code
 * host; only `DiffSideContentProvider` / `openVisualDiff` touch the API.
 */

import * as vscode from 'vscode';
import { DiffEvent, LogEvent, getEventFilePath } from './types';

/** URI scheme of the read-only documents that feed the diff editor. */
export const DIFF_SCHEME = 'chatwizard-diff';

/** Hard cap on the number of lines reconstructed per side of a patch. */
export const MAX_PATCH_SIDE_LINES = 20000;

/** How many virtual diff documents are kept before the oldest is dropped. */
export const MAX_CACHED_DIFF_DOCUMENTS = 200;

/** The two reconstructed sides of a patch, plus its parsing metadata. */
export interface ReconstructedDiffSides {
    /** Context + removed lines (the "original" pane). */
    before: string;
    /** Context + added lines (the "modified" pane). */
    after: string;
    /** Number of `@@ … @@` hunk headers seen. */
    hunkCount: number;
    /** `+` lines counted while reconstructing. */
    addedLines: number;
    /** `-` lines counted while reconstructing. */
    removedLines: number;
    /** `--- ` header path, when the patch carried one. */
    oldPath?: string;
    /** `+++ ` header path, when the patch carried one. */
    newPath?: string;
    /** False when the text had no hunk header (a summarized / hand-written patch). */
    hasHunks: boolean;
    /** True when a side hit {@link MAX_PATCH_SIDE_LINES}. */
    truncated: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Normalize a `---`/`+++` header path: drop the trailing `<TAB>timestamp`
 * git appends and the `"a/"` / `"b/"` prefixes it uses.
 */
export function diffHeaderPath(raw: string): string | undefined {
    let value = raw.trim();
    const tab = value.indexOf('\t');
    if (tab >= 0) { value = value.slice(0, tab).trim(); }
    if (value.length === 0) { return undefined; }
    if (value.startsWith('"') && value.endsWith('"')) { value = value.slice(1, -1); }
    value = value.replace(/^[ab]\//, '');
    return value.length > 0 ? value : undefined;
}

/** Basename of a POSIX or Windows path ('' for an empty path). */
export function baseNameOf(filePath: string): string {
    const normalized = (filePath ?? '').replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/**
 * Split a unified diff / patch into its "before" and "after" sides.
 *
 * Tolerant by design — the store holds patches from several adapters:
 *   - standard `--- a/x` / `+++ b/x` / `@@ -1,3 +1,3 @@` git & unified diffs
 *   - Cline SEARCH/REPLACE patches (`@@ -3 +4 @@` — counts, not offsets)
 *   - Copilot summarized patches (`@@ modified by assistant @@`, additions only)
 *   - patches with no hunk header at all (parsed as one implicit hunk)
 *
 * `\ No newline at end of file` markers are ignored, CRLF is normalized, and a
 * side is never allowed to grow past {@link MAX_PATCH_SIDE_LINES}.
 */
export function reconstructDiffSides(diffText: string): ReconstructedDiffSides {
    const before: string[] = [];
    const after: string[] = [];
    let hunkCount = 0;
    let addedLines = 0;
    let removedLines = 0;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let truncated = false;

    const push = (target: string[], value: string): void => {
        if (target.length >= MAX_PATCH_SIDE_LINES) {
            truncated = true;
            return;
        }
        target.push(value);
    };

    const lines = (diffText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // The final newline must not turn into a bogus empty trailing line.
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }

    // `inHunk` starts true for patch texts that carry no hunk header at all
    // (they are parsed as one implicit hunk). `inBody` marks the point where
    // real content has begun — from there on `---`/`+++` lines are content
    // (e.g. a removed SQL `-- comment`), never file headers.
    let inHunk = !lines.some((line) => line.startsWith('@@'));
    let inBody = false;

    for (const line of lines) {
        if (!inBody && line.startsWith('--- ')) {
            oldPath = diffHeaderPath(line.slice(4)) ?? oldPath;
            continue;
        }
        if (!inBody && line.startsWith('+++ ')) {
            newPath = diffHeaderPath(line.slice(4)) ?? newPath;
            continue;
        }
        if (line.startsWith('@@')) {
            hunkCount++;
            inHunk = true;
            inBody = true;
            continue;
        }
        // Preamble lines ("diff --git …", "index …", "similarity index …").
        if (!inHunk) { continue; }
        inBody = true;
        if (line.startsWith('\\')) { continue; } // "\ No newline at end of file"

        const marker = line.charAt(0);
        if (marker === '+') {
            addedLines++;
            push(after, line.slice(1));
        } else if (marker === '-') {
            removedLines++;
            push(before, line.slice(1));
        } else if (marker === ' ') {
            push(before, line.slice(1));
            push(after, line.slice(1));
        } else if (line.length === 0) {
            push(before, '');
            push(after, '');
        } else {
            // Not a unified-diff body line — keep it visible on both sides.
            push(before, line);
            push(after, line);
        }
    }

    return {
        before: before.join('\n'),
        after: after.join('\n'),
        hunkCount,
        addedLines,
        removedLines,
        oldPath,
        newPath,
        hasHunks: hunkCount > 0,
        truncated,
    };
}

/** Whether {@link reconstructDiffSides} found anything worth rendering. */
export function hasRenderableSides(sides: ReconstructedDiffSides): boolean {
    return sides.before.trim().length > 0 || sides.after.trim().length > 0;
}

/** Editor title for the visual diff (kept short — it lands in the tab). */
export function buildVisualDiffTitle(event: LogEvent): string {
    const filePath = getEventFilePath(event) ?? 'change';
    const name = baseNameOf(filePath) || filePath;
    if (event.type === 'diff') {
        const d = event as DiffEvent;
        const stats = d.addedLines !== undefined || d.removedLines !== undefined
            ? ` (+${d.addedLines ?? 0} −${d.removedLines ?? 0})`
            : '';
        return `${name} — ${event.tool} diff${stats}`;
    }
    return `${name} — ${event.tool}`;
}

/** The pair of virtual URIs handed to `vscode.diff` for one event. */
export interface DiffSideUris {
    left: vscode.Uri;
    right: vscode.Uri;
}

/**
 * Build the two virtual document URIs for an event.
 *
 * The URI *path* keeps the real file name (with its extension) so VS Code
 * infers the language and syntax-highlights both panes; the side + event id
 * live in the query string.
 */
export function diffSideUris(event: LogEvent, sides: ReconstructedDiffSides): DiffSideUris {
    const filePath = sides.newPath ?? sides.oldPath ?? getEventFilePath(event) ?? 'change.txt';
    const name = baseNameOf(filePath) || 'change.txt';
    const key = encodeURIComponent(event.id);
    const make = (side: 'before' | 'after'): vscode.Uri => vscode.Uri.from({
        scheme: DIFF_SCHEME,
        path: `/${name}`,
        query: `id=${key}&side=${side}`,
    });
    return { left: make('before'), right: make('after') };
}

// ---------------------------------------------------------------------------
// Virtual documents backing the diff editor
// ---------------------------------------------------------------------------

/**
 * Read-only `TextDocumentContentProvider` for the {@link DIFF_SCHEME} scheme.
 * Content is registered per URI right before the diff editor opens it, so no
 * log data ever leaks into the workspace file system.
 */
export class DiffSideContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _contents = new Map<string, string>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    /** Register (or replace) the content served for `uri`. */
    set(uri: vscode.Uri, content: string): void {
        const key = uri.toString();
        // Re-insert so the map keeps its LRU order.
        this._contents.delete(key);
        this._contents.set(key, content);
        while (this._contents.size > MAX_CACHED_DIFF_DOCUMENTS) {
            const oldest = this._contents.keys().next().value as string | undefined;
            if (oldest === undefined) { break; }
            this._contents.delete(oldest);
        }
        this._onDidChange.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }

    /** Number of documents currently cached (tests / diagnostics). */
    get size(): number {
        return this._contents.size;
    }

    dispose(): void {
        this._contents.clear();
        this._onDidChange.dispose();
    }
}

/** Minimal subscription bag (matches `logsCommands.ts` / `logEventWebview.ts`). */
export interface DiffViewerSubscriptions {
    push(item: { dispose(): void }): void;
}

let _provider: DiffSideContentProvider | undefined;
let _providerRegistered = false;

/** The process-wide provider instance (created lazily). */
export function getDiffSideContentProvider(): DiffSideContentProvider {
    if (!_provider) { _provider = new DiffSideContentProvider(); }
    return _provider;
}

/** The minimal extension-context shape this module needs (same as `logsCommands`). */
export interface DiffViewerContext {
    subscriptions: DiffViewerSubscriptions;
}

/**
 * Register the virtual-document provider that backs the diff editor. Safe to
 * call more than once — the scheme can only be registered once per host.
 */
export function registerDiffViewer(context: DiffViewerContext): DiffSideContentProvider {
    const provider = getDiffSideContentProvider();
    if (!_providerRegistered) {
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider));
        context.subscriptions.push(provider);
        _providerRegistered = true;
    }
    return provider;
}

/**
 * Options for {@link openVisualDiff}.
 */
export interface OpenVisualDiffOptions {
    /**
     * Open in preview mode (a single reusable tab). Used by the tree's
     * click-to-open handler so arrow-key navigation does not spam tabs;
     * explicit invocations (command / button) open a permanent tab.
     */
    preview?: boolean;
}

/**
 * Open the change in VS Code's diff editor (side-by-side by default, inline via
 * the editor title-bar toggle) — the same native UI the Git / SCM extensions use.
 *
 * Returns `false` (without opening anything) when the event is not a diff or
 * carries no renderable patch, so callers can fall back to the detail webview.
 */
export async function openVisualDiff(event: LogEvent, options?: OpenVisualDiffOptions): Promise<boolean> {
    if (event.type !== 'diff') { return false; }

    const sides = reconstructDiffSides((event as DiffEvent).diffText);
    if (!hasRenderableSides(sides)) { return false; }

    const provider = getDiffSideContentProvider();
    const { left, right } = diffSideUris(event, sides);
    provider.set(left, sides.before);
    provider.set(right, sides.after);

    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        buildVisualDiffTitle(event),
        { preview: options?.preview ?? false }
    );
    return true;
}


