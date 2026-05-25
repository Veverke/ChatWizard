// src/utils/workItemExtractor.ts
// Extracts work-item references (e.g. JIRA tickets, GitHub issues, Azure DevOps items)
// from session titles and message content.
//
// The pattern is configurable via 'chatwizard.workItemPattern' (a regex string).
// Default pattern covers: JIRA-style (ABC-123), GitHub issues (#123, GH-123),
// Azure DevOps (#12345), and user-defined patterns.
//
// Feature 11: Work-Item Grouping

/** Default regex string for common work-item ID formats. */
export const DEFAULT_WORK_ITEM_PATTERN =
    '(?:(?:[A-Z]{2,10}-\\d+)|(?:#\\d+)|(?:GH-\\d+)|(?:AB#\\d+))';

/**
 * Extracts all unique work-item references found in `text`.
 *
 * @param text     Text to search (e.g. session title or message content)
 * @param pattern  Optional regex string override (from config). Defaults to DEFAULT_WORK_ITEM_PATTERN.
 * @returns        Deduplicated, uppercased work-item IDs, e.g. ['ABC-123', '#456']
 */
export function extractWorkItems(text: string, pattern?: string): string[] {
    if (!text) { return []; }

    const regexStr = (pattern && pattern.trim()) ? pattern.trim() : DEFAULT_WORK_ITEM_PATTERN;

    let re: RegExp;
    try {
        re = new RegExp(regexStr, 'gi');
    } catch {
        // Invalid user-supplied pattern — fall back to default
        re = new RegExp(DEFAULT_WORK_ITEM_PATTERN, 'gi');
    }

    const seen = new Set<string>();
    const results: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        const val = m[0].toUpperCase();
        if (!seen.has(val)) {
            seen.add(val);
            results.push(val);
        }
    }

    return results;
}

/**
 * Extracts all work items from a session (title + all messages up to a char budget).
 */
export function extractWorkItemsFromSession(
    title: string,
    messages: Array<{ role: string; content: string }>,
    pattern?: string,
): string[] {
    const fromTitle = extractWorkItems(title, pattern);

    // Scan all messages up to a total character budget to keep this efficient
    // even for very long sessions.
    const CHAR_BUDGET = 10_000;
    let budget = CHAR_BUDGET;
    const seen = new Set(fromTitle);
    const all = [...fromTitle];

    for (const msg of messages) {
        if (budget <= 0) { break; }
        const slice = msg.content.slice(0, budget);
        budget -= slice.length;
        for (const item of extractWorkItems(slice, pattern)) {
            if (!seen.has(item)) { seen.add(item); all.push(item); }
        }
    }

    return all;
}
