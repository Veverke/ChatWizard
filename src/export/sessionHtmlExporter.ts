// src/export/sessionHtmlExporter.ts
// Feature 36 — Session Sharing (HTML Bundle Exporter)

import * as fs from 'fs';
import * as path from 'path';
import type { Session, MessageAnnotation } from '../types/index';

export interface SessionHtmlExportOptions {
    /** Whether to include inline annotation blocks. Default: false */
    includeAnnotations: boolean;
    /** Color theme for the output. Default: 'light' */
    theme: 'light' | 'dark' | 'auto';
    /** When true, fenced code block content is replaced with [code block redacted]. Default: false */
    redactCodeBlocks: boolean;
    /** Annotations to include (from sidecar metadata). Required when includeAnnotations: true */
    annotations?: MessageAnnotation[];
}

const DEFAULT_OPTIONS: SessionHtmlExportOptions = {
    includeAnnotations: false,
    theme: 'light',
    redactCodeBlocks: false,
};

/**
 * Escape HTML special characters to prevent XSS in the output.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Redact fenced code blocks from content, replacing them with a placeholder.
 */
function redactFencedCodeBlocks(content: string): string {
    return content.replace(/```[\s\S]*?```/g, '[code block redacted]');
}

/**
 * Convert message content to simple HTML paragraphs (no markdown parsing — just safe escaping).
 */
function contentToHtml(content: string, redact: boolean): string {
    const processed = redact ? redactFencedCodeBlocks(content) : content;
    // Split into paragraphs by double newlines, or by single newlines for line breaks
    return escapeHtml(processed).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
}

/**
 * Generate the inline CSS for the HTML export.
 */
function buildCss(theme: 'light' | 'dark' | 'auto'): string {
    const lightVars = `
        --bg: #ffffff;
        --surface: #f8f9fa;
        --border: #e1e4e8;
        --text: #24292e;
        --user-accent: #0366d6;
        --assistant-accent: #6f42c1;
        --compaction-bg: #dbeafe;
        --compaction-border: #3b82f6;
        --annotation-bg: #fefce8;
        --annotation-border: #eab308;
        --header-bg: #16324f;
        --header-text: #ffffff;
        --code-bg: #f6f8fa;
    `;
    const darkVars = `
        --bg: #0d1117;
        --surface: #161b22;
        --border: #30363d;
        --text: #c9d1d9;
        --user-accent: #58a6ff;
        --assistant-accent: #d2a8ff;
        --compaction-bg: #1e3a5f;
        --compaction-border: #58a6ff;
        --annotation-bg: #2d2a0a;
        --annotation-border: #d4a017;
        --header-bg: #161b22;
        --header-text: #c9d1d9;
        --code-bg: #1c2028;
    `;

    let mediaQuery = '';
    if (theme === 'auto') {
        mediaQuery = `@media (prefers-color-scheme: dark) { :root { ${darkVars} } }`;
    }

    const rootVars = theme === 'dark' ? darkVars : lightVars;

    return `
        :root { ${rootVars} }
        ${mediaQuery}
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.6; }
        .cw-header { background: var(--header-bg); color: var(--header-text); padding: 20px 24px; }
        .cw-header h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
        .cw-header .meta { font-size: 13px; opacity: 0.8; }
        .cw-banner { font-size: 12px; opacity: 0.6; margin-top: 8px; }
        .cw-container { max-width: 900px; margin: 0 auto; padding: 24px; }
        .cw-compaction { background: var(--compaction-bg); border-left: 4px solid var(--compaction-border); border-radius: 6px; padding: 16px; margin-bottom: 24px; }
        .cw-compaction .cw-compaction-title { font-weight: 600; margin-bottom: 8px; }
        .cw-compaction .cw-compaction-note { font-size: 13px; opacity: 0.7; margin-top: 8px; }
        .cw-message { margin-bottom: 20px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .cw-message-header { padding: 8px 14px; font-size: 13px; font-weight: 600; background: var(--surface); }
        .cw-message.user .cw-message-header { color: var(--user-accent); }
        .cw-message.assistant .cw-message-header { color: var(--assistant-accent); }
        .cw-message-body { padding: 12px 14px; white-space: pre-wrap; word-break: break-word; }
        .cw-annotation { background: var(--annotation-bg); border-left: 3px solid var(--annotation-border); padding: 8px 12px; margin: 8px 14px 12px; border-radius: 4px; font-size: 13px; }
        .cw-annotation-label { font-weight: 600; font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
    `;
}

/**
 * Export a session as a self-contained, static HTML file.
 *
 * The output file:
 * - Contains inline CSS (no external dependencies).
 * - Renders all messages with proper user/assistant styling.
 * - Optionally includes annotation blocks.
 * - Contains no JavaScript.
 * - Optionally redacts fenced code block content.
 */
export async function exportSessionAsHtml(
    session: Session,
    outputPath: string,
    options: Partial<SessionHtmlExportOptions> = {}
): Promise<void> {
    const opts: SessionHtmlExportOptions = { ...DEFAULT_OPTIONS, ...options };

    const title = escapeHtml(session.title);
    const source = escapeHtml(session.source);
    const date = escapeHtml(session.updatedAt.slice(0, 10)); // YYYY-MM-DD
    const messageCount = session.messages.length;

    const css = buildCss(opts.theme);

    const annotationMap = new Map<number, MessageAnnotation[]>();
    if (opts.includeAnnotations && opts.annotations) {
        for (const ann of opts.annotations) {
            const arr = annotationMap.get(ann.messageIndex) ?? [];
            arr.push(ann);
            annotationMap.set(ann.messageIndex, arr);
        }
    }

    const messageParts: string[] = [];

    // Render compaction block if present
    if (session.isCompacted && session.compactionSummary) {
        messageParts.push(`
            <div class="cw-compaction">
                <div class="cw-compaction-title">📋 Context summary from earlier conversation</div>
                <div>${escapeHtml(session.compactionSummary)}</div>
                <div class="cw-compaction-note">Earlier turns were compacted by Claude Code.</div>
            </div>
        `);
    }

    // Render messages
    for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i];
        const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
        const roleClass = msg.role === 'user' ? 'user' : 'assistant';
        const ts = msg.timestamp ? ` · ${escapeHtml(msg.timestamp.slice(0, 19).replace('T', ' '))}` : '';
        const bodyHtml = contentToHtml(msg.content, opts.redactCodeBlocks);

        let annotationHtml = '';
        if (opts.includeAnnotations) {
            const anns = annotationMap.get(i) ?? [];
            for (const ann of anns) {
                annotationHtml += `
                    <div class="cw-annotation">
                        <div class="cw-annotation-label">📝 Note</div>
                        <div>${escapeHtml(ann.text)}</div>
                    </div>
                `;
            }
        }

        messageParts.push(`
            <div class="cw-message ${roleClass}">
                <div class="cw-message-header">${roleLabel}${ts}</div>
                <div class="cw-message-body"><p>${bodyHtml}</p></div>
                ${annotationHtml}
            </div>
        `);
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ChatWizard Export</title>
<style>${css}</style>
</head>
<body>
<div class="cw-header">
    <h1>${title}</h1>
    <div class="meta">Source: ${source} · Date: ${date} · ${messageCount} messages</div>
    <div class="cw-banner">Generated by ChatWizard · <a href="https://github.com/Veverke/ChatWizard" style="color:inherit;opacity:0.6">chatwizard</a></div>
</div>
<div class="cw-container">
    ${messageParts.join('\n')}
</div>
</body>
</html>`;

    // Ensure output directory exists
    const dir = path.dirname(outputPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(outputPath, html, 'utf8');
}