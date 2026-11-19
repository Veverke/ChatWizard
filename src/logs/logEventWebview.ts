/**
 * src/logs/logEventWebview.ts
 *
 * Phase 4 — "Show full contents" webview for watch-logs panels.
 *
 * Clicking a row in the Terminal Commands / LLM Tool Calls / Unified Timeline /
 * Diff Explorer sections of the **Commands** view opens a webview showing the
 * *full* contents of that normalized `LogEvent` — everything the tree row's
 * tooltip carries, a plain-English **Description** of what the command / tool
 * does, plus structured metadata and per-kind code blocks:
 *
 *   - every kind   → **Description** (`Runs a Git command: git status`,
 *                    `Reads a file from the workspace: src/extension.ts`).
 *                    For commands it is upgraded asynchronously: as soon as the
 *                    panel opens, a **free** model (when one is available,
 *                    loaded lazily by `commandPurpose`) is asked what the
 *                    sequence is *for*, and the Description row is patched in
 *                    place. Without a model the heuristic sentence stays.
 *   - command      → **Input** (one statement per line + **▶ Run in Terminal**
 *                    directly under it, cwd/shell) and **Output** (exit code,
 *                    stdout, stderr)
 *   - toolCall     → **Input** (tool name + pretty-printed JSON arguments) and
 *                    **Output** (success/duration/result, when captured)
 *   - fileOperation→ operation type, file path, from-path, raw payload
 *   - diff         → file path, +/- stats and the full diff/patch text
 *                    (+ a **Visual Diff** button that opens the change in
 *                    VS Code's native side-by-side diff editor)
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
import {
    describeLogEvent,
    toolCallInputText,
    toolCallLabel,
    toolCallOutputText,
} from './logEventSummary';
import { formatCommandStatements } from './commandStatements';
import {
    deriveCommandPurpose,
    isCommandPurposeResolved,
    peekCommandPurpose,
} from './commandPurpose';
import { createLogger } from '../utils/logger';

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
            return `${kind}: ${toolCallLabel(event as ToolCallEvent, max)}`.slice(0, max);
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

/**
 * Per-kind detail sections (rows + code blocks) for the webview.
 *
 * Every event leads with a **Description** section — a plain-English sentence
 * explaining what the command / tool does — followed by the kind-specific
 * payload. Rows that describe what the agent *asked for* live under **Input**,
 * what came back (exit code, captured output, tool result) under **Output**.
 *
 * `description` overrides the heuristic sentence — it is how the lazily
 * derived model purpose reaches the rendered page.
 */
export function buildEventDetailSections(event: LogEvent, description?: string): EventDetailSection[] {
    const what = (description ?? '').trim().length > 0 ? (description as string) : describeLogEvent(event);
    return [
        { heading: 'Description', rows: [['What happened', what]], code: [] },
        ...eventPayloadSections(event),
    ];
}

/**
 * Placeholder painted in the Description row while the free model is answering.
 * Command details start with this instead of the heuristic sentence, so the row
 * visibly fills in when the answer lands — or falls back to the heuristic text
 * when no model is available.
 */
export const DESCRIPTION_LOADING_TEXT = 'Loading…';

/**
 * Whether this event's Description is waiting on the free model right now, so
 * the page is showing {@link DESCRIPTION_LOADING_TEXT}.
 */
function awaitsModelDescription(event: LogEvent): boolean {
    if (event.type !== 'command') { return false; }
    const command = event as CommandEvent;
    if ((command.commandText ?? '').trim().length === 0) { return false; }
    return !isCommandPurposeResolved(command);
}

/**
 * The Description to paint on the **first** render of a detail page:
 *
 *   - the cached model purpose, when one was already derived,
 *   - {@link DESCRIPTION_LOADING_TEXT} while the free-model answer is still
 *     outstanding (the host patches the row when it lands),
 *   - `undefined` for everything else, which shows the heuristic sentence.
 *
 * A previously asked command whose model call returned nothing is *settled* —
 * it renders the heuristic text immediately instead of a stuck placeholder.
 */
