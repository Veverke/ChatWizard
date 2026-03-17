export function extractSnippet(
    content: string,
    matchOffset: number,
    matchLength: number,
    contextChars: number = 100
): { snippet: string; matchStart: number; matchEnd: number } {
    const windowStart = Math.max(0, matchOffset - contextChars);
    const windowEnd = Math.min(content.length, matchOffset + matchLength + contextChars);

    const raw = content.slice(windowStart, windowEnd);

    const matchStart = matchOffset - windowStart;
    const matchEnd = matchStart + matchLength;

    const prependEllipsis = windowStart > 0;
    const appendEllipsis = windowEnd < content.length;

    const ellipsisOffset = prependEllipsis ? 1 : 0; // '…' is a single character
    const snippet = (prependEllipsis ? '…' : '') + raw + (appendEllipsis ? '…' : '');

    return { snippet, matchStart: matchStart + ellipsisOffset, matchEnd: matchEnd + ellipsisOffset };
}

export function findFirstMatch(
    content: string,
    query: string | RegExp
): { offset: number; length: number } | undefined {
    if (typeof query === 'string') {
        const idx = content.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) {
            return undefined;
        }
        return { offset: idx, length: query.length };
    } else {
        const match = query.exec(content);
        if (match === null) {
            return undefined;
        }
        return { offset: match.index, length: match[0].length };
    }
}
