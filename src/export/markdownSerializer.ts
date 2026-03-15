// src/export/markdownSerializer.ts

import { Session } from '../types/index';

/** Truncate text to at most maxLen chars, appending '…' if cut. */
function truncate(text: string, maxLen: number): string {
    return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

// SEC-9: safe URL schemes in exported Markdown links
const RE_SAFE_EXPORT_URL = /^https?:\/\/|^ftp:\/\/|^#|^\/[^/]|^\.\.?\//i;
const RE_MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * SEC-9: Strip Markdown link URLs that use an unsafe scheme.
 * Replaces `[text](javascript:...)` with `[text]` to prevent XSS if the
 * exported Markdown is rendered by a browser or Markdown preview.
 * http(s), ftp, anchor (#), and relative paths are preserved unchanged.
 */
function sanitizeForExport(text: string): string {
    return text.replace(RE_MD_LINK, (_match, linkText, url) => {
        return RE_SAFE_EXPORT_URL.test(url.trim())
            ? `[${linkText}](${url})`
            : `[${linkText}]`;
    });
}

// SEC-9: Export file preamble so renderers and users understand what the file is.
const EXPORT_HEADER = '<!-- ChatWizard export — AI-generated content. ' +
    'Render in a trusted environment only. -->\n\n';

/** Serialize a single session to a Markdown string.
 *
 * @param sanitize When true (default), unsafe Markdown link URLs are stripped. SEC-9.
 */
export function serializeSession(session: Session, sanitize = true): string {
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
        // SEC-9: sanitize message content to strip unsafe Markdown links
        const content = sanitize ? sanitizeForExport(msg.content) : msg.content;
        if (msg.role === 'user') {
            const firstLine = content.split('\n')[0].trim();
            const heading = truncate(firstLine || 'Prompt', 120);
            lines.push('---');
            lines.push('');
            if (first) { first = false; }
            lines.push(`## ${heading}`);
            lines.push('');
            lines.push(content);
            lines.push('');
        } else {
            lines.push('### Response');
            lines.push('');
            lines.push(content);
            lines.push('');
        }
    }

    return lines.join('\n');
}

/** Serialize multiple sessions to a single combined Markdown string with TOC.
 *
 * @param sanitize When true (default), unsafe Markdown link URLs are stripped. SEC-9.
 */
export function serializeSessions(sessions: Session[], _mode: 'combined', sanitize = true): string {
    const parts: string[] = [];
    // SEC-9: preamble warns renderers that content is AI-generated
    parts.push(EXPORT_HEADER);
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
        parts.push(serializeSession(session, sanitize));
    }

    return parts.join('\n');
}
