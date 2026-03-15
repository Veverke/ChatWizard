// src/views/sessionRenderer.ts
//
// Pure rendering helpers for the session webview panel.
// No VS Code dependency — safe to import in unit tests.

import { Message } from '../types/index';

export interface VisibleMessage {
    msg:     Message;
    origIdx: number;
}

// ── Pre-compiled regex constants (module-level, compiled once) ────────────────
// Whole-text passes
const RE_CONTROL        = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const RE_NON_ASCII      = /[^\x00-\x7F]/gu;
const RE_FENCE          = /```([^\n`]*)\n([\s\S]*?)```/g;
const RE_INLINE_CODE    = /`([^`]+)`/g;
const RE_PLACEHOLDER_CB = /^\x00CB(\d+)\x00$/;
const RE_PLACEHOLDER_CB_G = /\x00CB(\d+)\x00/g;
const RE_PLACEHOLDER_IC_G = /\x00IC(\d+)\x00/g;
// HTML entity escaping
const RE_AMP  = /&/g;
const RE_LT   = /</g;
const RE_GT   = />/g;
const RE_QUOT = /"/g;
const RE_APOS = /'/g;
// Line-level patterns
const RE_INDENT     = /^    /;
const RE_HEADING    = /^(#{1,6})\s+(.+)$/;
const RE_HR         = /^([-*_])\1\1+\s*$/;
const RE_BLOCKQUOTE = /^&gt;\s?(.*)$/;
const RE_TABLE_ROW  = /^\|/;
const RE_TABLE_SEP  = /^\|[\s|:-]+\|$/;
const RE_UL         = /^[-*+]\s+(.+)$/;
const RE_OL         = /^\d+\.\s+(.+)$/;
// Inline formatting patterns
const RE_BOLD_ITALIC = /\*\*\*(.+?)\*\*\*/g;
const RE_BOLD        = /\*\*(.+?)\*\*/g;
const RE_ITALIC      = /\*(.+?)\*/g;
const RE_STRIKE      = /~~(.+?)~~/g;
const RE_LINK        = /\[([^\]]+)\]\(([^)]+)\)/g;
// SEC-1: safe URL schemes for rendered links
const RE_SAFE_URL    = /^https?:\/\/|^#|^\/[^/]|^\.\.?\//;
// escapeHtml patterns
const RE_ESC_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// ── MessageRenderer class ─────────────────────────────────────────────────────

/**
 * Stateless renderer class — thin wrapper around the module-level functions.
 * Useful for unit testing and benchmarking via `new MessageRenderer()` or
 * `MessageRenderer.markdownToHtml()`.
 */
export class MessageRenderer {
    /** Convert Markdown to HTML using the single-pass line scanner. */
    static markdownToHtml(markdown: string): string {
        return markdownToHtml(markdown);
    }

    static renderMessage(
        msg: Message,
        origIdx: number,
        visibleIdx: number,
        visibleMessages: VisibleMessage[],
        assistantLabel: string,
        fadeIdx: number | undefined
    ): string {
        return renderMessage(msg, origIdx, visibleIdx, visibleMessages, assistantLabel, fadeIdx);
    }

    static renderChunk(
        visibleMessages: VisibleMessage[],
        renderedMessages: (string | null)[],
        start: number,
        end: number,
        assistantLabel: string,
        withFade: boolean
    ): string {
        return renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade);
    }
}

/**
 * Render messages[start..end) into an HTML string, using/populating the
 * `renderedMessages` cache array.
 *
 * When `withFade` is true the first 16 messages in the chunk receive
 * CSS fade-in styles (`--cw-i`) rendered fresh (without affecting the cache
 * entries which always store the style-free version).
 */
export function renderChunk(
    visibleMessages:  VisibleMessage[],
    renderedMessages: (string | null)[],
    start:     number,
    end:       number,
    assistantLabel: string,
    withFade:  boolean
): string {
    const parts: string[] = [];
    for (let i = start; i < end; i++) {
        const { msg, origIdx } = visibleMessages[i];
        const fadeIdx = withFade ? (i - start) : undefined;

        if (fadeIdx !== undefined && fadeIdx < 16) {
            // First 16 of initial render: include fade style, render fresh
            parts.push(renderMessage(msg, origIdx, i, visibleMessages, assistantLabel, fadeIdx));
            // Also populate cache with the non-faded version if missing
            if (renderedMessages[i] === null) {
                renderedMessages[i] = renderMessage(
                    msg, origIdx, i, visibleMessages, assistantLabel, undefined
                );
            }
        } else {
            if (renderedMessages[i] === null) {
                renderedMessages[i] = renderMessage(
                    msg, origIdx, i, visibleMessages, assistantLabel, undefined
                );
            }
            parts.push(renderedMessages[i]!);
        }
    }
    return parts.join('\n');
}

