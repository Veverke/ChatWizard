"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sessionRenderer_exports = {};
__export(sessionRenderer_exports, {
  MessageRenderer: () => MessageRenderer,
  escapeHtml: () => escapeHtml,
  markdownToHtml: () => markdownToHtml,
  renderChunk: () => renderChunk,
  renderMessage: () => renderMessage
});
module.exports = __toCommonJS(sessionRenderer_exports);
const RE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const RE_NON_ASCII = /[^\x00-\x7F]/gu;
const RE_FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const RE_INLINE_CODE = /`([^`]+)`/g;
const RE_PLACEHOLDER_CB = /^\x00CB(\d+)\x00$/;
const RE_PLACEHOLDER_CB_G = /\x00CB(\d+)\x00/g;
const RE_PLACEHOLDER_IC_G = /\x00IC(\d+)\x00/g;
const RE_AMP = /&/g;
const RE_LT = /</g;
const RE_GT = />/g;
const RE_QUOT = /"/g;
const RE_APOS = /'/g;
const RE_INDENT = /^    /;
const RE_HEADING = /^(#{1,6})\s+(.+)$/;
const RE_HR = /^([-*_])\1\1+\s*$/;
const RE_BLOCKQUOTE = /^&gt;\s?(.*)$/;
const RE_TABLE_ROW = /^\|/;
const RE_TABLE_SEP = /^\|[\s|:-]+\|$/;
const RE_UL = /^[-*+]\s+(.+)$/;
const RE_OL = /^\d+\.\s+(.+)$/;
const RE_BOLD_ITALIC = /\*\*\*(.+?)\*\*\*/g;
const RE_BOLD = /\*\*(.+?)\*\*/g;
const RE_ITALIC = /\*(.+?)\*/g;
const RE_STRIKE = /~~(.+?)~~/g;
const RE_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const RE_ESC_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
class MessageRenderer {
  /** Convert Markdown to HTML using the single-pass line scanner. */
  static markdownToHtml(markdown) {
    return markdownToHtml(markdown);
  }
  static renderMessage(msg, origIdx, visibleIdx, visibleMessages, assistantLabel, fadeIdx) {
    return renderMessage(msg, origIdx, visibleIdx, visibleMessages, assistantLabel, fadeIdx);
  }
  static renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade) {
    return renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade);
  }
}
function renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade) {
  const parts = [];
  for (let i = start; i < end; i++) {
    const { msg, origIdx } = visibleMessages[i];
    const fadeIdx = withFade ? i - start : void 0;
    if (fadeIdx !== void 0 && fadeIdx < 16) {
      parts.push(renderMessage(msg, origIdx, i, visibleMessages, assistantLabel, fadeIdx));
      if (renderedMessages[i] === null) {
        renderedMessages[i] = renderMessage(
          msg,
          origIdx,
          i,
          visibleMessages,
          assistantLabel,
          void 0
        );
      }
    } else {
      if (renderedMessages[i] === null) {
        renderedMessages[i] = renderMessage(
          msg,
          origIdx,
          i,
          visibleMessages,
          assistantLabel,
          void 0
        );
      }
      parts.push(renderedMessages[i]);
    }
  }
  return parts.join("\n");
}
function renderMessage(msg, origIdx, visibleIdx, visibleMessages, assistantLabel, fadeIdx) {
  const roleClass = msg.role === "user" ? "user" : "assistant";
  const label = msg.role === "user" ? "You" : assistantLabel;
  const timestamp = msg.timestamp ? `<span class="timestamp">${escapeHtml(new Date(msg.timestamp).toLocaleString())}</span>` : "";
  const fadeStyle = fadeIdx !== void 0 && fadeIdx < 16 ? ` style="--cw-i:${fadeIdx}"` : "";
  let pCount = 0, rCount = 0;
  for (let i = 0; i <= visibleIdx; i++) {
    if (visibleMessages[i].msg.role === "user") {
      pCount++;
    } else {
      rCount++;
    }
  }
  const turnLabel = msg.role === "user" ? `P${pCount}` : `R${rCount}`;
  if (msg.skipped) {
    const sizeKb = msg.skippedLineLength !== void 0 ? Math.round(msg.skippedLineLength / 1024) : "?";
    const limitKb = msg.skippedLineLimit !== void 0 ? Math.round(msg.skippedLineLimit / 1024) : "?";
    return `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}" id="cw-msg-${turnLabel}">
  <div class="message-header">
    <span class="role-label">${label}</span><span class="cw-turn-label">${turnLabel}</span>${timestamp}
  </div>
  <div class="message-body skipped-notice">&#9888; Message not shown &mdash; source line is ${sizeKb}&nbsp;KB, exceeding the ${limitKb}&nbsp;KB limit. Raise <code>chatwizard.maxLineLengthChars</code> in settings to include it.</div>
