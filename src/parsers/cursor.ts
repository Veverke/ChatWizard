// src/parsers/cursor.ts

import * as path from 'path';
import { Session, Message, CodeBlock, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

/** Maximum number of ComposerEntry records processed per database. */
const MAX_COMPOSERS = 5_000;

/** Maximum characters to keep in a title derived from the first user message. */
const MAX_TITLE_CHARS = 120;

// ─── Raw JSON shapes (Cursor composer.composerData) ──────────────────────────

interface ComposerEntry {
    composerId?: string;
    name?: string;
    createdAt?: number;       // unix ms
    updatedAt?: number;       // unix ms
    /** Cursor 0.43+ often uses lastUpdatedAt on composer heads */
    lastUpdatedAt?: number;   // unix ms
    type?: number | string;   // 1 = chat, 2 = agent; newer builds may use "head"
    conversation?: ConversationItem[];
    messages?: ConversationItem[];
    model?: string;
}

interface ConversationItem {
    type?: number;            // 1 = user, 2 = assistant
    role?: string;
    isUser?: boolean;
    text?: string;
    richText?: string;
    content?: string;
    message?: string;
    markdown?: string;
    parts?: Array<{ text?: string; content?: string }>;
    unixMs?: number;
    timestamp?: number;
    createdAt?: number;
}

function extractItemRole(item: ConversationItem): 'user' | 'assistant' | null {
    if (item.type === 1) { return 'user'; }
    if (item.type === 2) { return 'assistant'; }
    if (item.isUser === true) { return 'user'; }
    if (item.isUser === false) { return 'assistant'; }
    if (typeof item.role === 'string') {
        const r = item.role.toLowerCase();
        if (r === 'user') { return 'user'; }
        if (r === 'assistant' || r === 'model' || r === 'ai') { return 'assistant'; }
    }
    return null;
}

function extractItemText(item: ConversationItem): string {
    if (typeof item.text === 'string' && item.text.trim()) { return item.text; }
    if (typeof item.richText === 'string' && item.richText.trim()) { return item.richText; }
    if (typeof item.content === 'string' && item.content.trim()) { return item.content; }
    if (typeof item.message === 'string' && item.message.trim()) { return item.message; }
    if (typeof item.markdown === 'string' && item.markdown.trim()) { return item.markdown; }
    if (Array.isArray(item.parts)) {
        const fromParts = item.parts
            .map(p => (typeof p.text === 'string' && p.text) ? p.text : (typeof p.content === 'string' ? p.content : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (fromParts) { return fromParts; }
    }
    return '';
}

const AISERVICE_SOURCE_NOTE =
    'This session was rebuilt from Cursor\'s aiService.prompts data. Cursor does not store full assistant ' +
    'replies in workspace state.vscdb for this build — only your prompts are available here. This is not a parse failure.';

/** Try to read a composer/chat id Cursor may attach to each prompt entry. */
function extractPromptComposerId(p: unknown): string | undefined {
    if (!p || typeof p !== 'object') { return undefined; }
    const o = p as Record<string, unknown>;
    const keys = ['composerId', 'composerID', 'composerSessionId', 'sessionId', 'chatId', 'composer_id'] as const;
    for (const k of keys) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) { return v.trim(); }
    }
    return undefined;
}

function extractPromptText(p: unknown): string {
    if (!p || typeof p !== 'object') { return ''; }
    const o = p as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text.trim()) { return o.text.trim(); }
    if (typeof o.prompt === 'string' && o.prompt.trim()) { return o.prompt.trim(); }
    if (typeof o.content === 'string' && o.content.trim()) { return o.content.trim(); }
    return '';
}

function composerTimeEnd(c: ComposerEntry): number {
    const lu = c.lastUpdatedAt ?? c.updatedAt ?? 0;
    const cr = c.createdAt ?? 0;
    return (lu > 0 ? lu : cr) || cr;
}

