// src/parsers/windsurf.ts

import { Session, Message, CodeBlock, ParseResult } from '../types/index';
import { extractCodeBlocks } from './claude';

/** Maximum number of CascadeSession records processed per database. */
const MAX_SESSIONS = 5_000;

/** Maximum characters to keep in a title derived from the first user message. */
const MAX_TITLE_CHARS = 120;

// ─── Raw JSON shapes (Windsurf cascade.sessionData) ───────────────────────────

interface CascadeSession {
    sessionId?: string;
    title?: string;
    createdAt?: number;       // unix ms
    messages?: CascadeMessage[];
}

interface CascadeMessage {
    role?: 'user' | 'assistant';
    content?: string;
    timestamp?: number;       // unix ms
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Extracts fenced code blocks from a Windsurf message.
 * Delegates to the shared extractor used by the Claude/Cursor parsers.
 */
export function extractWindsurfCodeBlocks(
    content: string,
    sessionId: string,
    messageIndex: number
): CodeBlock[] {
    return extractCodeBlocks(content, sessionId, messageIndex);
}

/**
 * Reads a Windsurf `state.vscdb` SQLite database and returns one `ParseResult`
 * per Cascade session found inside `cascade.sessionData`.
 *
 * Returns an array because one SQLite file contains multiple sessions.
 * On fatal errors (cannot open DB, missing key, malformed JSON) returns a
 * single-element array with `errors` populated and an empty session.
 *
 * @param vscdbPath     Absolute path to `state.vscdb`.
 * @param workspaceId   Storage hash directory name (used as the workspace ID).
 * @param workspacePath Resolved path to the workspace root, if known.
 */
export async function parseWindsurfWorkspace(
    vscdbPath: string,
    workspaceId: string,
    workspacePath?: string
): Promise<ParseResult[]> {
    /** Returns a single error result for fatal failures. */
    const fatalResult = (msg: string): ParseResult[] => [{
        session: {
            id: `${workspaceId}-windsurf-error`,
            title: 'Windsurf workspace (parse error)',
            source: 'windsurf',
            workspaceId,
            workspacePath,
            messages: [],
            filePath: vscdbPath,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        },
        errors: [msg],
    }];

    // ── Open SQLite and fetch cascade session data ───────────────────────────
    let rawValue: string | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        const db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'cascade.sessionData'"
            ).get() as { value: string } | undefined;
            rawValue = row?.value ?? null;
        } finally {
            db.close();
        }
    } catch (err) {
        return fatalResult(
            `Failed to open/query state.vscdb: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    if (rawValue == null) {
        return fatalResult("Missing 'cascade.sessionData' key in state.vscdb");
    }

    // ── Parse the JSON blob ──────────────────────────────────────────────────
    let cascadeData: { sessions?: unknown };
    try {
        cascadeData = JSON.parse(rawValue);
    } catch (err) {
        return fatalResult(
            `Failed to parse cascade.sessionData JSON: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    const allSessions = cascadeData?.sessions;
    if (!Array.isArray(allSessions)) {
        return fatalResult('cascade.sessionData.sessions is not an array');
    }
    if (allSessions.length === 0) {
        return [];
    }

    // ── Map each CascadeSession to a ParseResult ──────────────────────────────
    const sessions = (allSessions as CascadeSession[]).slice(0, MAX_SESSIONS);

    return sessions.map((cascadeSession): ParseResult => {
        const sessionId = (typeof cascadeSession.sessionId === 'string' && cascadeSession.sessionId)
            ? cascadeSession.sessionId
            : `${workspaceId}-windsurf-unknown`;

        const errors: string[] = [];
        const rawMessages = Array.isArray(cascadeSession.messages) ? cascadeSession.messages : [];

        const messages: Message[] = [];
        for (const msg of rawMessages) {
            if (msg.role !== 'user' && msg.role !== 'assistant') { continue; }

            const content = typeof msg.content === 'string' ? msg.content : '';
            if (!content.trim()) { continue; }

            const messageIndex = messages.length;
            messages.push({
                id: `${sessionId}-${messageIndex}`,
                role: msg.role,
                content,
                codeBlocks: extractWindsurfCodeBlocks(content, sessionId, messageIndex),
                timestamp: (typeof msg.timestamp === 'number' && msg.timestamp > 0)
                    ? new Date(msg.timestamp).toISOString()
                    : undefined,
            });
        }

        // ── Derive title ─────────────────────────────────────────────────────
        const firstUserMsg = messages.find(m => m.role === 'user');
        let title: string;
        if (typeof cascadeSession.title === 'string' && cascadeSession.title.trim()) {
            title = cascadeSession.title.trim();
        } else if (firstUserMsg) {
            const firstLine = firstUserMsg.content.split('\n')[0];
            const base = firstLine || firstUserMsg.content;
            title = base.length > MAX_TITLE_CHARS ? base.slice(0, MAX_TITLE_CHARS) + '…' : base;
        } else {
            title = 'Untitled';
        }

        // ── Derive timestamps ────────────────────────────────────────────────
        const createdAt = (typeof cascadeSession.createdAt === 'number' && cascadeSession.createdAt > 0)
            ? new Date(cascadeSession.createdAt).toISOString()
            : (messages.find(m => m.timestamp)?.timestamp ?? new Date(0).toISOString());

        const lastTimestampMsg = [...messages].reverse().find(m => m.timestamp);
        const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;

        return {
            session: {
                id: sessionId,
                title,
                source: 'windsurf',
                workspaceId,
                workspacePath,
                messages,
                filePath: vscdbPath,
                createdAt,
                updatedAt,
            },
            errors,
        };
    });
}