</div>`;
  }
  const renderedContent = markdownToHtml(msg.content);
  let html = `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}" id="cw-msg-${turnLabel}">
  <div class="message-header">
    <span class="role-label">${label}</span><span class="cw-turn-label">${turnLabel}</span>${timestamp}<button class="cw-copy-ref-btn" data-turn="${turnLabel}" title="Copy as reference (${turnLabel})">&#10697;</button>
  </div>
  <div class="message-body" data-raw="${escapeHtml(msg.content)}">${renderedContent}</div>
</div>`;
  const nextEntry = visibleMessages[visibleIdx + 1];
  const hasAssistant = visibleMessages.some((vm) => vm.msg.role === "assistant");
  if (msg.role === "user" && (!nextEntry || nextEntry.msg.role === "user")) {
    if (hasAssistant) {
      html += `
<div class="message assistant cw-role-response aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice">&#9888; Response not available &mdash; cancelled or incomplete</div>
</div>`;
    } else {
      html += `
<div class="message assistant cw-role-response aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice" style="opacity:0.55">&#8505; Response not stored locally for this source</div>
</div>`;
    }
  }
  return html;
}
function escapeHtml(text) {
  return text.replace(RE_ESC_CONTROL, "").replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;").replace(RE_QUOT, "&quot;").replace(RE_APOS, "&#39;").replace(RE_NON_ASCII, (c) => `&#${c.codePointAt(0)};`);
}
function applyInline(text) {
  return text.replace(RE_BOLD_ITALIC, "<strong><em>$1</em></strong>").replace(RE_BOLD, "<strong>$1</strong>").replace(RE_ITALIC, "<em>$1</em>").replace(RE_STRIKE, "<del>$1</del>").replace(RE_LINK, '<a href="$2">$1</a>');
}
function markdownToHtml(markdown) {
  markdown = markdown.replace(RE_CONTROL, "");
  const codeBlocks = [];
  let text = markdown.replace(RE_FENCE, (_m, lang, code) => {
    const esc = code.replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
    const attr = lang.trim() ? ` class="language-${lang.trim()}"` : "";
    const fenceIdx = codeBlocks.length;
    codeBlocks.push(`<pre data-fence-idx="${fenceIdx}"><code${attr}>${esc}</code></pre>`);
    return `\0CB${codeBlocks.length - 1}\0`;
  });
  text = text.replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
  text = text.replace(RE_NON_ASCII, (c) => `&#${c.codePointAt(0)};`);
  const inlineCodes = [];
  text = text.replace(RE_INLINE_CODE, (_m, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\0IC${inlineCodes.length - 1}\0`;
  });
  const lines = text.split("\n");
  const out = [];
  let inUl = false, inOl = false, inTable = false;
  let columnAligns = [];
  let paragraphLines = [];
  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</tbody></table></div>");
      inTable = false;
      columnAligns = [];
    }
  };
  const alignAttr = (colIdx) => {
    const a = columnAligns[colIdx] ?? "";
    return a ? ` style="text-align:${a}"` : "";
  };
  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.join("<br>")}</p>`);
      paragraphLines = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cbMatch = line.trim().match(RE_PLACEHOLDER_CB);
    if (cbMatch) {
      flushParagraph();
      closeList();
      closeTable();
      out.push(codeBlocks[+cbMatch[1]]);
      continue;
    }
    if (RE_INDENT.test(line) && !inUl && !inOl) {
      flushParagraph();
      closeList();
      closeTable();
      const indentedLines = [line.slice(4)];
      while (i + 1 < lines.length && RE_INDENT.test(lines[i + 1])) {
        i++;
        indentedLines.push(lines[i].slice(4));
      }
      const esc = indentedLines.join("\n").replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
      out.push(`<pre><code>${esc}</code></pre>`);
      continue;
    }
    const hMatch = line.match(RE_HEADING);
    if (hMatch) {
      flushParagraph();
      closeList();
      closeTable();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${applyInline(hMatch[2])}</h${lvl}>`);
      continue;
    }
    if (RE_HR.test(line)) {
      flushParagraph();
      closeList();
      closeTable();
      out.push("<hr>");
      continue;
    }
    const bqMatch = line.match(RE_BLOCKQUOTE);
    if (bqMatch) {
      flushParagraph();
      closeList();
      closeTable();
      out.push(`<blockquote><p>${applyInline(bqMatch[1])}</p></blockquote>`);
      continue;
    }
    if (RE_TABLE_ROW.test(line.trim()) && line.trim().endsWith("|")) {
      const nextLine = lines[i + 1] ?? "";
      const isSeparator = RE_TABLE_SEP.test(nextLine.trim());
      if (isSeparator && !inTable) {
        flushParagraph();
        closeList();
        const headerCells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        const sepCells = nextLine.trim().slice(1, -1).split("|").map((c) => c.trim());
        columnAligns = sepCells.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) {
            return "center";
          }
          if (c.endsWith(":")) {
            return "right";
          }
          if (c.startsWith(":")) {
            return "left";
          }
          return "";
        });
        out.push('<div class="table-wrap"><table><thead><tr>');
        for (let ci = 0; ci < headerCells.length; ci++) {
          out.push(`<th${alignAttr(ci)}>${applyInline(headerCells[ci])}</th>`);
        }
        out.push("</tr></thead><tbody>");
        inTable = true;
        i++;
        continue;
      }
      if (RE_TABLE_SEP.test(line.trim())) {
        continue;
      }
      if (inTable || !isSeparator && RE_TABLE_ROW.test(line.trim())) {
        if (!inTable) {
          flushParagraph();
          closeList();
          out.push('<div class="table-wrap"><table><tbody>');
          inTable = true;
        }
        const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        out.push("<tr>");
        for (let ci = 0; ci < cells.length; ci++) {
          out.push(`<td${alignAttr(ci)}>${applyInline(cells[ci])}</td>`);
        }
        out.push("</tr>");
        continue;
      }
    } else if (inTable) {
      closeTable();
    }
    const ulMatch = line.match(RE_UL);
    if (ulMatch) {
      flushParagraph();
      closeTable();
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${applyInline(ulMatch[1])}</li>`);
      continue;
    }
    const olMatch = line.match(RE_OL);
    if (olMatch) {
      flushParagraph();
      closeTable();
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${applyInline(olMatch[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      closeTable();
      continue;
    }
    closeList();
    closeTable();
    paragraphLines.push(applyInline(line));
  }
  flushParagraph();
  closeList();
  closeTable();
  let result = out.join("\n");
  result = result.replace(RE_PLACEHOLDER_IC_G, (_m, i) => inlineCodes[+i]);
  result = result.replace(RE_PLACEHOLDER_CB_G, (_m, i) => codeBlocks[+i]);
  return result;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MessageRenderer,
  escapeHtml,
  markdownToHtml,
  renderChunk,
  renderMessage
});
