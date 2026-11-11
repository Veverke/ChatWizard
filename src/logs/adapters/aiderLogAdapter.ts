/**
 * src/logs/adapters/aiderLogAdapter.ts
 *
 * Phase 3 — Aider log adapter.
 *
 * Aider persists every chat as a Markdown transcript at
 * `<repo>/.aider.chat.history.md` (`~/.aider.chat.history.md` for the global
 * session). It is the only on-disk record of what the agent *did*, and unlike
 * the other tools it is prose, not structured JSON:
 *
 *   - `# aider chat started at 2024-11-15 09:23:45`  → session header/time
 *   - `#### <text>`                                  → user message
 *   - `> !npm test`                                  → shell passthrough the user
 *                                                      asked Aider to run
 *   - `> /run npm test` / `/test` / `/lint` / `/exec` / `/cmd` / `/shell`
 *                                                    → Aider commands that run
 *                                                      a shell command
 *   - `Applied edit to src/utils.ts`                 → a file Aider rewrote
 *   - ````` ```diff … ``` `````                       → unified diff Aider printed
 *                                                      (`/diff`, review prompts)
 *
 * Everything else (`> /add`, `> /model`, LLM prose) is not an agent *action*
 * and is skipped. Aider never records exit codes or captured stdout for the
 * commands it runs, and its edit events carry no patch text unless the
 * transcript itself contains a diff block — so Aider contributes commands,
 * file operations and (when present) diffs, but no exit badges.
 *
 * The pure helpers below work on the transcript text, so they are unit-tested
 * without touching the file system; `parseAiderLogEvents` is the file wrapper.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { countPatchLines } from './copilotLogAdapter';
import { CommandEvent, DiffEvent, FileOperationEvent, LogEvent } from '../types';

// ---------------------------------------------------------------------------
// Security / sanity limits (mirror the Cline and Copilot adapters)
// ---------------------------------------------------------------------------

/** Maximum file size (bytes) of the history file before it is skipped. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Maximum number of transcript lines replayed before bailing out. */
const MAX_LINES = 200_000;
/** Cap on the raw snippet stored on an event (`raw` column is for debugging). */
const MAX_RAW_CHARS = 2_000;
/** Cap on the stdout summary attached to a command. */
const MAX_OUTPUT_CHARS = 4_000;
/** Commands longer than this are skipped (a multi-page script is not a "command"). */
const MAX_COMMAND_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Transcript markers
// ---------------------------------------------------------------------------

/** `# aider chat started at 2024-11-15 09:23:45` */
const RE_SESSION_START = /^#\s+aider chat started at\s+(.+?)\s*$/i;
/** `#### user text` */
const USER_PREFIX = '#### ';
/** `> …` — an Aider interactive command (or shell passthrough with `!`). */
const CMD_PREFIX = '> ';
/** `Applied edit to <path>` */
const RE_APPLIED_EDIT = /^Applied edit to\s+(.+?)\s*$/i;
/** Opening fence of a diff block. */
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)\s*$/;

/** Aider slash commands whose argument is a shell command that Aider runs. */
const SHELL_SLASH_COMMANDS = new Set(['run', 'test', 'lint', 'exec', 'cmd', 'shell']);

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

export interface AiderLogAdapterContext {
    /** ChatWizard session id (sha1 of the history path, as the session parser uses). */
    sessionId: string;
    /** Repo root the history file lives in, when known. */
    workspacePath?: string;
    /** Absolute path of the `.aider.chat.history.md` file. */
    sourcePath: string;
    /** Used for events when the transcript has no `# aider chat started at` header. */
    fallbackTimestamp?: string;
}

export interface AiderLogAdapterResult {
    /** Normalized events extracted from the transcript. */
    events: LogEvent[];
    /** Non-fatal issues encountered while parsing. */
    errors: string[];
}

