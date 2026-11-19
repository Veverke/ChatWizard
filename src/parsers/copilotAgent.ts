/**
 * src/parsers/copilotAgent.ts
 *
 * GitHub Copilot "agent host" sessions (VS Code 1.146+ / Copilot Chat 1.0+).
 *
 * Newer VS Code moved Copilot chat history out of
 * `workspaceStorage/<hash>/chatSessions/*.jsonl` into the Copilot home:
 *
 *   <COPILOT_HOME || ~/.copilot>/session-state/<sessionId>/
 *     workspace.yaml    ← title (`name`), cwd, git branch, created/updated
 *     events.jsonl      ← the transcript (one JSON event per line)
 *
 * `events.jsonl` event kinds this parser renders:
 *   - `session.start`     → model (`data.selectedModel`) + cwd/git context
 *   - `user.message`      → user turn (`data.content`)
 *   - `assistant.message` → assistant turn (`data.content`; tool-only turns are
 *                           skipped, matching the other parsers)
 *
 * Tool executions (`tool.execution_start` / `tool.execution_complete`) are
 * agent-execution data, not chat turns, so they are not rendered here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodeBlock, Message, ParseResult, Session } from '../types/index';
import { extractCodeBlocks } from './copilot';

/** Maximum transcript size (bytes) read in one go. */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Maximum number of events replayed from one transcript. */
const MAX_EVENTS = 50_000;

/** Maximum characters kept in a title derived from the first user turn. */
const MAX_TITLE_CHARS = 120;

/**
 * Workspace id for agent-host sessions.
 *
 * Copilot chats in `~/.copilot/session-state` are global (not tied to a VS Code
 * workspace hash), so they get a stable synthetic id. `CacheManager.loadAll`
 * treats it as a global workspace id, and the workspace-path scope filter does
 * not narrow it (each session carries its own `cwd`).
 */
export const COPILOT_AGENT_WORKSPACE_ID = 'copilot-agent';

/** Shape of one `events.jsonl` line (only the fields we read). */
export interface CopilotAgentEvent {
    type?: string;
    data?: Record<string, unknown>;
    id?: string;
    timestamp?: string;
    parentId?: string | null;
}

/** Parsed YAML block-scalar header (`|`, `|-`, `|+`, `>`, `>-`, `>+`, optional indent indicator). */
interface BlockScalarHeader {
    /** `>` (folded) instead of `|` (literal). */
    folded: boolean;
    /** `-` strips trailing newlines, `+` keeps them, `''` clips to one. */
    chomp: '' | '-' | '+';
    /** Explicit indentation indicator (`|2`), 0 when absent. */
    indentIndicator: number;
}

/**
 * Recognizes a block-scalar header, e.g. `|-` in `name: |-`.
 * Returns `null` for ordinary scalars.
 */
function parseBlockScalarHeader(value: string): BlockScalarHeader | null {
    if (value.length === 0 || (value[0] !== '|' && value[0] !== '>')) { return null; }
    if (value.length > 3) { return null; }

    let chomp: '' | '-' | '+' = '';
    let indentIndicator = 0;
    for (const ch of value.slice(1)) {
        if (ch === '-' || ch === '+') {
            if (chomp !== '') { return null; }
            chomp = ch;
        } else if (ch >= '1' && ch <= '9') {
            if (indentIndicator !== 0) { return null; }
            indentIndicator = Number(ch);
        } else {
            return null;
        }
    }
    return { folded: value[0] === '>', chomp, indentIndicator };
}

/** Number of leading whitespace characters (YAML indentation). */
function indentationOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** Folds the lines of a `>`-style block scalar (single breaks → spaces, blank lines → newlines). */
function foldBlockLines(lines: string[]): string {
    let folded = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0) {
            folded = line;
        } else if (line === '' || lines[i - 1] === '') {
            folded += `\n${line}`;
        } else {
            folded += ` ${line}`;
        }
    }
    return folded;
}

/**
 * Reads the indented body of a block scalar starting after its header line.
 *
 * @returns the scalar text (chomped per the header) and the index of the first
 *          line that is no longer part of the scalar.
 */
