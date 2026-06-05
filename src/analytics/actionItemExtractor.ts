// src/analytics/actionItemExtractor.ts
// Feature 34 — Outcome / Follow-Up Tracking

import type { Session, ActionItem } from '../types/index';

const MAX_ACTION_ITEMS = 20;

/**
 * Phrases in assistant messages that signal an action item or follow-up task.
 * Matched case-insensitively as substring matches.
 */
const ACTION_SIGNAL_PHRASES: string[] = [
    'you should',
    'next step',
    'todo:',
    'action:',
    'follow up',
    "don't forget",
    'make sure to',
    "you'll need to",
    'remember to',
    'you need to',
    'be sure to',
    'make sure you',
    "you'll want to",
];

/**
 * Generate a stable, deterministic ID for an action item based on its content.
 */
function makeActionItemId(sessionId: string, text: string, index: number): string {
    // Use a simple hash-like approach: index + first 20 chars + session prefix
    const prefix = sessionId.slice(0, 8);
    const slug = text.toLowerCase().replace(/\W+/g, '-').slice(0, 20);
    return `${prefix}-${index}-${slug}`;
}

/**
 * Extract the sentence containing the signal phrase from a message.
 * Returns the whole sentence (split on . ! ? or newlines), trimmed.
 */
function extractSentence(content: string, phraseIndex: number): string {
    // Find sentence boundaries around the phrase index
    const sentenceBreaks = /[.!?\n]/;
    let start = phraseIndex;
    let end = phraseIndex;

    // Walk back to find start of sentence
    while (start > 0 && !sentenceBreaks.test(content[start - 1])) {
        start--;
    }

    // Walk forward to find end of sentence
    while (end < content.length && !sentenceBreaks.test(content[end])) {
        end++;
    }

    return content.slice(start, end).trim();
}

/**
 * Normalize text for deduplication: lowercase, collapse whitespace.
 */
function normalizeForDedup(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract action items from assistant messages in a session.
 *
 * Scans assistant messages for actionable phrases, extracts the containing
 * sentence, deduplicates by normalized text, and caps at MAX_ACTION_ITEMS.
 *
 * Returns an empty array for purely conversational sessions.
 */
export function extractActionItems(session: Session): ActionItem[] {
    const items: ActionItem[] = [];
    const seenTexts = new Set<string>();
    let index = 0;
    const now = new Date().toISOString();

    for (const message of session.messages) {
        if (message.role !== 'assistant') { continue; }
        if (!message.content) { continue; }

        const content = message.content;
        const lower = content.toLowerCase();

        for (const phrase of ACTION_SIGNAL_PHRASES) {
            let searchFrom = 0;
            let foundAt: number;

            // Find all occurrences of this phrase in the message
            while ((foundAt = lower.indexOf(phrase, searchFrom)) !== -1) {
                searchFrom = foundAt + phrase.length;

                const sentence = extractSentence(content, foundAt);
                if (!sentence || sentence.length < 5) { continue; }

                const normalized = normalizeForDedup(sentence);
                if (seenTexts.has(normalized)) { continue; }
                seenTexts.add(normalized);

                items.push({
                    id: makeActionItemId(session.id, sentence, index++),
                    text: sentence,
                    done: false,
                    createdAt: message.timestamp ?? now,
                    source: 'extracted',
                });

                if (items.length >= MAX_ACTION_ITEMS) {
                    return items;
                }
            }
        }
    }

    return items;
}