/** A single parsed Aider transcript decision point — useful for tests. */
export interface AiderCommandLine {
    /** The shell command Aider ran (or the `/test` placeholder when it runs the configured one). */
    commandText: string;
    /** `'shell'` for `!cmd` passthroughs, `'aider'` for slash commands. */
    shell: 'shell' | 'aider';
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Classify a `> …` line: does it ask Aider to run something?
 *
 * Returns `undefined` for non-command lines and for Aider meta commands
 * (`/add`, `/model`, `/diff`, …) that do not execute anything.
 */
export function parseAiderCommandLine(line: string): AiderCommandLine | undefined {
    if (!line.startsWith(CMD_PREFIX)) { return undefined; }
    const body = line.slice(CMD_PREFIX.length).trim();
    if (body.length === 0) { return undefined; }

    // `> !cmd` — the user asked Aider to run a shell command verbatim.
    if (body.startsWith('!')) {
        const command = body.slice(1).trim();
        return command.length > 0 && command.length <= MAX_COMMAND_CHARS
            ? { commandText: command, shell: 'shell' }
            : undefined;
    }

    const match = /^\/([A-Za-z_-]+)(?:\s+([\s\S]*))?$/.exec(body);
    if (!match) { return undefined; }
    const name = match[1].toLowerCase();
    if (!SHELL_SLASH_COMMANDS.has(name)) { return undefined; }

    const args = (match[2] ?? '').trim();
    if (args.length === 0) {
        // `/test` and `/lint` without arguments run Aider's configured command.
        return name === 'test' || name === 'lint'
            ? { commandText: `/${name}`, shell: 'aider' }
            : undefined;
    }
    if (args.length > MAX_COMMAND_CHARS) { return undefined; }
    return { commandText: args, shell: 'aider' };
}

/** Repo-relative/absolute path from an `Applied edit to …` line. */
export function parseAiderAppliedEdit(line: string): string | undefined {
    const match = RE_APPLIED_EDIT.exec(line);
    if (!match) { return undefined; }
    const filePath = match[1].trim().replace(/^[`'"]|[`'"]$/g, '');
    return filePath.length > 0 ? filePath : undefined;
}

/**
 * File path a unified diff block applies to — the `+++ b/<path>` (or
 * `--- a/<path>`) header, with git's `a/`/`b/` prefix and timestamp stripped.
 * Returns `undefined` when the block has no recognisable header.
 */
export function diffBlockFilePath(diffText: string): string | undefined {
    for (const rawLine of diffText.split('\n')) {
        const line = rawLine.trimEnd();
        for (const prefix of ['+++ ', '--- ']) {
            if (!line.startsWith(prefix)) { continue; }
            let value = line.slice(prefix.length);
            const tab = value.indexOf('\t');
            if (tab >= 0) { value = value.slice(0, tab); }
            const match = /^[ab]\/(.+)$/.exec(value.trim());
            const filePath = (match ? match[1] : value.trim()).trim();
            if (filePath.length > 0 && filePath !== '/dev/null') { return filePath; }
        }
    }
    return undefined;
}

/**
 * ISO timestamp from the `# aider chat started at …` header.
 * Aider writes local time without a zone (`2024-11-15 09:23:45`), which is
 * interpreted as local time here.
 */
export function aiderStartTimestamp(headerValue: string): string | undefined {
    const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(headerValue);
    if (!match) { return undefined; }
    const [, y, mo, d, h, mi, s] = match;
    const date = new Date(
        Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)
    );
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Collect the transcript lines that follow a command as its captured output.
 * Aider writes the command's output directly under the `> …` line, terminated
 * by a blank line or the next transcript marker.
 */
function collectCommandOutput(lines: string[], start: number): { output?: string; next: number } {
    const collected: string[] = [];
    let total = 0;
    let i = start;
    for (; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.length === 0) { break; }
        if (line.startsWith(CMD_PREFIX) || line.startsWith(USER_PREFIX)) { break; }
        if (FENCE_OPEN_RE.test(trimmed) || RE_SESSION_START.test(trimmed)) { break; }
        if (total + line.length > MAX_OUTPUT_CHARS) {
            collected.push('…');
            break;
        }
        collected.push(line);
        total += line.length + 1;
    }
    const output = collected.length > 0 ? collected.join('\n').slice(0, MAX_OUTPUT_CHARS) : undefined;
    return { output, next: i };
}

// ---------------------------------------------------------------------------
// Transcript parser (pure)
// ---------------------------------------------------------------------------

/**
 * Replay an Aider transcript and normalize its agent-execution trail into
 * `LogEvent`s. Pure: no file system access, so it is unit-tested directly.
 */
export function parseAiderLogHistoryText(
    rawText: string,
    ctx: AiderLogAdapterContext
): AiderLogAdapterResult {
    const events: LogEvent[] = [];
    const errors: string[] = [];
    const lines = (rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    if (lines.length > MAX_LINES) {
        errors.push(`Transcript truncated to ${MAX_LINES} of ${lines.length} lines`);
        lines.length = MAX_LINES;
    }

    const base = {
        tool: 'aider' as const,
        sessionId: ctx.sessionId,
        workspaceId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        sourcePath: ctx.sourcePath,
    };

    // Every event shares the transcript's start time — Aider timestamps nothing else.
    let sessionTimestamp: string | undefined;
    for (const line of lines) {
        const match = RE_SESSION_START.exec(line.trim());
        if (match) {
            sessionTimestamp = aiderStartTimestamp(match[1]);
            break;
        }
    }
    const timestamp = sessionTimestamp ?? ctx.fallbackTimestamp ?? new Date(0).toISOString();

    let lastEditedPath: string | undefined;
    let commandSeq = 0;
    let editSeq = 0;
    let diffSeq = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (RE_SESSION_START.test(trimmed)) { continue; }

        // ── Fenced block ────────────────────────────────────────────────────
        const fence = FENCE_OPEN_RE.exec(trimmed);
        if (fence) {
            const language = fence[1].toLowerCase();
            const openedAt = i;
            const body: string[] = [];
            let closed = false;
            for (i = i + 1; i < lines.length; i++) {
                if (/^```\s*$/.test(lines[i].trim())) { closed = true; break; }
                body.push(lines[i]);
            }
            if (!closed) { errors.push(`Unterminated code fence at line ${openedAt + 1}`); }
            if (language === 'diff' || language === 'patch') {
                const diffText = body.join('\n').trimEnd();
                const filePath = diffBlockFilePath(diffText) ?? lastEditedPath;
                if (diffText.length > 0 && filePath) {
                    const stats = countPatchLines(diffText);
                    events.push({
                        ...base,
                        id: `${ctx.sessionId}:l${openedAt}:diff${diffSeq++}`,
                        type: 'diff',
                        timestamp,
                        filePath,
                        diffText,
                        addedLines: stats.added,
                        removedLines: stats.removed,
                        raw: `diff block in the aider transcript`.slice(0, MAX_RAW_CHARS),
                    } satisfies DiffEvent);
                }
            }
            continue;
        }

        // ── `Applied edit to <path>` ────────────────────────────────────────
        const appliedEdit = parseAiderAppliedEdit(trimmed);
        if (appliedEdit) {
            lastEditedPath = appliedEdit;
            events.push({
                ...base,
                id: `${ctx.sessionId}:l${i}:file${editSeq++}`,
                type: 'fileOperation',
                timestamp,
                operationType: 'patch',
                filePath: appliedEdit,
                detail: 'Applied edit (aider)',
                raw: line.trim().slice(0, MAX_RAW_CHARS),
            } satisfies FileOperationEvent);
            continue;
        }

        // ── `> !cmd` / `> /run …` ───────────────────────────────────────────
        const command = parseAiderCommandLine(line);
        if (command) {
            const { output, next } = collectCommandOutput(lines, i + 1);
            events.push({
                ...base,
                id: `${ctx.sessionId}:l${i}:cmd${commandSeq++}`,
                type: 'command',
                timestamp,
                commandText: command.commandText,
                cwd: ctx.workspacePath,
                shell: command.shell,
                stdoutSummary: output,
                raw: line.trim().slice(0, MAX_RAW_CHARS),
            } satisfies CommandEvent);
            i = next > i ? next - 1 : i;
        }
    }

    return { events, errors };
}

// ---------------------------------------------------------------------------
// Entry point (file wrapper)
// ---------------------------------------------------------------------------

/**
 * Parse a `.aider.chat.history.md` file into normalized `LogEvent`s.
 *
 * @param historyFile   Absolute path to the history file.
 * @param workspacePath Repo root the file belongs to, when known.
 * @param sessionId     ChatWizard session id; defaults to sha1(historyFile),
 *                      which is exactly what `src/parsers/aider.ts` uses, so
 *                      events line up with the chat session they came from.
 */
export function parseAiderLogEvents(
    historyFile: string,
    workspacePath?: string,
    sessionId?: string
): AiderLogAdapterResult {
    const events: LogEvent[] = [];
    const errors: string[] = [];

    let fallbackTimestamp: string | undefined;
    let raw: string;
    try {
        const stat = fs.statSync(historyFile);
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`History file exceeds ${MAX_FILE_BYTES} bytes — skipped`);
            return { events, errors };
        }
        fallbackTimestamp = stat.mtime.toISOString();
        raw = fs.readFileSync(historyFile, 'utf8');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Cannot read aider history ${historyFile}: ${message}`);
        return { events, errors };
    }

    return parseAiderLogHistoryText(raw, {
        sessionId: sessionId ?? crypto.createHash('sha1').update(historyFile).digest('hex'),
        workspacePath,
        sourcePath: historyFile,
        fallbackTimestamp,
    });
}