export function initialEventDescription(event: LogEvent): string | undefined {
    if (event.type !== 'command') { return undefined; }
    const command = event as CommandEvent;
    if ((command.commandText ?? '').trim().length === 0) { return undefined; }
    const cached = peekCommandPurpose(command);
    if (cached !== undefined) { return cached; }
    return awaitsModelDescription(event) ? DESCRIPTION_LOADING_TEXT : undefined;
}

/** The kind-specific sections that follow the shared Description. */
function eventPayloadSections(event: LogEvent): EventDetailSection[] {
    switch (event.type) {
        case 'command': {
            const c = event as CommandEvent;
            const inputRows: [string, string][] = [];
            if (c.cwd) { inputRows.push(['Working directory', c.cwd]); }
            if (c.shell) { inputRows.push(['Shell', c.shell]); }
            const input: EventDetailSection = {
                heading: 'Input',
                rows: inputRows,
                // One statement per line — a long `a && b; c` chain is
                // unreadable as a single line. Separators are kept so the text
                // stays copy-pasteable (the Run button still uses the original).
                code: [{ language: 'bash', text: formatCommandStatements(c.commandText), action: 'runInTerminal' }],
            };
            const outputRows: [string, string][] = [
                ['Exit code', c.exitCode === undefined ? 'unknown' : String(c.exitCode)],
            ];
            const outputCode: EventCodeBlock[] = [];
            if (c.stdoutSummary && c.stdoutSummary.trim().length > 0) {
                outputCode.push({ language: 'text', text: c.stdoutSummary });
            }
            if (c.stderrSummary && c.stderrSummary.trim().length > 0) {
                outputCode.push({ language: 'text', text: c.stderrSummary });
            }
            return [input, { heading: 'Output', rows: outputRows, code: outputCode }];
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
            // Input: the tool + the arguments the model sent.
            const inputCode: EventCodeBlock[] = [];
            const argsText = toolCallInputText(t);
            if (argsText) { inputCode.push({ language: 'json', text: argsText }); }
            if (t.raw && t.raw.trim().length > 0 && t.raw !== argsText) {
                inputCode.push({ language: 'text', text: t.raw });
            }
            const input: EventDetailSection = {
                heading: 'Input',
                rows: [['Tool', t.toolName]],
                code: inputCode,
            };
            // Output: whatever the agent host captured for the call.
            const outputRows: [string, string][] = [];
            if (t.success !== undefined) { outputRows.push(['Success', String(t.success)]); }
            if (t.durationMs !== undefined) { outputRows.push(['Duration', `${t.durationMs} ms`]); }
            const outputCode: EventCodeBlock[] = [];
            const result = toolCallOutputText(t);
            if (result) {
                outputCode.push({ language: 'text', text: result });
            } else if (outputRows.length === 0) {
                outputRows.push(['Result', 'not captured in the agent log']);
            }
            return [input, { heading: 'Output', rows: outputRows, code: outputCode }];
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
export function eventDetailText(event: LogEvent, description?: string): string {
    const lines: string[] = [shortEventLabel(event)];
    lines.push('');
    for (const [key, value] of eventMetaRows(event)) { lines.push(`${key}: ${value}`); }
    for (const section of buildEventDetailSections(event, description)) {
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

/**
 * Render a "key: value" table as escaped HTML rows.
 *
 * `valueId` is set on every value cell — the Description section uses it so the
 * asynchronously derived purpose can be patched without re-rendering the page.
 */
function renderRows(rows: [string, string][], valueId?: string, valueClass?: string): string {
    if (rows.length === 0) { return ''; }
    const idAttr = valueId ? ` id="${valueId}"` : '';
    const clsAttr = valueClass ? ` ${valueClass}` : '';
    const body = rows.map(([k, v]) =>
        `<tr><td class="cw-k">${escapeHtml(k)}</td><td class="cw-v${clsAttr}"${idAttr}>${escapeHtml(v)}</td></tr>`).join('\n');
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
export function renderSections(event: LogEvent, description?: string): string {
    const parts: string[] = [];
    for (const section of buildEventDetailSections(event, description)) {
        parts.push(`<section class="cw-section">`);
        parts.push(`<h3>${escapeHtml(section.heading)}</h3>`);
        // The Description value gets an id so the model-derived purpose can be
        // swapped in without re-rendering (and losing the reader's scroll).
        // While the free model is answering it is styled as a placeholder.
        const isDescription = section.heading === 'Description';
        const loading = isDescription && description === DESCRIPTION_LOADING_TEXT;
        parts.push(renderRows(
            section.rows,
            isDescription ? 'cwDescriptionValue' : undefined,
            loading ? 'cw-loading' : undefined,
        ));
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
export function renderEventHtml(event: LogEvent, nonce: string, description?: string): string {
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
    // CSP: `script-src` MUST be 'unsafe-inline' — never a nonce.
    //
    // VS Code's webview host parses this markup with `DOMParser` and re-serialises
    // it through `outerHTML` before writing it into the iframe
    // (`contrib/webview/browser/pre/index.html` → `toContentHtml`). Chromium hides
    // `nonce` content-attribute values during serialization, so the script tag
    // arrives with `nonce=""`, `script-src 'nonce-…'` matches nothing, and **every
    // inline script in this page is blocked** — which silently killed the
    // Description update below *and* the Copy / Run in Terminal / Open Session
    // buttons. Same rule (and rationale) as the other panels in this extension; see
    // docs/troubleshooting/search-issue-analysis.md.
    //
    // The `nonce` attribute stays on the tags for API compatibility only — it is
    // deliberately not referenced by the policy.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
/* Placeholder shown while the free model derives the Description. */
.cw-rows .cw-loading { color: var(--cw-text-muted); font-style: italic; }
.cw-rows .cw-loading::after {
  content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: var(--cw-accent); vertical-align: middle;
  animation: cw-pulse 1s ease-in-out infinite;
}
@keyframes cw-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
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
  <main>${renderSections(event, description)}</main>
  <script nonce="${nonce}">
  ${cwInteractiveJs()}
  ${syntaxHighlighterJs()}
  (function() {
    var vscode = acquireVsCodeApi();

    // Handshake: proves this script really ran. With a nonce-based CSP it did
    // not (VS Code strips the nonce before writing the page), so the host never
    // saw this and the Description patch below never fired.
    vscode.postMessage({ command: 'ready' });

    // The host derives a model-written purpose *after* the panel opens (free
    // model, when available) and patches the Description row in place.
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (!msg || msg.command !== 'updateDescription' || typeof msg.text !== 'string') { return; }
      var target = document.getElementById('cwDescriptionValue');
      if (target) {
        target.textContent = msg.text;
        // Drop the "loading" styling once the real sentence is in place.
        target.classList.remove('cw-loading');
      }
    });

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
    /** Model-derived purpose currently shown (command events only). */
    description?: string;
    /**
     * True while the Description row shows {@link DESCRIPTION_LOADING_TEXT}
     * because the free-model answer is still outstanding. The only moment the
     * host may replace the row with the heuristic sentence.
     */
    descriptionLoading: boolean;
    /**
     * True once the page posted its `ready` handshake — i.e. its inline script
     * ran and the `message` listener that patches the Description row exists.
     * Reset on every re-render; a purpose derived before it flips is kept and
     * flushed when the handshake arrives.
     */
    scriptReady: boolean;
    disposables: vscode.Disposable[];
}

let _detail: EventDetailPanelState | undefined;

/** Lazily created so importing this module never touches a VS Code API. */
function detailLog() {
    return createLogger().withContext('EventDetail');
}

/**
 * Show a Description in the live page.
 *
 * `postMessage` resolves `false` (and the message is dropped) when the page is
 * not listening yet — every retarget reloads the document. So text that arrives
 * early stays in `state.description` and is flushed on `ready`, which also
 * makes a script-blocking CSP visible in the log instead of silent.
 *
 * `text` defaults to the model-derived purpose; the fallback path passes the
 * heuristic sentence explicitly to replace the loading placeholder.
 */
async function pushDescription(state: EventDetailPanelState, text?: string): Promise<void> {
    const description = text ?? state.description;
    if (!description || !state.scriptReady) { return; }
    const delivered = await state.panel.webview.postMessage({ command: 'updateDescription', text: description });
    if (delivered) {
        detailLog().info('description updated: %s', description);
    } else {
        detailLog().warn('model-derived description was not delivered (webview not listening)');
    }
}

/**
 * Ask the lazily loaded **free** model what the command is for and patch the
 * Description row when the answer arrives.
 *
 * Only called when a command detail panel is opened — never at activation, and
 * never for non-command rows. The row starts at {@link DESCRIPTION_LOADING_TEXT}
 * (see `initialEventDescription`); a derivation that yields `null` restores the
 * heuristic description, so the placeholder never sticks.
 */
function requestCommandPurpose(event: LogEvent, state: EventDetailPanelState): void {
    if (event.type !== 'command') { return; }
    const command = event as CommandEvent;
    if ((command.commandText ?? '').trim().length === 0) { return; }
    // Already answered (with a purpose *or* with "no model") — nothing to wait for.
    if (isCommandPurposeResolved(command)) { return; }

    void (async () => {
        const purpose = await deriveCommandPurpose(command);
        // The panel may have been retargeted/closed while the model answered.
        if (_detail !== state || state.current !== event) { return; }
        if (!purpose) {
            detailLog().info('no free model answered — restoring the heuristic description');
            if (state.descriptionLoading) {
                state.descriptionLoading = false;
                // The row is showing the placeholder; put the original sentence back.
                await pushDescription(state, describeLogEvent(event));
            }
            return;
        }
        state.descriptionLoading = false;
        state.description = purpose;
        await pushDescription(state);
    })();
}

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
    // First paint: a cached purpose, the "Loading…" placeholder while the free
    // model is answering, or nothing (→ the heuristic description).
    const initialDescription = initialEventDescription(event);
    const descriptionLoading = awaitsModelDescription(event);
    const cachedPurpose = descriptionLoading ? undefined : initialDescription;

    if (_detail) {
        _detail.current = event;
        _detail.description = cachedPurpose;
        _detail.descriptionLoading = descriptionLoading;
        // The document reloads below, so its script must report ready again.
        _detail.scriptReady = false;
        _detail.panel.title = shortEventLabel(event);
        _detail.panel.webview.html = renderEventHtml(event, generateNonce(), initialDescription);
        _detail.panel.reveal(vscode.ViewColumn.Two);
        requestCommandPurpose(event, _detail);
        return _detail.panel;
    }

    const panel = vscode.window.createWebviewPanel(
        'chatwizardLogEventDetail',
        shortEventLabel(event),
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const state: EventDetailPanelState = {
        panel,
        current: event,
        description: cachedPurpose,
        descriptionLoading,
        scriptReady: false,
        disposables: [],
    };
    _detail = state;

    panel.onDidDispose(() => {
        if (_detail === state) { _detail = undefined; }
        for (const d of state.disposables) { d.dispose(); }
    });

    // Handlers read `state.current` — the panel outlives any single event.
    // Registered *before* `webview.html` so the page's early `ready` handshake
    // can never be missed.
    const msgListener = panel.webview.onDidReceiveMessage((message: { command?: string }) => {
        const current = state.current;
        if (message.command === 'ready') {
            // The page's inline script ran — the Description row can take the
            // model-derived purpose now (flushes one that arrived first).
            state.scriptReady = true;
            detailLog().info('detail webview script is live');
            void pushDescription(state);
        } else if (message.command === 'copy') {
            void vscode.env.clipboard.writeText(eventDetailText(current, state.description));
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

    panel.webview.html = renderEventHtml(event, generateNonce(), initialDescription);

    // Lazy free-model pass, only now that the panel is actually open.
    requestCommandPurpose(event, state);

    return panel;
}

/** Close the shared detail panel (used by tests and panel re-use checks). */
export function closeEventWebview(): void {
    _detail?.panel.dispose();
    _detail = undefined;
}
