// src/webview/cwTheme.ts
// Shared design system: CSS variables, reusable component classes, syntax highlighter.
// All --cw-* tokens are independent of the active VS Code colour theme.
// Only the dark/light *palette variant* switches — the brand colours never change.

/**
 * Returns the CSS block that defines --cw-* design tokens and reusable component classes.
 * Interpolate the return value into a <style> block in any webview.
 */
export function cwThemeCss(): string {
    return `
/* ── CW Design Tokens ─────────────────────────────────────────── */
:root {
  --cw-radius:    8px;
  --cw-radius-sm: 5px;
  --cw-radius-xs: 3px;
}

.vscode-dark, .vscode-high-contrast {
  --cw-accent:         #5B8AF5;
  --cw-accent-hover:   #4a7ae0;
  --cw-accent-text:    #ffffff;
  --cw-copilot:        #f0883e;
  --cw-claude:         #a67bf0;
  --cw-surface:        #181c2a;
  --cw-surface-raised: #1f2438;
  --cw-surface-subtle: #252b40;
  --cw-border:         rgba(255,255,255,0.07);
  --cw-border-strong:  rgba(255,255,255,0.13);
  --cw-text-muted:     #7a879f;
  --cw-shadow:         0 2px 12px rgba(0,0,0,0.35);
  --cw-shadow-hover:   0 4px 20px rgba(0,0,0,0.50);
  --cw-sk-base:        #1f2438;
  --cw-sk-shine:       #2a3050;
}

.vscode-light {
  --cw-accent:         #3b6fd4;
  --cw-accent-hover:   #2a5bbf;
  --cw-accent-text:    #ffffff;
  --cw-copilot:        #c05c00;
  --cw-claude:         #7b4fd4;
  --cw-surface:        #f4f6fb;
  --cw-surface-raised: #ffffff;
  --cw-surface-subtle: #eef1f8;
  --cw-border:         rgba(0,0,0,0.08);
  --cw-border-strong:  rgba(0,0,0,0.16);
  --cw-text-muted:     #6370a0;
  --cw-shadow:         0 2px 12px rgba(0,0,0,0.08);
  --cw-shadow-hover:   0 4px 20px rgba(0,0,0,0.14);
  --cw-sk-base:        #eef1f8;
  --cw-sk-shine:       #ffffff;
}

/* ── Skeleton shimmer ─────────────────────────────────────────── */
@keyframes cw-shimmer {
  0%   { background-position: -400px 0; }
  100% { background-position:  400px 0; }
}

.cw-skeleton {
  background: linear-gradient(
    90deg,
    var(--cw-sk-base)  25%,
    var(--cw-sk-shine) 50%,
    var(--cw-sk-base)  75%
  );
  background-size: 800px 100%;
  animation: cw-shimmer 1.6s infinite linear;
  border-radius: var(--cw-radius-xs);
}

/* ── Card ─────────────────────────────────────────────────────── */
.cw-card {
  background:    var(--cw-surface-raised);
  border:        1px solid var(--cw-border);
  border-radius: var(--cw-radius);
  box-shadow:    var(--cw-shadow);
  overflow:      hidden;
}

.cw-card-header {
  background:    var(--cw-surface-subtle);
  border-bottom: 1px solid var(--cw-border);
  padding:       6px 10px;
  display:       flex;
  align-items:   center;
  gap:           8px;
}

/* ── Button ───────────────────────────────────────────────────── */
.cw-btn {
  font-size:     0.78em;
  padding:       2px 10px;
  border:        1px solid var(--cw-border-strong);
  border-radius: var(--cw-radius-xs);
  cursor:        pointer;
  background:    var(--cw-surface-subtle);
  color:         inherit;
  white-space:   nowrap;
  flex-shrink:   0;
  transition:    background 0.12s, color 0.12s, border-color 0.12s;
}

.cw-btn:hover {
  background:   var(--cw-accent);
  color:        var(--cw-accent-text);
  border-color: var(--cw-accent);
}

/* ── Badges ───────────────────────────────────────────────────── */
.cw-badge-accent {
  display:       inline-block;
  font-size:     0.78em;
  font-weight:   700;
  padding:       2px 9px;
  border-radius: 10px;
  background:    var(--cw-accent);
  color:         var(--cw-accent-text);
  white-space:   nowrap;
  flex-shrink:   0;
}

.cw-badge-copilot {
  display:       inline-block;
  font-size:     0.73em;
  font-weight:   600;
  padding:       1px 6px;
  border-radius: var(--cw-radius-xs);
  background:    rgba(240,136,62,0.18);
  color:         var(--cw-copilot);
  border:        1px solid rgba(240,136,62,0.35);
  white-space:   nowrap;
}

.cw-badge-claude {
  display:       inline-block;
  font-size:     0.73em;
  font-weight:   600;
  padding:       1px 6px;
  border-radius: var(--cw-radius-xs);
  background:    rgba(166,123,240,0.18);
  color:         var(--cw-claude);
  border:        1px solid rgba(166,123,240,0.35);
  white-space:   nowrap;
}

/* ── Toolbar ──────────────────────────────────────────────────── */
.cw-toolbar {
  background:    var(--cw-surface);
  border-bottom: 1px solid var(--cw-border);
}
`;
}

