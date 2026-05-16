import { readFileSync, writeFileSync } from 'fs';

const file = new URL('../src/mcp/chatParticipant.ts', import.meta.url).pathname.replace(/^\//, '');
let content = readFileSync(file, 'utf8');

const oldStart = content.indexOf('/**\n * Return an excerpt');
if (oldStart === -1) {
    // Try CRLF
    const idx = content.indexOf('/**\r\n * Return an excerpt');
    if (idx === -1) { console.error('Could not find old JSDoc'); process.exit(1); }
    console.log('Found old function JSDoc (CRLF) at', idx);
}

// Find end: closing } of keywordAnchoredExcerpt, which is followed by blank line + next comment
const funcMarker = 'function keywordAnchoredExcerpt(';
const funcStart = content.indexOf(funcMarker);
if (funcStart === -1) { console.error('Could not find function declaration'); process.exit(1); }

// Find the JSDoc that immediately precedes the function
const jsdocStart = content.lastIndexOf('/**', funcStart);
console.log('JSDoc start:', jsdocStart, '  func start:', funcStart);

// Find the closing } by counting braces from funcStart
let braceDepth = 0;
let funcEnd = -1;
for (let i = funcStart; i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    else if (content[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) { funcEnd = i; break; }
    }
}
if (funcEnd === -1) { console.error('Could not find closing brace'); process.exit(1); }
console.log('Function ends at:', funcEnd, '  char:', content[funcEnd]);

const before = content.substring(0, jsdocStart);
const after = content.substring(funcEnd + 1);

const newCode = `/**
 * Bold whole-word occurrences of each keyword in \`text\`.
 * Existing **bold** and \`code\` spans are passed through untouched to avoid
 * breaking markdown that already came from the session content.
 */
function boldKeywords(text: string, keywordTokens: string[]): string {
    if (keywordTokens.length === 0) { return text; }
    const escaped = keywordTokens.map(kw => kw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'));
    const kwRegex = new RegExp(\`\\\\b(\${escaped.join('|')})\\\\b\`, 'gi');
    const result: string[] = [];
    const protectedRegex = /(\\*\\*[^*]+\\*\\*|\`[^\`]+\`)/g;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = protectedRegex.exec(text)) !== null) {
        if (m.index > lastIndex) {
            result.push(text.slice(lastIndex, m.index).replace(kwRegex, '**$1**'));
        }
        result.push(m[0]);
        lastIndex = protectedRegex.lastIndex;
    }
    if (lastIndex < text.length) {
        result.push(text.slice(lastIndex).replace(kwRegex, '**$1**'));
    }
    return result.join('');
}

/**
 * Return an excerpt from \`passage\` centred around the first WHOLE-WORD
 * occurrence of any query keyword. Keywords are then bolded in the result.
 * A leading \u2026 is prepended when the window starts mid-text.
 */
function keywordAnchoredExcerpt(passage: string, keywordTokens: string[], maxChars: number): string {
    const flat = passage.replace(/[\\n\\r]+/g, ' ').trim();
    if (!flat) { return ''; }
    if (keywordTokens.length === 0) {
        return flat.slice(0, maxChars) + (flat.length > maxChars ? '\u2026' : '');
    }
    const lower = flat.toLowerCase();
    let firstPos = -1;
    for (const kw of keywordTokens) {
        const re = new RegExp(\`\\\\b\${kw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\b\`);
        const match = re.exec(lower);
        if (match && (firstPos === -1 || match.index < firstPos)) { firstPos = match.index; }
    }
    let excerpt: string;
    let prefix = '';
    let suffix = '';
    if (firstPos <= 30 || firstPos === -1) {
        excerpt = flat.slice(0, maxChars);
        if (flat.length > maxChars) { suffix = '\u2026'; }
    } else {
        const start = firstPos - 30;
        excerpt = flat.slice(start, start + maxChars);
        prefix = '\u2026';
        if (start + maxChars < flat.length) { suffix = '\u2026'; }
    }
    return prefix + boldKeywords(excerpt, keywordTokens) + suffix;
}`;

const newContent = before + newCode + after;
writeFileSync(file, newContent, 'utf8');
console.log('Done. Wrote', newContent.length, 'chars. Old length was', content.length);

// Verify
const verify = readFileSync(file, 'utf8');
if (verify.includes('lower.indexOf(kw)')) {
    console.error('ERROR: old indexOf still present!');
} else {
    console.log('OK: indexOf removed');
}
if (verify.includes('boldKeywords')) {
    console.log('OK: boldKeywords present');
} else {
    console.error('ERROR: boldKeywords not found!');
}
