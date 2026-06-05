// src/utils/contentFilter.ts

/**
 * Strips fenced code blocks and long inline code spans from a Markdown string.
 * Replaces each removed block with `[code block omitted]`.
 *
 * Rules:
 * - Fenced code blocks (``` ... ```) are always removed regardless of length.
 * - Inline code spans longer than 40 characters are removed.
 * - Prose and inline code ≤ 40 characters are preserved.
 */
export function stripCodeBlocks(content: string): string {
    if (!content) { return content; }

    // 1. Remove fenced code blocks (``` ... ```) — greedy multiline match.
    //    Handles optional language labels after the opening fence.
    let result = content.replace(/```[\s\S]*?```/g, '[code block omitted]');

    // 2. Remove inline code spans longer than 40 characters.
    //    Match `...` where the content is > 40 chars.
    result = result.replace(/`([^`]+)`/g, (_match, inner: string) => {
        return inner.length > 40 ? '[code block omitted]' : `\`${inner}\``;
    });

    return result;
}