/**
 * Render a single message to an HTML string.
 * `fadeIdx` < 16 injects a `--cw-i` CSS variable for the entry-animation.
 * `fadeIdx` undefined or ≥ 16 produces no animation style.
 */
export function renderMessage(
    msg:            Message,
    origIdx:        number,
    visibleIdx:     number,
    visibleMessages: VisibleMessage[],
    assistantLabel: string,
    fadeIdx:        number | undefined
): string {
    const roleClass = msg.role === 'user' ? 'user' : 'assistant';
    const label     = msg.role === 'user' ? 'You' : assistantLabel;
    const timestamp = msg.timestamp
        ? `<span class="timestamp">${escapeHtml(new Date(msg.timestamp).toLocaleString())}</span>`
        : '';
    const renderedContent = markdownToHtml(msg.content);
    const fadeStyle = (fadeIdx !== undefined && fadeIdx < 16) ? ` style="--cw-i:${fadeIdx}"` : '';

    let html = `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}">
  <div class="message-header">
    <span class="role-label">${label}</span>${timestamp}
  </div>
  <div class="message-body">${renderedContent}</div>
</div>`;

    // Aborted-response placeholder: user msg with no following assistant reply
    const nextEntry = visibleMessages[visibleIdx + 1];
    if (msg.role === 'user' && (!nextEntry || nextEntry.msg.role === 'user')) {
        html += `\n<div class="message aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice">&#9888; Response not available &mdash; cancelled or incomplete</div>
</div>`;
    }
    return html;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
    return text
        .replace(RE_ESC_CONTROL, '')
        .replace(RE_AMP,  '&amp;')
        .replace(RE_LT,   '&lt;')
        .replace(RE_GT,   '&gt;')
        .replace(RE_QUOT, '&quot;')
        .replace(RE_APOS, '&#39;')
        .replace(RE_NON_ASCII, c => `&#${c.codePointAt(0)};`);
}

/**
 * SEC-1: Validates a URL captured from Markdown link syntax.
 * Only http/https, anchor links, absolute paths, and relative paths are allowed.
 * Any other scheme (javascript:, data:, vbscript:, etc.) is replaced with '#'.
 *
 * The URL may contain HTML-entity-escaped characters from the earlier escaping pass
 * (& → &amp; etc.). We decode & and ' entities before scheme-checking so that
 * obfuscated schemes like "javascript&colon;" are also rejected.
 */
function sanitizeUrl(url: string): string {
    const decoded = url.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    return RE_SAFE_URL.test(decoded) ? url : '#';
}

function applyInline(text: string): string {
    return text
        .replace(RE_BOLD_ITALIC, '<strong><em>$1</em></strong>')
        .replace(RE_BOLD,        '<strong>$1</strong>')
        .replace(RE_ITALIC,      '<em>$1</em>')
        .replace(RE_STRIKE,      '<del>$1</del>')
        // SEC-1: sanitize href to block javascript: / data: / vbscript: etc.
        .replace(RE_LINK, (_m, linkText, url) => `<a href="${sanitizeUrl(url)}">${linkText}</a>`);
}