/**
 * When composer rows have no `conversation` but `aiService.prompts` holds user turns,
 * split prompts into one session per composer (matching Cursor tab titles) when possible.
 */
function buildAiServiceFallbackSessions(
    vscdbPath: string,
    workspaceId: string,
    workspacePath: string | undefined,
    composers: ComposerEntry[],
    promptsJson: string,
    generationsJson: string | null
): ParseResult[] | null {
    let prompts: unknown;
    try {
        prompts = JSON.parse(promptsJson);
    } catch {
        return null;
    }
    if (!Array.isArray(prompts) || prompts.length === 0) { return null; }

    let genTimestamps: Array<number | undefined> = [];
    if (generationsJson) {
        try {
            const gens = JSON.parse(generationsJson) as unknown;
            if (Array.isArray(gens)) {
                genTimestamps = gens.map(g =>
                    (typeof g === 'object' && g !== null && 'unixMs' in g &&
                        typeof (g as { unixMs?: unknown }).unixMs === 'number' &&
                        (g as { unixMs: number }).unixMs > 0)
                        ? (g as { unixMs: number }).unixMs
                        : undefined
                );
            }
        } catch {
            // ignore
        }
    }

    type IndexedPrompt = { index: number; text: string; unixMs?: number; composerId?: string };
    const flat: IndexedPrompt[] = [];
    for (let i = 0; i < prompts.length; i++) {
        const text = extractPromptText(prompts[i]);
        if (!text) { continue; }
        const unixMs = genTimestamps[i];
        const cid = extractPromptComposerId(prompts[i]);
        flat.push({
            index: i,
            text,
            unixMs: unixMs !== undefined ? unixMs : undefined,
            composerId: cid,
        });
    }
    if (flat.length === 0) { return null; }

    const withIds = composers.filter(c => typeof c.composerId === 'string' && c.composerId.trim());

    const buildMergedOrSingleComposerSession = (composer?: ComposerEntry): ParseResult => {
        const sid = (composer?.composerId && composer.composerId.trim())
            ? composer.composerId.trim()
            : `${workspaceId}-cursor-aiservice`;
        const messages: Message[] = [];
        for (let j = 0; j < flat.length; j++) {
            const fp = flat[j];
            const messageIndex = messages.length;
            messages.push({
                id: `${sid}-${messageIndex}`,
                role: 'user',
                content: fp.text,
                codeBlocks: extractCursorCodeBlocks(fp.text, sid, messageIndex),
                timestamp: fp.unixMs !== undefined ? new Date(fp.unixMs).toISOString() : undefined,
            });
        }
        const firstLine = messages[0].content.split('\n')[0] || messages[0].content;
        let title: string;
        if (composer && typeof composer.name === 'string' && composer.name.trim()) {
            title = composer.name.trim();
        } else {
            title = firstLine.length > MAX_TITLE_CHARS
                ? firstLine.slice(0, MAX_TITLE_CHARS) + '…'
                : firstLine;
        }
        const createdAt = (composer && typeof composer.createdAt === 'number' && composer.createdAt > 0)
            ? new Date(composer.createdAt).toISOString()
            : (messages.find(m => m.timestamp)?.timestamp ?? new Date().toISOString());
        const updatedAt = [...messages].reverse().find(m => m.timestamp)?.timestamp ?? createdAt;
        return {
            session: {
                id: sid,
                title,
                source: 'cursor',
                workspaceId,
                workspacePath,
                model: composer?.model,
                messages,
                filePath: vscdbPath,
                createdAt,
                updatedAt,
                sourceNotes: [AISERVICE_SOURCE_NOTE],
            },
            errors: [],
        };
    };

    if (withIds.length <= 1) {
        return [buildMergedOrSingleComposerSession(withIds[0])];
    }

    const byComposer = new Map<string, IndexedPrompt[]>();
    for (const c of withIds) {
        byComposer.set(c.composerId!, []);
    }
    const unassigned: IndexedPrompt[] = [];

    for (const fp of flat) {
        if (fp.composerId && byComposer.has(fp.composerId)) {
            byComposer.get(fp.composerId)!.push(fp);
        } else {
            unassigned.push(fp);
        }
    }

    /** Assign prompts whose entries lack composerId using per-composer time windows. */
    if (unassigned.length > 0) {
        const sorted = [...withIds].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for (const fp of unassigned) {
            const ts = fp.unixMs;
            if (ts === undefined) { continue; }
            let best: ComposerEntry | undefined;
            for (const c of sorted) {
                const start = c.createdAt ?? 0;
                const end = composerTimeEnd(c);
                if (end >= start && ts >= start && ts <= end) {
                    best = c;
                    break;
                }
            }
            if (!best) {
                let bestDist = Infinity;
                for (const c of sorted) {
                    const start = c.createdAt ?? 0;
                    const end = composerTimeEnd(c);
                    const mid = start && end ? (start + end) / 2 : start || end || ts;
                    const dist = Math.abs(ts - mid);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = c;
                    }
                }
            }
            if (best?.composerId) {
                byComposer.get(best.composerId)!.push(fp);
            }
        }
    }

    /** Prompts not yet assigned to any composer bucket. */
    const claimed = new Set<string>();
    for (const [, arr] of byComposer) {
        for (const p of arr) { claimed.add(`${p.index}`); }
    }
    const stillFloating: IndexedPrompt[] = [];
    for (const fp of flat) {
        if (!claimed.has(`${fp.index}`)) { stillFloating.push(fp); }
    }

    if (stillFloating.length > 0) {
        const sortedC = [...withIds].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for (const fp of stillFloating) {
            const firstLine = fp.text.split('\n')[0]?.trim() ?? fp.text;
            let matched: ComposerEntry | undefined;
            for (const c of sortedC) {
                const name = typeof c.name === 'string' ? c.name.trim() : '';
                if (!name) { continue; }
                if (firstLine === name || firstLine.toLowerCase().startsWith(name.toLowerCase())) {
                    matched = c;
                    break;
                }
            }
            if (matched?.composerId) {
                byComposer.get(matched.composerId)!.push(fp);
            }
        }
    }

    const claimed2 = new Set<string>();
    for (const [, arr] of byComposer) {
        for (const p of arr) { claimed2.add(`${p.index}`); }
    }
    const still2: IndexedPrompt[] = [];
    for (const fp of flat) {
        if (!claimed2.has(`${fp.index}`)) { still2.push(fp); }
    }

    /** Last resort: split remaining prompts evenly across composers in creation order. */
    if (still2.length > 0) {
        const sortedC = [...withIds].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        const k = sortedC.length;
        const n = still2.length;
        const base = Math.floor(n / k);
        const rem = n % k;
        let offset = 0;
        for (let i = 0; i < k; i++) {
            const len = base + (i < rem ? 1 : 0);
            const slice = still2.slice(offset, offset + len);
            offset += len;
            const cid = sortedC[i].composerId!;
            byComposer.get(cid)!.push(...slice);
        }
    }

    const results: ParseResult[] = [];
    const ordered = [...withIds].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const c of ordered) {
        const cid = c.composerId!;
        const items = (byComposer.get(cid) ?? []).slice().sort((a, b) => a.index - b.index);
        if (items.length === 0) { continue; }

        const messages: Message[] = [];
        for (let j = 0; j < items.length; j++) {
            const fp = items[j];
            const messageIndex = messages.length;
            messages.push({
                id: `${cid}-${messageIndex}`,
                role: 'user',
                content: fp.text,
                codeBlocks: extractCursorCodeBlocks(fp.text, cid, messageIndex),
                timestamp: fp.unixMs !== undefined ? new Date(fp.unixMs).toISOString() : undefined,
            });
        }

        let title: string;
        if (typeof c.name === 'string' && c.name.trim()) {
            title = c.name.trim();
        } else {
            const firstLine = messages[0].content.split('\n')[0] || messages[0].content;
            title = firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS) + '…' : firstLine;
        }

        const createdAt = (typeof c.createdAt === 'number' && c.createdAt > 0)
            ? new Date(c.createdAt).toISOString()
            : (messages.find(m => m.timestamp)?.timestamp ?? new Date().toISOString());
        const updatedAt = [...messages].reverse().find(m => m.timestamp)?.timestamp ?? createdAt;

        results.push({
            session: {
                id: cid,
                title,
                source: 'cursor',
                workspaceId,
                workspacePath,
                model: c.model,
                messages,
                filePath: vscdbPath,
                createdAt,
                updatedAt,
                sourceNotes: [AISERVICE_SOURCE_NOTE],
            },
            errors: [],
        });
    }

    return results.length > 0 ? results : null;
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Extracts fenced code blocks from a Cursor message.
 * Delegates to the shared extractor used by the Claude/Cline parsers.
 */
