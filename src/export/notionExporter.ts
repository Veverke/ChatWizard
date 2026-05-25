// src/export/notionExporter.ts
// Exports ChatWizard sessions to Notion via the Notion API.
//
// Each session becomes a new page inside the specified database.
// API key is stored in VS Code SecretStorage (never in settings.json).
//
// Rate limiting: Notion's API allows 3 req/s.
// We stay safely under limit with a configurable delay between requests.
//
// Feature 22: Obsidian/Notion Export

import * as https from 'https';
import { Session } from '../types/index';
import { SessionMetadata } from '../types/index';
import { friendlySourceName } from '../ui/sourceUi';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NotionExportOptions {
    databaseId: string;
    apiKey: string;
    /** Milliseconds to wait between API calls (default: 400 to stay under 3 req/s) */
    rateDelayMs?: number;
}

export interface NotionExportResult {
    written: number;
    errors: Array<{ sessionId: string; error: string }>;
}

// Notion block type helpers
type NotionBlock = Record<string, unknown>;

// ─── Block builders ───────────────────────────────────────────────────────────

function heading2(text: string): NotionBlock {
    return {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
    };
}

function heading3(text: string): NotionBlock {
    return {
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
    };
}

function paragraph(text: string): NotionBlock {
    return {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
    };
}

function divider(): NotionBlock {
    return { object: 'block', type: 'divider', divider: {} };
}

/** Splits text into ≤2000-char paragraph blocks (Notion API limit per block). */
function textToBlocks(text: string): NotionBlock[] {
    const chunks: NotionBlock[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(paragraph(remaining.slice(0, 2000)));
        remaining = remaining.slice(2000);
    }
    return chunks;
}

/** Build Notion page children blocks from a session. */
function buildBlocks(session: Session, metadata?: SessionMetadata): NotionBlock[] {
    const blocks: NotionBlock[] = [];

    if (metadata?.summary) {
        blocks.push(paragraph(`📝 ${metadata.summary}`));
        blocks.push(divider());
    }

    const visible = session.messages.filter(m => m.content.trim());
    for (const msg of visible) {
        if (msg.role === 'user') {
            const firstLine = msg.content.split('\n')[0].trim().slice(0, 100) || 'Prompt';
            blocks.push(heading2(firstLine));
            blocks.push(...textToBlocks(msg.content));
        } else {
            blocks.push(heading3('Response'));
            blocks.push(...textToBlocks(msg.content));
        }
        blocks.push(divider());
    }

    // Notion API max 100 children per request; we silently truncate
    return blocks.slice(0, 100);
}

/** Build the Notion page properties object. */
function buildProperties(
    session: Session,
    metadata?: SessionMetadata,
): Record<string, unknown> {
    const props: Record<string, unknown> = {
        Name: {
            title: [{ type: 'text', text: { content: (session.title || 'Untitled').slice(0, 2000) } }],
        },
        Source: {
            rich_text: [{ type: 'text', text: { content: friendlySourceName(session.source) } }],
        },
        Date: { date: { start: session.updatedAt.slice(0, 10) } },
        ChatWizardId: { rich_text: [{ type: 'text', text: { content: session.id } }] },
    };

    if (session.model) {
        props['Model'] = { rich_text: [{ type: 'text', text: { content: session.model } }] };
    }

    const tags = metadata?.tags ?? [];
    if (tags.length > 0) {
        props['Tags'] = { multi_select: tags.map(t => ({ name: t })) };
    }

    return props;
}

// ─── HTTP helper (no external dependency) ────────────────────────────────────

function notionRequest(
    path: string,
    body: Record<string, unknown>,
    apiKey: string,
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request(
            {
                hostname: 'api.notion.com',
                port: 443,
                path,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': '2022-06-28',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({
                    statusCode: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ─── NotionExporter ───────────────────────────────────────────────────────────

export class NotionExporter {
    /**
     * Exports sessions to a Notion database as individual pages.
     * @param sessions     Sessions to export
     * @param options      Must include databaseId and apiKey (from SecretStorage)
     * @param getMetadata  Optional function to retrieve metadata per session ID
     */
    async export(
        sessions: Session[],
        options: NotionExportOptions,
        getMetadata?: (sessionId: string) => SessionMetadata | undefined,
    ): Promise<NotionExportResult> {
        const rateDelay = options.rateDelayMs ?? 400; // ≈ 2.5 req/s (safe under 3/s)
        const result: NotionExportResult = { written: 0, errors: [] };

        for (const session of sessions) {
            try {
                const metadata = getMetadata?.(session.id);
                const properties = buildProperties(session, metadata);
                const children = buildBlocks(session, metadata);

                const pageBody: Record<string, unknown> = {
                    parent: { database_id: options.databaseId },
                    properties,
                    children,
                };

                const response = await notionRequest('/v1/pages', pageBody, options.apiKey);

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    result.written++;
                } else {
                    let detail = response.body;
                    try { detail = JSON.parse(response.body)?.message ?? detail; } catch { /* ignore */ }
                    result.errors.push({ sessionId: session.id, error: `HTTP ${response.statusCode}: ${detail}` });
                }
            } catch (err) {
                result.errors.push({ sessionId: session.id, error: String(err) });
            }

            await delay(rateDelay);
        }

        return result;
    }
}
