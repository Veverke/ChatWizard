// src/analytics/kbClassifier.ts
// Feature 23 — KB Entry Classification

import type { Session } from '../types/index';
import type { KbEntryType } from '../types/kb';

/**
 * Heuristic signal phrases for each KB entry type.
 * Rules are evaluated in order; first match wins.
 * Fallthrough: any session not matching the above rules is classified as 'learning'.
 */
const CLASSIFICATION_RULES: Array<{ type: KbEntryType; phrases: string[] }> = [
    {
        type: 'decision',
        phrases: [
            'i decided', 'we chose', 'we went with', 'the reason we',
            'trade-off', 'tradeoff', 'alternative', 'chose to', 'we decided',
        ],
    },
    {
        type: 'gotcha',
        phrases: [
            'gotcha', 'footgun', 'be careful', 'watch out',
            "don't forget", 'turns out', 'fixed by', 'tricky',
            'common mistake', 'easy to miss',
        ],
    },
    {
        type: 'architecture',
        phrases: [
            'architecture', 'component', 'service', 'layer', 'schema',
            'system design', 'dependency graph', 'microservice', 'monolith',
            'api design', 'data model',
        ],
    },
    {
        type: 'pattern',
        phrases: [
            'pattern', 'template', 'reusable', 'abstraction', 'convention',
            'strategy', 'best practice', 'idiom', 'recipe',
        ],
    },
    // 'learning' is the fallthrough — no explicit phrases needed
];

/**
 * Classify a session into one of five KB entry types using heuristic phrase matching.
 *
 * Applies rules in order against the concatenated text of the first 10 messages
 * (lowercased). Returns the type of the first matching rule, or 'learning' if no
 * rule matches.
 */
export function classifySession(session: Session): KbEntryType {
    // Take only the first 10 messages for classification
    const firstTenMessages = session.messages.slice(0, 10);
    const combinedText = firstTenMessages
        .map(m => m.content)
        .join(' ')
        .toLowerCase();

    for (const rule of CLASSIFICATION_RULES) {
        for (const phrase of rule.phrases) {
            if (combinedText.includes(phrase)) {
                return rule.type;
            }
        }
    }

    // Fallthrough: any session not matching the above is a 'learning'
    return 'learning';
}