export function extractCursorCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    return extractCodeBlocks(content, sessionId, messageIndex);
}

/**
 * Reads a Cursor `state.vscdb` SQLite database and returns one `ParseResult`
 * per composer session found inside `composer.composerData`.
 *
 * Returns an array because one SQLite file contains multiple sessions.
 * On fatal errors (cannot open DB, missing key, malformed JSON) returns a
 * single-element array with `errors` populated and an empty session.
 *
 * @param vscdbPath     Absolute path to `state.vscdb`.
 * @param workspaceId   Storage hash directory name (used as the workspace ID).
 * @param workspacePath Resolved path to the workspace root, if known.
 */
export async function parseCursorWorkspace(
    vscdbPath: string,
    workspaceId: string,
    workspacePath?: string
): Promise<ParseResult[]> {
    /** Returns a single error result for fatal failures. */
    const fatalResult = (msg: string): ParseResult[] => [{
        session: {
            id: `${workspaceId}-cursor-error`,
            title: 'Cursor workspace (parse error)',
            source: 'cursor',
            workspaceId,
            workspacePath,
            messages: [],
            filePath: vscdbPath,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        },
        errors: [msg],
    }];

    // ── Open SQLite and fetch composer + aiService rows (single connection) ───
    let rawValue: string | null = null;
    let usedKey = 'composer.composerData';
    let rawPrompts: string | null = null;
    let rawGenerations: string | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        const db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
            ).get() as { value: string } | undefined;
            rawValue = row?.value ?? null;
            if (rawValue == null) {
                const probeRows = db.prepare(
                    "SELECT key, value FROM ItemTable WHERE key LIKE '%composer%' ORDER BY key LIMIT 100"
                ).all() as Array<{ key: string; value: string }>;
                for (const pr of probeRows) {
                    try {
                        const parsed = JSON.parse(pr.value) as { allComposers?: unknown; composers?: unknown };
                        if (Array.isArray(parsed?.allComposers) || Array.isArray(parsed?.composers)) {
                            rawValue = pr.value;
                            usedKey = pr.key;
                            break;
                        }
                    } catch {
                        // non-JSON value or unexpected shape
                    }
                }
            }
            const prRow = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'aiService.prompts'"
            ).get() as { value: string } | undefined;
            rawPrompts = prRow?.value ?? null;
            const genRow = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'aiService.generations'"
            ).get() as { value: string } | undefined;
            rawGenerations = genRow?.value ?? null;
        } finally {
            db.close();
        }
    } catch (err) {
        return fatalResult(
            `Failed to open/query state.vscdb: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    if (rawValue == null) {
        if (rawPrompts) {
            const fb = buildAiServiceFallbackSessions(
                vscdbPath, workspaceId, workspacePath, [], rawPrompts, rawGenerations
            );
            return fb && fb.length > 0 ? fb : fatalResult("Missing usable composer data key in state.vscdb");
        }
        return fatalResult("Missing usable composer data key in state.vscdb");
    }

    // ── Parse the JSON blob ──────────────────────────────────────────────────
    let composerData: { allComposers?: unknown; composers?: unknown };
    try {
        composerData = JSON.parse(rawValue);
    } catch (err) {
        return fatalResult(
            `Failed to parse composer.composerData JSON: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    const allComposers = Array.isArray(composerData?.allComposers)
        ? composerData.allComposers
        : composerData?.composers;
    if (!Array.isArray(allComposers)) {
        return fatalResult(`${usedKey} does not contain allComposers/composers array`);
    }
    if (allComposers.length === 0) {
        const fb = rawPrompts
            ? buildAiServiceFallbackSessions(
                vscdbPath, workspaceId, workspacePath, [], rawPrompts, rawGenerations
            )
            : null;
        return fb && fb.length > 0 ? fb : [];
    }

    // ── Map each ComposerEntry to a ParseResult ───────────────────────────────
    const composers = (allComposers as ComposerEntry[]).slice(0, MAX_COMPOSERS);

    const perComposer: ParseResult[] = composers.map((composer): ParseResult => {
        const composerId = (typeof composer.composerId === 'string' && composer.composerId)
            ? composer.composerId
            : `${workspaceId}-${path.basename(vscdbPath)}-unknown`;

        const errors: string[] = [];
        const conversation = Array.isArray(composer.conversation)
            ? composer.conversation
            : (Array.isArray(composer.messages) ? composer.messages : []);

        const messages: Message[] = [];
        for (const item of conversation) {
            const role = extractItemRole(item);
            if (!role) { continue; }
            const content = extractItemText(item);

            if (!content.trim()) { continue; }

            const messageIndex = messages.length;
            messages.push({
                id: `${composerId}-${messageIndex}`,
                role,
                content,
                codeBlocks: extractCursorCodeBlocks(content, composerId, messageIndex),
                timestamp: (typeof item.unixMs === 'number' && item.unixMs > 0)
                    ? new Date(item.unixMs).toISOString()
                    : (typeof item.timestamp === 'number' && item.timestamp > 0)
                        ? new Date(item.timestamp).toISOString()
                        : (typeof item.createdAt === 'number' && item.createdAt > 0)
                            ? new Date(item.createdAt).toISOString()
                    : undefined,
            });
        }

        // ── Derive title ─────────────────────────────────────────────────────
        const firstUserMsg = messages.find(m => m.role === 'user');
        let title: string;
        if (typeof composer.name === 'string' && composer.name.trim()) {
            title = composer.name.trim();
        } else if (firstUserMsg) {
            const firstLine = firstUserMsg.content.split('\n')[0];
            const base = firstLine || firstUserMsg.content;
            title = base.length > MAX_TITLE_CHARS ? base.slice(0, MAX_TITLE_CHARS) + '…' : base;
        } else {
            title = 'Untitled';
        }

        // ── Derive timestamps ────────────────────────────────────────────────
        const createdAt = (typeof composer.createdAt === 'number' && composer.createdAt > 0)
            ? new Date(composer.createdAt).toISOString()
            : (typeof composer.updatedAt === 'number' && composer.updatedAt > 0)
                ? new Date(composer.updatedAt).toISOString()
                : (messages.find(m => m.timestamp)?.timestamp ?? new Date().toISOString());

        const lastTimestampMsg = [...messages].reverse().find(m => m.timestamp);
        const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;

        return {
            session: {
                id: composerId,
                title,
                source: 'cursor',
                workspaceId,
                workspacePath,
                model: composer.model,
                messages,
                filePath: vscdbPath,
                createdAt,
                updatedAt,
            },
            errors,
        };
    });

    const nonempty = perComposer.filter(r => r.session.messages.length > 0);
    if (nonempty.length > 0) {
        return nonempty;
    }
    const fb = rawPrompts
        ? buildAiServiceFallbackSessions(
            vscdbPath, workspaceId, workspacePath, composers, rawPrompts, rawGenerations
        )
        : null;
    return fb && fb.length > 0 ? fb : [];
}