export function markdownToHtml(markdown: string): string {
    // Strip non-printable control characters (keep \t \n \r)
    markdown = markdown.replace(RE_CONTROL, '');
    // Encode non-ASCII as HTML entities
    markdown = markdown.replace(RE_NON_ASCII, c => `&#${c.codePointAt(0)};`);

    const codeBlocks: string[] = [];
    let text = markdown.replace(RE_FENCE, (_m, lang, code) => {
        const esc = code.replace(RE_AMP, '&amp;').replace(RE_LT, '&lt;').replace(RE_GT, '&gt;');
        const attr = lang.trim() ? ` class="language-${lang.trim()}"` : '';
        codeBlocks.push(`<pre><code${attr}>${esc}</code></pre>`);
        return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    text = text.replace(RE_AMP, '&amp;').replace(RE_LT, '&lt;').replace(RE_GT, '&gt;');

    const inlineCodes: string[] = [];
    text = text.replace(RE_INLINE_CODE, (_m, code) => {
        inlineCodes.push(`<code>${code}</code>`);
        return `\x00IC${inlineCodes.length - 1}\x00`;
    });

    const lines = text.split('\n');
    const out: string[] = [];
    let inUl = false, inOl = false, inTable = false;
    let columnAligns: string[] = [];
    let paragraphLines: string[] = [];

    const closeList  = (): void => {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
    };
    const closeTable = (): void => {
        if (inTable) { out.push('</tbody></table></div>'); inTable = false; columnAligns = []; }
    };
    const alignAttr = (colIdx: number): string => {
        const a = columnAligns[colIdx] ?? '';
        return a ? ` style="text-align:${a}"` : '';
    };
    const flushParagraph = (): void => {
        if (paragraphLines.length > 0) {
            out.push(`<p>${paragraphLines.join('<br>')}</p>`);
            paragraphLines = [];
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const cbMatch = line.trim().match(RE_PLACEHOLDER_CB);
        if (cbMatch) { flushParagraph(); closeList(); closeTable(); out.push(codeBlocks[+cbMatch[1]]); continue; }

        if (RE_INDENT.test(line) && !inUl && !inOl) {
            flushParagraph(); closeList(); closeTable();
            const indentedLines: string[] = [line.slice(4)];
            while (i + 1 < lines.length && RE_INDENT.test(lines[i + 1])) {
                i++; indentedLines.push(lines[i].slice(4));
            }
            const esc = indentedLines.join('\n').replace(RE_AMP, '&amp;').replace(RE_LT, '&lt;').replace(RE_GT, '&gt;');
            out.push(`<pre><code>${esc}</code></pre>`);
            continue;
        }

        const hMatch = line.match(RE_HEADING);
        if (hMatch) {
            flushParagraph(); closeList(); closeTable();
            const lvl = hMatch[1].length;
            out.push(`<h${lvl}>${applyInline(hMatch[2])}</h${lvl}>`);
            continue;
        }

        if (RE_HR.test(line)) { flushParagraph(); closeList(); closeTable(); out.push('<hr>'); continue; }

        const bqMatch = line.match(RE_BLOCKQUOTE);
        if (bqMatch) {
            flushParagraph(); closeList(); closeTable();
            out.push(`<blockquote><p>${applyInline(bqMatch[1])}</p></blockquote>`);
            continue;
        }

        if (RE_TABLE_ROW.test(line.trim()) && line.trim().endsWith('|')) {
            const nextLine = lines[i + 1] ?? '';
            const isSeparator = RE_TABLE_SEP.test(nextLine.trim());
            if (isSeparator && !inTable) {
                flushParagraph(); closeList();
                const headerCells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                const sepCells    = nextLine.trim().slice(1, -1).split('|').map(c => c.trim());
                columnAligns = sepCells.map(c => {
                    if (c.startsWith(':') && c.endsWith(':')) { return 'center'; }
                    if (c.endsWith(':')) { return 'right'; }
                    if (c.startsWith(':')) { return 'left'; }
                    return '';
                });
                out.push('<div class="table-wrap"><table><thead><tr>');
                for (let ci = 0; ci < headerCells.length; ci++) {
                    out.push(`<th${alignAttr(ci)}>${applyInline(headerCells[ci])}</th>`);
                }
                out.push('</tr></thead><tbody>');
                inTable = true; i++; continue;
            }
            if (RE_TABLE_SEP.test(line.trim())) { continue; }
            if (inTable || (!isSeparator && RE_TABLE_ROW.test(line.trim()))) {
                if (!inTable) { flushParagraph(); closeList(); out.push('<div class="table-wrap"><table><tbody>'); inTable = true; }
                const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
                out.push('<tr>');
                for (let ci = 0; ci < cells.length; ci++) {
                    out.push(`<td${alignAttr(ci)}>${applyInline(cells[ci])}</td>`);
                }
                out.push('</tr>');
                continue;
            }
        } else if (inTable) {
            closeTable();
        }

        const ulMatch = line.match(RE_UL);
        if (ulMatch) {
            flushParagraph(); closeTable();
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${applyInline(ulMatch[1])}</li>`);
            continue;
        }

        const olMatch = line.match(RE_OL);
        if (olMatch) {
            flushParagraph(); closeTable();
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (!inOl) { out.push('<ol>'); inOl = true; }
            out.push(`<li>${applyInline(olMatch[1])}</li>`);
            continue;
        }

        if (line.trim() === '') { flushParagraph(); closeList(); closeTable(); continue; }

        closeList(); closeTable();
        paragraphLines.push(applyInline(line));
    }
    flushParagraph(); closeList(); closeTable();

    let result = out.join('\n');
    result = result.replace(RE_PLACEHOLDER_IC_G, (_m, i) => inlineCodes[+i]);
    result = result.replace(RE_PLACEHOLDER_CB_G, (_m, i) => codeBlocks[+i]);
    return result;
}
