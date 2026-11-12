/**
 * src/logs/logEventWebview.ts
 *
 * Phase 4 — "Show full contents" webview for watch-logs panels.
 *
 * Clicking a row in the Executed Commands / Unified Timeline / Diff Explorer
 * sections of the **Commands** view opens a webview showing the *full* contents
 * of that normalized `LogEvent` — everything the tree row's tooltip carries,
 * plus structured metadata and per-kind code blocks:
 *
 *   - command      → full command text (+ **▶ Run in Terminal** directly under
 *                    it), cwd/shell/exit code, stdout/stderr
 *   - fileOperation→ operation type, file path, from-path, raw payload
 *   - diff         → file path, +/- stats and the full diff/patch text
 *                    (+ a **Visual Diff** button that opens the change in
 *                    VS Code's native side-by-side diff editor)
 *   - toolCall     → tool name + pretty-printed JSON arguments
 *   - error        → severity, message, stack trace
 *   - plannerStep  → description + status
 *
 * Rendering uses the shared CW design system (`cwThemeCss` +
 * `syntaxHighlighterCss` + `cwInteractiveJs`) so the panel looks identical to
 * every other ChatWizard surface. The pure helpers (`buildEventDetailSections`,
 * `eventDetailText`, `renderEventHtml`) are unit-tested without a VS Code host.
 *
 * Only **one** detail window exists at a time: `showEventWebview()` retargets
 * the live panel (title + contents) instead of creating a tab per event.
 */

import * as vscode from 'vscode';
import {
    CommandEvent,
    DiffEvent,
    ErrorEvent,
    FileOperationEvent,
    LogEvent,
    PlannerStepEvent,
    ToolCallEvent,
    logEventTypeLabel,
} from './types';
import { cwThemeCss, syntaxHighlighterCss, cwInteractiveJs, syntaxHighlighterJs } from '../webview/cwTheme';
import { generateNonce } from '../views/webviewUtils';
import { openVisualDiff } from './diffViewer';
import { runCommandInTerminal } from './runInTerminal';

/** Minimal subscription bag (matches the shape used by `logsCommands.ts`). */
export interface LogEventWebviewSubscriptions {
    push(item: { dispose(): void }): void;
}

/** Inline action rendered right below a code block. */
export type EventCodeBlockAction = 'runInTerminal';

/** A code block rendered inside a detail section. `language` drives tinting. */
export interface EventCodeBlock {
    language: 'bash' | 'diff' | 'json' | 'text';
    text: string;
    /** Optional button rendered directly under this block. */
    action?: EventCodeBlockAction;
}


/** One rendered detail section: key/value rows plus optional code blocks. */
export interface EventDetailSection {
    heading: string;
    rows: [string, string][];
    code: EventCodeBlock[];
}

// ---------------------------------------------------------------------------
// Pure display helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Escape a string for safe embedding in webview HTML (XSS-hardening). */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** First non-empty trimmed line of a text, truncated for browser titles. */
function firstLine(text: string, max: number): string {
    const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Short "<kind>: <what>" label used as the webview panel title. */
export function shortEventLabel(event: LogEvent, max = 70): string {
    const kind = logEventTypeLabel(event.type);
    switch (event.type) {
        case 'command':
            return `${kind}: ${firstLine((event as CommandEvent).commandText, max)}`.slice(0, max);
        case 'diff':
            return `${kind}: ${(event as DiffEvent).filePath}`.slice(0, max);
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            return `${kind}: ${op.operationType} ${op.filePath}`.slice(0, max);
        }
        case 'toolCall':
            return `${kind}: ${(event as ToolCallEvent).toolName}`.slice(0, max);
        case 'error':
            return `${kind}: ${firstLine((event as ErrorEvent).message, max)}`.slice(0, max);
        case 'plannerStep':
            return `${kind}: ${firstLine((event as PlannerStepEvent).description, max)}`.slice(0, max);
    }
}

/** Metadata rows common to every event kind. */
export function eventMetaRows(event: LogEvent): [string, string][] {
    const rows: [string, string][] = [];
    rows.push(['Event kind', logEventTypeLabel(event.type)]);
    rows.push(['Tool', event.tool]);
    if (event.timestamp) { rows.push(['Timestamp', event.timestamp]); }
    if (event.sessionId) { rows.push(['Session', event.sessionId]); }
    if (event.workspaceId) { rows.push(['Workspace id', event.workspaceId]); }
    if (event.workspacePath) { rows.push(['Workspace path', event.workspacePath]); }
    if (event.messageIndex !== undefined) { rows.push(['Message index', String(event.messageIndex)]); }
    if (event.sourcePath) { rows.push(['Source log', event.sourcePath]); }
    rows.push(['Event id', event.id]);
    return rows;
}

