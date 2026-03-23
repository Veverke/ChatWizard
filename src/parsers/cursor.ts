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
    type?: number;            // 1 = chat, 2 = agent
    conversation?: ConversationItem[];
}

interface ConversationItem {
    type?: number;            // 1 = user, 2 = assistant
    text?: string;
    richText?: string;
    unixMs?: number;
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

    // ── Open SQLite and fetch composer data ─────────────────────────────────
    let rawValue: string | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        const db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
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
        return fatalResult("Missing 'composer.composerData' key in state.vscdb");
    }

    // ── Parse the JSON blob ──────────────────────────────────────────────────
    let composerData: { allComposers?: unknown };
    try {
        composerData = JSON.parse(rawValue);
    } catch (err) {
        return fatalResult(
            `Failed to parse composer.composerData JSON: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    const allComposers = composerData?.allComposers;
    if (!Array.isArray(allComposers)) {
        return fatalResult('composer.composerData.allComposers is not an array');
    }
    if (allComposers.length === 0) {
        return [];
    }

    // ── Map each ComposerEntry to a ParseResult ───────────────────────────────
    const composers = (allComposers as ComposerEntry[]).slice(0, MAX_COMPOSERS);

    return composers.map((composer): ParseResult => {
        const composerId = (typeof composer.composerId === 'string' && composer.composerId)
            ? composer.composerId
            : `${workspaceId}-${path.basename(vscdbPath)}-unknown`;

        const errors: string[] = [];
        const conversation = Array.isArray(composer.conversation) ? composer.conversation : [];

        const messages: Message[] = [];
        for (const item of conversation) {
            // Only types 1 (user) and 2 (assistant) are chat messages.
            if (item.type !== 1 && item.type !== 2) { continue; }

            const role: 'user' | 'assistant' = item.type === 1 ? 'user' : 'assistant';
            const content = (typeof item.text === 'string' && item.text)
                ? item.text
                : (typeof item.richText === 'string' ? item.richText : '');

            if (!content.trim()) { continue; }

            const messageIndex = messages.length;
            messages.push({
                id: `${composerId}-${messageIndex}`,
                role,
                content,
                codeBlocks: extractCursorCodeBlocks(content, composerId, messageIndex),
                timestamp: (typeof item.unixMs === 'number' && item.unixMs > 0)
                    ? new Date(item.unixMs).toISOString()
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
            : (messages.find(m => m.timestamp)?.timestamp ?? new Date(0).toISOString());

        const lastTimestampMsg = [...messages].reverse().find(m => m.timestamp);
        const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;

        return {
            session: {
                id: composerId,
                title,
                source: 'cursor',
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