function readBlockScalar(
    lines: string[],
    startIndex: number,
    header: BlockScalarHeader
): { text: string; nextIndex: number } {
    let blockIndent = header.indentIndicator;
    if (blockIndent === 0) {
        // Derive the indentation from the first non-empty line. A sibling key at
        // column 0 means the block is empty (e.g. `name: |-` followed by `cwd:`).
        let probe = startIndex;
        while (probe < lines.length && lines[probe].trim().length === 0) { probe++; }
        const detected = probe < lines.length ? indentationOf(lines[probe]) : 0;
        if (detected === 0) {
            return { text: '', nextIndex: startIndex };
        }
        blockIndent = detected;
    }

    const body: string[] = [];
    let index = startIndex;
    for (; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim().length === 0) {
            body.push('');
            continue;
        }
        if (indentationOf(line) < blockIndent) { break; }
        body.push(line.slice(blockIndent));
    }

    // Trailing blank lines are chomping markers, not content.
    while (body.length > 0 && body[body.length - 1].trim() === '') { body.pop(); }

    let text = header.folded ? foldBlockLines(body) : body.join('\n');
    if (text.length > 0 && header.chomp !== '-') {
        text += '\n'; // clip (`''`) / keep (`+`) — one trailing break is enough here
    }
    return { text, nextIndex: index };
}

/** Expands the escape sequences YAML allows inside a double-quoted scalar. */
function unescapeDoubleQuoted(value: string): string {
    return value.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (match, esc: string) => {
        switch (esc[0]) {
            case '0': return '\0';
            case 'a': return '\x07';
            case 'b': return '\b';
            case 't': return '\t';
            case 'n': return '\n';
            case 'v': return '\v';
            case 'f': return '\f';
            case 'r': return '\r';
            case 'e': return '\x1b';
            case ' ': return ' ';
            case '"': return '"';
            case '/': return '/';
            case '\\': return '\\';
            case 'N': return '\u0085';
            case '_': return '\u00a0';
            case 'L': return '\u2028';
            case 'P': return '\u2029';
            case 'x':
            case 'u':
            case 'U': {
                const codePoint = parseInt(esc.slice(1), 16);
                return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
                    ? String.fromCodePoint(codePoint)
                    : match;
            }
            default: return match;
        }
    });
}

/** Removes the quoting of a single-line YAML scalar and unescapes it. */
function unquoteYamlScalar(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return unescapeDoubleQuoted(value.slice(1, -1));
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}

/**
 * Parse the small YAML dialect Copilot writes to `workspace.yaml`
 * (flat `key: value` pairs, optional single/double quotes, `|`/`>` block
 * scalars).
 *
 * Block scalars matter for the title: Copilot writes `name: |-` followed by an
 * indented multi-line prompt for auto-titled chats (child chats inherited from
 * a parent session, for example), and newer builds instead use a double-quoted
 * scalar with `\r\n` escapes. Both must resolve to the chat's title rather than
 * to the literal `|-` marker or to the raw escape text.
 *
 * Deliberately not a general YAML parser: the file only ever holds scalars,
 * and pulling in a YAML dependency for this would be overkill.
 */
export function parseCopilotAgentWorkspaceYaml(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) { continue; }
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
        if (!match) { continue; }

        const key = match[1];
        const inline = match[2].trim();
        const header = parseBlockScalarHeader(inline);
        if (header) {
            const { text, nextIndex } = readBlockScalar(lines, i + 1, header);
            result[key] = text;
            i = nextIndex - 1;
            continue;
        }
        result[key] = unquoteYamlScalar(inline);
    }
    return result;
}

/** Strip the `<current_datetime>…</current_datetime>` wrapper Copilot prepends. */
export function stripCopilotAgentPreamble(text: string): string {
    return text.replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '').trim();
}

/** First non-empty line of a text, capped at MAX_TITLE_CHARS. */
function firstLine(text: string): string {
    const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
    return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line;
}

/**
 * Normalizes a `content` value: Copilot writes a plain string today, but a
 * future/other producer may send the multimodal `[{type:'text', text}]` array
 * shape (as Cline 4.x does) — accept both.
 */
function contentToText(value: unknown): string {
    if (typeof value === 'string') { return value; }
    if (!Array.isArray(value)) { return ''; }
    return value
        .filter((part): part is { type?: string; text?: string } => !!part && typeof part === 'object')
        .filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text as string)
        .join('');
}

/**
 * Reads a Copilot agent-host session directory and returns a `ParseResult`.
 *
 * @param sessionDir  Absolute path of `…/session-state/<sessionId>`.
 * @param workspaceId Optional workspace id (defaults to the session's cwd).
 */
