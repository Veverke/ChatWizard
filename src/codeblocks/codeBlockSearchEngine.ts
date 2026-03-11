import { IndexedCodeBlock } from '../types/index';

export class CodeBlockSearchEngine {
    private blocks: IndexedCodeBlock[] = [];

    /** Replace the entire code block index with a new set */
    index(blocks: IndexedCodeBlock[]): void {
        this.blocks = [...blocks];
    }

    /** All distinct language labels in the index, sorted alphabetically.
     *  Empty-string language is included (unlabeled blocks).
     *  Use this to populate the language filter dropdown in the UI. */
    getLanguages(): string[] {
        const seen = new Set<string>();
        for (const block of this.blocks) {
            seen.add(block.language);
        }
        return [...seen].sort();
    }

    /**
     * Search code blocks.
     * @param query - plain text substring to match against block content (case-insensitive).
     *                If empty, returns all blocks (subject to language filter).
     * @param language - if provided (non-empty string), only return blocks with this language (exact match, case-insensitive).
     * @returns matching IndexedCodeBlock[], preserving insertion order.
     */
    search(query: string, language?: string): IndexedCodeBlock[] {
        let results = this.blocks;

        if (language && language.length > 0) {
            const langLower = language.toLowerCase();
            results = results.filter(b => b.language.toLowerCase() === langLower);
        }

        if (query.length > 0) {
            const queryLower = query.toLowerCase();
            results = results.filter(b => b.content.toLowerCase().includes(queryLower));
        }

        return results;
    }

    /** Total number of blocks currently in the index. */
    get size(): number {
        return this.blocks.length;
    }

    /**
     * Remove all blocks belonging to the given session.
     * No-op if the sessionId is not present in the index.
     */
    removeBySession(sessionId: string): void {
        this.blocks = this.blocks.filter(b => b.sessionId !== sessionId);
    }

    /**
     * Replace all blocks for `sessionId` with the supplied `blocks` array,
     * then append any blocks from other sessions that were already indexed.
     * If `blocks` is empty this behaves like `removeBySession`.
     */
    upsertBySession(sessionId: string, blocks: IndexedCodeBlock[]): void {
        this.removeBySession(sessionId);
        this.blocks = [...this.blocks, ...blocks];
    }
}