/** Per-kind detail sections (rows + code blocks) for the webview. */
export function buildEventDetailSections(event: LogEvent): EventDetailSection[] {
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            const rows: [string, string][] = [];
            if (c.cwd) { rows.push(['Working directory', c.cwd]); }
            if (c.shell) { rows.push(['Shell', c.shell]); }
            rows.push(['Exit code', c.exitCode === undefined ? 'unknown' : String(c.exitCode)]);
            const code: EventCodeBlock[] = [{ language: 'bash', text: c.commandText, action: 'runInTerminal' }];
            if (c.stdoutSummary && c.stdoutSummary.trim().length > 0) {
                code.push({ language: 'text', text: c.stdoutSummary });
            }
            if (c.stderrSummary && c.stderrSummary.trim().length > 0) {
                code.push({ language: 'text', text: c.stderrSummary });
            }
            return [{ heading: 'Command', rows, code }];
        }
        case 'fileOperation': {
            const op = event as FileOperationEvent;
            const rows: [string, string][] = [
                ['Operation', op.operationType],
                ['File path', op.filePath],
            ];
            if (op.oldPath) { rows.push(['From', op.oldPath]); }
            if (op.detail) { rows.push(['Detail', op.detail]); }
            const code: EventCodeBlock[] = op.raw && op.raw.trim().length > 0
                ? [{ language: 'json', text: op.raw }]
                : [];
            return [{ heading: 'File Operation', rows, code }];
        }
        case 'diff': {
            const d = event as DiffEvent;
            const stats = d.addedLines !== undefined || d.removedLines !== undefined
                ? `+${d.addedLines ?? 0} −${d.removedLines ?? 0}`
                : 'unknown';
            const rows: [string, string][] = [
                ['File path', d.filePath],
                ['Lines', stats],
            ];
            if (d.commandId) { rows.push(['Triggered by command', d.commandId]); }
            const code: EventCodeBlock[] = d.diffText && d.diffText.trim().length > 0
                ? [{ language: 'diff', text: d.diffText }]
                : [];
            return [{ heading: 'Diff / Patch', rows, code }];
        }
        case 'toolCall': {
            const t = event as ToolCallEvent;
            const rows: [string, string][] = [['Tool', t.toolName]];
            if (t.success !== undefined) { rows.push(['Success', String(t.success)]); }
            if (t.durationMs !== undefined) { rows.push(['Duration', `${t.durationMs} ms`]); }
            if (t.resultSummary) { rows.push(['Result', t.resultSummary]); }
            const code: EventCodeBlock[] = [];
            if (t.arguments) { code.push({ language: 'json', text: JSON.stringify(t.arguments, null, 2) }); }
            if (t.raw && t.raw.trim().length > 0) { code.push({ language: 'text', text: t.raw }); }
            return [{ heading: 'Tool Call', rows, code }];
        }
        case 'error': {
            const e = event as ErrorEvent;
            const rows: [string, string][] = [['Severity', e.severity ?? 'error']];
            if (e.commandId) { rows.push(['Command', e.commandId]); }
            const code: EventCodeBlock[] = [{ language: 'text', text: e.message }];
            if (e.stackTrace && e.stackTrace.trim().length > 0) { code.push({ language: 'text', text: e.stackTrace }); }
            if (e.raw && e.raw.trim().length > 0) { code.push({ language: 'text', text: e.raw }); }
            return [{ heading: 'Error / Failure', rows, code }];
        }
        case 'plannerStep': {
            const p = event as PlannerStepEvent;
            const rows: [string, string][] = [];
            if (p.stepType) { rows.push(['Step type', p.stepType]); }
            if (p.status) { rows.push(['Status', p.status]); }
            const code: EventCodeBlock[] = p.description && p.description.trim().length > 0
                ? [{ language: 'text', text: p.description }]
                : [];
            return [{ heading: 'Planner Step', rows, code }];
        }
    }
}

/**
 * Plain-text representation of the event's full contents — used by the
 * webview's Copy button so the clipboard mirrors exactly what was displayed.
 */