export function parseCopilotAgentSession(sessionDir: string, workspaceId?: string): ParseResult {
    const errors: string[] = [];
    const sessionId = path.basename(sessionDir);
    const eventsFile = path.join(sessionDir, 'events.jsonl');
    const workspaceFile = path.join(sessionDir, 'workspace.yaml');

    // ── workspace.yaml (optional) ────────────────────────────────────────────
    let meta: Record<string, string> = {};
    try {
        meta = parseCopilotAgentWorkspaceYaml(fs.readFileSync(workspaceFile, 'utf8'));
    } catch {
        // Optional — a session started seconds ago may not have it yet.
    }

    const emptySession = (): Session => ({
        id: sessionId,
        title: 'Untitled Session',
        source: 'copilot',
        workspaceId: workspaceId ?? COPILOT_AGENT_WORKSPACE_ID,
        workspacePath: meta['cwd'] || meta['git_root'] || undefined,
        messages: [],
        filePath: eventsFile,
        createdAt: meta['created_at'] ?? new Date(0).toISOString(),
        updatedAt: meta['updated_at'] ?? new Date(0).toISOString(),
    });

    // ── events.jsonl (required) ──────────────────────────────────────────────
    let raw: string;
    let fileSizeBytes: number | undefined;
    try {
        const stat = fs.statSync(eventsFile);
        fileSizeBytes = stat.size;
        if (stat.size > MAX_FILE_BYTES) {
            errors.push(`events.jsonl exceeds 50 MB size limit (${stat.size} bytes) — skipped`);
            return { session: emptySession(), errors };
        }
        raw = fs.readFileSync(eventsFile, 'utf8');
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to read events.jsonl: ${msg}`);
        return { session: emptySession(), errors };
    }

    const messages: Message[] = [];
    let model: string | undefined;
    let cwd: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length && i < MAX_EVENTS; i++) {
        const line = lines[i].trim();
        if (line.length === 0) { continue; }

        let event: CopilotAgentEvent;
        try {
            event = JSON.parse(line) as CopilotAgentEvent;
        } catch {
            errors.push(`Line ${i + 1}: invalid JSON`);
            continue;
        }
        if (!event || typeof event !== 'object') { continue; }

        if (typeof event.timestamp === 'string' && event.timestamp.length > 0) {
            if (!firstTs) { firstTs = event.timestamp; }
            lastTs = event.timestamp;
        }

        const data = event.data ?? {};
        switch (event.type) {
            case 'session.start': {
                if (typeof data['selectedModel'] === 'string' && !model) {
                    model = data['selectedModel'];
                }
                const context = data['context'];
                if (context && typeof context === 'object') {
                    const ctx = context as Record<string, unknown>;
                    if (typeof ctx['cwd'] === 'string' && !cwd) { cwd = ctx['cwd']; }
                }
                break;
            }
            case 'user.message': {
                const content = stripCopilotAgentPreamble(contentToText(data['content']));
                if (!content) { break; }
                const messageIndex = messages.length;
                messages.push({
                    id: `${sessionId}-${messageIndex}`,
                    role: 'user',
                    content,
                    codeBlocks: [] as CodeBlock[],
                    timestamp: event.timestamp,
                });
                break;
            }
            case 'assistant.message': {
                const content = contentToText(data['content']).trim();
                // Tool-only turns carry no text — skip them (same as Copilot/Claude).
                if (!content) { break; }
                const messageIndex = messages.length;
                messages.push({
                    id: `${sessionId}-${messageIndex}`,
                    role: 'assistant',
                    content,
                    codeBlocks: extractCodeBlocks(content, sessionId, messageIndex),
                    timestamp: event.timestamp,
                });
                break;
            }
            default:
                break;
        }
    }

    if (lines.length > MAX_EVENTS) {
        errors.push(`events.jsonl has more than ${MAX_EVENTS} events — truncated`);
    }

    const workspacePath = meta['cwd'] || meta['git_root'] || cwd;
    const firstUser = messages.find(m => m.role === 'user')?.content ?? '';
    // `name` may be a whole multi-line prompt (block scalar / escaped \r\n);
    // the chat's title is its first line. Never surface the raw `|-` marker.
    const title = firstLine(meta['name'] ?? '') || firstLine(firstUser) || 'Untitled Session';

    let createdAt = meta['created_at'] || firstTs;
    let updatedAt = meta['updated_at'] || lastTs;
    if (!createdAt || !updatedAt) {
        try {
            const mtime = fs.statSync(eventsFile).mtime.toISOString();
            if (!createdAt) { createdAt = mtime; }
            if (!updatedAt) { updatedAt = mtime; }
        } catch {
            // ignore — epoch fallback below
        }
    }

    return {
        session: {
            id: sessionId,
            title,
            source: 'copilot',
            workspaceId: workspaceId ?? COPILOT_AGENT_WORKSPACE_ID,
            workspacePath,
            model,
            messages,
            filePath: eventsFile,
            fileSizeBytes,
            createdAt: createdAt ?? new Date(0).toISOString(),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
        },
        errors,
    };
}