/**
 * Returns CSS for the fixed-dark syntax highlighting theme.
 * These colours never change regardless of the VS Code theme.
 * Interpolate into a <style> block alongside cwThemeCss().
 */
export function syntaxHighlighterCss(): string {
    return `
/* ── Syntax Highlight (fixed dark palette) ───────────────────── */
pre {
  background: #0d1117 !important;
  border-radius: var(--cw-radius-sm, 5px);
  border: 1px solid rgba(255,255,255,0.06);
}

pre code {
  background: transparent !important;
  color: #c9d1d9;
}

.tok-keyword  { color: #ff7b72; }
.tok-string   { color: #a5d6ff; }
.tok-comment  { color: #8b949e; font-style: italic; }
.tok-number   { color: #79c0ff; }
.tok-function { color: #d2a8ff; }
.tok-type     { color: #ffa657; }
`;
}

/**
 * Returns the inline JavaScript for syntax highlighting.
 * Does not include <script> tags — wrap as needed.
 *
 * For sessionWebviewPanel.ts: embed inside the nonce script block.
 * For other panels: wrap in <script>...</script>.
 */
export function syntaxHighlighterJs(): string {
    return `
(function() {
  var KEYWORDS = new Set([
    'abstract','as','async','await','break','case','catch','class','const',
    'continue','debugger','declare','default','delete','do','else','enum',
    'export','extends','false','finally','for','from','function','get','if',
    'implements','import','in','instanceof','interface','let','namespace',
    'new','null','of','package','private','protected','public','readonly',
    'return','set','static','super','switch','this','throw','true','try',
    'type','typeof','undefined','var','void','while','with','yield',
    'def','elif','except','exec','lambda','nonlocal','pass','print','raise',
    'and','not','or','is',
    'fn','mut','pub','use','mod','impl','struct','trait','where',
    'int','float','double','char','long','short','byte','unsigned','signed',
    'auto','register','extern','volatile','inline','None','True','False','self'
  ]);

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function sp(cls, text) {
    return '<span class="' + cls + '">' + escHtml(text) + '</span>';
  }

  function tokenize(code) {
    var out = '';
    var i = 0;
    var len = code.length;

    while (i < len) {
      var ch = code[i];

      // Block comment /* ... */
      if (ch === '/' && code[i+1] === '*') {
        var ce = code.indexOf('*/', i + 2);
        if (ce === -1) { ce = len - 2; }
        out += sp('tok-comment', code.slice(i, ce + 2));
        i = ce + 2;
        continue;
      }

      // Line comment //
      if (ch === '/' && code[i+1] === '/') {
        var nl = code.indexOf('\n', i);
        if (nl === -1) { nl = len; }
        out += sp('tok-comment', code.slice(i, nl));
        i = nl;
        continue;
      }

      // Hash comment #
      if (ch === '#') {
        var nh = code.indexOf('\n', i);
        if (nh === -1) { nh = len; }
        out += sp('tok-comment', code.slice(i, nh));
        i = nh;
        continue;
      }

      // String: single or double quote
      if (ch === '"' || ch === "'") {
        var q = ch;
        var j = i + 1;
        while (j < len) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === q)    { j++; break; }
          j++;
        }
        out += sp('tok-string', code.slice(i, j));
        i = j;
        continue;
      }

      // Number
      if (ch >= '0' && ch <= '9') {
        var k = i;
        while (k < len) {
          var c = code[k];
          if (!((c >= '0' && c <= '9') || c === '.' || c === '_' ||
                c === 'x' || c === 'X' ||
                (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) { break; }
          k++;
        }
        out += sp('tok-number', code.slice(i, k));
        i = k;
        continue;
      }

      // Identifier: keyword, function call, PascalCase type, or plain word
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
        var m = i;
        while (m < len) {
          var mc = code[m];
          if (!((mc >= 'a' && mc <= 'z') || (mc >= 'A' && mc <= 'Z') ||
                (mc >= '0' && mc <= '9') || mc === '_')) { break; }
          m++;
        }
        var word = code.slice(i, m);
        var next = code[m] || '';
        if (KEYWORDS.has(word)) {
          out += sp('tok-keyword', word);
        } else if (next === '(') {
          out += sp('tok-function', word);
        } else if (word[0] >= 'A' && word[0] <= 'Z') {
          out += sp('tok-type', word);
        } else {
          out += escHtml(word);
        }
        i = m;
        continue;
      }

      // Everything else
      out += escHtml(ch);
      i++;
    }
    return out;
  }

  document.querySelectorAll('pre code').forEach(function(block) {
    block.innerHTML = tokenize(block.textContent || '');
  });
})();
`;
}