export function eventDetailText(event: LogEvent): string {
    const lines: string[] = [shortEventLabel(event)];
    lines.push('');
    for (const [key, value] of eventMetaRows(event)) { lines.push(`${key}: ${value}`); }
    for (const section of buildEventDetailSections(event)) {
        lines.push('');
        lines.push(`── ${section.heading} ──`);
        for (const [key, value] of section.rows) { lines.push(`${key}: ${value}`); }
        for (const block of section.code) {
            lines.push('');
            if (block.language !== 'text') { lines.push(`~~~ ${block.language}`); }
            lines.push(block.text);
            if (block.language !== 'text') { lines.push('~~~'); }
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** Render a "key: value" table as escaped HTML rows. */
function renderRows(rows: [string, string][]): string {
    if (rows.length === 0) { return ''; }
    const body = rows.map(([k, v]) =>
        `<tr><td class="cw-k">${escapeHtml(k)}</td><td class="cw-v">${escapeHtml(v)}</td></tr>`).join('\n');
    return `<table class="cw-rows"><tbody>${body}</tbody></table>`;
}

/** Render one code block, wrapped in `<pre><code>` with a tinting class. */
function renderCode(block: EventCodeBlock): string {
    const cls = block.language === 'text' ? 'language-text' : `language-${block.language}`;
    return `<pre><code class="${cls}">${escapeHtml(block.text)}</code></pre>`;
}

/**
 * Render the inline button that belongs to a code block. Commands get
 * "▶ Run in Terminal" *below the command text*, so re-running what the agent
 * ran is one click away.
 */
export function renderCodeBlockAction(action: EventCodeBlockAction): string {
    switch (action) {
        case 'runInTerminal':
            return `<div class="cw-block-action"><button class="cw-btn cw-run-btn" id="runCommandBtn"`
                + ` title="Open a terminal and run this command">▶ Run in Terminal</button></div>`;
    }
}

/** Render every detail section described by the event. */
export function renderSections(event: LogEvent): string {
    const parts: string[] = [];
    for (const section of buildEventDetailSections(event)) {
        parts.push(`<section class="cw-section">`);
        parts.push(`<h3>${escapeHtml(section.heading)}</h3>`);
        parts.push(renderRows(section.rows));
        for (const block of section.code) {
            parts.push(renderCode(block));
            if (block.action) { parts.push(renderCodeBlockAction(block.action)); }
        }
        parts.push('</section>');
    }
    // Metadata block always last so the primary content reads first.
    parts.push('<section class="cw-section cw-meta"><h3>Metadata</h3>');
    parts.push(renderRows(eventMetaRows(event)));
    parts.push('</section>');
    return parts.join('\n');
}

/** Full standalone HTML document for the event's webview panel. */
export function renderEventHtml(event: LogEvent, nonce: string): string {
    const kind = logEventTypeLabel(event.type);
    const time = event.timestamp ? new Date(event.timestamp).toLocaleString() : 'unknown time';
    const hasSession = typeof event.sessionId === 'string' && event.sessionId.length > 0;
    // Diffs get a dedicated action: the raw patch text below is for reading,
    // the native diff editor is for *seeing* the change.
    const hasDiff = event.type === 'diff' && ((event as DiffEvent).diffText ?? '').trim().length > 0;
    const actionButtons = `
        <button class="cw-btn" id="copyBtn" title="Copy the full contents">Copy</button>
        ${hasDiff ? `<button class="cw-btn" id="visualDiffBtn" title="Open in the side-by-side diff editor">Visual Diff</button>` : ''}
        ${hasSession ? `<button class="cw-btn" id="sessionBtn" title="Open the chat session">Open Session</button>` : ''}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline' 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${escapeHtml(shortEventLabel(event))}</title>
<style nonce="${nonce}">
${cwThemeCss()}
${syntaxHighlighterCss()}
/* -- LogEvent detail webview ------------------------------------ */
body { padding: 14px 18px; font-size: 13px; }
.cw-kind  { color: var(--cw-accent); font-weight: 600; }
.cw-tool  { color: var(--cw-text-muted); }
.cw-time  { color: var(--cw-text-muted); }
.cw-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cw-header .cw-btn { margin-left: auto; }
.cw-section { margin-top: 14px; }
.cw-section h3 {
  margin: 0 0 6px; font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--cw-text-muted);
}
.cw-rows { width: 100%; border-collapse: collapse; }
.cw-rows td { padding: 3px 10px; border-bottom: 1px solid var(--cw-border); vertical-align: top; }
.cw-rows .cw-k { color: var(--cw-text-muted); white-space: nowrap; width: 1%; padding-right: 14px; }
.cw-rows .cw-v { word-break: break-all; }
.cw-meta { opacity: 0.92; }
pre { max-width: 100%; overflow-x: auto; }
code.language-text { white-space: pre-wrap; }
/* inline action(s) rendered under a code block */
.cw-block-action { display: flex; align-items: center; gap: 6px; margin: 6px 0 2px; }
.cw-block-action .cw-run-btn { font-weight: 600; }
/* diff tinting (custom tokens) */
.diff-add  { color: #3fb950; }
.diff-del  { color: #f85149; }
.diff-hunk { color: #d2a8ff; }
.diff-meta { color: #79c0ff; }
</style>
</head>
<body>
  <header class="cw-header cw-card-header">
    <span class="cw-kind">${escapeHtml(kind)}</span>
    <span class="cw-tool">${escapeHtml(event.tool)}</span>
    <span class="cw-time">${escapeHtml(time)}</span>
    ${actionButtons}
  </header>
  <main>${renderSections(event)}</main>
  <script nonce="${nonce}">
  ${cwInteractiveJs()}
  ${syntaxHighlighterJs()}
  (function() {
    var vscode = acquireVsCodeApi();

    // Diff-line tinting for pre code.language-diff blocks.
    function escT(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    document.querySelectorAll('pre code.language-diff').forEach(function(block) {
      var raw = block.textContent || '';
      var lines = raw.split('\\n').map(function(line) {
        if (line.startsWith('+++') || line.startsWith('---')) {
          return '<span class="diff-meta">' + escT(line) + '</span>';
        }
        if (line.startsWith('+')) { return '<span class="diff-add">' + escT(line) + '</span>'; }
        if (line.startsWith('-')) { return '<span class="diff-del">' + escT(line) + '</span>'; }
        if (line.startsWith('@@')) { return '<span class="diff-hunk">' + escT(line) + '</span>'; }
        return escT(line);
      });
      block.innerHTML = lines.join('\\n');
    });

    var copyBtn = document.getElementById('copyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        vscode.postMessage({ command: 'copy' });
        if (window.cwShowToast) { window.cwShowToast('Copied to clipboard'); }
      });
    }
    var sessionBtn = document.getElementById('sessionBtn');
    if (sessionBtn) {
      sessionBtn.addEventListener('click', function() { vscode.postMessage({ command: 'openSession' }); });
    }
    var visualDiffBtn = document.getElementById('visualDiffBtn');
    if (visualDiffBtn) {
      visualDiffBtn.addEventListener('click', function() { vscode.postMessage({ command: 'openVisualDiff' }); });
    }
    var runBtn = document.getElementById('runCommandBtn');
    if (runBtn) {
      runBtn.addEventListener('click', function() {
        vscode.postMessage({ command: 'runInTerminal' });
        if (window.cwShowToast) { window.cwShowToast('Running in terminal'); }
      });
    }
  })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------

/**
 * The single detail window. Every log row (Executed Commands, Unified Timeline,
 * Diff Explorer) reuses this panel — clicking row after row updates the same
 * window instead of piling up one webview per event, which used to lose the
 * user among a dozen tabs.
 */
interface EventDetailPanelState {
    panel: vscode.WebviewPanel;
    /** The event currently rendered in the panel (updated on every open). */
    current: LogEvent;
    disposables: vscode.Disposable[];
}

let _detail: EventDetailPanelState | undefined;

/**
 * Open — or retarget — the shared detail panel for `event`.
 *
 * The panel is created once and then re-used: its title and HTML are replaced
 * with the new event's contents, so there is exactly one "log event" window.
 * Closing the window disposes the state, and the next click creates a fresh
 * panel. `subscriptions` is optional and matches the bag used by
 * `registerLogCommands` (its `push` registers a dispose that lives for the
 * extension's lifetime).
 */
export function showEventWebview(event: LogEvent, subscriptions?: LogEventWebviewSubscriptions): vscode.WebviewPanel | undefined {
    if (_detail) {
        _detail.current = event;
        _detail.panel.title = shortEventLabel(event);
        _detail.panel.webview.html = renderEventHtml(event, generateNonce());
        _detail.panel.reveal(vscode.ViewColumn.Two);
        return _detail.panel;
    }

    const panel = vscode.window.createWebviewPanel(
        'chatwizardLogEventDetail',
        shortEventLabel(event),
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const state: EventDetailPanelState = { panel, current: event, disposables: [] };
    _detail = state;
    panel.webview.html = renderEventHtml(event, generateNonce());

    panel.onDidDispose(() => {
        if (_detail === state) { _detail = undefined; }
        for (const d of state.disposables) { d.dispose(); }
    });

    // Handlers read `state.current` — the panel outlives any single event.
    const msgListener = panel.webview.onDidReceiveMessage((message: { command?: string }) => {
        const current = state.current;
        if (message.command === 'copy') {
            void vscode.env.clipboard.writeText(eventDetailText(current));
        } else if (message.command === 'openSession' && current.sessionId) {
            void vscode.commands.executeCommand('chatwizard.openSession', { id: current.sessionId });
        } else if (message.command === 'openVisualDiff') {
            void openVisualDiff(current);
        } else if (message.command === 'runInTerminal' && current.type === 'command') {
            const commandEvent = current as CommandEvent;
            void runCommandInTerminal(commandEvent.commandText, commandEvent.cwd);
        }
    });
    state.disposables.push(msgListener);

    if (subscriptions) {
        // Tie the panel's listeners to the caller's extension-lifetime bag.
        subscriptions.push({
            dispose: () => { for (const d of state.disposables) { d.dispose(); } },
        });
    }

    return panel;
}

/** Close the shared detail panel (used by tests and panel re-use checks). */
export function closeEventWebview(): void {
    _detail?.panel.dispose();
    _detail = undefined;
}
