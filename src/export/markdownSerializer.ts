// src/export/markdownSerializer.ts

import { Session } from '../types/index';

/** Truncate text to at most maxLen chars, appending '…' if cut. */
function truncate(text: string, maxLen: number): string {
    return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

/** Serialize a single session to a Markdown string. */
export function serializeSession(session: Session): string {
    const lines: string[] = [];
    lines.push(`# ${session.title || 'Untitled Session'}`);
    lines.push('');
    lines.push(`- **Source:** ${session.source === 'copilot' ? 'GitHub Copilot' : 'Claude Code'}`);
    if (session.model) { lines.push(`- **Model:** ${session.model}`); }
    lines.push(`- **Updated:** ${session.updatedAt.slice(0, 16).replace('T', ' ')}`);
    lines.push('');

    const visible = session.messages.filter(m => m.content.trim() !== '');
    let first = true;
    for (const msg of visible) {
        if (msg.role === 'user') {
            const firstLine = msg.content.split('\n')[0].trim();
            const heading = truncate(firstLine || 'Prompt', 120);
            lines.push('---');
            lines.push('');
            if (first) { first = false; }
            lines.push(`## ${heading}`);
            lines.push('');
            lines.push(msg.content);
            lines.push('');
        } else {
            lines.push('### Response');
            lines.push('');
            lines.push(msg.content);
            lines.push('');
        }
    }

    return lines.join('\n');
}

/** Serialize multiple sessions to a single combined Markdown string with TOC. */
export function serializeSessions(sessions: Session[], _mode: 'combined'): string {
    const parts: string[] = [];
    parts.push('# ChatWizard Export');
    parts.push('');
    parts.push('## Table of Contents');
    parts.push('');
    for (let i = 0; i < sessions.length; i++) {
        const title = sessions[i].title || 'Untitled Session';
        const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        parts.push(`${i + 1}. [${title}](#${anchor})`);
    }
    parts.push('');
    parts.push('---');
    parts.push('');

    for (const session of sessions) {
        parts.push(serializeSession(session));
    }

    return parts.join('\n');
}
