// src/timeline/timelineBuilder.ts

import { Session } from '../types/index';

export interface TimelineEntry {
    sessionId: string;
    sessionTitle: string;
    source: 'copilot' | 'claude';
    workspacePath: string;
    workspaceName: string;   // basename of workspacePath (last path segment, or '' if empty)
    date: string;            // YYYY-MM-DD derived from session updatedAt
    timestamp: number;       // ms epoch for sorting (from session updatedAt)
    firstPrompt: string;     // text of first user/human message, trimmed; capped at 150 chars with '…'
    messageCount: number;    // total messages in session
    promptCount: number;     // count of user/human messages
}

/**
 * Extract the basename from a workspace path.
 * Replaces all backslashes with forward slashes, splits by '/', and returns
 * the last non-empty segment. Returns '' if the path is empty or undefined.
 */
function extractWorkspaceName(workspacePath: string | undefined): string {
    if (!workspacePath) {
        return '';
    }
    const normalized = workspacePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(s => s.length > 0);
    return segments[segments.length - 1] ?? '';
}

/**
 * Extract text from a message content value.
 * Handles both plain strings and arrays of content blocks (with type/text fields).
 */
function extractMessageText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
                const text = (block as { type: string; text?: string }).text;
                if (typeof text === 'string') {
                    return text;
                }
            }
        }
    }
    return '';
}

/**
 * Build a timeline of sessions sorted newest-first.
 *
 * - Sessions with 0 messages are skipped.
 * - Sessions whose updatedAt resolves to the epoch date ('1970-01-01') are skipped.
 * - Results are sorted by timestamp descending.
 */
export function buildTimeline(sessions: Session[]): TimelineEntry[] {
    const entries: TimelineEntry[] = [];

    for (const session of sessions) {
        if (session.messages.length === 0) {
            continue;
        }

        const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
        const resolvedTimestamp = isNaN(timestamp) ? 0 : timestamp;

        let date: string;
        if (!session.updatedAt || isNaN(timestamp)) {
            date = '1970-01-01';
        } else {
            date = new Date(timestamp).toISOString().slice(0, 10);
        }

        if (date === '1970-01-01') {
            continue;
        }

        const workspacePath = session.workspacePath ?? '';
        const workspaceName = extractWorkspaceName(session.workspacePath);

        // Find first user/human message
        let firstPrompt = '';
        for (const msg of session.messages) {
            const role = msg.role as string;
            if (role === 'user' || role === 'human') {
                const raw = extractMessageText(msg.content).trim();
                firstPrompt = raw.length > 150 ? raw.slice(0, 150) + '…' : raw;
                break;
            }
        }

        // Count user/human messages
        let promptCount = 0;
        for (const msg of session.messages) {
            const role = msg.role as string;
            if (role === 'user' || role === 'human') {
                promptCount++;
            }
        }

        entries.push({
            sessionId: session.id,
            sessionTitle: session.title,
            source: session.source,
            workspacePath,
            workspaceName,
            date,
            timestamp: resolvedTimestamp,
            firstPrompt,
            messageCount: session.messages.length,
            promptCount,
        });
    }

    // Sort newest first
    entries.sort((a, b) => b.timestamp - a.timestamp);

    return entries;
}
